// @vitest-environment jsdom
/**
 * 分享出站与轻提示的单元面：分享链接的线协议形态、两条出站通道的降级次序、失败必须被说出来。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createShareAction } from '../../src/core/share';
import { createNotice } from '../../src/components/notice';
import type { ContentItem, EpisodeItem } from '../../edge/src/types/api';
import type { PrismNativeBridge } from '../../src/core/native/bridge';

const CONTENT: ContentItem = { id: 'drama 1/', channelId: 'drama', title: '凤逆天下', category: '都市', isPrivate: false };
const EPISODE: EpisodeItem = { episodeId: 88, episodeNumber: 7, durationSeconds: 120 };

function share(options: { clipboard: 'ok' | 'denied' | 'absent'; externalFails?: boolean } = { clipboard: 'ok' }) {
  const writeText = options.clipboard === 'absent'
    ? undefined
    : vi.fn(async () => {
      if (options.clipboard === 'denied') throw new Error('NotAllowedError');
    });
  Object.defineProperty(navigator, 'clipboard', { value: writeText === undefined ? undefined : { writeText }, configurable: true, writable: true });
  const reports: string[] = [];
  const opened: string[] = [];
  const bridge = {
    openExternalUrl: async (url: string) => {
      if (options.externalFails === true) throw new Error('no channel');
      opened.push(url);
    }
  } as unknown as PrismNativeBridge;
  const action = createShareAction({ bridge, report: (message) => reports.push(message), origin: 'https://play.prismos.org' });
  return { action, reports, opened, writeText };
}

describe('分享出站', () => {
  beforeEach(() => { document.body.replaceChildren(); vi.useRealTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('播放中分享带上当前集数，id 经百分号编码，端点形态符合 /s/:id?ep=集数', async () => {
    const h = share();
    await h.action(CONTENT, EPISODE);
    expect(h.opened).toEqual([]);
    expect(h.writeText?.mock.calls).toEqual([['https://play.prismos.org/s/drama%201%2F?ep=7']]);
    expect(h.reports).toEqual(['分享链接已复制，可直接粘贴给好友']);
  });

  it('海报卡分享无播放上下文时落第一集（缺失 ep 的边缘答案是 404，不能省略）', async () => {
    const h = share({ clipboard: 'denied' });
    await h.action(CONTENT);
    expect(h.opened).toEqual(['https://play.prismos.org/s/drama%201%2F?ep=1']);
  });

  it('剪贴板被拒时退回系统分享通道，而不是静默', async () => {
    const h = share({ clipboard: 'denied' });
    await h.action(CONTENT, EPISODE);
    expect(h.opened).toEqual(['https://play.prismos.org/s/drama%201%2F?ep=7']);
    expect(h.reports).toEqual([]);
  });

  it('两条通道都不通才报错，且报错文案不假装成功', async () => {
    const h = share({ clipboard: 'absent', externalFails: true });
    await h.action(CONTENT, EPISODE);
    expect(h.opened).toEqual([]);
    expect(h.reports).toEqual(['分享失败：本机无可用分享通道']);
  });
});

describe('轻提示', () => {
  it('同屏只保留一条，新消息复用节点', () => {
    const app = document.createElement('div');
    document.body.replaceChildren(app);
    const report = createNotice(app);
    report('第一条');
    report('第二条');
    expect(app.querySelectorAll('.app-notice')).toHaveLength(1);
    const node = app.querySelector('.app-notice');
    expect(node?.textContent).toBe('第二条');
    expect(node?.getAttribute('role')).toBe('status');
    expect(node?.getAttribute('aria-live')).toBe('polite');
  });

  it('到期自动收起，期间的第二条消息把计时重置到新时长', () => {
    vi.useFakeTimers();
    const app = document.createElement('div');
    document.body.replaceChildren(app);
    const report = createNotice(app, 5_000);
    report('A');
    vi.advanceTimersByTime(4_000);
    report('B');
    vi.advanceTimersByTime(4_000);
    expect(app.querySelector('.app-notice')?.textContent).toBe('B');
    vi.advanceTimersByTime(1_000);
    expect(app.querySelector('.app-notice')).toBeNull();
    vi.useRealTimers();
  });
});
