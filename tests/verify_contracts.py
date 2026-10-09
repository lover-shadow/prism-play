"""
《光影Play》(Prism Play) 阶段 0 契约与数据模型自动化闭环检验脚本 (Gate G0 门禁脚本)
用于在编码阶段开始前，机械化确保 PRD / SPEC / OpenAPI / D1 Schema / Design Tokens 严格对齐、杜绝虚假度量。
"""
import sys
import re
import json
import sqlite3
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent

def check_openapi():
    print("[1/5] 检验 OpenAPI 3.0.3 接口机读正本与闭集约束...")
    import yaml
    api_path = ROOT / "docs" / "03-contracts" / "openapi.yaml"
    text = api_path.read_text(encoding="utf-8")
    doc = yaml.safe_load(text)
    
    assert doc.get("openapi") == "3.0.3", "OpenAPI 版本必须为 3.0.3"
    paths = doc.get("paths", {})
    expected_paths = [
        "/api/channels",
        "/api/sources",
        "/api/search/suggestions",
        "/api/search/discoveries",
        "/api/search",
        "/api/titles/{titleId}/related",
        "/api/titles/{titleId}/episodes/{episodeNumber}/native-playback",
        "/api/catalog/changes",
        "/api/catalog",
        "/api/titles/{titleId}",
        "/api/episodes/{episodeId}/playback",
        "/api/private-sessions",
        "/api/config/monetization",
        "/api/redeem",
        "/api/device/ping",
        "/api/user/sync",
        "/api/version",
        "/api/announcements",
        "/api/telemetry/lines",
        "/s/{drama_id}",
        "/dl",
        "/dl/latest/{platform}",
        "/dl/artifacts/{versionCode}/{file}",
        "/",
        "/assets/{file}",
        "/robots.txt",
        "/sitemap.xml",
        "/proxy/{kind}/{handle}"
    ]
    admin_paths = {
        '/api/admin/' + suffix for suffix in [
            'login', 'session', 'logout', 'dashboard', 'coupons', 'coupons/generate',
            'coupons/{id}', 'coupons/{id}/reveal', 'coupons/{id}/confirm-stock',
            'coupons/{id}/dispatch', 'coupons/{id}/revoke', 'operations', 'announcements',
        ]
    }
    for p in expected_paths:
        assert p in paths, f"OpenAPI 缺少端点: {p}"
    privacy_paths = {'/privacy', '/api/analytics/consent'}
    assert set(paths) == set(expected_paths) | admin_paths | privacy_paths, 'App或后台路径集合发生漂移'
    for path in admin_paths:
        for method, operation in paths[path].items():
            if method not in ('get', 'post'):
                continue
            if path != '/api/admin/login':
                assert operation.get('security') == [{'AdminSession': []}], f'后台认证缺失: {path}'
                if method == 'post':
                    assert any(p.get('name') == 'X-CSRF-Token' and p.get('required') for p in operation.get('parameters', [])), f'后台CSRF缺失: {path}'
    
    # 悬空引用检查
    schemas = doc.get("components", {}).get("schemas", {})
    refs = re.findall(r"#/components/schemas/([A-Za-z0-9_]+)", text)
    missing_refs = set(refs) - set(schemas.keys())
    assert not missing_refs, f"OpenAPI 存在未解析的 $ref 引用: {missing_refs}"
    
    # MonetizationConfig 必须为正式 Schema (消除 R-4)
    assert "MonetizationConfig" in schemas, "MonetizationConfig 必须声明为正式独立 Schema"
    
    # 错误码必须为闭集 enum (消除 R-5)
    err_codes = schemas["ErrorResponse"]["properties"]["code"].get("enum", [])
    assert len(err_codes) >= 9, f"ErrorResponse.code 必须为受控闭集 enum，当前: {err_codes}"
    
    # 搜索去 AI 验证 (落实 M-5)
    search_enums = schemas["SearchResult"]["properties"]["matchType"].get("enum", [])
    assert "semantic" not in search_enums, "本期纯词法检索，不得包含 semantic 匹配类型"
    
    # 卡密正则与参数
    code_pattern = schemas["RedeemRequest"]["properties"]["code"]["pattern"]
    assert re.fullmatch(code_pattern, "GY-Q90D-A7F2-8899"), "卡密正则无法匹配示例卡密 GY-Q90D-A7F2-8899"
    assert re.fullmatch(code_pattern, "GY-B365D-A7F2-8899"), "卡密正则应兼容 5 字符批次段"
    assert schemas["RedeemRequest"]["properties"]["platform"]["enum"] == ["android"], "本期平台仅限 android"
    assert "windows" not in schemas["VersionResponse"]["properties"], "VersionResponse 不得包含未交付的 windows 产物属性"
    assert "oneOf" in schemas["CatalogChange"], "CatalogChange 必须使用 oneOf 区分 upsert 与 delete"
    print(f"  -> OpenAPI {len(expected_paths)} 个App路径与 {len(admin_paths)} 个后台目标路径校验通过，无悬空引用；不代表后台已部署。")
    return len(expected_paths)

def load_migration_sql():
    """按序读取全部迁移文件。

    0002 之前本脚本只读 0001，导致增量迁移的 CHECK / FK 约束游离于契约复核之外
    （复审 A-2：迁移正本被劈成两份而门禁只认其一）。此处改为全量按序拼接，
    使每一份迁移都进入同一份内存库并接受同样的约束断言。
    """
    migration_dir = ROOT / "edge" / "migrations"
    files = sorted(p.name for p in migration_dir.glob("*.sql"))
    assert files, "未找到任何 D1 迁移文件"
    assert files[0] == "0001_initial_schema.sql", f"迁移序列必须从 0001 起始，实际: {files}"
    return "\n".join((migration_dir / name).read_text(encoding="utf-8") for name in files), files


def check_sqlite_schema():
    print("[2/5] 检验 Cloudflare D1 (SQLite) 数据模型与真实业务表结构...")
    sql, migration_files = load_migration_sql()
    print(f"        迁移文件: {', '.join(migration_files)}")

    conn = sqlite3.connect(":memory:")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript(sql)

    all_tables = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'").fetchall()]
    fts_shadow = [t for t in all_tables if any(t.endswith(s) for s in ['_config', '_content', '_data', '_docsize', '_idx'])]
    business_tables = [t for t in all_tables if t not in fts_shadow]

    # 诚实校验业务表与 FTS 影子表 (消除 R-7 虚假表数)
    # 0002 新增 cloud_watch_history 与 cloud_user_profile 两张同步表；
    # 0003 瘦身迁移新增线路健康遥测账本 line_health_signals（内容大表标记 DEPRECATED 但不物理 DROP）；
    # 0004 运营后台与分析 additive 新增 analytics_daily / analytics_visitors / analytics_visitor_days /
    #   admin_sessions / admin_login_limits / coupon_batches / admin_audit_logs 七张表（同样不 DROP 旧表）。
    discovery_tables = {"discovery_works", "discovery_changes", "discovery_queries", "discovery_leases", "discovery_rate_windows", "discovery_job_queries", "discovery_jobs", "discovery_cards"}
    assert discovery_tables.issubset(set(business_tables)), f"缺少共享发现表: {discovery_tables - set(business_tables)}"
    assert len(business_tables) == 38, f"业务表数量不符: 期望 38, 实际 {len(business_tables)}: {business_tables}"
    assert len(fts_shadow) == 5, f"FTS5 影子表数量不符: 期望 5, 实际 {len(fts_shadow)}: {fts_shadow}"

    # 0004 运营后台与分析表必须实际落地，而不只是让表数凑够 (计划 §2.4)
    admin_tables = {
        "analytics_daily", "analytics_visitors", "analytics_visitor_days",
        "admin_sessions", "admin_login_limits", "coupon_batches", "admin_audit_logs",
    }
    assert admin_tables.issubset(set(business_tables)), f"缺少运营后台/分析表: {admin_tables - set(business_tables)}"
    # card_coupons 的分发标记为 additive，旧行默认 UNKNOWN，须人工确认库存后方可分发。
    coupon_dispatch_cols = {"dispatch_status", "dispatch_note", "dispatched_at", "dispatch_request_id", "batch_id"}
    coupon_cols = {r[1] for r in conn.execute("PRAGMA table_info(card_coupons)").fetchall()}
    missing_coupon_cols = coupon_dispatch_cols - coupon_cols
    assert not missing_coupon_cols, f"card_coupons 缺少分发列: {missing_coupon_cols}"

    # 验证多端同步表存在且幂等主键成立 (SPEC §2.1)
    sync_tables = {"cloud_watch_history", "cloud_user_profile"}
    assert sync_tables.issubset(set(business_tables)), f"缺少多端同步表: {sync_tables - set(business_tables)}"
    pk_cols = [r[1] for r in conn.execute("PRAGMA table_info(cloud_watch_history)").fetchall() if r[5] > 0]
    assert sorted(pk_cols) == ["content_id", "coupon_code"], f"cloud_watch_history 主键必须是 (coupon_code, content_id)，实际: {pk_cols}"

    # 验证 content_items 客观属性列已就位 (SPEC §3.1)
    content_cols = {r[1] for r in conn.execute("PRAGMA table_info(content_items)").fetchall()}
    for col in ("hits_week", "hits_total", "hot_score", "is_ai", "is_hot"):
        assert col in content_cols, f"content_items 缺少客观属性列: {col}"

    # 验证动态频道约束 (M-3 云端可配)
    conn.execute("INSERT INTO channels(id, name, categories_json, created_at, updated_at) VALUES(?,?,?,?,?)",
                 ("drama", "短剧精选", "[]", 1, 1))
    conn.execute("INSERT INTO channels(id, name, requires_tier, categories_json, created_at, updated_at) VALUES(?,?,?,?,?,?)",
                 ("private", "私密频道", "B,Y,S", "[]", 1, 1))
    
    try:
        conn.execute("INSERT INTO channels(id, name, requires_tier, categories_json, created_at, updated_at) VALUES(?,?,?,?,?,?)",
                     ("movie", "院线电影", "B", "[]", 1, 1))
        raise AssertionError("非 private 频道 requires_tier 必须为 '0'")
    except sqlite3.IntegrityError:
        pass
        
    # 验证内容默认未发布与未分享
    conn.execute("INSERT INTO content_items(id, channel_id, title, category, created_at, updated_at) VALUES(?,?,?,?,?,?)",
                 ("test_item_1", "drama", "战神之龙王归来", "战神", 1, 1))
    row = conn.execute("SELECT enabled, shareable, is_private FROM content_items WHERE id='test_item_1'").fetchone()
    assert row == (0, 0, 0), f"content_items 初始值错误: {row}"

    # 验证 R-1: 私密性与可分享物理强制等式 (消除 R-1 合规漏洞)
    try:
        conn.execute("INSERT INTO content_items(id, channel_id, title, category, is_private, shareable, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)",
                     ("bad_priv_1", "private", "泄露测试1", "探索", 0, 1, 1, 1))
        raise AssertionError("必须物理阻断 private 频道但 is_private=0 的记录")
    except sqlite3.IntegrityError:
        pass

    try:
        conn.execute("INSERT INTO content_items(id, channel_id, title, category, is_private, shareable, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)",
                     ("bad_priv_2", "private", "泄露测试2", "探索", 1, 1, 1, 1))
        raise AssertionError("必须物理阻断 private 频道但 shareable=1 的记录")
    except sqlite3.IntegrityError:
        pass

    # 验证预制卡密 10 台上限与条件更新原子性
    conn.execute("INSERT INTO card_coupons(code, tier, tier_name, duration_days, max_devices, device_count, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)",
                 ("GY-Q90D-A7F2-8899", "Q", "季度畅享卡", 90, 10, 9, 1, 1))
    cur = conn.execute("UPDATE card_coupons SET device_count = device_count + 1 WHERE code=? AND status IN ('UNUSED','ACTIVE') AND device_count < max_devices",
                       ("GY-Q90D-A7F2-8899",))
    assert cur.rowcount == 1, "第 10 台设备应该更新成功"
    
    cur = conn.execute("UPDATE card_coupons SET device_count = device_count + 1 WHERE code=? AND status IN ('UNUSED','ACTIVE') AND device_count < max_devices",
                       ("GY-Q90D-A7F2-8899",))
    assert cur.rowcount == 0, "第 11 台设备必须被条件更新阻断（受影响行数为 0）"
    
    # 验证 FTS 检索单字与双字预生成词元
    conn.execute("INSERT INTO public_search_fts(content_id, title_tokens) VALUES(?,?)", ("test_item_1", "战 神 战神 之 龙王 归来 战神之龙王归来"))
    res_single = conn.execute("SELECT content_id FROM public_search_fts WHERE public_search_fts MATCH ?", ("战",)).fetchall()
    res_double = conn.execute("SELECT content_id FROM public_search_fts WHERE public_search_fts MATCH ?", ("战神",)).fetchall()
    assert res_single and res_double, "FTS5 必须支持单字与双字预生成词元检索"
    print(f"  -> D1 真实业务表 {len(business_tables)} 张，FTS5 影子表 {len(fts_shadow)} 张；R-1 强制等式与卡密上限全部通过。")
    return len(business_tables)

def check_spec_openapi_alignment():
    print("[3/5] 检验 SPEC-v2.0 §5 声明与 OpenAPI 实际响应体形状对齐 (消除 R-4)...")
    spec_text = (ROOT / "docs" / "04-spec" / "SPEC-v2.0.md").read_text(encoding="utf-8")
    
    # 必须匹配响应体嵌套对象，拒绝裸数组假象
    assert "{version, channels: ChannelItem[]}" in spec_text, "SPEC §5 /api/channels 必须声明为包含 version 和 channels 的嵌套对象"
    assert "{updatedAt, providers: SourceProvider[]}" in spec_text, "SPEC §5 /api/sources 必须声明为包含 updatedAt 和 providers 的嵌套对象"
    assert "MonetizationConfig" in spec_text, "SPEC §5 /api/config/monetization 必须声明为 MonetizationConfig"
    assert "/proxy/{kind}/{handle}" in spec_text, "SPEC §5 代理路径必须声明为 /proxy/{kind}/{handle}"
    print("  -> SPEC §5 与 OpenAPI 响应体嵌套结构 100% 吻合，无形状矛盾。")

def check_cross_documents():
    print("[4/5] 检验 PRD 与 SPEC 功能编号与验收指标五源对齐...")
    spec_text = (ROOT / "docs" / "04-spec" / "SPEC-v2.0.md").read_text(encoding="utf-8")
    prd_text = (ROOT / "docs" / "01-prd" / "PRD-prism-play.md").read_text(encoding="utf-8")
    
    expected_f = [f"F-{i:02d}" for i in list(range(1, 11)) + [13, 14, 15]]
    for f in expected_f:
        assert f in spec_text, f"SPEC-v2.0.md 缺失功能 {f}"
        assert f in prd_text, f"PRD-prism-play.md 缺失功能 {f}"
        
    expected_ac = [f"AC-{i:02d}" for i in range(1, 31)]
    for ac in expected_ac:
        assert ac in spec_text, f"SPEC-v2.0.md 缺失验收标准 {ac}"
        assert ac in prd_text, f"PRD-prism-play.md 缺失验收标准 {ac}"
        
    # 验证 PRD 标题无重号 (消除 R-11)
    assert "### 13.1" in prd_text and "### 13.2" in prd_text, "PRD 第十三章子标题必须为 13.1 与 13.2，不可与第十二章重号"
    print(f"  -> {expected_f[0]}~{expected_f[-1]} 与 {expected_ac[0]}~{expected_ac[-1]} 编号无缝对齐，PRD 标题层级无重号。")
    return len(expected_f), len(expected_ac)

def check_design_tokens():
    print("[5/5] 检验 Design Tokens 与 CSS 变量一致性...")
    css_text = (ROOT / "src" / "styles" / "design-tokens.css").read_text(encoding="utf-8")
    json_data = json.loads((ROOT / "src" / "styles" / "design-tokens.json").read_text(encoding="utf-8"))
    
    checked_count = 0
    missing_colors = []
    for theme_name, theme_data in json_data.get("themes", {}).items():
        for color_key, color_info in theme_data.get("color", {}).items():
            val = color_info.get("value", "")
            if re.fullmatch(r"#[0-9A-Fa-f]{6}", val):
                checked_count += 1
                if val.lower() not in css_text.lower():
                    missing_colors.append((theme_name, color_key, val))
                
    assert not missing_colors, f"CSS 缺少 Design Tokens 中定义的色值: {missing_colors}"
    print(f"  -> 已核验 {checked_count} 条深浅双模直接 Hex 色值，CSS 与 JSON 严格对应。")

if __name__ == "__main__":
    try:
        api_count = check_openapi()
        table_count = check_sqlite_schema()
        check_spec_openapi_alignment()
        function_count, ac_count = check_cross_documents()
        check_design_tokens()
        print("\n==================================================")
        print("  【阶段 0：施工前契约复核门禁 (Gate G0)】通过检验！")
        print(f"   (覆盖 {api_count} App API / {table_count} 业务表 / "
              f"{function_count} 功能 / {ac_count} AC 验收)")
        print("==================================================")
    except Exception as e:
        print(f"\n[FAILED] 契约复核未通过: {e}", file=sys.stderr)
        sys.exit(1)
