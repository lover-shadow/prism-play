"""
《光影Play》(Prism Play) Android 工程静态一致性门禁 (Gate G4 证据)

为什么需要它：本机没有 JDK / Android SDK / Gradle，`./gradlew assembleDebug` 只能在 GitHub Actions
里跑。等 CI 报错再回修，代价是每轮几分钟且错误信息埋在日志里；而 APK 构建失败最常见的几类原因
——资源引用不存在、R 引用对不上、插件工程目录缺失、Gradle wrapper 残缺——全都是**纯静态事实**，
可以在本地用字符串/文件存在性判定提前拦下。

本门禁检查（全部只读、不执行任何构建）：
  1) AndroidManifest 里的 @xml/@string/@style/@drawable/@mipmap 引用都能在 res/ 找到；
  2) Java 源码里的 R.<type>.<name> 引用都能在 res/ 找到（AAPT2 会因此报错的那一类）；
  3) values/*.xml 内不存在重名资源（同一模块两个 res 目录合并后最容易出的错）；
  4) capacitor.settings.gradle 里每个 projectDir 真实存在（少装一个插件包 = 配置阶段即失败）；
  5) Gradle wrapper 四件套齐全且 distributionUrl 指向预期版本（CI 靠它自举 Gradle）；
  6) 我们自己的 Capacitor 插件名在 Java 注解与 TypeScript 常量之间逐字一致（PrismNative / PrismCast 两个）；
  7) 清单里声明了 Java 侧会启动的组件与权限（前台服务、来电接收器、AC-24 的组播权限），app 模块插件
     确实在 MainActivity 里 registerPlugin，且 H1 的前提——明文策略未放宽——在清单与 security config 上都还成立。

它证明的是"配置自洽"，不证明"能编译通过"——后者只有 CI 的 assembleDebug 才是证据。
"""
import pathlib
import re
import sys
import xml.etree.ElementTree as ET

ROOT = pathlib.Path(__file__).resolve().parent.parent
APP = ROOT / "android" / "app" / "src" / "main"
RES = APP / "res"
JAVA = APP / "java"

MANIFEST = APP / "AndroidManifest.xml"
MANIFEST_REF = re.compile(r"@(xml|string|style|drawable|mipmap|layout)/([A-Za-z_0-9.]+)")
JAVA_REF = re.compile(r"\bR\.(string|drawable|mipmap|layout|id|xml)\.([A-Za-z_0-9]+)")
PROJECT_DIR = re.compile(r"projectDir = new File\('([^']+)'\)")
WRAPPER_EXPECTED = "gradle-8.11.1-all.zip"


def resource_files(kind: str, name: str):
    """在 res/ 下按资源类型找候选文件；values 类资源走 XML 声明。"""
    if kind in {"string", "style"}:
        hits = []
        for values in RES.glob("values*/**/*.xml"):
            text = values.read_text(encoding="utf-8")
            if re.search(rf'<(?:string|style)\s+name="{re.escape(name)}"', text):
                hits.append(values)
        return hits
    candidates = []
    for folder in RES.glob(f"{kind}*"):
        for suffix in ("xml", "png", "webp", "jpg"):
            candidate = folder / f"{name}.{suffix}"
            if candidate.exists():
                candidates.append(candidate)
    return candidates


def check_manifest_refs(problems, checked):
    text = MANIFEST.read_text(encoding="utf-8")
    for kind, name in MANIFEST_REF.findall(text):
        checked.append(f"{kind}/{name}")
        if name.startswith("android:"):
            continue
        if not resource_files(kind, name):
            problems.append(f"AndroidManifest 引用了不存在的资源 @{kind}/{name}")


def check_java_refs(problems, checked):
    for java in JAVA.rglob("*.java"):
        source = java.read_text(encoding="utf-8")
        for kind, name in JAVA_REF.findall(source):
            checked.append(f"R.{kind}/{name}")
            if kind == "id":  # id 由布局生成，本工程不使用 R.id
                continue
            if not resource_files(kind, name):
                problems.append(f"{java.relative_to(ROOT).as_posix()} 引用了不存在的 R.{kind}.{name}")


def check_duplicate_resources(problems):
    seen = {}
    for values in RES.glob("values*/**/*.xml"):
        text = values.read_text(encoding="utf-8")
        for kind, name in re.findall(r'<(string|style|color|dimen|integer)\s+name="([A-Za-z_0-9.]+)"', text):
            key = f"{kind}/{name}"
            if key in seen:
                problems.append(f"资源重名 {key}：{seen[key].name} 与 {values.name}")
            seen[key] = values


def check_plugin_projects(problems, checked):
    settings = (ROOT / "android" / "capacitor.settings.gradle").read_text(encoding="utf-8")
    for relative in PROJECT_DIR.findall(settings):
        checked.append(relative)
        target = (ROOT / "android" / relative).resolve()
        if not target.exists():
            problems.append(f"capacitor.settings.gradle 指向的工程目录不存在：{relative}")


def check_wrapper(problems, checked):
    for name in ("gradlew", "gradlew.bat", "gradle/wrapper/gradle-wrapper.jar", "gradle/wrapper/gradle-wrapper.properties"):
        path = ROOT / "android" / name
        checked.append(name)
        if not path.exists():
            problems.append(f"Gradle wrapper 缺件：android/{name}")
    properties = ROOT / "android" / "gradle" / "wrapper" / "gradle-wrapper.properties"
    if properties.exists() and not re.search(r"gradle-8\.11\.1-(?:all|bin)\.zip", properties.read_text(encoding="utf-8")):
        problems.append(f"gradle-wrapper.properties 未指向 gradle-8.11.1-(all|bin).zip")


def compare_plugin_name(ts_file: str, ts_constant: str, java_file: str, problems, checked):
    """单个插件的名字对账：注解里既可能是字面量，也可能引用同文件常量（本工程两处都是后者）。"""
    ts = (ROOT / ts_file).read_text(encoding="utf-8")
    ts_name = re.search(rf"{ts_constant}\s*=\s*'([^']+)'", ts)
    java = (JAVA / "org" / "prismos" / "play" / java_file).read_text(encoding="utf-8")
    literal = re.search(r'@CapacitorPlugin\(\s*name\s*=\s*"([^"]+)"', java)
    reference = re.search(r"@CapacitorPlugin\(\s*name\s*=\s*(?:\w+\.)?(\w+)", java)
    java_name = None
    if literal is not None:
        java_name = literal.group(1)
    elif reference is not None:
        constant = re.search(rf'String\s+{reference.group(1)}\s*=\s*"([^"]+)"', java)
        java_name = constant.group(1) if constant is not None else None
    checked.append(f"plugin={ts_name and ts_name.group(1)}")
    if ts_name is None or java_name is None or ts_name.group(1) != java_name:
        problems.append(
            f"插件名不一致（{java_file}）：TS={ts_name and ts_name.group(1)} Java={java_name}"
        )
    return java_name


def check_plugin_name(problems, checked):
    """插件名必须逐字一致，否则 JS 侧 registerPlugin 拿到的是空实现（调用静默失效）。

    两个插件都在 app 模块内注册，因此都不出现在 capacitor.plugins.json（那文件只承载 npm 侧插件），
    两侧名字的一致性只能靠这条断言来守：AC-10/AC-11 的 PrismNative 与 AC-24 的 PrismCast。
    """
    compare_plugin_name("src/core/native/bridge.ts", "PRISM_NATIVE_PLUGIN", "PrismNativePlugin.java", problems, checked)
    compare_plugin_name("src/core/native/cast.ts", "PRISM_CAST_PLUGIN", "PrismCastPlugin.java", problems, checked)


def check_components_declared(problems, checked):
    manifest = MANIFEST.read_text(encoding="utf-8")
    for component in ("PlaybackService", "CallStateReceiver", "MainActivity"):
        checked.append(component)
        if f'android:name=".{component}"' not in manifest:
            problems.append(f"清单未声明 Java 侧会用到的组件：{component}")
    for permission in ("FOREGROUND_SERVICE_MEDIA_PLAYBACK", "POST_NOTIFICATIONS", "READ_PHONE_STATE",
                       "CHANGE_WIFI_MULTICAST_STATE"):
        checked.append(permission)
        if permission not in manifest:
            problems.append(f"清单缺少 AC-10/AC-11/AC-24 依赖的权限：{permission}")
    # 组播权限只是必要条件的一半：MulticastLock 必须在扫描期持有、结束即释放，且明文策略不得因此被放宽。
    # 这两条都是清单级静态事实，放在本门禁比放在真机 checklist 上更早、也更难被悄悄改掉。
    activity = (APP / "java" / "org" / "prismos" / "play" / "MainActivity.java").read_text(encoding="utf-8")
    for plugin_class in ("PrismNativePlugin.class", "PrismCastPlugin.class"):
        checked.append(plugin_class)
        if f"registerPlugin({plugin_class})" not in activity:
            problems.append(f"MainActivity 未注册 app 模块插件：{plugin_class}（Bridge 拿不到实现，调用静默失效）")
    if 'android:usesCleartextTraffic="false"' not in manifest:
        problems.append("清单的 usesCleartextTraffic 必须保持 false：AC-24 的 H1 是裸 socket 方案，不靠放宽明文策略")
    security = (RES / "xml" / "network_security_config.xml").read_text(encoding="utf-8")
    if 'cleartextTrafficPermitted="false"' not in security:
        problems.append("network_security_config 的 base-config 必须保持 cleartextTrafficPermitted=\"false\"")


def check_color_tokens(problems, checked):
    """原生资源里的颜色必须能在 design-tokens.json 里找到——Android 资源层没有 CSS 变量，
    颜色只能写字面量，因此"单源"要靠本断言而不是靠自觉。"""
    tokens = (ROOT / "src" / "styles" / "design-tokens.json").read_text(encoding="utf-8")
    allowed = {literal.lower() for literal in re.findall(r"#[0-9A-Fa-f]{3,8}\b", tokens)}
    for values in RES.glob("values*/**/*.xml"):
        for literal in re.findall(r"#[0-9A-Fa-f]{3,8}\b", values.read_text(encoding="utf-8")):
            checked.append(f"{values.name}:{literal}")
            if literal.lower() not in allowed:
                problems.append(f"{values.name} 的颜色 {literal} 不在 design-tokens.json 中（原生侧同样只允许一个颜色真相源）")


def check_backup_allowlist(problems, checked):
    """精确白名单：历史库及旁文件 + 默认偏好，其他域不得进入备份。"""
    history = "prism_localSQLite.db"
    expected = {("database", history + suffix) for suffix in ("", "-wal", "-shm", "-journal")}
    expected.add(("sharedpref", "CapacitorStorage.xml"))
    required_excludes = {
        ("sharedpref", "prism_credentials_encrypted.xml"),
        ("sharedpref", "__androidx_security_master_key_.xml"),
        ("database", "prism_catalog.db"),
        ("database", "prism_catalog.db-wal"),
        ("database", "prism_catalog.db-journal"),
        ("root", "cache"), ("file", "cache"), ("file", "cache/posters"),
    }
    for name in ("backup_rules.xml", "data_extraction_rules.xml"):
        try:
            root = ET.parse(RES / "xml" / name).getroot()
        except (OSError, ET.ParseError) as error:
            problems.append(f"备份规则不可读取 {name}: {error}")
            continue
        sections = [root] if name == "backup_rules.xml" else [root.find(tag) for tag in ("cloud-backup", "device-transfer")]
        for section in sections:
            if section is None:
                problems.append(f"{name} 缺少独立备份/迁移策略")
                continue
            label = f"{name}:{section.tag}"
            checked.append(label)
            includes = [(node.get("domain"), node.get("path")) for node in section.findall("include")]
            excludes = {(node.get("domain"), node.get("path")) for node in section.findall("exclude")}
            if set(includes) != expected or len(includes) != len(expected):
                problems.append(f"{label} 必须仅包含 {history} 及 wal/shm/journal 和 CapacitorStorage.xml，实际为 {includes}")
            required = required_excludes | ({("root", "code_cache")} if section is not root else set())
            if not required <= excludes or expected & excludes:
                problems.append(f"{label} 排除项缺失或误排历史/偏好：{required - excludes}")


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    problems: list[str] = []
    checked: list[str] = []
    if not MANIFEST.exists():
        print("[FAIL] 未找到 android/app/src/main/AndroidManifest.xml：Android 工程尚未成型")
        return 1
    check_manifest_refs(problems, checked)
    check_java_refs(problems, checked)
    check_duplicate_resources(problems)
    check_plugin_projects(problems, checked)
    check_wrapper(problems, checked)
    check_plugin_name(problems, checked)
    check_components_declared(problems, checked)
    check_color_tokens(problems, checked)
    check_backup_allowlist(problems, checked)

    print("【Android 工程静态一致性】清单/资源/R 引用/插件工程/Wrapper/组件声明")
    print("=" * 74)
    print(f"  已核验条目：{len(checked)}；涉及 res 文件 {len(list(RES.rglob('*.*')))} 个")
    if problems:
        print(f"  【未通过】{len(problems)} 项：")
        for problem in problems:
            print(f"    - {problem}")
        return 1
    print("  【通过】引用自洽、插件工程齐备、wrapper 完整、组件与权限声明到位。")
    print("  注意：本门禁不执行编译；能否出 APK 由 GitHub Actions 的 assembleDebug 说了算。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
