/// <reference types="vite/client" />
/**
 * 生产内核：ArtPlayer 承担界面与事件，hls.js 承担受控代理清单（ADR-002）。
 *
 * 两者都在函数体内 `import()`——首屏不该为一个还没点开的播放器买单，
 * `npm run build` 也据此把它们切成懒加载 chunk（G4 交付证据）。
 */
import { clamp } from './gestures';
import type { EngineFactory } from './engine-seam';

/** Production engine: ArtPlayer for chrome and events, hls.js for the controlled proxy manifest. */
export const createArtEngine: EngineFactory = async ({ container, theme, poster, onError }) => {
  const [{ default: Artplayer }, { default: Hls }] = await Promise.all([import('artplayer'), import('hls.js')]);
  let hls: InstanceType<typeof Hls> | null = null;
  const blank = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  const initialPoster = poster || blank;
  const art = new Artplayer({
    container, url: '', poster: initialPoster, theme, volume: 1, autoplay: true, autoSize: false, isLive: false, lang: 'zh-cn', playsInline: true,
    customType: {
      m3u8: (video: HTMLVideoElement, url: string) => {
        hls?.destroy();
        video.poster = initialPoster; video.playsInline = true;
        video.setAttribute('playsinline', 'true'); video.setAttribute('webkit-playsinline', 'true');
        if (Hls.isSupported()) {
          hls = new Hls({ lowLatencyMode: false }); hls.loadSource(url); hls.attachMedia(video);
          hls.on(Hls.Events.MANIFEST_PARSED, () => { void video.play().catch(() => { video.muted = true; void video.play().catch(() => {}); }); });
          hls.on(Hls.Events.ERROR, (_e, data) => { if (data.fatal) onError('播放中断，正在尝试重新解析'); });
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) { video.src = url; void video.play().catch(() => {}); }
        else onError('当前设备不支持 HLS 播放，需在 Android 端验证');
      }
    }
  });
  return {
    play: () => void art.play(), pause: () => art.pause(), playing: () => art.playing,
    currentTime: () => art.currentTime, setCurrentTime: (s) => void (art.currentTime = s),
    duration: () => art.duration, volume: () => art.video.volume, setVolume: (v) => void (art.video.volume = clamp(v, 0, 1)),
    toggleControls: () => art.controls.toggle(),
    setSource: (u, m) => { art.type = m === 'video/mp4' ? 'mp4' : 'm3u8'; art.url = u; void art.play().catch(() => {}); },
    on: (event, handler) => { const name = `video:${event}`; art.on(name, handler); return () => art.off(name, handler); },
    resize: () => art.autoSize(), destroy: () => { hls?.destroy(); art.destroy(); }
  };
};
