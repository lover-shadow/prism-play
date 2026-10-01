/**
 * Theme and layout-preference state.
 *
 * Preferences (theme, poster mode) belong to the history/preferences domain: they are allowed in the
 * Android backup set (SPEC §6.1) and must therefore never be routed through the Keystore credential
 * store, and never through the cache that "clear cache" wipes.
 */

export const THEME_MODES = ['dark', 'light'] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

export const POSTER_MODES = ['compact-3', 'comfort-2', 'bookshelf-4', 'list-1'] as const;
export type PosterMode = (typeof POSTER_MODES)[number];

/** Grid classes shipped by design-tokens.css — the app must not re-declare them. */
export const POSTER_MODE_CLASS: Readonly<Record<PosterMode, string>> = {
  'compact-3': 'grid-posters-compact-3',
  'comfort-2': 'grid-posters-comfort-2',
  'bookshelf-4': 'grid-posters-bookshelf-4',
  'list-1': 'grid-posters-list-1'
};

export const POSTER_MODE_LABEL: Readonly<Record<PosterMode, string>> = {
  'compact-3': '三列紧凑',
  'comfort-2': '两列大图',
  'bookshelf-4': '四列书架',
  'list-1': '单列图文'
};

export const DEFAULT_THEME_MODE: ThemeMode = 'dark';
export const DEFAULT_POSTER_MODE: PosterMode = 'compact-3';

export interface PreferenceStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

const THEME_KEY = 'prism.theme';
const POSTER_KEY = 'prism.posterMode';

export function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === 'string' && (THEME_MODES as readonly string[]).includes(value);
}

export function isPosterMode(value: unknown): value is PosterMode {
  return typeof value === 'string' && (POSTER_MODES as readonly string[]).includes(value);
}

/**
 * `meta[name=theme-color]` cannot resolve a CSS variable, so the value is read back from the applied
 * token instead of being duplicated in markup: one source of truth, and it follows theme switches.
 */
export function syncThemeColorMeta(doc: Document = document): void {
  const meta = doc.querySelector('meta[name="theme-color"]');
  if (meta === null) return;
  const resolved = getComputedStyle(doc.documentElement).getPropertyValue('--bg').trim();
  if (resolved !== '') meta.setAttribute('content', resolved);
}

export function applyTheme(mode: ThemeMode, root: HTMLElement = document.documentElement): void {
  root.dataset.theme = mode;
  const owner = root.ownerDocument;
  if (owner !== null) syncThemeColorMeta(owner);
}

export async function readThemePreference(store: PreferenceStore): Promise<ThemeMode> {
  const stored = await store.get(THEME_KEY);
  return isThemeMode(stored) ? stored : DEFAULT_THEME_MODE;
}

export async function writeThemePreference(store: PreferenceStore, mode: ThemeMode): Promise<void> {
  await store.set(THEME_KEY, mode);
}

export async function readPosterMode(store: PreferenceStore): Promise<PosterMode> {
  const stored = await store.get(POSTER_KEY);
  return isPosterMode(stored) ? stored : DEFAULT_POSTER_MODE;
}

export async function writePosterMode(store: PreferenceStore, mode: PosterMode): Promise<void> {
  await store.set(POSTER_KEY, mode);
}
