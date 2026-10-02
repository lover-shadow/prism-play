"""
《光影Play》(Prism Play) 验收标准覆盖矩阵门禁 (Gate G4 证据，AC-01~AC-30)

为什么需要它：SPEC §9 的 30 条 EARS 验收是"合同条款"，而测试套件是散文式清单时极易出现
"某条从没被任何断言碰过"却仍在汇报里被写成已覆盖。本脚本把两侧对齐并让它可机器复核：

  1) AC 编号与名称只从 `docs/04-spec/SPEC-v2.0.md` §9 表格读取（契约是唯一来源，不在本脚本里另立一份）；
  2) 测试侧只承认出现在 `describe(...)` / `it(...)` / `test(...)` **标题**里的 `AC-xx` 标记（标题是 vitest
     报告里会打印的位置，注释里写一百遍 AC 编号不算覆盖），且该用例体内必须真的有断言
     （`expect(` / `assert`），空壳署名同样判红；
  3) AC-02 的六个子条款按 SPEC 单元格里的编号逐条要求，缺一条即红；
  4) 测试里出现 SPEC §9 不存在的 AC 编号 → 红（防止端侧自造验收口径）；
  5) 性能与原生效果类条款打印"逻辑已测 / 指标待真机"两列，绝不把 jsdom 结果说成真机实测（SPEC §10）。

本门禁证明的是"每条验收都有署名断言"，不证明语义完备——后者仍需监理人工复核。
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent

# 真机才可能定量的条款：逻辑侧有用例，指标/效果侧必须实测。
DEVICE_ONLY = {
    "AC-01": "首屏 ≤1.2s 需带机型与网络实测",
    "AC-03": "起播 ≤800ms 需带机型与网络实测",
    "AC-10": "ForegroundService 息屏保活与通知栏需真机",
    "AC-11": "真实来电三前置条件与焦点恢复需真机",
    "AC-02-4": "FLAG_SECURE 实际防截屏效果需真机（端侧调用已测）",
    "AC-18": "LRU 与断电原子性需真机（编排逻辑已测）",
    "AC-19": "舞台铺满与底片填充的实际观感需真机（状态机与样式已测）",
    "AC-20": "ScreenOrientation 真机旋转效果需实测（锁定调用与解锁时序已测）",
    "AC-21": "系统返回键与侧滑手势需真机（级联调度逻辑已测）",
    "AC-22": "跨构建 SHA-256 恒定需由 CI 两次出包比对（配置绑定已测）",
    "AC-24": "局域网设备发现与大屏播放需真机同网段（SSDP/SOAP 报文构造已测）",
    "AC-25": "顶栏垂直居中与上提 ≥40px 需真机像素实测（结构与样式权威已测）",
    "AC-26": "胶囊视觉 28px / 命中 44px 需真机可点击区域实测（token 与样式已测）",
    "AC-27": "TabBar 实宽 ≤360px 需真机实测（限宽样式已测）",
    "AC-28": "单块 ≤2ms 耗时需在真机档位复测（块结构与零重排在单测中定量断言）",
    "AC-30": "挂起被冻结时的补传与多端秒级续播需真机（队列与合并逻辑已测）",
}

AC_ROW = re.compile(r"^\|\s*\*\*(AC-\d{2})\*\*\s*\|(.+?)\|\s*P(\d)\s*\|\s*$", re.MULTILINE)
AC_REF = re.compile(r"\bAC-\d{2}(?:-\d)?\b")
TITLE = re.compile(r"""^\s*(it|test|describe)(?:\.\w+)?\(\s*(['"`])(.+?)\2""", re.MULTILINE | re.DOTALL)
ASSERTION = re.compile(r"\b(?:expect\(|assert\(|\.toBe|\.toEqual|\.toContain|\.toMatch|\.toHaveLength)")
AC_TOTAL = 30


def spec_acceptance():
    """返回 [(编号, 优先级, 子条款数, 名称)]，名称取 EARS 句的前若干字，仅供报表可读。"""
    text = (ROOT / "docs" / "04-spec" / "SPEC-v2.0.md").read_text(encoding="utf-8")
    section = text.split("## 9.")[1].split("## 10.")[0]
    rows = []
    for match in AC_ROW.finditer(section):
        ac_id, body, priority = match.group(1), match.group(2), match.group(3)
        clauses = len(re.findall(r"^\s*(\d+)\.\s", body.replace("<br>", "\n"), re.MULTILINE))
        name = re.sub(r"\*\*", "", body).replace("<br>", " / ").strip()
        rows.append((ac_id, priority, clauses, name[:46]))
    return rows


def titled_clauses():
    """扫描测试文件，收集 (AC 标记, 文件, 用例标题, 该作用域内是否有断言)。

    作用域口径：`it/test` 只看自己那一段（到下一条 it/test 为止），防止"蹭别人的断言"；
    `describe` 看它之后的全文，因为套件标题的断言天然分布在它的各条用例里。
    """
    found = []
    for path in sorted((ROOT / "tests").rglob("*.ts")):
        rel = path.relative_to(ROOT).as_posix()
        source = path.read_text(encoding="utf-8")
        titles = list(TITLE.finditer(source))
        for index, match in enumerate(titles):
            kind = match.group(1)
            title = " ".join(match.group(3).split())
            start = match.end()
            if kind == "describe":
                body = source[start:]
            else:
                nxt = next((item for item in titles[index + 1:] if item.group(1) != "describe"), None)
                body = source[start:nxt.start() if nxt else len(source)]
            for marker in AC_REF.findall(title):
                found.append((marker, rel, title, ASSERTION.search(body) is not None))
    return found


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    rows = spec_acceptance()
    if len(rows) != AC_TOTAL:
        print(f"[FAIL] SPEC §9 解析到 {len(rows)} 条验收，预期 {AC_TOTAL} 条：口径变更需同步本门禁")
        return 1
    hits = titled_clauses()

    print("【AC 覆盖矩阵】SPEC §9 为唯一编号来源，测试标题为署名来源")
    print("=" * 78)
    problems = []
    used = set()
    for ac_id, priority, clauses, name in rows:
        own = [hit for hit in hits if hit[0] == ac_id or hit[0].startswith(f"{ac_id}-")]
        for hit in own:
            used.add(hit[0])
        if not own:
            problems.append(f"{ac_id} 零覆盖：没有任何用例标题署名它")
            print(f"  [FAIL] {ac_id} (P{priority}) {name}")
            continue
        silent = [hit for hit in own if not hit[3]]
        if silent:
            problems.append(f"{ac_id} 有署名用例但体内无断言：{silent[0][2]}")
        files = sorted({hit[1] for hit in own})
        tail = "；真机待测：" + DEVICE_ONLY[ac_id] if ac_id in DEVICE_ONLY else ""
        print(f"  [ OK ] {ac_id} (P{priority}) 断言用例 {len(own)} 条 · {len(files)} 文件{tail}")
        for rel in files:
            print(f"           - {rel}")

    # AC-02 子条款必须逐条署名：它是全项目唯一的"合规生死线"，整条命中不足以证明六条都在。
    cell = next(row for row in rows if row[0] == "AC-02")
    for index in range(1, cell[2] + 1):
        marker = f"AC-02-{index}"
        if not any(hit[0] == marker for hit in hits):
            problems.append(f"{marker} 零覆盖：AC-02 第 {index} 子条款无署名用例")

    invented = sorted({hit[0] for hit in hits} - used - {row[0] for row in rows})
    if invented:
        problems.append(f"测试里出现 SPEC §9 不存在的验收编号：{', '.join(invented)}")

    print("=" * 78)
    if problems:
        print(f"  【未通过】{len(problems)} 项覆盖缺口")
        for problem in problems:
            print(f"    - {problem}")
        return 1
    print(f"  【通过】{AC_TOTAL}/{AC_TOTAL} 条验收均有署名断言，AC-02 六子条款逐条到位，"
          f"共 {len(hits)} 条署名用例；未实测项已在矩阵中标注，不得转写为已通过。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
