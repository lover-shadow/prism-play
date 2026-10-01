/**
 * Domain 4 — 私密禁存域 (SPEC §6.1 row 4; AC-02-2 and AC-02-5; ARCHITECTURE §3.6.4).
 *
 * 个人探索 titles, covers, episode lists, resume points and the session credential live in a Map and
 * nowhere else. This module has no async surface, no injected adapter, no path, no database handle and
 * no key-value client: zero I/O is a *structural* property here, not a runtime check, and
 * `tests/client/13-credentials-vault.test.ts` reads this file's source to keep it that way.
 *
 * Honest boundary (AGENTS.md 二.2): the app can prove the user's explicit opt-in reached the server and
 * that this domain holds nothing on disk, but it cannot prove a user physically tapped — and any
 * screenshot, screen recording or external camera of this content is outside what software can prevent.
 * Cold start and full process exit drop everything here by definition, since a process has no memory.
 */

import type { SessionHolder } from '../api/client';
import type { TitleDetail } from '../../../edge/src/types/api';
import { createVolatileStore, type StorageDomain, type VolatileStore, type WatchHistoryRow } from './storage-domains';

export const PRIVATE_VOLATILE_DOMAIN: StorageDomain = 'private-volatile';

/** Key namespaces. Exposed so a caller can assert nothing leaked into another domain's key space. */
export const PRIVATE_VOLATILE_NAMESPACES = ['title', 'poster', 'breakpoint', 'session'] as const;
export type PrivateVolatileNamespace = (typeof PRIVATE_VOLATILE_NAMESPACES)[number];

const namespaced = (namespace: PrivateVolatileNamespace, key: string): string => `${namespace}:${key}`;

export interface PrivateVault {
  putTitle(detail: TitleDetail): void;
  getTitle(contentId: string): TitleDetail | undefined;
  listTitles(): TitleDetail[];
  putPoster(contentId: string, bytes: Uint8Array): void;
  getPoster(contentId: string): Uint8Array | undefined;
  putBreakpoint(row: WatchHistoryRow): void;
  getBreakpoint(contentId: string): WatchHistoryRow | undefined;
  listBreakpoints(): WatchHistoryRow[];
  /** Handed to `PrismApiClient.bindSessionHolder`; the token never leaves this process. */
  readonly session: SessionHolder;
  sessionToken(): string | null;
  keys(): string[];
  size(): number;
  /** Returns how many entries were dropped; the second call is a documented no-op (idempotent). */
  clear(): number;
}

/**
 * The private-session credential is a RAM-only value with a synchronous reader, which is exactly the
 * shape `SessionHolder` asks for. Writing `null` deletes it, so `forgetPrivateSessionLocally()` and
 * `clear()` cannot leave a stale token behind in this process.
 */
function sessionHolderOf(store: VolatileStore<string>, key: string): SessionHolder {
  return {
    read: () => store.get(key) ?? null,
    write: (token: string | null) => {
      if (token === null) store.delete(key);
      else store.set(key, token);
    }
  };
}

export function createPrivateVault(): PrivateVault {
  const titles = createVolatileStore<TitleDetail>();
  const posters = createVolatileStore<Uint8Array>();
  const breakpoints = createVolatileStore<WatchHistoryRow>();
  const sessions = createVolatileStore<string>();
  const session = sessionHolderOf(sessions, namespaced('session', 'current'));

  const everyStore = [titles, posters, breakpoints, sessions];

  return {
    // AC-02-2: a private resume point is legal here and illegal in domain 2. The row shape is shared so
    // the player has one resume code path; only the destination differs.
    putTitle: (detail) => titles.set(namespaced('title', detail.item.id), detail),
    getTitle: (contentId) => titles.get(namespaced('title', contentId)),
    listTitles: () => [...titles.keys()].map((key) => titles.get(key)).filter((value): value is TitleDetail => value !== undefined),

    putPoster: (contentId, bytes) => posters.set(namespaced('poster', contentId), copyPosterBytes(bytes)),
    getPoster: (contentId) => {
      const bytes = posters.get(namespaced('poster', contentId));
      return bytes === undefined ? undefined : copyPosterBytes(bytes);
    },

    putBreakpoint: (row) => breakpoints.set(namespaced('breakpoint', row.content_id), row),
    getBreakpoint: (contentId) => breakpoints.get(namespaced('breakpoint', contentId)),
    listBreakpoints: () =>
      [...breakpoints.keys()]
        .map((key) => breakpoints.get(key))
        .filter((row): row is WatchHistoryRow => row !== undefined)
        .sort((left, right) => right.updated_at - left.updated_at),

    session,
    sessionToken: () => session.read(),

    keys: () => everyStore.flatMap((store) => store.keys()),
    size: () => everyStore.reduce((total, store) => total + store.size(), 0),
    clear: () => {
      const dropped = everyStore.reduce((total, store) => total + store.size(), 0);
      for (const store of everyStore) store.clear();
      return dropped;
    }
  };
}

/**
 * Defensive copy on both ends is deliberate: handing out the same `Uint8Array` reference would let a
 * caller keep the buffer alive past `clear()` through a stray field, and letting a caller keep writing
 * into the stored array would let 个人探索 pixels change after the fact. Both directions get a fresh copy.
 */
export function copyPosterBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}
