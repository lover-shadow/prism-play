/**
 * The inline visual base for the edge-rendered HTML surfaces (`/s`, `/dl`, `/`).
 *
 * SPEC 10 pins those documents to "边缘直出的极简内联样式，不引入站点级 CSS/JS 资产": a shared
 * stylesheet cannot be fetched on a weak connection, so the token block is inlined instead. That is
 * the ONLY reason this file carries bare colour values, and it is the only file in the repository
 * that may. `tests/edge/83-token-parity.test.ts` reconciles every value below against
 * `src/styles/design-tokens.json` at test time; without that test this file would be the escape
 * hatch for the P0-2 (purple/pink gradient) and P0-3 (colour drift) red lines.
 *
 * Rules enforced here and proven by that test:
 *   - `inlineThemeStyles()` is the night palette (the share page is a cinema surface, no theme switch
 *     is negotiated in its URL); `inlineDayPaletteStyles()` layers the ivory day palette on top of it
 *     behind `prefers-color-scheme`, and only the portal opts into that second layer;
 *   - amber gold `--accent` on obsidian `--bg`; no gradient of any kind, purple or otherwise;
 *   - every rule consumes a token, so the page modules contain zero colour;
 *   - icons are Lucide inline SVG and the size set is closed at 16 / 20 / 24 px (see `lucide-icons.ts`).
 */

import { escapeText } from './escape';

export { ICON_SIZES, lucideIcon, type IconSize, type LucideIconName } from './lucide-icons';

/**
 * design-tokens.json `themes.dark.color` keys that this surface inlines, name for name. The day
 * palette below is keyed by the very same list, so the two modes can never drift apart in coverage.
 */
export const NIGHT_COLOR_TOKENS = [
  'bg',
  'surface',
  'surface-raised',
  'surface-overlay',
  'fg',
  'fg-2',
  'muted',
  'border',
  'accent',
  'accent-on',
  'accent-subtle',
  'player-bg',
  'player-hud-bg',
  'warn',
  'warn-subtle'
] as const;

export type NightColorToken = (typeof NIGHT_COLOR_TOKENS)[number];

/**
 * Values are the design-token literals; the parity test reads the JSON and fails on any mismatch,
 * so a rename here is caught rather than shipped.
 */
const NIGHT_COLORS: Readonly<Record<NightColorToken, string>> = {
  bg: '#080A10',
  surface: '#12151F',
  'surface-raised': '#1A1F2C',
  'surface-overlay': 'rgba(8, 10, 16, 0.82)',
  fg: '#F4F6FB',
  'fg-2': '#C5CBD8',
  muted: '#7E8698',
  border: '#222736',
  accent: '#E5A93C',
  'accent-on': '#080A10',
  'accent-subtle': 'rgba(229, 169, 60, 0.12)',
  'player-bg': '#000000',
  'player-hud-bg': 'rgba(8, 10, 16, 0.72)',
  warn: '#F59E0B',
  'warn-subtle': 'rgba(245, 158, 11, 0.14)'
};

/**
 * The ivory day palette (AGENTS.md P0-2: 日间主背景 `#F5F6FA`), keyed by exactly the same token names
 * as the night block so a page never has to know which of the two it is rendering. Only the portal
 * mounts it; the share page stays night-only. Same parity test, same no-gradient rule.
 */
const DAY_COLORS: Readonly<Record<NightColorToken, string>> = {
  bg: '#F5F6FA',
  surface: '#FFFFFF',
  'surface-raised': '#FFFFFF',
  'surface-overlay': 'rgba(245, 246, 250, 0.88)',
  fg: '#131720',
  'fg-2': '#3E4656',
  muted: '#6C7486',
  border: '#DFE2EA',
  accent: '#B87B14',
  'accent-on': '#131720',
  'accent-subtle': 'rgba(184, 123, 20, 0.10)',
  'player-bg': '#000000',
  'player-hud-bg': 'rgba(19, 23, 32, 0.85)',
  warn: '#B45309',
  'warn-subtle': 'rgba(180, 83, 9, 0.12)'
};

/** Non-colour tokens are inlined from the same source of truth (typography / radius / spacing / motion). */
const TYPOGRAPHY_TOKENS: Readonly<Record<string, string>> = {
  'font-body': "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
  'font-display': "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
  'text-xs': '12px',
  'text-sm': '13px',
  'text-base': '15px',
  'text-md': '17px',
  'text-lg': '20px',
  'text-xl': '24px',
  'text-display': '32px',
  'leading-normal': '1.5',
  'leading-tight': '1.25',
  'tracking-tight': '-0.015em',
  'tracking-caps': '0.06em'
};

const STRUCTURE_TOKENS: Readonly<Record<string, string>> = {
  'space-1': '4px',
  'space-2': '8px',
  'space-3': '12px',
  'space-4': '16px',
  'space-5': '20px',
  'space-6': '24px',
  'space-8': '32px',
  'space-10': '40px',
  'space-12': '48px',
  'radius-xs': '4px',
  'radius-sm': '6px',
  'radius-md': '10px',
  'radius-lg': '14px',
  'radius-pill': '9999px',
  'duration-fast': '150ms',
  'duration-normal': '240ms',
  'easing-standard': 'cubic-bezier(0.2, 0, 0, 1)',
  'touch-target': '44px',
  'container-mobile': '480px',
  'container-tablet': '820px',
  'container-desktop': '1200px'
};

/** The `theme-color` meta needs the raw night background; it is exported rather than duplicated. */
export const NIGHT_BACKGROUND = NIGHT_COLORS.bg;
/** The portal's light `theme-color` meta needs the ivory base; same reason, exported not duplicated. */
export const DAY_BACKGROUND = DAY_COLORS.bg;

function declarations(table: Readonly<Record<string, string>>, indent = '  '): string {
  return Object.entries(table)
    .map(([name, value]) => `${indent}--${name}: ${value};`)
    .join('\n');
}

/** The `:root` block. One call per document; the strings are static, so nothing here needs escaping. */
export function inlineThemeStyles(): string {
  return [
    ':root {',
    declarations(NIGHT_COLORS),
    declarations(TYPOGRAPHY_TOKENS),
    declarations(STRUCTURE_TOKENS),
    '  --safe-top: env(safe-area-inset-top, 0px);',
    '  --safe-bottom: env(safe-area-inset-bottom, 0px);',
    '}',
    '[hidden] { display: none !important; }',
    '* { box-sizing: border-box; margin: 0; padding: 0; }',
    'body {',
    '  background: var(--bg);',
    '  color: var(--fg);',
    '  font-family: var(--font-body);',
    '  font-size: var(--text-base);',
    '  line-height: var(--leading-normal);',
    '  letter-spacing: var(--tracking-tight);',
    '  padding: var(--safe-top) var(--space-4) var(--safe-bottom);',
    '  -webkit-text-size-adjust: 100%;',
    '}',
    '.shell { max-width: var(--container-mobile); margin: 0 auto; padding: var(--space-4) 0 var(--space-6); }',
    '.brand { color: var(--accent); font-size: var(--text-sm); letter-spacing: var(--tracking-caps); }',
    '.stack > * + * { margin-top: var(--space-4); }',
    '.title { font-size: var(--text-lg); color: var(--fg); }',
    '.meta { font-size: var(--text-sm); color: var(--muted); }',
    '.stage { background: var(--player-bg); border: 1px solid var(--border); border-radius: var(--radius-md); overflow: hidden; }',
    '.video { display: block; width: 100%; aspect-ratio: 16 / 9; background: var(--player-bg); }',
    '.panel { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: var(--space-4); }',
    '.notice { background: var(--warn-subtle); border: 1px solid var(--border); border-radius: var(--radius-md); padding: var(--space-3) var(--space-4); color: var(--fg-2); font-size: var(--text-sm); }',
    '.notice .icon { color: var(--warn); vertical-align: -3px; margin-right: var(--space-2); }',
    '.accent { color: var(--accent); }',
    '.cta {',
    '  display: inline-flex;',
    '  align-items: center;',
    '  justify-content: center;',
    '  gap: var(--space-2);',
    '  min-height: var(--touch-target);',
    '  min-width: var(--touch-target);',
    '  padding: var(--space-3) var(--space-4);',
    '  background: var(--accent);',
    '  color: var(--accent-on);',
    '  border: 0;',
    '  border-radius: var(--radius-pill);',
    '  font-size: var(--text-base);',
    '  font-family: inherit;',
    '  text-decoration: none;',
    '  cursor: pointer;',
    '}',
    '.cta:active { transform: translateY(1px); }',
    '.ghost {',
    '  display: inline-flex;',
    '  align-items: center;',
    '  min-height: var(--touch-target);',
    '  padding: var(--space-3) var(--space-4);',
    '  color: var(--fg-2);',
    '  background: transparent;',
    '  border: 1px solid var(--border);',
    '  border-radius: var(--radius-pill);',
    '  text-decoration: none;',
    '  font-size: var(--text-sm);',
    '}',
    '.cta:hover, .ghost:hover { color: var(--fg); }',
    '.cta:focus-visible, .ghost:focus-visible, a:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px var(--accent); }',
    '.icon { flex: none; }',
    '.fineprint { font-size: var(--text-xs); color: var(--muted); }',
    '.overlay {',
    '  display: flex;',
    '  flex-direction: column;',
    '  align-items: center;',
    '  gap: var(--space-3);',
    '  padding: var(--space-4);',
    '  background: var(--player-hud-bg);',
    '  border-radius: var(--radius-md);',
    '  transition: opacity var(--duration-normal) var(--easing-standard);',
    '}',
    '@media (prefers-reduced-motion: reduce) {',
    '  * { transition-duration: 0ms !important; animation-duration: 0ms !important; }',
    '}'
  ].join('\n');
}

/**
 * The ivory day palette, layered behind `prefers-color-scheme` on top of `inlineThemeStyles()`.
 *
 * It is a separate call, not part of the night block, because `/s` is a cinema surface that stays
 * dark whatever the OS asks for (SPEC 5), while the portal (`/`) follows the system. A page that
 * mounts both gets a real dual-mode document with no second set of class names to keep in sync.
 */
export function inlineDayPaletteStyles(): string {
  return [
    '@media (prefers-color-scheme: light) {',
    '  :root {',
    '    color-scheme: light;',
    declarations(DAY_COLORS, '    '),
    '  }',
    '}'
  ].join('\n');
}

/**
 * `<head>` preamble shared by every edge document: charset, viewport with safe-area, theme colour.
 * The title arrives RAW and is escaped here, so a caller cannot forget this one step.
 *
 * `dualMode` states both palette colours plus the `color-scheme` hint; without it the document keeps
 * the single unconditional night `theme-color` it has always shipped, byte for byte, which is what
 * `tests/edge/80-share-page.test.ts` relies on when it pins the share page to one palette.
 */
export function inlineDocumentHead(
  rawTitle: string,
  styleSheet: string,
  options: { readonly dualMode?: boolean } = {}
): string {
  const paletteMeta =
    options.dualMode === true
      ? [
          `<meta name="theme-color" media="(prefers-color-scheme: dark)" content="${NIGHT_BACKGROUND}" />`,
          `<meta name="theme-color" media="(prefers-color-scheme: light)" content="${DAY_BACKGROUND}" />`,
          '<meta name="color-scheme" content="dark light" />'
        ]
      : [`<meta name="theme-color" content="${NIGHT_BACKGROUND}" />`];
  return [
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />',
    ...paletteMeta,
    `<title>${escapeText(rawTitle)}</title>`,
    `<style>${styleSheet}</style>`
  ].join('\n');
}
