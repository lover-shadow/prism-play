/**
 * Token parity for the edge-rendered HTML surfaces.
 *
 * This is the test that justifies the one exemption `tests/scan_p0.py` grants to `edge/src/html/` for
 * bare hex values (SPEC 10 forbids a site-level stylesheet on `/s`, so the palette must be inlined).
 * Without it that exemption would be the escape hatch for the two red lines it touches: P0-3 colour
 * drift away from `src/styles/design-tokens.*`, and P0-2 purple-to-pink as a primary visual. Nothing
 * here hardcodes a colour: every expected value is read from the JSON at test time, so a design-system
 * change either propagates into `theme.ts` or fails this suite.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ICON_SIZES,
  NIGHT_BACKGROUND,
  NIGHT_COLOR_TOKENS,
  inlineThemeStyles,
  lucideIcon,
  type NightColorToken
} from '../../edge/src/html/theme';
import { renderSharePage } from '../../edge/src/html/share-page';
import { renderAndroidDownloadPage, renderUnsupportedNoticePage, renderWeChatGuidePage } from '../../edge/src/html/dl-page';

const HEX_LITERAL = new RegExp('[#][0-9A-Fa-f]{3,8}\\b', 'g');

interface TokenEntry {
  value: string;
}

interface TokenGroup {
  [name: string]: TokenEntry;
}

interface TokenDocument {
  meta: {
    sourceOfTruth: string;
    // design-tokens.json stores the icon system as plain strings: "16px", "2", true.
    iconSystem: { strokeWidth: string; sizes: { inline: string; button: string; standalone: string }; emojiForbidden: boolean };
  };
  themes: { dark: { name: string; isDefault: boolean; color: TokenGroup }; light: { name: string; color: TokenGroup } };
  typography: { fontFamily: TokenGroup; fontSize: TokenGroup; leading: TokenGroup; tracking: TokenGroup };
  spacing: TokenGroup;
  radius: TokenGroup;
  motion: { duration: TokenGroup; easing: TokenGroup; reducedMotion: TokenGroup };
  interaction: { touchTargetMin: TokenEntry; states: string[] };
  layout: { containerMax: TokenGroup };
}

const TOKENS = JSON.parse(
  readFileSync(new URL('../../src/styles/design-tokens.json', import.meta.url), 'utf8')
) as TokenDocument;
const CSS_SOURCE = readFileSync(new URL('../../src/styles/design-tokens.css', import.meta.url), 'utf8');
const THEME_CSS = inlineThemeStyles();
const HTML_DIRECTORY = new URL('../../edge/src/html/', import.meta.url);

function darkColor(name: string): string {
  const entry = TOKENS.themes.dark.color[name];
  expect(entry, `design-tokens.json declares no dark colour "${name}"`).toBeDefined();
  return (entry as TokenEntry).value;
}

function expectDeclaration(css: string, name: string, value: string): void {
  // Asserted against the real emitted CSS, so a rename or a reformatted value fails loudly.
  expect(css, `--${name} must equal ${value}`).toContain(`--${name}: ${value};`);
}

/** Same hue band as scan_p0.py: purple 260 deg through pink 335 deg is banned as a primary visual. */
function hueOf(hexValue: string): number | null {
  const digits = hexValue.replace('#', '');
  if (digits.length !== 6) return null;
  const channels = [0, 2, 4].map((offset) => Number.parseInt(digits.slice(offset, offset + 2), 16) / 255);
  const [r, g, b] = channels as [number, number, number];
  const top = Math.max(r, g, b);
  const delta = top - Math.min(r, g, b);
  if (delta === 0) return null;
  let hue: number;
  if (top === r) hue = ((g - b) / delta) % 6;
  else if (top === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;
  return Math.round(hue * 60);
}

describe('night palette parity with design-tokens.json', () => {
  it('inlines every declared dark colour with the exact token value', () => {
    const names: readonly NightColorToken[] = NIGHT_COLOR_TOKENS;
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expectDeclaration(THEME_CSS, name, darkColor(name));
  });

  it('carries the four identity tokens SPEC 8 pins and keeps the night theme the default', () => {
    const required: NightColorToken[] = ['bg', 'surface', 'fg', 'accent'];
    for (const name of required) expect(NIGHT_COLOR_TOKENS).toContain(name);
    expect(NIGHT_BACKGROUND).toBe(darkColor('bg'));
    expect(TOKENS.themes.dark.isDefault).toBe(true);
    // Day and night must not collapse into one value: SPEC 5 / AC-05 switches the obsidian base for
    // the ivory one, and this inline block is night-only by design, so the light value must differ.
    expect(TOKENS.themes.light.color.bg.value).not.toBe(darkColor('bg'));
    expect(TOKENS.themes.light.color.accent.value).not.toBe(darkColor('accent'));
  });

  it('agrees with design-tokens.css, the declared source of truth', () => {
    expect(TOKENS.meta.sourceOfTruth).toBe('src/styles/design-tokens.css');
    for (const name of ['bg', 'surface', 'fg', 'accent']) {
      // The dark `:root` block is first in the CSS file, so the first declaration is the night value.
      const declared = new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{3,8})`).exec(CSS_SOURCE);
      expect(declared?.[1], `${name} is missing from design-tokens.css`).toBeDefined();
      expect((declared?.[1] as string).toUpperCase()).toBe(darkColor(name).toUpperCase());
    }
  });

  it('maps the non-colour tokens too, so the inline page is not free-styled', () => {
    expectDeclaration(THEME_CSS, 'font-body', TOKENS.typography.fontFamily.body.value);
    expectDeclaration(THEME_CSS, 'text-base', TOKENS.typography.fontSize.base.value);
    expectDeclaration(THEME_CSS, 'text-sm', TOKENS.typography.fontSize.sm.value);
    expectDeclaration(THEME_CSS, 'text-xs', TOKENS.typography.fontSize.xs.value);
    expectDeclaration(THEME_CSS, 'text-lg', TOKENS.typography.fontSize.lg.value);
    expectDeclaration(THEME_CSS, 'leading-normal', TOKENS.typography.leading.normal.value);
    expectDeclaration(THEME_CSS, 'tracking-tight', TOKENS.typography.tracking.tight.value);
    expectDeclaration(THEME_CSS, 'tracking-caps', TOKENS.typography.tracking.caps.value);
    expectDeclaration(THEME_CSS, 'space-2', TOKENS.spacing['2'].value);
    expectDeclaration(THEME_CSS, 'space-4', TOKENS.spacing['4'].value);
    expectDeclaration(THEME_CSS, 'radius-md', TOKENS.radius.md.value);
    expectDeclaration(THEME_CSS, 'radius-pill', TOKENS.radius.pill.value);
    expectDeclaration(THEME_CSS, 'duration-normal', TOKENS.motion.duration.normal.value);
    expectDeclaration(THEME_CSS, 'easing-standard', TOKENS.motion.easing.standard.value);
    expectDeclaration(THEME_CSS, 'touch-target', TOKENS.interaction.touchTargetMin.value);
    expectDeclaration(THEME_CSS, 'container-mobile', TOKENS.layout.containerMax.mobile.value);
    // SPEC 10 accessibility floor: 44px targets and a visible focus ring, tokenised not magic-numbered.
    expect(TOKENS.interaction.touchTargetMin.value).toBe('44px');
    expect(THEME_CSS).toContain(':focus-visible');
    expect(THEME_CSS).toContain('@media (prefers-reduced-motion: reduce)');
    expectDeclaration(THEME_CSS, 'container-mobile', TOKENS.layout.containerMax.mobile.value);
    expect(TOKENS.motion.reducedMotion.duration.value).toBe('0ms');
    expect(THEME_CSS).toContain('0ms');
  });
});

describe('P0 red lines, enforced from the test side', () => {
  it('P0-2: no gradient at all, and no hex inside the purple-to-pink band', () => {
    expect(THEME_CSS).not.toMatch(/linear-gradient|radial-gradient|conic-gradient/i);
    const literals = THEME_CSS.match(HEX_LITERAL) ?? [];
    expect(literals.length).toBeGreaterThan(0);
    for (const literal of literals) {
      const hue = hueOf(literal);
      if (hue !== null) expect(hue >= 260 && hue <= 335, `${literal} sits in the banned band`).toBe(false);
    }
  });

  it('P0-3: theme.ts is the only html module that may carry a hex literal', () => {
    const files = readdirSync(HTML_DIRECTORY).filter((name) => name.endsWith('.ts'));
    expect(files).toEqual(expect.arrayContaining(['escape.ts', 'theme.ts', 'share-page.ts', 'dl-page.ts']));
    for (const name of files) {
      const text = readFileSync(new URL(name, HTML_DIRECTORY), 'utf8');
      const hits = text.match(HEX_LITERAL) ?? [];
      if (name === 'theme.ts') expect(hits.length).toBeGreaterThan(0);
      else expect(hits, `${name} must consume tokens, not colours`).toEqual([]);
    }
  });

  it('P0-3: rendered documents add no colour of their own', () => {
    const pages = [
      renderSharePage({ dramaId: 'work-1', title: '测试剧目', episodeNumber: 4, mediaUrl: '/proxy/media/e_4.a.b?exp=1&sig=2' }),
      renderWeChatGuidePage({ ref: 'GY-1024ABCD' }),
      renderAndroidDownloadPage({}),
      renderUnsupportedNoticePage({ audience: 'windows', origin: 'http://localhost:8787' })
    ];
    const allowed = [...(THEME_CSS.match(HEX_LITERAL) ?? []), NIGHT_BACKGROUND];
    for (const page of pages) {
      const extra = (page.match(HEX_LITERAL) ?? []).filter((literal) => !allowed.includes(literal));
      expect(extra, 'a page introduced a colour outside the token block').toEqual([]);
      expect(page).toContain('var(--accent)');
      expect(page).not.toMatch(/linear-gradient|radial-gradient|conic-gradient/i);
      // SPEC 10 分享页资源策略: no external stylesheet, script, font or CDN reference anywhere.
      expect(page).not.toMatch(/<script[^>]+\bsrc=/i);
      expect(page).not.toMatch(/<link\b|@import|@font-face/i);
    }
  });

  it('P0-1: icons are Lucide inline SVG at 16/20/24 with a 2px stroke, never pictographs', () => {
    expect([...ICON_SIZES]).toEqual(
      [TOKENS.meta.iconSystem.sizes.inline, TOKENS.meta.iconSystem.sizes.button, TOKENS.meta.iconSystem.sizes.standalone].map(
        (value) => Number.parseInt(value, 10)
      )
    );
    expect(TOKENS.meta.iconSystem.emojiForbidden).toBe(true);
    expect(TOKENS.meta.iconSystem.strokeWidth).toBe('2');
    const documents = [
      renderSharePage({ dramaId: 'work-1', title: '测试剧目', episodeNumber: 1, mediaUrl: '/proxy/media/e_1.a.b?exp=1&sig=2' }),
      renderWeChatGuidePage({}),
      renderAndroidDownloadPage({ ref: 'GY-1' }),
      renderUnsupportedNoticePage({})
    ];
    for (const size of ICON_SIZES) {
      const svg = lucideIcon('play', size);
      expect(svg).toContain(`width="${size}" height="${size}" viewBox="0 0 24 24"`);
      expect(svg).toContain('stroke-width="2"');
      expect(svg).toContain('aria-hidden="true"');
    }
    for (const document of documents) {
      const sizes = [...document.matchAll(/<svg class="icon" width="(\d+)" height="(\d+)" viewBox="0 0 24 24"/g)];
      expect(sizes.length).toBeGreaterThan(0);
      for (const match of sizes) {
        expect(Number(match[1])).toBe(Number(match[2]));
        expect([...ICON_SIZES]).toContain(Number(match[1]));
      }
      expect(document).not.toMatch(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u);
    }
  });
});
