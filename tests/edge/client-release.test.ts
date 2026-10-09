import { describe, expect, it } from 'vitest';
// @ts-ignore Node publishing script is executed without a TypeScript build.
import { runPreflight } from '../../edge/scripts/publish-client-release.mjs';

const apk = 'build/apk265/prism-play-v2.6.5-client-feedback-acceptance-20261008.apk';
describe('AC-OPT-12 release preflight uses actual APK metadata', () => {
  it('does not relabel the previous APK as a new version', () => {
    const result = runPreflight(apk);
    expect(result.versionCode).toBe(21605);
    expect(result.versionName).toBe('2.6.5');
    expect(result.artifact.key).toContain('/21605/');
  }, 30000);
  it('refuses expected version mismatches rather than inventing a new Code', () => {
    expect(() => runPreflight(apk, { versionCode: 21606 })).toThrow(/versionCode/);
  }, 30000);
});
