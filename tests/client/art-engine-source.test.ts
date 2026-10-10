import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createArtEngine } from '../../src/player/art-engine';

type Listener = (event: string, data: { fatal?: boolean; details?: string }) => void;
const mocks = vi.hoisted(() => ({
  video: {
    currentSrc: '', src: '', poster: '', playsInline: false, muted: false,
    setAttribute: vi.fn(), canPlayType: vi.fn(() => ''),
    play: vi.fn<() => Promise<void>>()
  },
  hls: [] as Array<{
    listeners: Map<string, Listener>; emit(event: string, data?: { fatal?: boolean; details?: string }): void;
    destroy: ReturnType<typeof vi.fn>; loadSource: ReturnType<typeof vi.fn>; attachMedia: ReturnType<typeof vi.fn>;
  }>,
  art: null as null | { destroy: ReturnType<typeof vi.fn> },
  setupEvent: '', emitOnDestroy: false
}));

vi.mock('artplayer', () => ({
  default: class {
    type = '';
    video = mocks.video;
    controls = { show: true };
    play = vi.fn(() => Promise.resolve());
    destroy = vi.fn();
    constructor(private options: { customType: { m3u8(video: unknown, url: string): void } }) {
      mocks.art = this;
    }
    set url(url: string) {
      mocks.video.currentSrc = url;
      if (this.type === 'm3u8') this.options.customType.m3u8(this.video, url);
      else mocks.video.src = url;
    }
  }
}));

vi.mock('hls.js', () => ({
  default: class {
    static Events = { MANIFEST_PARSED: 'manifest', ERROR: 'error' };
    static isSupported = () => true;
    listeners = new Map<string, Listener>();
    constructor() { mocks.hls.push(this); }
    on(event: string, listener: Listener) { this.listeners.set(event, listener); }
    emit(event: string, data = {}) { this.listeners.get(event)?.(event, data); }
    loadSource = vi.fn(() => {
      if (mocks.setupEvent === 'load') this.emit('error', { fatal: true, details: 'manifestLoadTimeOut' });
    });
    attachMedia = vi.fn(() => {
      mocks.video.currentSrc = 'blob:mock-media';
      if (mocks.setupEvent === 'attach') this.emit('manifest');
    });
    destroy = vi.fn(() => {
      if (mocks.emitOnDestroy) {
        this.emit('manifest');
        this.emit('error', { fatal: true, details: 'bufferAppendError' });
      }
    });
  }
}));

async function setup() {
  const onError = vi.fn();
  const engine = await createArtEngine({ container: {} as HTMLDivElement, theme: 'test', onError });
  engine.setSource('https://media.invalid/first.m3u8');
  return { engine, onError, first: mocks.hls[0] };
}

beforeEach(() => {
  mocks.hls.length = 0;
  mocks.art = null;
  mocks.setupEvent = '';
  mocks.emitOnDestroy = false;
  mocks.video.currentSrc = '';
  mocks.video.muted = false;
  mocks.video.play.mockReset().mockResolvedValue(undefined);
});

describe('Art engine HLS source identity', () => {
  it('starts playback with an MSE blob currentSrc', async () => {
    const { first } = await setup();
    expect(mocks.video.currentSrc).toBe('blob:mock-media');
    first.emit('manifest');
    expect(mocks.video.play).toHaveBeenCalledTimes(1);
  });

  it('reports current fatal errors with a blob currentSrc but ignores nonfatal errors', async () => {
    const { engine, onError, first } = await setup();
    first.emit('error', { fatal: false, details: 'bufferAppendError' });
    expect(onError).not.toHaveBeenCalled();
    first.emit('error', { fatal: true, details: 'bufferAppendError' });
    expect(onError).toHaveBeenCalledWith('播放中断，正在尝试备用线路', 'decode_error');
    expect(engine.failureCode?.()).toBe('decode_error');
  });

  it.each(['load', 'attach'])('registers listeners before %s setup callbacks', async (stage) => {
    mocks.setupEvent = stage;
    const { onError } = await setup();
    if (stage === 'load') expect(onError).toHaveBeenCalledWith('播放中断，正在尝试备用线路', 'timeout');
    else expect(mocks.video.play).toHaveBeenCalledTimes(1);
  });

  it('retries blocked playback muted for the current instance', async () => {
    const { first } = await setup();
    mocks.video.play.mockRejectedValueOnce(new Error('autoplay blocked'));
    first.emit('manifest');
    await Promise.resolve();
    expect(mocks.video.muted).toBe(true);
    expect(mocks.video.play).toHaveBeenCalledTimes(2);
  });

  it.each(['hls', 'mp4', 'destroy'])('invalidates old callbacks before %s teardown', async (transition) => {
    const { engine, onError, first } = await setup();
    mocks.video.currentSrc = 'https://media.invalid/first.m3u8';
    mocks.emitOnDestroy = true;
    if (transition === 'destroy') engine.destroy();
    else engine.setSource('https://media.invalid/second', transition === 'mp4' ? 'video/mp4' : undefined);
    first.emit('manifest');
    first.emit('error', { fatal: true, details: 'bufferAppendError' });
    expect(first.destroy).toHaveBeenCalledTimes(1);
    expect(mocks.video.play).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(engine.failureCode?.()).toBeNull();
    if (transition === 'hls') {
      const second = mocks.hls[1];
      second.emit('manifest');
      second.emit('error', { fatal: true, details: 'manifestLoadTimeOut' });
      expect(mocks.video.play).toHaveBeenCalledTimes(1);
      expect(engine.failureCode?.()).toBe('timeout');
    }
    if (transition === 'destroy') expect(mocks.art?.destroy).toHaveBeenCalledTimes(1);
  });

  it.each(['hls', 'mp4', 'destroy'])('does not retry an old rejected play after %s', async (transition) => {
    const { engine, first, onError } = await setup();
    mocks.video.currentSrc = 'https://media.invalid/first.m3u8';
    let rejectPlay!: (reason: Error) => void;
    mocks.video.play.mockReturnValueOnce(new Promise<void>((_resolve, reject) => { rejectPlay = reject; }));
    first.emit('manifest');
    expect(mocks.video.play).toHaveBeenCalledTimes(1);
    if (transition === 'destroy') engine.destroy();
    else engine.setSource('https://media.invalid/second', transition === 'mp4' ? 'video/mp4' : undefined);
    rejectPlay(new Error('autoplay blocked'));
    await Promise.resolve();
    expect(mocks.video.muted).toBe(false);
    expect(mocks.video.play).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('controls show state is updated via setControlsVisible', async () => {
    const { engine } = await setup();
    engine.setControlsVisible?.(false);
    expect((mocks.art as any)?.controls.show).toBe(false);
    engine.setControlsVisible?.(true);
    expect((mocks.art as any)?.controls.show).toBe(true);
  });
});
