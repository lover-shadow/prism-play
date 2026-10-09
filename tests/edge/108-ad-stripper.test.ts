import { describe, expect, it } from 'vitest';
import { cleanHlsPlaylist } from '../../edge/src/media/ad-stripper';
import { AD_STRIP_DEFAULT_PARAMS, isCleanableMediaUrl, readAdStripSettings } from '../../edge/src/media/ad-strip-config';
import { titleAssetResponse } from '../../edge/src/library/title-asset';
import type { TitleAsset } from '../../edge/src/library/title-asset';

const BASE = 'https://play.modujx17.com/20260830/il7CWEiN/2000kb/hls/index.m3u8';
const PARAMS = AD_STRIP_DEFAULT_PARAMS;
const HEAD = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4';
const CALL = { baseUrl: BASE, params: PARAMS };

/** 正片分片：绝对地址、统一目录（实测 96%+ 占比的"主流签名"形态）。 */
const content = (from: number, count: number, seconds = 2): string =>
  Array.from({ length: count }, (_, i) => `#EXTINF:${seconds}.0,\nhttps://bf.modujx17.com/20260830/il7CWEiN/2000kb/hls/c${from + i}.ts`).join('\n');
/** 广告分片：实测形态——根路径目录 + 高码率池 + 恒被 DISCONTINUITY 包裹。 */
const ads = (from: number, count: number, seconds = 3): string =>
  Array.from({ length: count }, (_, i) => `#EXTINF:${seconds}.0,\n/20261009/Bjf6z0RU/10152kb/hls/ad${from + i}.ts`).join('\n');
const D = '#EXT-X-DISCONTINUITY';

describe('广告手术刀引擎：五道闸门', () => {
  it('纯净单签名清单：原样放行、逐字节不做改动', () => {
    const text = `${HEAD}\n${content(1, 30)}\n#EXT-X-ENDLIST`;
    const res = cleanHlsPlaylist(text, CALL);
    expect(res.mode).toBe('unchanged');
    expect(res.removedBlocks).toBe(0);
    expect(res.text).toBe(text);
  });

  it('真实结构（中插 1 处 + 片尾 1 处广告，广告块自带 KEY:NONE 明文声明）：全部切除且正片完整', () => {
    const text = `${HEAD}\n${content(1, 60)}\n${D}\n#EXT-X-KEY:METHOD=NONE\n${ads(1, 2)}\n${D}\n${content(61, 120)}\n${D}\n#EXT-X-KEY:METHOD=NONE\n${ads(3, 2)}\n#EXT-X-ENDLIST`;
    const res = cleanHlsPlaylist(text, CALL);
    expect(res.mode).toBe('cleaned');
    expect(res.removedBlocks).toBe(2);
    expect(res.removedSegments).toBe(4);
    expect(res.removedSeconds).toBe(12);
    expect(res.text).not.toContain('Bjf6z0RU');
    expect(res.text).not.toContain('10152kb');
    // 明文声明随广告块一并远离，正片不含任何密钥标签。
    expect(res.text).not.toContain('#EXT-X-KEY');
    expect(res.text).toContain('c1.ts');
    expect(res.text).toContain('c180.ts');
    // 被删块两侧的多余边界收敛：保留块之间只剩一个 DISCONTINUITY。
    expect(res.text.split(D).length - 1).toBe(1);
  });

  it('闸门④ 重复验证：单次出现的异类块视为合法片段，一条不删', () => {
    const text = `${HEAD}\n${content(1, 60)}\n${D}\n${ads(1, 2)}\n#EXT-X-ENDLIST`;
    const res = cleanHlsPlaylist(text, CALL);
    expect(res.mode).toBe('unchanged');
    expect(res.removedBlocks).toBe(0);
  });

  it('闸门② 主流确认：找不到绝对主流（51% < 55%）则整份放行', () => {
    const text = `${HEAD}\n${content(1, 25)}\n${D}\n${ads(1, 8)}\n${D}\n${ads(9, 8)}\n#EXT-X-ENDLIST`;
    const res = cleanHlsPlaylist(text, CALL);
    expect(res.mode).toBe('unchanged');
    expect(res.removedBlocks).toBe(0);
    expect(res.dominantRatio).toBeLessThan(0.55);
  });

  it('实测校准回放：短剧集 79.3% 正片占比仍能精准切除（真实比例回归）', () => {
    // 真实数据形态：ep1 正片 138s + 2 条广告块 36s，正片占比 79.3%（2026-10-09 抓包）。
    const text = `${HEAD}\n${content(1, 50)}\n${D}\n#EXT-X-KEY:METHOD=NONE\n${ads(1, 6)}\n${D}\n${content(51, 19)}\n${D}\n#EXT-X-KEY:METHOD=NONE\n${ads(7, 6)}\n#EXT-X-ENDLIST`;
    const res = cleanHlsPlaylist(text, CALL);
    expect(res.mode).toBe('cleaned');
    expect(res.removedBlocks).toBe(2);
    expect(res.removedSeconds).toBe(36);
    expect(res.dominantRatio).toBeGreaterThan(0.55);
    expect(res.text).not.toContain('/20261009/');
  });

  it('闸门⑤ 时长上限：超过上限的孤岛不动刀（参数可调）', () => {
    const text = `${HEAD}\n${content(1, 60)}\n${D}\n${ads(1, 2)}\n${D}\n${content(61, 120)}\n${D}\n${ads(3, 2)}\n#EXT-X-ENDLIST`;
    const res = cleanHlsPlaylist(text, { baseUrl: BASE, params: { ...PARAMS, maxBlockSeconds: 5 } });
    expect(res.removedBlocks).toBe(0);
  });

  it('闸门① 加密清单原样放行：不破坏密钥继承关系', () => {
    const text = `${HEAD}\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n${content(1, 30)}\n#EXT-X-ENDLIST`;
    expect(cleanHlsPlaylist(text, CALL).mode).toBe('passthrough');
  });

  it('闸门① 初始化段（EXT-X-MAP）原样放行', () => {
    const text = `${HEAD}\n#EXT-X-MAP:URI="init.mp4"\n${content(1, 30)}\n#EXT-X-ENDLIST`;
    expect(cleanHlsPlaylist(text, CALL).mode).toBe('passthrough');
  });

  it('闸门① 无 ENDLIST（直播形态）原样放行', () => {
    const text = `${HEAD}\n${content(1, 30)}`;
    expect(cleanHlsPlaylist(text, CALL).mode).toBe('passthrough');
  });

  it('相对路径绝对化 + BYTERANGE 标签随段保留、被删段标签不留残渣', () => {
    const first = Array.from({ length: 30 }, (_, i) => `#EXTINF:2.0,\n${i === 0 ? '#EXT-X-BYTERANGE:722296@0\n' : ''}seg${i + 1}.ts`).join('\n');
    const second = Array.from({ length: 60 }, (_, i) => `#EXTINF:2.0,\nseg${i + 31}.ts`).join('\n');
    const text = `${HEAD}\n${first}\n${D}\n${ads(1, 2)}\n${D}\n${second}\n${D}\n${ads(3, 2)}\n#EXT-X-ENDLIST`;
    const res = cleanHlsPlaylist(text, CALL);
    expect(res.mode).toBe('cleaned');
    expect(res.text).toContain('#EXT-X-BYTERANGE:722296@0');
    expect(res.text).toContain('https://play.modujx17.com/20260830/il7CWEiN/2000kb/hls/seg1.ts');
    expect(res.text).not.toContain('/20261009/');
  });

  it('主清单：变体流重写为清洗入口并携带作品身份，URI 属性绝对化', () => {
    const text = `#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI="audio.m3u8"\n#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=2000000\n/20260830/il7CWEiN/2000kb/hls/index.m3u8`;
    const res = cleanHlsPlaylist(text, { ...CALL, cleanBase: 'https://play.prismos.org/proxy/hls/clean', workId: 'drama_m_88837' });
    expect(res.mode).toBe('master');
    expect(res.text).toContain('URI="https://play.modujx17.com/20260830/il7CWEiN/2000kb/hls/audio.m3u8"');
    const variant = encodeURIComponent('https://play.modujx17.com/20260830/il7CWEiN/2000kb/hls/index.m3u8');
    expect(res.text).toContain(`/proxy/hls/clean?target=${variant}&work=drama_m_88837`);
  });

  it('闸门① 分片数超限原样放行（参数可调）', () => {
    const text = `${HEAD}\n${content(1, 30)}\n#EXT-X-ENDLIST`;
    expect(cleanHlsPlaylist(text, { baseUrl: BASE, params: { ...PARAMS, maxSegments: 10 } }).mode).toBe('passthrough');
  });

  it('闸门① 非清单文本原样放行', () => {
    expect(cleanHlsPlaylist('<html>not a playlist</html>', CALL).mode).toBe('passthrough');
  });
});

describe('配置口径：包裹端与入口端同源', () => {
  it('启用条件：开关为 true 且白名单非空，缺一不可', () => {
    expect(readAdStripSettings({ AD_STRIP_ENABLED: 'true' }).enabled).toBe(false);
    expect(readAdStripSettings({ AD_STRIP_ENABLED: 'false', AD_STRIP_TARGET_HOSTS: 'a.com' }).enabled).toBe(false);
    expect(readAdStripSettings({ AD_STRIP_ENABLED: 'true', AD_STRIP_TARGET_HOSTS: 'a.com' }).enabled).toBe(true);
  });

  it('参数覆盖生效、越界与损坏配置退回默认', () => {
    const tuned = readAdStripSettings({ AD_STRIP_ENABLED: 'true', AD_STRIP_TARGET_HOSTS: 'a.com', AD_STRIP_CONFIG: '{"dominantRatio":0.95,"repeatBlocks":3,"maxBlockSeconds":30}' });
    expect(tuned.params.dominantRatio).toBe(0.95);
    expect(tuned.params.repeatBlocks).toBe(3);
    expect(tuned.params.maxBlockSeconds).toBe(30);
    const broken = readAdStripSettings({ AD_STRIP_ENABLED: 'true', AD_STRIP_TARGET_HOSTS: 'a.com', AD_STRIP_CONFIG: '{broken' });
    expect(broken.params).toEqual(AD_STRIP_DEFAULT_PARAMS);
    const wild = readAdStripSettings({ AD_STRIP_ENABLED: 'true', AD_STRIP_TARGET_HOSTS: 'a.com', AD_STRIP_CONFIG: '{"dominantRatio":-1,"repeatBlocks":0}' });
    expect(wild.params.dominantRatio).toBe(AD_STRIP_DEFAULT_PARAMS.dominantRatio);
    expect(wild.params.repeatBlocks).toBe(AD_STRIP_DEFAULT_PARAMS.repeatBlocks);
  });

  it('媒体地址筛选：精确主机匹配，子串伪造与明文协议一律拒绝', () => {
    const hosts = new Set(['play.modujx17.com']);
    expect(isCleanableMediaUrl('https://play.modujx17.com/a/index.m3u8', hosts)).toBe(true);
    expect(isCleanableMediaUrl('https://play.modujx17.com.evil.example/a.m3u8', hosts)).toBe(false);
    expect(isCleanableMediaUrl('https://play.modujx17.com.evil/a.m3u8', hosts)).toBe(false);
    expect(isCleanableMediaUrl('http://play.modujx17.com/a/index.m3u8', hosts)).toBe(false);
    expect(isCleanableMediaUrl('https://play.modujx17.com/a/ep1.mp4', hosts)).toBe(false);
    expect(isCleanableMediaUrl(undefined, hosts)).toBe(false);
  });
});

describe('下发接驳：仅 provider_m1 公开 HLS 线路包裹清洗入口', () => {
  const mk = (line: { providerId: string; mediaUrl?: string }): TitleAsset => ({
    workId: 'drama_m_88837', title: '糯糯下山', channelId: 'drama', isPrivate: false,
    generatedAt: 1, category: '都市', hasCover: false,
    episodes: [{ episodeNumber: 1, lines: [line] }]
  } as TitleAsset);

  it('m1 公开清单包裹为清洗入口并携带 work 参数', () => {
    const url = 'https://play.modujx17.com/20260830/il7CWEiN/index.m3u8';
    const out = titleAssetResponse(mk({ providerId: 'provider_m1', mediaUrl: url }), undefined,
      { cleanBase: 'https://play.prismos.org/proxy/hls/clean', hosts: new Set(['play.modujx17.com']) });
    expect(out.episodes[0].lines[0].mediaUrl)
      .toBe(`https://play.prismos.org/proxy/hls/clean?target=${encodeURIComponent(url)}&work=drama_m_88837`);
  });

  it('其余情况一律不动：非 m1、非白名单主机、非 m3u8、无清洗上下文', () => {
    const clean = { cleanBase: 'https://play.prismos.org/proxy/hls/clean', hosts: new Set(['play.modujx17.com']) };
    const native = { providerId: 'provider_s1', mediaUrl: 'https://play.modujx17.com/x.m3u8' };
    expect(titleAssetResponse(mk(native), undefined, clean).episodes[0].lines[0]).toEqual(native);
    const foreign = { providerId: 'provider_m1', mediaUrl: 'https://other.example/x.m3u8' };
    expect(titleAssetResponse(mk(foreign), undefined, clean).episodes[0].lines[0]).toEqual(foreign);
    const mp4 = { providerId: 'provider_m1', mediaUrl: 'https://play.modujx17.com/x.mp4' };
    expect(titleAssetResponse(mk(mp4), undefined, clean).episodes[0].lines[0]).toEqual(mp4);
    const bare = { providerId: 'provider_m1', mediaUrl: 'https://play.modujx17.com/x.m3u8' };
    expect(titleAssetResponse(mk(bare)).episodes[0].lines[0]).toEqual(bare);
  });
});
