/**
 * AC-22 永久签名覆盖安装（SPEC §1.3 / 二合一正本 WP1）。
 *
 * 本机没有 JDK，跑不了 `keytool`，也解不开 PKCS12；因此这里断言的是**签名的绑定关系**——
 * 密钥库在不在工程的固定位置、两种构建类型是否都绑到同一份配置、以及那条会让机制静默失效的
 * `.gitignore` 守卫。真正的"跨构建指纹恒定"只能由 GitHub Actions 两次出包后复算比对来证明
 * （见 `verify_acceptance.py` 的 AC-22 DEVICE_ONLY 条目），不许把本文件的绿色当成那个结论。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const readSource = (relative: string): string => {
  let directory = process.cwd();
  for (let depth = 0; depth < 5; depth += 1) {
    const candidate = join(directory, relative);
    if (existsSync(candidate)) return readFileSync(candidate, 'utf8');
    directory = dirname(directory);
  }
  throw new Error(`找不到正本 ${relative}`);
};

const rootOf = (relative: string): string => {
  let directory = process.cwd();
  for (let depth = 0; depth < 5; depth += 1) {
    const candidate = join(directory, relative);
    if (existsSync(candidate)) return candidate;
    directory = dirname(directory);
  }
  throw new Error(`找不到资产 ${relative}`);
};

const gradle = readSource('android/app/build.gradle');
const gitignore = readSource('android/.gitignore');
const facts = readSource('docs/02-architecture/GITHUB-DEVOPS-FACTS.md');

describe('AC-22 签名资产与构建绑定', () => {
  it('AC-22 密钥库作为工程资产存在于固定位置，且不依赖任何临时环境', () => {
    const store = rootOf('android/app/debug.keystore');
    // 路径就是契约：SPEC §1.3 的命令把它生成在 `android/app/debug.keystore`，`build.gradle` 也按这个名字引用。
    expect(store.replace(/\\/g, '/')).toMatch(/android\/app\/debug\.keystore$/);
    // 空文件或占位文件会让构建期才炸；RSA 2048 的 PKCS12 体积在千字节级。
    expect(statSync(store).size).toBeGreaterThan(1024);
  });

  it('AC-22 debug 与 release 两种构建类型都绑定同一份 signingConfigs.debug', () => {
    const block = gradle.match(/signingConfigs\s*\{([\s\S]*?)\n    \}/)?.[1] ?? '';
    expect(block).toContain("storeFile file('debug.keystore')");
    expect(block).toContain("keyAlias 'androiddebugkey'");
    expect(block).toContain("storeType 'pkcs12'");
    // 口令写死是 §1.3 的唯一正本命令，不是随手填的：改成读环境变量就等于把恒定交还给构建机。
    expect(block).toContain("storePassword 'android'");
    expect(gradle.match(/signingConfig signingConfigs\.debug/g)).toHaveLength(2);
    // 任何一份 release 走外部凭据都会让指纹重新漂移。
    expect(gradle).not.toMatch(/signingConfigs\s*\{\s*release/);
  });

  it('AC-22 .gitignore 的 `*.keystore` 必须仍是注释状态，否则机制静默失效而 CI 不报错', () => {
    const lines = gitignore.split(/\r?\n/);
    const keystoreRules = lines.filter((line) => line.includes('.keystore'));
    expect(keystoreRules.length).toBeGreaterThan(0);
    // 活规则（不以 # 开头）会让密钥库不再入库 → 构建机各自生成 → 覆盖安装重新报 -7。
    expect(keystoreRules.every((line) => line.trimStart().startsWith('#'))).toBe(true);
  });

  it('AC-22 指纹基线以 32 组冒号分隔十六进制记录在 DevOps 事实册里', () => {
    // 门禁不自己抄一份指纹：唯一权威是事实册，本用例只校验它的形状，防的是"表里空着"而不是"表里写错"。
    const baseline = facts.match(/`?([0-9A-F]{2}:){31}[0-9A-F]{2}`?/);
    expect(baseline).not.toBeNull();
    expect(facts).toMatch(/指纹基线/);
    expect(facts).toMatch(/静默失效/);
  });
});
