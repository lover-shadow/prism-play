import type { Env } from '../types/env';
import type { ContentRow } from '../db/content-repo';
import { PUBLIC_CHANNEL_IDS } from '../types/api';
import { readKvText, parseStoredJson } from '../config/kv-config';
import { CATALOG_MANIFEST_KV_KEY, validatePublicManifest, type CatalogManifest } from './manifest';
import { isRecord, isSafeWorkId, isCount } from './contract';
import { parseTitleAsset, type TitleAsset } from './title-asset';

export interface WorkFact { asset: TitleAsset; row: ContentRow; shareable: boolean }
export type FactRead = { status: 'absent' } | { status: 'rejected' } | { status: 'ok'; fact: WorkFact };
// Missing pointer is the legacy deployment; malformed pointers never select legacy D1.
export async function factsManifest(env: Env): Promise<CatalogManifest | null | undefined> {
  const text = await readKvText(env.KV, CATALOG_MANIFEST_KV_KEY);
  return text === null ? undefined : validatePublicManifest(parseStoredJson(text));
}
export async function factsHash(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (v) => v.toString(16).padStart(2, '0')).join('');
}
function parseFact(raw: unknown, id: string): WorkFact | null {
  if (!isRecord(raw) || raw.workId !== id || (raw.id !== undefined && raw.id !== id)) return null;
  if (typeof raw.enabled !== 'boolean' || typeof raw.shareable !== 'boolean' || typeof raw.isPrivate !== 'boolean') return null;
  // A private entry is never projected or served from the public pack.
  if (raw.isPrivate || raw.channelId === 'private') return null;
  if (!(PUBLIC_CHANNEL_IDS as readonly unknown[]).includes(raw.channelId) || raw.generatedAt !== 0) return null;
  if (raw.coverTargetUrl !== undefined) {
    if (typeof raw.coverTargetUrl !== 'string') return null;
    try { const url = new URL(raw.coverTargetUrl); if (url.protocol !== 'https:' || url.username || url.password) return null; }
    catch { return null; }
  }
  if (!Array.isArray(raw.episodes)) return null;
  const numbers = new Set<number>();
  for (const ep of raw.episodes) {
    if (!isRecord(ep) || !isCount(ep.episodeNumber) || ep.episodeNumber < 1 || ep.episodeNumber > 999999 || numbers.has(ep.episodeNumber)) return null;
    numbers.add(ep.episodeNumber);
    if ((ep.title !== undefined && typeof ep.title !== 'string') || (ep.durationSeconds !== undefined && !isCount(ep.durationSeconds))) return null;
  }
  if (raw.episodeCount !== undefined && raw.episodeCount !== numbers.size) return null;
  const parsed = parseTitleAsset(JSON.stringify({ ...raw, coverUrl: raw.coverTargetUrl }), id);
  if (!parsed.ok) return null;
  const asset = parsed.value;
  return { asset, shareable: raw.shareable, row: {
    id, channel_id: asset.channelId, title: asset.title, cover_url: typeof raw.coverTargetUrl === 'string' ? raw.coverTargetUrl : null,
    cover_version: asset.coverVersion ?? null, synopsis: asset.synopsis ?? null, category: asset.category,
    is_private: 0, enabled: raw.enabled ? 1 : 0, shareable: raw.shareable ? 1 : 0,
    first_published_at: asset.firstPublishedAt ?? null, updated_at: 0, episode_count: numbers.size
  } };
}
export async function readWorkFact(env: Env, manifest: CatalogManifest, id: string): Promise<FactRead> {
  if (!isSafeWorkId(id)) return { status: 'absent' };
  const hash = await factsHash(new TextEncoder().encode(id));
  const leaf = Object.keys(manifest.workFacts!.packs).filter((p) => hash.startsWith(p)).sort((a, b) => b.length - a.length)[0];
  if (leaf === undefined) return { status: 'absent' };
  const declared = manifest.workFacts!.packs[leaf];
  try {
    const object = await env.APK_BUCKET?.get(declared.key);
    if (!object || object.size !== declared.bytes) return { status: 'rejected' };
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (bytes.byteLength !== declared.bytes || bytes.byteLength > 524288 || await factsHash(bytes) !== declared.sha256) return { status: 'rejected' };
    const pack: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
    if (!isRecord(pack) || pack.schema !== 1 || !isRecord(pack.works)) return { status: 'rejected' };
    let requested: WorkFact | null = null;
    for (const [workId, raw] of Object.entries(pack.works)) {
      if (!isSafeWorkId(workId) || !(await factsHash(new TextEncoder().encode(workId))).startsWith(leaf)) return { status: 'rejected' };
      if (isRecord(raw) && (raw.isPrivate === true || raw.channelId === 'private')) continue;
      const fact = parseFact(raw, workId);
      if (fact === null) return { status: 'rejected' };
      if (workId === id) requested = fact;
    }
    return requested === null || requested.row.enabled !== 1 ? { status: 'absent' } : { status: 'ok', fact: requested };
  } catch { return { status: 'rejected' }; }
}
