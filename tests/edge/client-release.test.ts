import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
// @ts-ignore Node publishing script is executed without a TypeScript build.
import { parseAaptBadging, runPreflight } from '../../edge/scripts/publish-client-release.mjs';

/**
 * AC-OPT-12 隔离夹具（与 merge-s1 的 CI 修复同款纪律）：干净 Linux runner 没有本机验收包与
 * Android 工具链（build/ 不进版本库），因此用临时文件充当 APK、注入解析器模拟 aapt 结果，
 * 验证预检始终以"解析到的实际元数据"为准、绝不放宽版本判定。真实 aapt/apksigner 解析链路
 * 由发布流水线本体在真实发布时验证（见 RELEASE-SOP-AND-PIPELINE）。
 */
const dir = mkdtempSync(path.join(tmpdir(), 'client-release-fixture-'));
const apk = path.join(dir, 'fixture.apk');
writeFileSync(apk, Buffer.from('isolated apk fixture for AC-OPT-12'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const badging21605 = "package: name='org.prismos.play' versionCode='21605' versionName='2.6.5' platformBuildVersionName='15'";
const inspected = {
  ...parseAaptBadging(badging21605),
  signature: 'fixture',
  seed: { revision: 4, items: 21963, private: false }
};

describe('AC-OPT-12 release preflight uses actual APK metadata', () => {
  it('parses version metadata from aapt badging output and refuses foreign or probe identities', () => {
    expect(parseAaptBadging(badging21605)).toEqual({ versionCode: 21605, versionName: '2.6.5' });
    expect(() => parseAaptBadging("package: name='org.example.other' versionCode='1' versionName='1.0'")).toThrow(/identity/);
    expect(() => parseAaptBadging("package: name='org.prismos.play' versionCode='21606' versionName='2.6.6-probe'")).toThrow(/identity/);
  });
  it('does not relabel the previous APK as a new version', () => {
    const result = runPreflight(apk, { inspect: () => inspected });
    expect(result.versionCode).toBe(21605);
    expect(result.versionName).toBe('2.6.5');
    expect(result.artifact.key).toContain('/21605/');
  });
  it('refuses expected version mismatches rather than inventing a new Code', () => {
    expect(() => runPreflight(apk, { inspect: () => inspected, versionCode: 21606 })).toThrow(/versionCode/);
  });
});
