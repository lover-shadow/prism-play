/**
 * The closed Lucide icon set for the edge-rendered documents (`/s`, `/dl`, `/`).
 *
 * P0-1 (AGENTS.md 三.1) forbids pictographs as functional icons: every glyph is an inline 2px-stroke
 * Lucide SVG, and the size set is locked at 16 / 20 / 24 px by `ICON_SIZES`. The path data below is
 * copied verbatim from the pinned `lucide-static` devDependency, so a glyph is never redrawn by hand.
 *
 * This module is split out of `theme.ts` for the 300-line file ceiling (SPEC 8 / scan_p0.py), and it
 * deliberately carries no colour: `currentColor` binds every glyph to the token of its own block, so
 * `theme.ts` stays the only file in the repository that may state a colour value at all.
 */

/** Closed icon size set from the token contract (inline / button / standalone). */
export const ICON_SIZES = [16, 20, 24] as const;
export type IconSize = (typeof ICON_SIZES)[number];

/**
 * `lucide-static` name -> inner markup. Keys are the only names a page may ask for; an unknown name is
 * a build-time type error rather than a runtime blank box.
 */
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
    '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
  film:
    '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M7 3v18"/><path d="M3 7.5h4"/><path d="M3 12h18"/><path d="M3 16.5h4"/><path d="M17 3v18"/><path d="M17 7.5h4"/><path d="M17 16.5h4"/>',
  'play-circle':
    '<path d="M9 9.003a1 1 0 0 1 1.517-.859l4.997 2.997a1 1 0 0 1 0 1.718l-4.997 2.997A1 1 0 0 1 9 14.996z"/><circle cx="12" cy="12" r="10"/>',
  'arrow-up-right': '<path d="M7 7h10v10"/><path d="M7 17 17 7"/>',
  'monitor-smartphone':
    '<path d="M18 8V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h8"/><path d="M10 19v-3.96 3.15"/><path d="M7 19h5"/><rect width="6" height="10" x="16" y="12" rx="2"/>',
  'wifi-off':
    '<path d="M12 20h.01"/><path d="M8.5 16.429a5 5 0 0 1 7 0"/><path d="M5 12.859a10 10 0 0 1 5.17-2.69"/><path d="M19 12.859a10 10 0 0 0-2.007-1.523"/><path d="M2 8.82a15 15 0 0 1 4.177-2.643"/><path d="M22 8.82a15 15 0 0 0-11.288-3.764"/><path d="m2 2 20 20"/>',
  layers:
    '<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"/><path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12"/><path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17"/>',
  tv: '<path d="m17 2-5 5-5-5"/><rect width="20" height="15" x="2" y="7" rx="2"/>',
  smartphone: '<rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/>',
  shield:
    '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  search: '<path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'
};

export type LucideIconName = keyof typeof LUCIDE_PATHS;

/**
 * P0-1: an icon is always an inline Lucide 2px-stroke SVG at 16/20/24px. Never a pictograph, never
 * an emoji character. `currentColor` keeps the glyph bound to the token in whose block it sits, and
 * `aria-hidden` means the decorative SVG never doubles as the accessible name of its button.
 */
export function lucideIcon(name: LucideIconName, size: IconSize): string {
  const body = LUCIDE_PATHS[name];
  return (
    `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"` +
    ` stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"` +
    ` aria-hidden="true" focusable="false">${body}</svg>`
  );
}
