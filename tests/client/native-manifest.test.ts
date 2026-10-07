// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { TitleManifest } from '../../edge/src/types/api';
import { adaptTitleDetail } from '../../src/core/api/title-detail';
import { MemoryCacheDisk } from '../../src/core/storage/public-cache';
import { createTitleManifestStore, parseTitleManifest, TITLE_MANIFEST_KEY_PREFIX } from '../../src/player/title-manifest';

const native = { kind: 's1-cenc' as const, videoId: '000123' };
const line = { providerId: 'provider_s1', mediaUrl: 'https://media.example/candidate.mp4', native };
const now = 1900000000;
const manifest = (candidate: unknown = line) => ({
  workId: 'drama_s_10', title: '故事', channelId: 'drama', isPrivate: false, generatedAt: now,
  episodes: [{ episodeNumber: 1, lines: [candidate] }]
});
const key = `${TITLE_MANIFEST_KEY_PREFIX}drama_s_10.json`;
const secret = '0123456789abcdef0123456789abcdef';

describe('native manifest client parser and cache', () => {
  it('accepts a native identity without inventing a media URL', () => {
    const identity = { providerId: 'provider_s1', native };
    expect(parseTitleManifest(manifest(identity))?.episodes[0].lines[0]).toEqual(identity);
    const detail = adaptTitleDetail({ ...manifest(identity), item: {
      id: 'drama_s_10', title: '故事', category: '', channelId: 'drama', isPrivate: false
    } }, 'drama_s_10');
    expect(detail.episodes[0].episodeNumber).toBe(1);
    expect(parseTitleManifest(manifest({ providerId: 'provider_m1' }))).toBeNull();
  });
  it('preserves the descriptor and source candidate, including numeric string identity', () => {
    expect(parseTitleManifest(manifest())?.episodes[0].lines[0]).toEqual(line);
    const longest = { ...line, native: { ...native, videoId: '1'.repeat(32) } };
    expect(parseTitleManifest(manifest(longest))?.episodes[0].lines[0]).toEqual(longest);
  });
  it.each([
    null, [], {}, { ...native, kind: 'cenc' }, { ...native, videoId: 123 },
    { ...native, videoId: '' }, { ...native, videoId: '1'.repeat(33) },
    { ...native, videoId: '12x' }, { ...native, videoId: ' 123' },
    { ...native, key: secret }, { ...native, key: null },
    { ...native, cencKeyHex: secret }, { ...native, unknown: true }
  ])('rejects malformed or secret-bearing native descriptors: %j', (descriptor) => {
    expect(parseTitleManifest(manifest({ ...line, native: descriptor }))).toBeNull();
  });
  it('rejects another provider and explicit undefined native without changing plain lines', () => {
    expect(parseTitleManifest(manifest({ ...line, providerId: 'provider_m1' }))).toBeNull();
    expect(parseTitleManifest(manifest({ ...line, native: undefined }))).toBeNull();
    const plain = { providerId: 'provider_m1', mediaUrl: line.mediaUrl };
    expect(parseTitleManifest(manifest(plain))?.episodes[0].lines[0]).toEqual(plain);
  });
  it('round-trips public native identity through disk and cold-start linesFor without a network request', async () => {
    const disk = new MemoryCacheDisk();
    const api = { titleManifest: vi.fn(async () => manifest() as TitleManifest) };
    const store = createTitleManifestStore({ api, disk, nowSeconds: () => now });
    expect(await store.linesFor('drama_s_10', 1)).toEqual([line]);
    const serialized = new TextDecoder().decode((await disk.read(key))!);
    expect(JSON.parse(serialized).manifest.episodes[0].lines[0]).toEqual(line);
    expect(serialized).not.toMatch(/key|spade|license/i);
    const coldApi = { titleManifest: vi.fn(async () => { throw new Error('must not fetch'); }) };
    const cold = createTitleManifestStore({ api: coldApi, disk, nowSeconds: () => now });
    expect(await cold.linesFor('drama_s_10', 1)).toEqual([line]);
    expect(cold.cached('drama_s_10')?.episodes[0].lines[0]).toEqual(line);
    expect(coldApi.titleManifest).not.toHaveBeenCalled();
  });
  it.each(['key', 'cencKeyHex', 'licenseUrl'])('rejects network secrets (%s) before memory or disk cache admission', async (field) => {
    const disk = new MemoryCacheDisk();
    const poisoned = manifest({ ...line, native: { ...native, [field]: secret } });
    const store = createTitleManifestStore({
      api: { titleManifest: async () => poisoned as TitleManifest }, disk, nowSeconds: () => now
    });
    expect(await store.load('drama_s_10')).toBeNull();
    expect(store.cached('drama_s_10')).toBeNull();
    expect(await disk.list(TITLE_MANIFEST_KEY_PREFIX)).toEqual([]);
  });
  it('rejects poisoned disk descriptors instead of silently downgrading them to plain lines', async () => {
    const disk = new MemoryCacheDisk();
    await disk.writeBatch([{ key, bytes: new TextEncoder().encode(JSON.stringify({ at: now,
      manifest: manifest({ ...line, native: { ...native, key: secret } }) })) }], []);
    const api = { titleManifest: vi.fn(async () => { throw new Error('offline'); }) };
    const store = createTitleManifestStore({ api, disk, nowSeconds: () => now });
    expect(await store.load('drama_s_10')).toBeNull();
    expect(store.cached('drama_s_10')).toBeNull();
    expect(api.titleManifest).toHaveBeenCalledOnce();
  });
  it('keeps private native identity only in memory with zero disk writes', async () => {
    const disk = new MemoryCacheDisk();
    const writes = vi.spyOn(disk, 'writeBatch');
    const store = createTitleManifestStore({
      api: { titleManifest: async () => ({ ...manifest(), isPrivate: true }) as TitleManifest },
      disk, nowSeconds: () => now
    });
    expect(await store.linesFor('drama_s_10', 1)).toEqual([line]);
    expect(writes).not.toHaveBeenCalled();
  });
});
