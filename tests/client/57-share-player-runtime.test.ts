/**
 * The `/s` share player at run time (SPEC-STATIC-PAGES v2 AC-S1-1..AC-S1-6, AC-S2-3, AC-S2-4).
 *
 * `tests/edge/80-share-page.test.ts` pins the document; this file executes it. The distinction is the
 * whole point: the shipped defect was a share page that looked right and never assigned a source, so
 * every assertion here is about what the inline script actually does to the element - which channel it
 * takes, what it hands the engine, and which card it reveals when a line fails.
 *
 * It lives in `tests/client` rather than `tests/edge` because it needs a DOM: `edge/tsconfig.json`
 * compiles without `lib.dom`, so a page-driver belongs to the root project. jsdom has no media stack,
 * hence `play`/`load`/`pause`/`canPlayType`/`scrollIntoView` are replaced with instruments before the
 * page's own script is evaluated; the probe, the injected `<script>` element and the manifest `fetch`
 * are exercised exactly as written.
 */

// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderSharePage } from '../../edge/src/html/share-page';

const FIRST_LINE = 'https://cdn.invalid/first.m3u8';
const SECOND_LINE = 'https://cdn.invalid/second.m3u8';
const MANIFEST_PATH = '/api/titles/work-1';
const CHROME_AGENT = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36';
const CONTAINER_AGENT = `${CHROME_AGENT} MMWEBSDK/202305 MicroMessenger/8.0.40`;

/** The v2 §2.1 episode manifest, exactly as Track 2 serves it. */
const MANIFEST = {
  workId: 'work-1',
  title: '战神归来',
  channelId: 'drama',
  isPrivate: false,
  episodes: [
    { episodeNumber: 2, title: '第2集', durationSeconds: 120, lines: [{ providerId: 'provider_m1', mediaUrl: FIRST_LINE }] },
    {
      episodeNumber: 3,
      title: '第3集',
      durationSeconds: 130,
      lines: [
        { providerId: 'provider_m1', mediaUrl: FIRST_LINE },
        { providerId: 'provider_m2', mediaUrl: SECOND_LINE }
      ]
    }
  ],
  generatedAt: 1790000000
};

const DOCUMENT = renderSharePage({ dramaId: 'work-1', title: '战神归来', episodeNumber: 3, durationSeconds: 130 });
const INLINE_SCRIPT = /<script>([\s\S]*?)<\/script>/.exec(DOCUMENT)?.[1] ?? '';

interface EngineStub {
  readonly sources: string[];
  readonly attached: HTMLMediaElement[];
  fatal(): void;
}

interface Harness {
  readonly video: HTMLVideoElement;
  playCalls(): number;
  hidden(id: string): boolean;
  text(id: string): string;
  click(id: string): boolean;
  engineScript(): HTMLScriptElement | null;
  installEngine(): EngineStub;
}

interface MountOptions {
  readonly native: boolean;
  readonly autoplayRejected?: boolean;
  readonly weChat?: boolean;
}

function mount(options: MountOptions): Harness {
  let playCalls = 0;
  Object.defineProperty(window.navigator, 'userAgent', { value: options.weChat === true ? CONTAINER_AGENT : CHROME_AGENT, configurable: true });
  HTMLMediaElement.prototype.load = () => undefined;
  HTMLMediaElement.prototype.pause = () => undefined;
  HTMLMediaElement.prototype.canPlayType = () => (options.native === false ? '' : 'maybe');
  HTMLMediaElement.prototype.play = () => {
    playCalls += 1;
    return options.autoplayRejected === true ? Promise.reject(new Error('NotAllowedError')) : Promise.resolve();
  };
  Element.prototype.scrollIntoView = () => undefined;
  // The environment is shared by every test in this file, so the engine global from an earlier mount
  // would short-circuit the injection this harness is supposed to observe.
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'Hls');
  window.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    if (url !== MANIFEST_PATH) return Promise.reject(new Error(`unexpected fetch: ${url}`));
    return Promise.resolve({ ok: true, json: () => Promise.resolve(MANIFEST) } as unknown as Response);
  }) as unknown as typeof window.fetch;

  // The markup is mounted without its script (innerHTML never executes), then evaluated by hand.
  document.documentElement.innerHTML = DOCUMENT.replace(/<script>[\s\S]*?<\/script>/, '');
  window.eval(INLINE_SCRIPT);

  const element = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;
  return {
    video: element('prism-video') as HTMLVideoElement,
    playCalls: () => playCalls,
    hidden: (id: string) => element(id).hidden,
    text: (id: string) => element(id).textContent ?? '',
    // Returns whether the click was swallowed, which is the whole difference between the two UAs.
    click: (id: string) => {
      const event = new MouseEvent('click', { bubbles: true, cancelable: true });
      element(id).dispatchEvent(event);
      return event.defaultPrevented;
    },
    engineScript: () =>
      ([...document.querySelectorAll('script')].find((node) => (node.getAttribute('src') ?? '') !== '') as HTMLScriptElement | undefined) ?? null,
    installEngine: () => {
      const sources: string[] = [];
      const attached: HTMLMediaElement[] = [];
      const handlers = new Map<string, (event: string, data: unknown) => void>();
      const stub = {
        sources,
        attached,
        loadSource: (url: string) => void sources.push(url),
        attachMedia: (media: HTMLMediaElement) => void attached.push(media),
        on: (name: string, callback: (event: string, data: unknown) => void) => void handlers.set(name, callback),
        destroy: () => undefined,
        fatal: () => handlers.get('error')?.('error', { fatal: true, type: 'networkError', details: 'levelLoadError' })
      };
      function Hls(): typeof stub {
        return stub;
      }
      Hls.isSupported = () => true;
      Hls.Events = { ERROR: 'error', MANIFEST_PARSED: 'manifestParsed' };
      (window as unknown as Record<string, unknown>).Hls = Hls;
      return stub as unknown as EngineStub;
    }
  };
}

/** The page resolves the manifest through two promise hops before it touches the element. */
async function settled(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function failLine(harness: Harness): void {
  harness.video.dispatchEvent(new Event('error'));
}

describe('channel A: a host that answers the HLS probe plays natively', () => {
  it('assigns the requested episode line and attempts playback (AC-S1-1, AC-S1-3)', async () => {
    const harness = mount({ native: true });
    await settled();
    expect(harness.video.getAttribute('src')).toBe(FIRST_LINE);
    expect(harness.playCalls()).toBeGreaterThan(0);
    expect(harness.hidden('prism-state')).toBe(true);
  });

  it('walks the fallback lines, then stops at an honest state card (S-1.6)', async () => {
    const harness = mount({ native: true });
    await settled();
    failLine(harness);
    await settled();
    expect(harness.video.getAttribute('src')).toBe(SECOND_LINE);
    failLine(harness);
    await settled();
    expect(harness.hidden('prism-state')).toBe(false);
    expect(harness.text('prism-state-text')).toContain('当前线路暂不可用');
    // The card names no line, no provider and no host: 去平台化 holds on the failure path too.
    expect(harness.text('prism-state')).not.toContain('cdn.invalid');
    expect(harness.text('prism-state')).not.toContain('provider_');
  });

  it('keeps the tap control up when the autoplay policy says no (AC-S1-4)', async () => {
    const harness = mount({ native: true, autoplayRejected: true });
    await settled();
    expect(harness.hidden('prism-tap')).toBe(false);
    expect(harness.playCalls()).toBe(1);
    harness.click('prism-play');
    await settled();
    expect(harness.playCalls()).toBe(2);
  });


  it('dismisses the tap control on the play event, never on the attempt', async () => {
    const harness = mount({ native: true });
    await settled();
    // play() resolving is not proof of playback: only the element's own `play` event hides the card.
    expect(harness.hidden('prism-tap')).toBe(false);
    harness.video.dispatchEvent(new Event('play'));
    expect(harness.hidden('prism-tap')).toBe(true);
  });
});

describe('channel B: a host that fails the probe gets the self-hosted MSE engine (AC-S1-2)', () => {
  it('injects the same-origin engine and drives the element through it', async () => {
    const harness = mount({ native: false });
    await settled();
    const injected = harness.engineScript();
    expect(injected).not.toBeNull();
    expect(injected?.getAttribute('src')).toBe('/assets/hls.min.js');
    expect(injected?.parentElement?.tagName).toBe('HEAD');
    // Nothing plays before the engine reports back, and the media element is never pointed at it.
    expect(harness.video.getAttribute('src')).toBeNull();
    expect(harness.playCalls()).toBe(0);
    const stub = harness.installEngine();
    injected?.dispatchEvent(new Event('load'));
    await settled();
    expect(stub.attached).toEqual([harness.video]);
    expect(stub.sources).toEqual([FIRST_LINE]);
  });

  it('retries the next line on a fatal engine error, then reports it (S-1.6)', async () => {
    const harness = mount({ native: false });
    await settled();
    const stub = harness.installEngine();
    harness.engineScript()?.dispatchEvent(new Event('load'));
    await settled();
    stub.fatal();
    await settled();
    expect(stub.sources).toEqual([FIRST_LINE, SECOND_LINE]);
    expect(harness.hidden('prism-state')).toBe(true);
    stub.fatal();
    await settled();
    expect(harness.hidden('prism-state')).toBe(false);
    expect(harness.text('prism-state-text')).toContain('当前线路暂不可用');
  });

  it('falls to the state card when the engine itself cannot be fetched', async () => {
    const harness = mount({ native: false });
    await settled();
    harness.engineScript()?.dispatchEvent(new Event('error'));
    await settled();
    expect(harness.text('prism-state-text')).toContain('播放组件未能载入');
  });

  it('asks the network for nothing but its own origin (AC-S1-6)', async () => {
    const harness = mount({ native: false });
    await settled();
    const injected = harness.engineScript();
    // The engine tag is the only external request the document can make, and it is same-origin.
    expect(injected?.src.startsWith(window.location.origin)).toBe(true);
    expect(injected?.getAttribute('src')).toBe('/assets/hls.min.js');
  });
});

describe('the rest of the page reacts (AC-13, AC-S2-3, AC-S2-4)', () => {
  it('reveals the 截流 card only when the episode ends', async () => {
    const harness = mount({ native: true });
    await settled();
    expect(harness.hidden('prism-card')).toBe(true);
    harness.video.dispatchEvent(new Event('ended'));
    await settled();
    expect(harness.hidden('prism-card')).toBe(false);
    expect(harness.hidden('prism-tap')).toBe(true);
  });

  it('renders the episode rail from the manifest and keeps a preview inert', async () => {
    const harness = mount({ native: true });
    await settled();
    const rail = document.getElementById('prism-rail') as HTMLElement;
    const chips = [...rail.querySelectorAll('button.chip')];
    expect(rail.hidden).toBe(false);
    expect(chips.map((chip) => chip.textContent)).toEqual(['第 2 集', '第 3 集']);
    expect(chips[1]?.className).toContain('is-current');
    expect(chips[1]?.getAttribute('aria-current')).toBe('true');
    expect(harness.hidden('prism-rail-hint')).toBe(true);
    const before = window.location.href;
    chips[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await settled();
    expect(harness.hidden('prism-rail-hint')).toBe(false);
    // A preview never loads a stream and never navigates.
    expect(harness.video.getAttribute('src')).toBe(FIRST_LINE);
    expect(window.location.href).toBe(before);
  });

  it('asks for the browser hand-off inside WeChat, and does nothing outside it', async () => {
    const inside = mount({ native: true, weChat: true });
    await settled();
    expect(inside.hidden('prism-mask')).toBe(true);
    expect(inside.click('prism-dock')).toBe(true);
    await settled();
    expect(inside.hidden('prism-mask')).toBe(false);
    expect(inside.text('prism-mask')).toContain('不承诺绕过任何平台限制');
    inside.click('prism-mask-close');
    await settled();
    expect(inside.hidden('prism-mask')).toBe(true);

    const outside = mount({ native: true });
    await settled();
    expect(outside.click('prism-dock')).toBe(false);
    expect(outside.hidden('prism-mask')).toBe(true);
  });
});
