import { createArtEngine } from './art-engine';
import { createExoEngine } from './exo-engine';
import type { MediaEvent, PlayerEngine } from './engine-seam';
import type { TitleDetail } from '../../edge/src/types/api';
import type { PlayerFailure, PrismPlayerOptions } from './player-contract';
import type { createValueChannels } from './value-channel';

export interface EngineSetupContext {
  options: PrismPlayerOptions;
  container: HTMLDivElement;
  detail: TitleDetail | null;
  getDirect(): number | null;
  getEngine(): PlayerEngine | null;
  savedVolume: number;
  locked: boolean;
  backgroundAudioOn: boolean;
  episodeNumber(): number;
  handleMediaEvent(event: MediaEvent, generation: number): void;
  noteLineFailure(): void;
  report(failure: PlayerFailure): void;
  channels: ReturnType<typeof createValueChannels>;
}

export async function buildPlayerEngine(
  ctx: EngineSetupContext,
  native: boolean,
  generation: number,
  isCurrent: () => boolean
): Promise<{ engine: PlayerEngine; mediaOff: (() => void)[] } | null> {
  const { options, container, detail } = ctx;
  const theme = getComputedStyle(document.documentElement).getPropertyValue('--player-accent').trim();
  let live: PlayerEngine | null = null;
  const created = await (options.engine ?? (native ? createExoEngine : createArtEngine))({
    container,
    theme,
    poster: detail?.item.coverUrl,
    resolveNative: async (source) => {
      const direct = ctx.getDirect();
      if (!options.api.nativePlayback || direct === null) throw new Error('原生播放复核不可用');
      const number = ctx.episodeNumber(), index = direct;
      const checked = await options.api.nativePlayback(options.titleId, number, index);
      if (!isCurrent() || checked.workId !== options.titleId || checked.episodeNumber !== number || checked.lineIndex !== index ||
          checked.native?.kind !== source.kind || !/^\d{1,32}$/.test(checked.native.videoId) ||
          checked.native.videoId !== source.videoId) throw new Error('播放身份已变化');
      return checked.native;
    },
    onError: (message) => {
      if (!isCurrent() || live === null || ctx.getEngine() !== live) return;
      if (ctx.getDirect() !== null) ctx.noteLineFailure(); else ctx.report({ kind: 'media', message });
    }
  });
  if (!isCurrent()) { created.destroy(); return null; }
  live = created;
  live.setVolume(ctx.savedVolume);
  live.setControlsLocked?.(ctx.locked);
  live.setBackgroundAllowed?.(ctx.backgroundAudioOn);
  const mediaOff = (['ended', 'timeupdate', 'play', 'playing', 'pause', 'waiting', 'seeking', 'seeked', 'error', 'loadedmetadata'] as const).map(
    (event) => created.on(event, () => { ctx.handleMediaEvent(event, generation); })
  );
  await ctx.channels.sync();
  return isCurrent() ? { engine: created, mediaOff } : (created.destroy(), null);
}
