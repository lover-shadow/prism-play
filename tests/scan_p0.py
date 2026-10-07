"""
《光影Play》(Prism Play) P0 工程红线静态扫描器 (Gate G3/G4 门禁证据)

扫描口径来自 AGENTS.md 与 SPEC-v2.0.md 第八章 / 指令包第〇章：
  P0-1  严禁 emoji 表情作为功能图标（统一 Lucide 2px SVG，16/20/24px）
  P0-2  严禁紫色→粉色渐变主视觉（主强调色锁定琥珀金 #E5A93C）
  P0-3  严禁裸 Hex 颜色代码与 AI 模板味（前端 100% 消费 design-tokens.css）
  M-5   严禁任何 Workers AI / Vectorize / 向量检索代码
  §10   单文件 ≤ 300 行（生成契约与迁移文件除外）
"""
import re
import sys
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent

SCAN_DIRS = ["src", "edge/src", "android", "tests", "."]
SCAN_SUFFIXES = {".ts", ".tsx", ".js", ".mjs", ".cjs", ".css", ".html", ".vue", ".svelte", ".java", ".kt", ".xml"}
SKIP_NAMES = {"node_modules", "dist", "build", ".git", ".workbuddy", ".wrangler", "docs", "coverage"}
# `npx cap sync android` 会把 dist/ 逐字节拷进 app/src/main/assets/public；那是一份构建产物，
# 与 SKIP_NAMES 里的 dist/build 同类，不应被当作业务源码判定（否则第三方 bundle 的色值会冒充我们的红线）。
SKIP_PATH_PREFIXES = ("android/app/src/main/assets/",)
# 唯一允许出现裸 Hex 的真相源；SPEC §8 与 design-tokens.json 同源。
HEX_ALLOWED = {"design-tokens.css", "design-tokens.json"}
# 自适应启动图标底色（Android 资源层没有 CSS 变量这种机制，颜色只能落在 colors 资源里）。
# 允许它出现裸 Hex 的前提是 tests/verify_android_assets.py 会断言该值 ∈ design-tokens.json，
# 即"原生侧同样只有一个颜色真相源"；换品牌图标时必须连同本豁免一起评审。
HEX_ALLOWED_ANDROID = {"ic_launcher_background.xml"}
# 边缘直出的分享/下载 H5 按 SPEC §10「不引入站点级 CSS/JS 资产」必须内联样式，
# 因此允许裸 Hex —— 但必须配一条与 src/styles/design-tokens.json 逐值对账的测试，
# 否则此处就是紫粉渐变与色值漂移的逃生门。
HEX_ALLOWED_DIRS = {"edge/src/html"}
# 扫描器自身必然包含被禁词的正则字面量，不参与业务代码判定。
SELF_EXCLUDED = {"scan_p0.py", "verify_contracts.py"}
LONG_FILE_ALLOWED = {
    "0001_initial_schema.sql",  # 迁移正本
    "openapi.yaml",             # 机读契约
    # SPEC §10 允许"生成契约文件"例外；design-tokens.css 与 design-tokens.json 同源，
    # 属权威设计资产，由文档主理 Agent 维护，施工方不得为凑行数拆分。
    "design-tokens.css",
}

HEX_COLOR = re.compile(r"#[0-9A-Fa-f]{3,8}\b")
GRADIENT = re.compile(r"(linear-gradient|radial-gradient|conic-gradient)\s*\(([^)]*)\)", re.IGNORECASE)
NAMED_PURPLE = re.compile(r"\b(purple|violet|fuchsia|magenta|orchid)\b", re.IGNORECASE)

# M-5：本期彻底不做语义检索与大模型。
# `embedding` 只有在与模型/向量语境相邻时才是违规信号；HTML 转义里 "safe embedding of a value"
# 属正常术语，裸匹配会产生误报并诱使人把真规则调松。
AI_TERMS = re.compile(
    r"(workers[\s_-]?ai|vectorize|bge[\s_-]?m3|knowledge[\s_-]?graph|语义检索|向量|"
    r"(?:text|query|document|content|semantic|feature)[\s_-]?embeddings?|"
    r"embeddings?[\s_-]?(?:model|vector|store|search|index)|向量(?:检索|库|索引|嵌入))",
    re.IGNORECASE,
)

# P0-1：emoji 与装饰性 pictographic 码位（不含中文与常规标点）。
EMOJI_RANGES = (
    (0x1F000, 0x1FAFF),
    (0x2600, 0x27BF),
    (0x2B00, 0x2BFF),
    (0xFE0F, 0xFE0F),
    (0x1F1E6, 0x1F1FF),
)


def is_emoji(ch: str) -> bool:
    code = ord(ch)
    return any(lo <= code <= hi for lo, hi in EMOJI_RANGES)


def hue_of(hex_value: str):
    """Return the purple->pink hue window in degrees, or None when it is greyscale."""
    digits = hex_value.lstrip("#")
    if len(digits) in (3, 4):
        digits = "".join(c * 2 for c in digits[:3])
    if len(digits) < 6:
        return None
    try:
        r, g, b = (int(digits[i : i + 2], 16) / 255 for i in (0, 2, 4))
    except ValueError:
        return None
    top, bottom = max(r, g, b), min(r, g, b)
    delta = top - bottom
    if delta == 0:
        return None
    if top == r:
        hue = ((g - b) / delta) % 6
    elif top == g:
        hue = (b - r) / delta + 2
    else:
        hue = (r - g) / delta + 4
    return round(hue * 60)


def in_purple_pink_band(hue) -> bool:
    # 紫 260°→粉 335°：AGENTS.md P0-2 明令禁止的主视觉区间。
    return hue is not None and 260 <= hue <= 335


def iter_files():
    seen = set()
    for base in SCAN_DIRS:
        root = ROOT / base
        if not root.exists():
            continue
        for path in root.rglob("*"):
            if not path.is_file():
                continue
            if any(part in SKIP_NAMES for part in path.parts):
                continue
            if path.relative_to(ROOT).as_posix().startswith(SKIP_PATH_PREFIXES):
                continue
            if path.name in SELF_EXCLUDED:
                continue
            if path.suffix not in SCAN_SUFFIXES and path.name not in {"vite.config.ts", "capacitor.config.ts"}:
                continue
            resolved = path.resolve()
            if resolved in seen:
                continue
            seen.add(resolved)
            yield path


def hex_allowed_for(rel: str) -> bool:
    name = rel.rsplit("/", 1)[-1]
    if name in HEX_ALLOWED:
        return True
    if name in HEX_ALLOWED_ANDROID and rel.startswith("android/"):
        return True
    return any(rel.startswith(f"{directory}/") for directory in HEX_ALLOWED_DIRS)


def scan():
    findings = []
    scanned = 0
    for path in iter_files():
        rel = path.relative_to(ROOT).as_posix()
        if path.name in LONG_FILE_ALLOWED:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, PermissionError):
            continue
        scanned += 1
        lines = text.splitlines()

        if not hex_allowed_for(rel):
            for number, line in enumerate(lines, 1):
                if HEX_COLOR.search(line):
                    findings.append(("P0-3 裸 Hex 颜色", f"{rel}:{number}", line.strip()))

        for number, line in enumerate(lines, 1):
            for match in GRADIENT.finditer(line):
                hues = [hue_of(value) for value in HEX_COLOR.findall(match.group(2))]
                if any(in_purple_pink_band(hue) for hue in hues) or NAMED_PURPLE.search(match.group(0)):
                    if not (path.name in HEX_ALLOWED and "accent" in line.lower()):
                        findings.append(("P0-2 紫粉渐变", f"{rel}:{number}", line.strip()))

        for number, line in enumerate(lines, 1):
            if AI_TERMS.search(line):
                findings.append(("M-5 禁用 AI/向量", f"{rel}:{number}", line.strip()))

        for number, line in enumerate(lines, 1):
            hit = [ch for ch in line if is_emoji(ch)]
            if hit:
                findings.append(("P0-1 emoji 图标", f"{rel}:{number}", "".join(hit)))

        if len(lines) > 300:
            findings.append(("§10 单文件超 300 行", rel, f"{len(lines)} 行"))

    return scanned, findings


def main() -> int:
    # Gate evidence is pasted into the supervision report; force UTF-8 so Windows GBK consoles
    # do not turn the Chinese findings into unreadable bytes.
    sys.stdout.reconfigure(encoding="utf-8")
    print("【P0 工程红线扫描】范围：src / edge/src / android / tests + 根配置")
    scanned, findings = scan()
    print(f"  已扫描文件：{scanned} 个")
    buckets = {}
    for rule, where, snippet in findings:
        buckets.setdefault(rule, []).append((where, snippet))

    if not buckets:
        print("  -> P0-1 零 emoji、P0-2 零紫粉渐变、P0-3 零裸 Hex、M-5 零 AI/向量、§10 零超长文件：全部通过")
        return 0

    for rule, items in buckets.items():
        print(f"\n[FAIL] {rule}：{len(items)} 处")
        for where, snippet in items[:20]:
            print(f"    {where} :: {snippet[:140]}")
    print("\n==================================================")
    print("  【P0 红线】未通过，禁止进入 Gate 验收")
    print("==================================================")
    return 1


if __name__ == "__main__":
    sys.exit(main())
