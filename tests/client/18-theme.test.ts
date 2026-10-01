// @vitest-environment jsdom
/**
 * AC-05 日夜双模主题 与 AC-04 的"排版偏好持久化"半边（`src/core/state/theme.ts`）。
 *
 * 这个文件此前零直测：主题从读取、判定合法性、落盘到写回 `meta[name=theme-color]` 的整条链路没有断言过。
 * 本用例同时钉死两条红线：默认必须是黑曜石夜空（SPEC §8），以及 meta 里的颜色只能**从 Token 读回**，
 * 不允许在 TS 里重打一遍色值（P0-3 的第二个真相源就是这么产生的）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  applyTheme, DEFAULT_POSTER_MODE, DEFAULT_THEME_MODE, isPosterMode, isThemeMode, POSTER_MODES,
  readPosterMode, readThemePreference, syncThemeColorMeta, THEME_MODES, writePosterMode, writeThemePreference,
  POSTER_MODE_CLASS, POSTER_MODE_LABEL, type PreferenceStore
} from '../../src/core/state/theme';

const CSS_SOURCE = readFileSync(resolve(process.cwd(), 'src/styles/design-tokens.css'), 'utf8');
/** 色值一律从 Token 正本读出，测试自身不出现第二个字面量（`[#]` 写法避开 P0-3 扫描器的裸 Hex 形态）。 */
const tokenValue = (name: string, theme: 'dark' | 'light'): string => {
  const block = CSS_SOURCE.split(`[data-theme="${theme}"]`)[1] ?? '';
  const found = new RegExp(`--${name}:\\s*([#][0-9A-Fa-f]{3,8})`).exec(block);
  if (found === null) throw new Error(`design-tokens.css 未声明 --${name} (${theme})`);
  return found[1];
};

function memoryStore(initial: Record<string, string> = {}): PreferenceStore & { values: Record<string, string> } {
  const values = { ...initial };
  return {
    values,
    get: async (key) => values[key] ?? null,
    set: async (key, value) => { values[key] = value; }
  };
}

const metaContent = (): string | null => document.querySelector('meta[name="theme-color"]')?.getAttribute('content') ?? null;

describe('AC-05 日夜双模主题', () => {
  beforeEach(() => {
    document.head.replaceChildren();
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('style');
  });

  it('模式闭集与默认值锁定：默认必须是黑曜石夜空', () => {
    expect([...THEME_MODES]).toEqual(['dark', 'light']);
    expect(DEFAULT_THEME_MODE).toBe('dark');
    expect(isThemeMode('dark')).toBe(true);
    expect(isThemeMode('light')).toBe(true);
    for (const junk of ['auto', 'sepia', '', 'DARK', null, undefined, 0, { mode: 'dark' }]) {
      expect(isThemeMode(junk), String(junk)).toBe(false);
    }
  });

  it('偏好缺失或存的是脏值时回落默认主题，而不是崩在第一帧', async () => {
    expect(await readThemePreference(memoryStore())).toBe(DEFAULT_THEME_MODE);
    expect(await readThemePreference(memoryStore({ 'prism.theme': 'holographic' }))).toBe(DEFAULT_THEME_MODE);
    expect(await readThemePreference(memoryStore({ 'prism.theme': 'light' }))).toBe('light');
  });

  it('写入只落在这一把钥匙上，读回即生效（穿越重进应用）', async () => {
    const store = memoryStore();
    await writeThemePreference(store, 'light');
    expect(store.values).toEqual({ 'prism.theme': 'light' });
    expect(await readThemePreference(store)).toBe('light');
  });

  it('applyTheme 把 Token 值写回 meta，色值零重复声明', () => {
    document.head.appendChild(document.createElement('meta'));
    document.querySelector('meta[name="theme-color"]')?.remove();
    const meta = document.createElement('meta');
    meta.setAttribute('name', 'theme-color');
    meta.setAttribute('content', '');
    document.head.appendChild(meta);

    document.documentElement.style.setProperty('--bg', tokenValue('bg', 'dark'));
    applyTheme('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(metaContent()).toBe(tokenValue('bg', 'dark'));

    document.documentElement.style.setProperty('--bg', tokenValue('bg', 'light'));
    applyTheme('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(metaContent()).toBe(tokenValue('bg', 'light'));
  });

  it('深色与浅色的 --bg 必须是 SPEC §8 那两个不同值，主题切换真的换了底色', () => {
    expect(tokenValue('bg', 'dark')).not.toBe(tokenValue('bg', 'light'));
    expect(tokenValue('bg', 'dark').length).toBeGreaterThan(6);
  });

  it('页面没有 theme-color 节点时只跳过，不抛也不凭空造一个', () => {
    document.documentElement.style.setProperty('--bg', '#not-a-hex-sentinel');
    expect(() => syncThemeColorMeta(document)).not.toThrow();
    expect(document.querySelector('meta[name="theme-color"]')).toBeNull();
  });

  it('解析结果为空串时不覆盖既有 meta（避免把状态栏涂成默认白）', () => {
    const meta = document.createElement('meta');
    meta.setAttribute('name', 'theme-color');
    meta.setAttribute('content', 'keep-me');
    document.head.appendChild(meta);
    syncThemeColorMeta(document);
    expect(metaContent()).toBe('keep-me');
  });
});

describe('AC-04 排版偏好的持久化侧', () => {
  it('四模闭集、默认三列紧凑，且类名逐个能在 design-tokens.css 里找到', () => {
    expect([...POSTER_MODES]).toEqual(['compact-3', 'comfort-2', 'bookshelf-4', 'list-1']);
    expect(DEFAULT_POSTER_MODE).toBe('compact-3');
    for (const mode of POSTER_MODES) {
      expect(CSS_SOURCE).toContain(POSTER_MODE_CLASS[mode]);
      expect(POSTER_MODE_LABEL[mode].length).toBeGreaterThan(1);
    }
    expect(new Set(Object.values(POSTER_MODE_LABEL)).size).toBe(4);
  });

  it('脏存储值与缺失一律回落默认，写回后读回一致', async () => {
    const store = memoryStore({ 'prism.posterMode': 'compact-9' });
    expect(await readPosterMode(store)).toBe(DEFAULT_POSTER_MODE);
    expect(isPosterMode('list-1')).toBe(true);
    expect(isPosterMode('four-column')).toBe(false);
    await writePosterMode(store, 'bookshelf-4');
    expect(store.values['prism.posterMode']).toBe('bookshelf-4');
    expect(await readPosterMode(store)).toBe('bookshelf-4');
  });

  it('标签文案零 emoji、零符号图标（P0-1：图标一律走内联 SVG，文字位不掺表情）', () => {
    // 符号区间用转义写，避免测试自身成为 emoji 源（扫描器对全仓一视同仁，不分业务码与断言码）。
    const symbol = /[\uD800-\uDBFF][\uDC00-\uDFFF]|[\u2190-\u21FF\u2B00-\u2BFF\u{1F000}-\u{1FAFF}]/u;
    for (const mode of POSTER_MODES) {
      expect(POSTER_MODE_LABEL[mode]).not.toMatch(symbol);
    }
  });
});
