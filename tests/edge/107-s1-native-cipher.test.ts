import { describe, expect, it } from 'vitest';
import { createCipheriv } from 'node:crypto';
import { extractSpadeKey, decodeHongguoPlaybackV2, countOnes, reverse8, rotateLeft8 } from '../../edge/src/search/providers/s1-cipher';
import { signHongguoRequest } from '../../edge/src/search/providers/s1-sign';
import { resolveS1AppMedia, resolveS1PlaybackApi } from '../../edge/src/search/providers/s1-native';
import { createS1Provider } from '../../edge/src/search/providers/s1';
import type { DiscoveryCandidate, DiscoveryConfig } from '../../edge/src/search/discovery-provider';

describe('s1 cipher and bit operations', () => {
  it('correctly computes countOnes, rotateLeft8, and reverse8', () => {
    expect(countOnes(0)).toBe(0);
    expect(countOnes(1)).toBe(1);
    expect(countOnes(7)).toBe(3);
    expect(countOnes(255)).toBe(8);

    expect(rotateLeft8(0b00000001, 1)).toBe(0b00000010);
    expect(rotateLeft8(0b10000000, 1)).toBe(0b00000001);

    expect(reverse8(0b10000000)).toBe(0b00000001);
    expect(reverse8(0b11000000)).toBe(0b00000011);
    expect(reverse8(0b10101010)).toBe(0b01010101);
  });

  it('rejects invalid or malformed spade_a inputs', () => {
    expect(extractSpadeKey('')).toBeNull();
    expect(extractSpadeKey('short')).toBeNull();
    expect(extractSpadeKey('invalid_base64_???')).toBeNull();
  });

  it('rejects unsupported tag versions like app_v2 or web_v2', () => {
    // 构造带有 app_v2 tag 的 raw buffer
    const tag = new TextEncoder().encode('app_v2');
    const tagLen = tag.length;
    const raw = new Uint8Array(40 + tagLen);
    // 设置首三字节使得 tagLength 计算为 tagLen
    raw[0] = 48 + tagLen;
    raw[1] = 0;
    raw[2] = 0;
    const spadeA = Buffer.from(raw).toString('base64');
    expect(extractSpadeKey(spadeA)).toBeNull();
  });

  it('decrypts v2. encrypted playback API payload', () => {
    const key = new Uint8Array(16).fill(1);
    const iv = new Uint8Array(16).fill(2);
    const plaintext = JSON.stringify({ key_urls: [{ src: 'https://v26-hgweb.qznovelvod.com/test.mp4' }] });
    const cipher = createCipheriv('aes-128-cbc', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

    // 构造测试 material (32 bytes)
    const material = new Uint8Array(32);
    material.set(key, 0);
    material.set(iv, 16);

    const mask = new Uint8Array([
      104, 64, 70, 166, 190, 168, 143, 130, 225, 254, 251, 217, 196, 34, 45, 60, 29, 20, 103, 105
    ]);
    const encoded = new Uint8Array(32);
    for (let index = 0; index < 32; index++) {
      const prev = index > 0 ? encoded[index - 1]! : 109;
      const slot = index % mask.length;
      const salt = (mask[slot]! ^ (90 + 13 * slot) ^ 85) & 0xff;
      const desired = (material[index]! ^ prev ^ salt) & 0xff;
      // 逆运算 rotateLeft8(shifted, 3) -> rotateLeft8(desired, 5)
      const shifted = rotateLeft8(desired, 5);
      encoded[index] = (shifted - 215 + 11 * index) & 0xff;
    }

    const payload = `v2.0000${Buffer.from(encoded).toString('hex')}.${ciphertext.toString('base64')}`;
    const decrypted = decodeHongguoPlaybackV2(payload);
    expect(decrypted).not.toBeNull();
    const str = new TextDecoder().decode(decrypted!);
    expect(str).toContain('https://v26-hgweb.qznovelvod.com/test.mp4');
  });
});

describe('s1 native app request signing', () => {
  it('generates consistent X-Gorgon and X-Khronos headers', () => {
    const now = 1791228811000;
    const headers = signHongguoRequest('aid=8662&app_name=novelread', new TextEncoder().encode('{"test":1}'), now);
    expect(headers['X-Khronos']).toBe('1791228811');
    expect(headers['X-SS-Req-Ticket']).toBe('1791228811000');
    expect(headers['X-SS-STUB']).toHaveLength(32);
    expect(headers['X-Gorgon']).toHaveLength(52); // hex of 26 bytes
    expect(headers['X-Gorgon']).toMatch(/^8404401c0000/);
  });
});

describe('s1 native episode resolution', () => {
  const config: DiscoveryConfig = {
    origin: 'https://hongguoduanju.com',
    originAllowlist: new Set(['https://hongguoduanju.com', 'https://novel.snssdk.com', 'https://api5-normal-sinfonlineb.fqnovel.com', 'https://djapi.999888456.xyz']),
    mediaAllowlist: new Set(['https://v26-hgweb.qznovelvod.com']),
    coverAllowlist: new Set(['https://p3-novel.byteimg.com', 'https://p6-novel.byteimg.com'])
  };

  /**
   * Inverse of `extractSpadeKey`: builds a `spade_a` blob that decodes to the given 16-byte key.
   * Layout is `[xorTagLenByte][33 content bytes][tagLength tag bytes ^ seed]`; content byte chain is
   * `current = prev ^ ((decoded + 21 + countOnes(index)) & 0xff)` with parity seeds 250/85, and
   * `decoded = ['0'(padding=0), ...32 lowercase hex chars]` so `contentLength - padding - 1 === 32`.
   */
  function buildSpadeA(keyHexLower: string, tag = 'hg1'): string {
    const decoded = new Uint8Array(33);
    decoded[0] = 48; // '0' -> parseInt('0', 36) === 0 padding
    decoded.set(new TextEncoder().encode(keyHexLower), 1);
    const tagBytes = new TextEncoder().encode(tag);
    const tagLength = tagBytes.length;
    const raw = new Uint8Array(33 + tagLength + 1);
    let prevEven = 250, prevOdd = 85;
    for (let index = 0; index < 33; index++) {
      const target = (decoded[index]! + 21 + countOnes(index)) & 0xff;
      const prev = index % 2 === 0 ? prevEven : prevOdd;
      const current = (prev ^ target) & 0xff;
      if (index % 2 === 0) prevEven = current; else prevOdd = current;
      raw[1 + index] = current;
    }
    const seed = (raw[raw.length - tagLength - 2]! ^ raw[raw.length - tagLength - 1]!) & 0xff;
    raw[0] = (48 + tagLength) ^ raw[1]! ^ raw[2]!;
    for (let i = 0; i < tagLength; i++) raw[34 + i] = (tagBytes[i]! ^ seed) & 0xff;
    return Buffer.from(raw).toString('base64');
  }

  it('builds a spade_a fixture that extractSpadeKey decodes back to the key', () => {
    const keyHexLower = '00112233445566778899aabbccddeeff';
    const key = extractSpadeKey(buildSpadeA(keyHexLower));
    expect(key).not.toBeNull();
    expect(Buffer.from(key!).toString('hex')).toBe(keyHexLower);
  });

  it('resolves stream from App native video_model API and ignores bytevc2 codec', async () => {
    const fakeScope = { remaining: 5, deadline: Date.now() + 10000 };
    const customConfig: DiscoveryConfig = {
      ...config,
      fetcher: async (url, init) => {
        expect(url).toContain('https://api5-normal-sinfonlineb.fqnovel.com/novel/player/video_model/v1/');
        expect(init?.method).toBe('POST');
        // P0-1: _rticket must be in the signed query string (present in the request URL).
        expect(url).toContain('_rticket=');
        const headers = init?.headers as Record<string, string>;
        expect(headers['Referer']).toBe('https://novel.snssdk.com/');
        expect(headers['User-Agent']).toMatch(/^com\.phoenix\.read\/73532/);
        expect(headers['X-Gorgon']).toBeTruthy();
        const model = {
          video_duration: 120.5,
          video_list: [
            {
              video_meta: { codec_type: 'bytevc2' },
              main_url: 'https://v26-hgweb.qznovelvod.com/bytevc2.mp4'
            },
            {
              video_meta: { codec_type: 'h264' },
              main_url: Buffer.from('https://v26-hgweb.qznovelvod.com/h264.mp4').toString('base64')
            }
          ]
        };
        return new Response(JSON.stringify({ code: 0, data: { video_model: model } }));
      }
    };

    const media = await resolveS1AppMedia(customConfig, 'vid123', fakeScope);
    expect(media).not.toBeNull();
    expect(media?.mediaUrl).toBe('https://v26-hgweb.qznovelvod.com/h264.mp4');
    expect(media?.durationSeconds).toBe(121);
    expect(media?.cencKeyHex).toBeUndefined();
  });

  it('selects the 1080p HEVC variant and returns its CENC key instead of discarding it (ADR-007 R-3)', async () => {
    const keyHexLower = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';
    const spade = buildSpadeA(keyHexLower);
    const fakeScope = { remaining: 5, deadline: Date.now() + 10000 };
    const customConfig: DiscoveryConfig = {
      ...config,
      fetcher: async () => {
        const model = {
          video_duration: 135.698,
          video_list: [
            { video_meta: { codec_type: 'bytevc2' }, encrypt_info: { spade_a: spade }, main_url: 'https://v26-hgweb.qznovelvod.com/sd.mp4' },
            { video_meta: { codec_type: 'bytevc1', definition: '720p' }, encrypt_info: { spade_a: spade }, main_url: 'https://v26-hgweb.qznovelvod.com/hd720.mp4' },
            { video_meta: { codec_type: 'bytevc1', definition: '1080p', vwidth: 1080, vheight: 1920 }, encrypt_info: { spade_a: spade }, main_url: 'https://v26-hgweb.qznovelvod.com/hd1080.mp4' }
          ]
        };
        return new Response(JSON.stringify({ code: 0, data: { video_model: model } }));
      }
    };

    const media = await resolveS1AppMedia(customConfig, 'vid999', fakeScope);
    expect(media).not.toBeNull();
    // bytevc2 (proprietary, undecodable) is dropped; only the bytevc1/hvc1 1080p variant is returned.
    expect(media?.mediaUrl).toBe('https://v26-hgweb.qznovelvod.com/hd1080.mp4');
    expect(media?.durationSeconds).toBe(136);
    expect(media?.cencKeyHex).toBe(keyHexLower);
    expect(media?.encryptionScheme).toBe('cenc-aes-ctr');
  });

  it('falls back to playback API when native model fails', async () => {
    const fakeScope = { remaining: 5, deadline: Date.now() + 10000 };
    const customConfig: DiscoveryConfig = {
      ...config,
      fetcher: async (url) => {
        expect(url).toContain('https://djapi.999888456.xyz/api/hongguo/play');
        const res = {
          key_urls: [{ src: 'https://v26-hgweb.qznovelvod.com/backup.mp4' }]
        };
        return new Response(JSON.stringify(res));
      }
    };

    const media = await resolveS1PlaybackApi(customConfig, 'series1', 'vid123', fakeScope);
    expect(media).not.toBeNull();
    expect(media?.mediaUrl).toBe('https://v26-hgweb.qznovelvod.com/backup.mp4');
  });

  it('seamlessly falls back to App native protocol when Web player returns 404 (bypassing 3-episode limit)', async () => {
    const candidate: DiscoveryCandidate = {
      providerId: 'provider_s1',
      sourceItemId: '7001',
      id: 'drama_s_7001',
      title: '测试连载剧',
      channelId: 'drama'
    };

    const customConfig: DiscoveryConfig = {
      ...config,
      fetcher: async (url) => {
        if (url.includes('/detail?series_id=7001')) {
          const detail = {
            seriesDetail: {
              series_id: '7001',
              series_title: '测试连载剧',
              episode_cnt: 4,
              vid_list: ['101', '102', '103', '104']
            }
          };
          return new Response(JSON.stringify({ loaderData: { 'detail_page': detail } }));
        }

        // Web 端第 1~3 集返回正常网页，第 4 集返回 404 试看阻断
        if (url.includes('/player/7001/101') || url.includes('/player/7001/102') || url.includes('/player/7001/103')) {
          const page = {
            series_id: '7001',
            vid: url.split('/').pop(),
            video_player_info: { main_url: 'https://v26-hgweb.qznovelvod.com/web.mp4', duration: 60 }
          };
          return new Response(JSON.stringify({ loaderData: { 'player_page': page } }));
        }

        if (url.includes('/player/7001/104')) {
          return new Response('Web 404 trial ended', { status: 404 });
        }

        // App 原生接口正常返回第 4 集流媒体
        if (url.includes('api5-normal-sinfonlineb.fqnovel.com')) {
          const model = {
            video_duration: 60,
            video_list: [{ video_meta: { codec_type: 'h264' }, main_url: 'https://v26-hgweb.qznovelvod.com/app104.mp4' }]
          };
          return new Response(JSON.stringify({ code: 0, data: { video_model: model } }));
        }

        return new Response('not found', { status: 404 });
      }
    };

    const provider = createS1Provider(customConfig);
    const result = await provider.resolve(candidate, undefined, { maxRequests: 8, timeoutMs: 15000 });
    expect(result.status).toBe('complete');
    if (result.status === 'complete') {
      expect(result.fact.episodeCount).toBe(4);
      expect(result.fact.episodes).toHaveLength(4);
      // 前 3 集来自 Web，第 4 集自动无缝由 App 原生协议取得！
      expect(result.fact.episodes[0]!.lines[0]!.mediaUrl).toBe('https://v26-hgweb.qznovelvod.com/web.mp4');
      expect(result.fact.episodes[3]!.lines[0]!.mediaUrl).toBe('https://v26-hgweb.qznovelvod.com/app104.mp4');
    }
  });
});
