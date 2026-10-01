/**
 * Provider adapter contract for F-14 (SPEC §2, ARCHITECTURE §3.4).
 *
 * The ingest engine only ever talks to a `ProviderAdapter`; it holds no URL, no HTTP client and no
 * upstream name. Which configured `ingest_sources` row maps to which adapter instance is wired by the
 * caller that owns the Worker entry point, so this module stays free of transport concerns.
 */

export interface ProviderEpisodeRef {
  sourceEpisodeId: string;
  /** 1-based as published by the source; validated downstream against `content_episodes` CHECKs. */
  episodeNumber: number;
  durationSeconds?: number;
}

export interface ProviderWork {
  sourceItemId: string;
  sourceRevision: string;
  title: string;
  /**
   * Source-supplied classification, taken as-is this period (API-SPEC §八 last bullet) and written to
   * `content_items.category`. It is never written to `source_records.classification_json` (M-5).
   */
  category: string;
  synopsis?: string;
  coverUrl?: string;
  episodes: ProviderEpisodeRef[];
}

export interface ProviderPage {
  items: ProviderWork[];
  /** Cursor that identifies the page *after* this one; `null` means the incremental pass is done. */
  nextCursor: string | null;
}

export interface ProviderAdapter {
  readonly providerId: string;
  fetchPage(cursor: string | null, signal?: AbortSignal): Promise<ProviderPage>;
}

export interface InMemoryProviderAdapter extends ProviderAdapter {
  /** Cursors actually pulled, in order — tests prove cursor advance and re-entrancy from it. */
  readonly requestedCursors: (string | null)[];
}

export class AdapterUnavailableError extends Error {
  constructor(providerId: string, detail: string) {
    super(`adapter for ${providerId} cannot serve the requested page: ${detail}`);
    this.name = 'AdapterUnavailableError';
  }
}

function cloneEpisode(episode: ProviderEpisodeRef): ProviderEpisodeRef {
  const cloned: ProviderEpisodeRef = {
    sourceEpisodeId: episode.sourceEpisodeId,
    episodeNumber: episode.episodeNumber
  };
  if (episode.durationSeconds !== undefined) cloned.durationSeconds = episode.durationSeconds;
  return cloned;
}

function cloneWork(work: ProviderWork): ProviderWork {
  const cloned: ProviderWork = {
    sourceItemId: work.sourceItemId,
    sourceRevision: work.sourceRevision,
    title: work.title,
    category: work.category,
    episodes: work.episodes.map(cloneEpisode)
  };
  if (work.synopsis !== undefined) cloned.synopsis = work.synopsis;
  if (work.coverUrl !== undefined) cloned.coverUrl = work.coverUrl;
  return cloned;
}

/**
 * Deterministic fixture adapter. Page i is addressed by the cursor page i-1 declared, and page 0 by
 * `null`, which is exactly how a real cursor chain behaves; supplying the chain up front keeps the
 * fixture free of invented cursor arithmetic.
 */
export function createInMemoryAdapter(
  providerId: string,
  pages: readonly ProviderPage[]
): InMemoryProviderAdapter {
  const byCursor = new Map<string | null, ProviderPage>();
  const first: ProviderPage = pages.length > 0 ? pages[0] : { items: [], nextCursor: null };
  byCursor.set(null, first);
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index];
    const isLast = index === pages.length - 1;
    if (isLast) {
      if (page.nextCursor !== null) {
        throw new Error(`in-memory adapter ${providerId}: the last page must declare nextCursor null`);
      }
      continue;
    }
    const nextCursor = page.nextCursor;
    if (nextCursor === null) {
      throw new Error(`in-memory adapter ${providerId}: page ${index} ends the pass but more pages follow`);
    }
    if (byCursor.has(nextCursor)) {
      throw new Error(`in-memory adapter ${providerId}: duplicate cursor ${nextCursor}`);
    }
    byCursor.set(nextCursor, pages[index + 1]);
  }

  const requestedCursors: (string | null)[] = [];
  return {
    providerId,
    requestedCursors,
    async fetchPage(cursor: string | null, signal?: AbortSignal): Promise<ProviderPage> {
      requestedCursors.push(cursor);
      if (signal?.aborted) throw new AdapterUnavailableError(providerId, 'run aborted');
      const page = byCursor.get(cursor);
      if (page === undefined) throw new AdapterUnavailableError(providerId, `unknown cursor ${String(cursor)}`);
      return { items: page.items.map(cloneWork), nextCursor: page.nextCursor };
    }
  };
}
