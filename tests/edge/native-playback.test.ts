import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../edge/src/types/env';
import { handleTitles } from '../../edge/src/routes/titles';
import { handleNativePlayback } from '../../edge/src/routes/native-playback';

vi.mock('../../edge/src/routes/titles', () => ({ handleTitles: vi.fn() }));
const clock = { nowSeconds: () => 100, nowMillis: () => 100000 };
const env = {} as Env;
const base = 'https://play.example.test/api/titles/drama_s_10/episodes/4/native-playback';
const asset = {
  workId: 'drama_s_10', title: '故事', channelId: 'drama', isPrivate: false, generatedAt: 100,
  episodes: [{ episodeNumber: 4, lines: [{ providerId: 'provider_s1', mediaUrl: 'https://media.example.test/4.mp4',
    native: { kind: 's1-cenc', videoId: '104' } }] }]
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(handleTitles).mockImplementation(async () => new Response(JSON.stringify(asset)));
});
describe('authoritative native playback selection', () => {
  it('selects only the server manifest identity and forwards admission headers', async () => {
    const response = await handleNativePlayback(new Request(`${base}?line=0`, { headers: {
      Authorization: 'Bearer fixture', 'X-Private-Session': 'session-fixture'
    } }), env, clock);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ workId: 'drama_s_10', episodeNumber: 4, lineIndex: 0,
      native: { kind: 's1-cenc', videoId: '104' }, checkedAt: 100 });
    const forwarded = vi.mocked(handleTitles).mock.calls[0][0];
    expect(new URL(forwarded.url).pathname).toBe('/api/titles/drama_s_10');
    expect(forwarded.headers.get('X-Private-Session')).toBe('session-fixture');
    expect(forwarded.headers.get('Authorization')).toBe('Bearer fixture');
  });
  it.each(['?line=0&videoId=999', '?line=0&line=1', '?line=-1', '?line=00', '', '?line=1.2'])
    ('rejects injected identities and ambiguous selectors: %s', async (query) => {
      expect((await handleNativePlayback(new Request(base + query), env, clock)).status).toBe(404);
      expect(handleTitles).not.toHaveBeenCalled();
    });
  it('preserves the admission denial and never emits a video identity', async () => {
    vi.mocked(handleTitles).mockResolvedValue(new Response('hidden', { status: 404 }));
    const response = await handleNativePlayback(new Request(`${base}?line=0`), env, clock);
    expect(response.status).toBe(404); expect(await response.text()).toBe('hidden');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
  it('rejects missing episodes, lines and plaintext-only media', async () => {
    expect((await handleNativePlayback(new Request(base.replace('/4/', '/5/') + '?line=0'), env, clock)).status).toBe(404);
    expect((await handleNativePlayback(new Request(base + '?line=1'), env, clock)).status).toBe(404);
    const plain = JSON.parse(JSON.stringify(asset)); delete plain.episodes[0].lines[0].native;
    vi.mocked(handleTitles).mockResolvedValue(new Response(JSON.stringify(plain)));
    expect((await handleNativePlayback(new Request(base + '?line=0'), env, clock)).status).toBe(404);
  });
});
