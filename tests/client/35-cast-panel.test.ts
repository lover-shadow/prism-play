// @vitest-environment jsdom
/**
 * AC-24 端侧投屏状态机与操作岛（SPEC §1.5.1）。
 *
 * 只断言本包真的会跑的那半边：注入假桥与假时钟，把面板状态机、连播定时、私密拦截、平台降级与呼吸状态条
 * 钉成可复测的用例。真实组播发包、真实渲染器的 SOAP 应答、真机同网段表现都不在这里，也不许被说成在这里
 * 过了——行为证据只能来自 Master 手上的那台手机（见 verify_acceptance.py 的 AC-24 DEVICE_ONLY 条目）。
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildDetailBody } from '../../src/player/player-detail';
import { PROXY, harness, pick } from './cast-harness';
import { detailOf, settle } from './player-harness';

/** 静态对账用的样式正本：从当前工作目录向上找到仓库根，避免依赖 vitest 的 cwd 假设。 */
const readSource = (relative: string): string => {
  let directory = process.cwd();
  for (let depth = 0; depth < 5; depth += 1) {
    const candidate = join(directory, relative);
    if (existsSync(candidate)) return readFileSync(candidate, 'utf8');
    directory = dirname(directory);
  }
  throw new Error(`找不到正本 ${relative}`);
};

describe('AC-24 操作岛四键结构与降级口径', () => {
  it('AC-24 第二键是【投屏】，顺序为 追剧/投屏/分享/沉浸全屏，图标取 Lucide cast 的 20px 几何', () => {
    const stage = buildDetailBody(detailOf(), 11, () => undefined, () => undefined);
    const keys = Array.from(stage.body.querySelectorAll('.action-island-item'));
    expect(keys.map((item) => item.querySelector('span')?.textContent)).toEqual(['追剧', '投屏', '分享', '沉浸全屏']);
    expect(keys).toHaveLength(4);
    expect(keys[1].innerHTML).toContain('M2 8V6a2 2 0 0 1 2-2h16');
    expect(keys[1].innerHTML).toContain('width="20"');
    expect(stage.body.textContent).not.toContain('缓存本集');
    // 状态条与面板都挂在详情台里，随浮层一起拆装，不留游离节点。
    expect(stage.body.querySelector('.prism-cast')).not.toBeNull();
    expect(stage.body.querySelector('.prism-cast-banner')).not.toBeNull();
  });

  it('AC-24 私密剧目点【投屏】既不发起组播扫描也不发控制报文，只给一句不泄露元信息的拒答', async () => {
    const stage = buildDetailBody(detailOf({ isPrivate: true }), 11, () => undefined, () => undefined);
    const island = Array.from(stage.body.querySelectorAll<HTMLButtonElement>('.action-island-item'));
    island[1].click();
    await settle();
    expect(stage.body.querySelector('.prism-cast__status')?.textContent).toBe('该影片不支持投屏');
    expect(stage.body.querySelector('.prism-cast__device')).toBeNull();
    expect(stage.body.querySelector<HTMLElement>('.prism-cast-banner')?.hidden).toBe(true);
  });

  it('AC-24 网页版明确不支持：不假装能扫描，重扫键显式禁用而不是点了没反应', async () => {
    const h = harness({ supported: false });
    h.panel.open();
    await settle();
    expect(h.panel.phase()).toBe('unsupported');
    expect(h.status()).toContain('Android 客户端');
    expect(h.calls).toEqual([]);
    expect((h.node('.prism-cast__rescan') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('AC-24 半屏设备面板的状态', () => {
  it('AC-24 扫描成功后按 名称 + ip:port 列出设备行', async () => {
    const h = harness();
    h.panel.open();
    await settle();
    expect(h.panel.phase()).toBe('ready');
    expect(h.status()).toContain('已发现 1 台设备');
    expect(h.text('.prism-cast__device-name')).toBe('客厅的小米电视');
    expect(h.text('.prism-cast__device-meta')).toBe('192.168.31.88:49152');
  });

  it('AC-24 零设备时区分"没扫到"与"本机没有组播通道"', async () => {
    const none = harness({ devices: [] });
    none.panel.open();
    await settle();
    expect(none.status()).toContain('同一 Wi-Fi');
    const blocked = harness({ devices: [], probesSent: 0, multicastAvailable: false });
    blocked.panel.open();
    await settle();
    expect(blocked.status()).toContain('组播通道不可用');
  });

  it('AC-24 扫描失败说出原因，不停在"扫描中"让用户干等', async () => {
    const h = harness({ discoverError: '设备无响应' });
    h.panel.open();
    await settle();
    expect(h.panel.phase()).toBe('error');
    expect(h.status()).toContain('设备无响应');
  });

  it('AC-24 关闭正在扫描的面板立刻收掉原生扫描窗口（组播锁不多持有一秒）', async () => {
    const h = harness();
    h.panel.open();
    expect(h.panel.phase()).toBe('scanning');
    h.panel.close();
    await settle();
    expect(h.calls).toContain('stop');
    expect(h.sheet().hidden).toBe(true);
  });
});

describe('AC-24 激活态与自动连播', () => {
  it('AC-24 选定设备后推当前集的代理流，并亮出琥珀金状态条', async () => {
    const h = harness();
    await pick(h);
    expect(h.pushed).toEqual([{ id: 'lan-1', url: `${PROXY}&ep=11`, title: '测试剧 第1集' }]);
    expect(h.panel.phase()).toBe('casting');
    expect(h.banner().hidden).toBe(false);
    expect(h.text('.prism-cast-banner__text')).toBe('正在投屏至 客厅的小米电视');
    expect(h.sheet().hidden).toBe(true);
  });

  it('R26-06 duration does not prove renderer ended: never advance on a wall timer', async () => {
    const h = harness({ durationSeconds: 100 });
    await pick(h);
    expect(h.timers.delays).toEqual([]);
    h.timers.fire();
    await settle();
    expect(h.pushed).toHaveLength(1);
    expect(h.panel.phase()).toBe('casting');
  });

  it('AC-24 时长未知就不武装定时器，状态条也不许写"自动无缝连播"', async () => {
    const h = harness({ durationSeconds: null });
    await pick(h);
    expect(h.timers.armed()).toBe(false);
    expect(h.text('.prism-cast-banner__text')).toBe('正在投屏至 客厅的小米电视');
  });

  it('AC-24 末集不再连播：解武装并退出投屏', async () => {
    const h = harness();
    h.setCurrent(13);
    await pick(h);
    await h.panel.handleEpisodeEnded();
    expect(h.banner().hidden).toBe(true);
    expect(h.calls).toContain('control:stop');
    expect(h.panel.activeDevice()).toBeNull();
  });

  it('AC-24 暂停与继续各发一次对应 SOAP 动词，按钮文案与呼吸态同步', async () => {
    const h = harness();
    await pick(h);
    h.node('.prism-cast-banner__btn').click();
    await settle();
    expect(h.calls).toContain('control:pause');
    expect(h.panel.phase()).toBe('paused');
    expect(h.text('.prism-cast-banner__btn')).toBe('继续');
    expect(h.banner().classList.contains('is-paused')).toBe(true);
    expect(h.timers.armed()).toBe(false);
  });

  it('AC-24 退出投屏让大屏停下，而不是只把手机上的状态条收掉', async () => {
    const h = harness();
    await pick(h);
    Array.from(h.banner().querySelectorAll<HTMLButtonElement>('.prism-cast-banner__btn'))[1].click();
    await settle();
    expect(h.calls).toContain('control:stop');
    expect(h.banner().hidden).toBe(true);
    expect(h.panel.activeDevice()).toBeNull();
  });

  it('AC-24 手机切集时大屏跟到同一集，未投屏时切集不打扰任何设备', async () => {
    const h = harness();
    h.setCurrent(12);
    await h.panel.syncNow();
    expect(h.pushed).toHaveLength(0);
    await pick(h);
    h.setCurrent(13);
    await h.panel.syncNow();
    expect(h.pushed).toHaveLength(2);
    expect(h.pushed[1].url).toBe(`${PROXY}&ep=13`);
  });

  it('R26-06 destroy stops the actual renderer and discovery client', async () => {
    const h = harness(); await pick(h); h.panel.destroy(); await settle();
    expect(h.calls).toContain('control:stop'); expect(h.calls).toContain('stop');
  });

  it('AC-24 样式口径：设备行与状态条按钮命中区 ≥44px，取值全部来自 tokens 且零裸色值', () => {
    const css = readSource('src/player/cast.css');
    expect(css).toMatch(/min-height: 56px/);
    expect(css).toMatch(/min-height: 44px/);
    expect(css).toContain('var(--accent)');
    expect(css).not.toMatch(/#[0-9A-Fa-f]{3,8}/);
    // 面板上的字必须进 DOM：CSS content 里的文案读屏读不到。
    expect(css).not.toMatch(/content:\s*['“]/);
  });
});
