import { describe, expect, it } from 'vitest';
import { handleApkArtifact, handleApkDownload, type DlEnv } from '../../edge/src/routes/dl';
import { handleVersion } from '../../edge/src/routes/version';

const hash = 'a'.repeat(64), code = 21606, name = '2.6.6';
const key = `releases/android/${code}/${hash}.apk`;
const origin = 'https://play.prismos.org', artifactUrl = `${origin}/dl/artifacts/${code}/${hash}.apk`;
const bytes = new Uint8Array([80, 75, 3, 4, 1, 2]);
const release = { android: { versionCode: code, versionName: name, downloadUrl: `${origin}/dl/latest/android`, force: false,
  artifact: { key, sha256: hash, bytes: bytes.length } } };
const clock = { nowSeconds: () => 1000, nowMillis: () => 1000000 };
function env(metadata = { sha256: hash, versionCode: String(code), versionName: name }): DlEnv {
  return { KV: { get: async () => JSON.stringify(release) }, APK_BUCKET: {
    head: async (k: string) => k === key ? { key, size: bytes.length, customMetadata: metadata } : null,
    get: async (k: string) => k === key ? { key, size: bytes.length, body: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }) } : null
  } } as unknown as DlEnv;
}
describe('MIN-04/06 correct same-origin APK delivery', () => {
  it('latest points at the declared verified same-origin artifact without an external base', async () => {
    const response = await handleApkDownload(new Request(`${origin}/dl/latest/android`), env(), clock);
    expect(response.status).toBe(302); expect(response.headers.get('Location')).toBe(artifactUrl);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const version = await (await handleVersion(new Request(`${origin}/api/version`), env(), clock)).json() as typeof release;
    expect(version.android.artifact).toEqual(release.android.artifact);
  });
  it('does not download a mismatched object or an absent artifact descriptor', async () => {
    expect((await handleApkDownload(new Request(`${origin}/dl/latest/android`), env({ sha256: 'b'.repeat(64), versionCode: String(code), versionName: name }), clock)).status).toBe(503);
    const missing = env(); missing.KV = { get: async () => JSON.stringify({ android: { ...release.android, artifact: undefined } }) } as unknown as KVNamespace;
    expect((await handleApkDownload(new Request(`${origin}/dl/latest/android`), missing, clock)).status).toBe(503);
  });
  it('GET streams the complete bytes and does not promise partial downloads', async () => {
    const response = await handleApkArtifact(new Request(artifactUrl, { headers: { Range: 'bytes=0-3' } }), env(), clock);
    expect(response.status).toBe(200); expect(response.headers.get('Accept-Ranges')).toBe('none');
    expect(response.headers.get('Content-Range')).toBeNull();
    expect(response.headers.get('Content-Length')).toBe(String(bytes.length));
    expect(response.headers.get('Content-Type')).toBe('application/vnd.android.package-archive');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });
  it('HEAD has no body and invalid or missing keys are 404', async () => {
    const head = await handleApkArtifact(new Request(artifactUrl, { method: 'HEAD' }), env(), clock);
    expect(head.status).toBe(200); expect(await head.text()).toBe('');
    for (const path of ['/dl/artifacts/0/latest.apk', '/dl/artifacts/21606/latest.apk', `/dl/artifacts/21606/${'b'.repeat(64)}.apk`]) {
      expect((await handleApkArtifact(new Request(origin + path), env(), clock)).status).toBe(404);
    }
  });
});
