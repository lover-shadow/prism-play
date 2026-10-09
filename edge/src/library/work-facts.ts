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
const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
export async function factsHash(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  let s = '';
  for (let i = 0; i < digest.length; i++) s += HEX[digest[i]];
  return s;
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
// Shared immutable content-addressed packs: 32 packs / 8 MiB encoded, including inflight reservations.
// A generation change gets a distinct key even if a publisher reuses a pack descriptor.
const MAX_PACK_BYTES = 8 * 1024 * 1024;
type VerifiedPack = { works: Map<string, unknown>; facts: Map<string, WorkFact | null> };
type PackSlot = { bucket: R2Bucket; bytes: number; value: Promise<VerifiedPack | null> };
const packs = new Map<string, PackSlot>();
const idHashes = new Map<string, Promise<string>>();
async function workIdHash(id: string): Promise<string> {
  let value = idHashes.get(id);
  if (!value) {
    if (idHashes.size >= 8192) idHashes.delete(idHashes.keys().next().value!);
    value = factsHash(new TextEncoder().encode(id)); idHashes.set(id, value);
    void value.catch(() => { if (idHashes.get(id) === value) idHashes.delete(id); });
  }
  return value;
}
async function loadPack(bucket: R2Bucket, declared: { key: string; bytes: number; sha256: string }, leaf: string): Promise<VerifiedPack | null> {
  try {
    const object = await bucket.get(declared.key);
    if (!object || object.size !== declared.bytes) return null;
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (bytes.byteLength !== declared.bytes || bytes.byteLength > 524288 || await factsHash(bytes) !== declared.sha256) return null;
    const pack: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
    if (!isRecord(pack) || pack.schema !== 1 || !isRecord(pack.works)) return null;
    const works = new Map<string, unknown>(), entries = Object.entries(pack.works);
    // Every work (including skipped private works) must still belong to the declared hash leaf.
    if (entries.length <= 4) {
      for (const [workId] of entries) {
        if (!(await workIdHash(workId)).startsWith(leaf)) return null;
      }
    }
    for (const [workId, raw] of entries) {
      if (!isSafeWorkId(workId)) return null;
      if (isRecord(raw) && (raw.isPrivate === true || raw.channelId === 'private')) continue;
      works.set(workId, raw);
    }
    return { works, facts: new Map() };
  } catch { return null; }
}
export async function readWorkFact(env: Env, manifest: CatalogManifest, id: string, includeDisabled = false): Promise<FactRead> {
  if (!isSafeWorkId(id) || !manifest.workFacts) return { status: 'absent' };
  try {
    const hash = await workIdHash(id);
    // Validated manifests disallow overlapping leaves, so no per-candidate sorting is necessary.
    let leaf: string | undefined;
    for (let length = 2; length <= hash.length; length++) {
      const prefix = hash.slice(0, length);
      if (Object.prototype.hasOwnProperty.call(manifest.workFacts.packs, prefix)) leaf = prefix;
    }
    if (leaf === undefined) return { status: 'absent' };
    const declared = manifest.workFacts.packs[leaf], bucket = env.APK_BUCKET;
    if (!bucket) return { status: 'rejected' };
    const key = JSON.stringify([manifest.revision, manifest.publicSearch?.sha256, leaf, declared.key, declared.sha256, declared.bytes]);
    let slot = packs.get(key);
    if (!slot || slot.bucket !== bucket) {
      if (declared.bytes < 1 || declared.bytes > 524288) return { status: 'rejected' };
      while (packs.size >= 32 || [...packs.values()].reduce((n, p) => n + p.bytes, 0) + declared.bytes > MAX_PACK_BYTES) {
        const first = packs.keys().next().value; if (first === undefined) break; packs.delete(first);
      }
      slot = { bucket, bytes: declared.bytes, value: loadPack(bucket, declared, leaf) };
      packs.set(key, slot);
      const current = slot;
      void slot.value.then((value) => { if (value === null && packs.get(key) === current) packs.delete(key); });
    }
    const pack = await slot.value;
    if (pack === null) return { status: 'rejected' };
    if (!pack.works.has(id)) return { status: 'absent' };
    if (!pack.facts.has(id)) pack.facts.set(id, parseFact(pack.works.get(id), id));
    const fact = pack.facts.get(id);
    if (!fact) return { status: 'rejected' };
    return !includeDisabled && fact.row.enabled !== 1 ? { status: 'absent' } : { status: 'ok', fact };
  } catch { return { status: 'rejected' }; }
}
