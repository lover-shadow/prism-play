/**
 * The inline visual base for the edge-rendered HTML surfaces (`/s`, `/dl`).
 *
 * SPEC 10 pins those documents to "边缘直出的极简内联样式，不引入站点级 CSS/JS 资产": a shared
 * stylesheet cannot be fetched on a weak connection, so the token block is inlined instead. That is
 * the ONLY reason this file carries bare colour values, and it is the only file in the repository
 * that may. `tests/edge/83-token-parity.test.ts` reconciles every value below against
 * `src/styles/design-tokens.json` at test time; without that test this file would be the escape
 * hatch for the P0-2 (purple/pink gradient) and P0-3 (colour drift) red lines.
 *
 * Rules enforced here and proven by that test:
 *   - night palette only (the share page is a cinema surface; no theme switch is negotiated in a URL);
 *   - amber gold `--accent` on obsidian `--bg`; no gradient of any kind, purple or otherwise;
 *   - every rule below consumes a token, so `share-page.ts` / `dl-page.ts` contain zero colour.
 *   - icons are Lucide inline SVG, 2px stroke, and the size set is closed at 16 / 20 / 24 px.
 */

import { escapeText } from './escape';

/** design-tokens.json `themes.dark.color` keys that this surface inlines, name for name. */
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

/** Non-colour tokens are inlined from the same source of truth (typography / radius / spacing / motion). */
const TYPOGRAPHY_TOKENS: Readonly<Record<string, string>> = {
  'font-body': "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
  'text-xs': '12px',
  'text-sm': '13px',
  'text-base': '15px',
  'text-lg': '20px',
  'leading-normal': '1.5',
  'tracking-tight': '-0.015em',
  'tracking-caps': '0.06em'
};

const STRUCTURE_TOKENS: Readonly<Record<string, string>> = {
  'space-2': '8px',
  'space-3': '12px',
  'space-4': '16px',
  'space-6': '24px',
  'radius-sm': '6px',
  'radius-md': '10px',
  'radius-lg': '14px',
  'radius-pill': '9999px',
  'duration-fast': '150ms',
  'duration-normal': '240ms',
  'easing-standard': 'cubic-bezier(0.2, 0, 0, 1)',
  'touch-target': '44px',
  'container-mobile': '480px'
};

/** The `theme-color` meta needs the raw night background; it is exported rather than duplicated. */
export const NIGHT_BACKGROUND = NIGHT_COLORS.bg;

/** Closed icon size set from the token contract (inline / button / standalone). */
export const ICON_SIZES = [16, 20, 24] as const;
export type IconSize = (typeof ICON_SIZES)[number];

const LUCIDE_PATHS = {
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  download:
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  alert:
    '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12" y2="17"/>',
  phone:
    '<rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/>',
  info: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
  'chevron-up': '<polyline points="18 15 12 9 6 15"/>',
  external:
    '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>'
};

export type LucideIconName = keyof typeof LUCIDE_PATHS;

/**
 * P0-1: an icon is always an inline Lucide 2px-stroke SVG at 16/20/24px. Never a pictograph, never
 * an emoji character. `currentColor` keeps the glyph bound to the token in whose block it sits.
 */
export function lucideIcon(name: LucideIconName, size: IconSize): string {
  const body = LUCIDE_PATHS[name];
  return (
    `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"` +
    ` stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"` +
    ` aria-hidden="true" focusable="false">${body}</svg>`
  );
}

function declarations(table: Readonly<Record<string, string>>): string {
  return Object.entries(table)
    .map(([name, value]) => `  --${name}: ${value};`)
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
 * `<head>` preamble shared by every edge document: charset, viewport with safe-area, theme colour.
 * The title arrives RAW and is escaped here, so a caller cannot forget this one step.
 */
export function inlineDocumentHead(rawTitle: string, styleSheet: string): string {
  return [
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />',
    `<meta name="theme-color" content="${NIGHT_BACKGROUND}" />`,
    `<title>${escapeText(rawTitle)}</title>`,
    `<style>${styleSheet}</style>`
  ].join('\n');
}
