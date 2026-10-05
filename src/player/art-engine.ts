/// <reference types="vite/client" />
/**
 * 生产内核：ArtPlayer 承担界面与事件，hls.js 承担**直连上游**的清单解析（ADR-002 + SPEC-APP-REFACTOR A-7）。
 *
 * 两者都在函数体内 `import()`——首屏不该为一个还没点开的播放器买单，
 * `npm run build` 也据此把它们切成懒加载 chunk（G4 交付证据）。
 *
 * A-7 之后 `setSource` 收到的是上游 `mediaUrl` 而不是云端代理句柄，所以失败分类成了本文件的职责：
 * 切线（`line-fallback.ts`）与遥测（`core/native/telemetry.ts`）都只认 §C-4 那三个失败码，
 * 而现场能分出差别的只有这里——hls 的 fatal 明细与 `MediaError.code`。分不出来就留 null，
 * 由上层按 `http_error` 保守记账，绝不编造一个更"好看"的失败原因。
 */
import { clamp } from './gestures';
import type { EngineFactory } from './engine-seam';
import type { LineFailureCode } from '../core/native/telemetry';

/**
 * hls 的 `data.details` 文案随版本增删，故按语义子串分类而不是枚举比对：
 * 超时优先（它决定切线该等多久），其次解码/封装类，其余网络失败一律 `http_error`。
 */
export function classifyHlsFailure(details: string): LineFailureCode {
  const text = details.toLowerCase();
  if (text.includes('timeout') || text.includes('timed out')) return 'timeout';
  if (/decode|pars|remux|append|buffer|fragloadingerror/.test(text)) return 'decode_error';
  return 'http_error';
}

/** W3C `MediaError.code`：1 中止（多为卡死后被系统掐断）、2 网络、3 解码、4 源不可用。 */
export function classifyMediaError(code: number | undefined): LineFailureCode | null {
  if (code === 1) return 'timeout';
  if (code === 2 || code === 4) return 'http_error';
  if (code === 3) return 'decode_error';
  return null;
}

/** Production engine: ArtPlayer for chrome and events, hls.js for the direct upstream manifest. */
export const createArtEngine: EngineFactory = async ({ container, theme, poster, onError }) => {
  const [{ default: Artplayer }, { default: Hls }] = await Promise.all([import('artplayer'), import('hls.js')]);
  let hls: InstanceType<typeof Hls> | null = null;
  const destroyHls = (): void => {
    const previous = hls;
    hls = null;
    previous?.destroy();
  };
  /** 本跳的失败原因：每次换源清零，于是上层读到的永远是这一次失败的解释。 */
  let lastFailure: LineFailureCode | null = null;
  const blank = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  const initialPoster = poster || blank;
  const art = new Artplayer({
    container, url: '', poster: initialPoster, theme, volume: 1, autoplay: false, autoSize: false, isLive: false, lang: 'zh-cn', playsInline: true,
    customType: {
      m3u8: (video: HTMLVideoElement, url: string) => {
        destroyHls();
        video.poster = initialPoster; video.playsInline = true;
        video.setAttribute('playsinline', 'true'); video.setAttribute('webkit-playsinline', 'true');
        if (Hls.isSupported()) {
          const instance = new Hls({ lowLatencyMode: false });
          hls = instance;
          const current = (): boolean => hls === instance;
          instance.on(Hls.Events.MANIFEST_PARSED, () => {
            if (!current()) return;
            void video.play().catch(() => {
              if (!current()) return;
              video.muted = true; void video.play().catch(() => {});
            });
          });
          instance.on(Hls.Events.ERROR, (_e, data) => {
            if (!data.fatal || !current()) return;
            lastFailure = classifyHlsFailure(String(data.details ?? data.type ?? ''));
            // 文案不提域名也不提源站名：界面与日志都不该出现上游品牌（AGENTS.md 二.1）。
            onError('播放中断，正在尝试备用线路', lastFailure);
          });
          instance.loadSource(url);
          if (current()) instance.attachMedia(video);
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) { video.src = url; void video.play().catch(() => {}); }
        else { lastFailure = 'decode_error'; onError('当前设备不支持 HLS 播放，需在 Android 端验证', lastFailure); }
      }
    }
  });
  return {
    play: () => { void art.play().catch(() => {}); }, pause: () => art.pause(), playing: () => art.playing,
    currentTime: () => art.currentTime, setCurrentTime: (s) => void (art.currentTime = s),
    duration: () => art.duration, volume: () => art.video.volume, setVolume: (v) => void (art.video.volume = clamp(v, 0, 1)),
    toggleControls: () => art.controls.toggle(),
    playbackRate: () => art.video.playbackRate,
    setPlaybackRate: (rate) => { art.video.playbackRate = rate; },
    setSource: (u, m) => { destroyHls(); lastFailure = null; art.type = m === 'video/mp4' ? 'mp4' : 'm3u8'; art.url = u; void art.play().catch(() => {}); },
    failureCode: () => lastFailure,
    on: (event, handler) => {
      const name = `video:${event}`;
      // `video:error` 先到的是元素自己的 MediaError：必须在把事件交给上层之前把它翻译成失败码，
      // 否则 `failureCode()` 读到的会是上一条线路留下的旧值，遥测就记错了账。
      const wrapped = event === 'error'
        ? () => { lastFailure ??= classifyMediaError(art.video?.error?.code); if (lastFailure === null) lastFailure = 'http_error'; handler(); }
        : handler;
      art.on(name, wrapped);
      return () => art.off(name, wrapped);
    },
    // autoSize() 会按媒体比例缩小容器；舞台尺寸必须由宿主 CSS 保持。
    resize: () => { art.emit('resize'); }, destroy: () => { destroyHls(); art.destroy(); }
  };
};
