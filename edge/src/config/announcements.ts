import { ANNOUNCEMENTS_KV_KEY } from '../core/constants';
import { parseStoredJson, readKvText } from './kv-config';

export interface AnnouncementItem {
  id: string;
  revision: number;
  title: string;
  body: string;
  startsAt: number;
  endsAt: number;
  minVersionCode?: number;
  maxVersionCode?: number | null;
  enabled: boolean;
}

export interface AnnouncementDocument {
  schema: 1;
  revision: number;
  items: AnnouncementItem[];
}

const ID_PATTERN = /^[a-zA-Z0-9_-]{8,64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateItem(item: unknown): AnnouncementItem | null {
  if (!isRecord(item)) return null;
  if (typeof item.id !== 'string' || !ID_PATTERN.test(item.id)) return null;
  if (!Number.isSafeInteger(item.revision) || (item.revision as number) < 1) return null;
  if (typeof item.title !== 'string' || item.title.trim().length < 1 || [...item.title].length > 80) return null;
  if (typeof item.body !== 'string' || item.body.trim().length < 1 || [...item.body].length > 1000) return null;
  if (/<\/?[a-z!]/i.test(item.title + item.body)) return null;
  if (!Number.isSafeInteger(item.startsAt) || (item.startsAt as number) < 0) return null;
  if (!Number.isSafeInteger(item.endsAt) || (item.endsAt as number) <= (item.startsAt as number)) return null;
  if (typeof item.enabled !== 'boolean') return null;

  const valid: AnnouncementItem = {
    id: item.id,
    revision: item.revision as number,
    title: item.title.trim(),
    body: item.body.trim(),
    startsAt: item.startsAt as number,
    endsAt: item.endsAt as number,
    enabled: item.enabled
  };

  if (item.minVersionCode !== undefined) {
    if (!Number.isSafeInteger(item.minVersionCode) || (item.minVersionCode as number) < 1) return null;
    valid.minVersionCode = item.minVersionCode as number;
  }

  if (item.maxVersionCode !== undefined && item.maxVersionCode !== null) {
    if (!Number.isSafeInteger(item.maxVersionCode) || (item.maxVersionCode as number) < 1) return null;
    valid.maxVersionCode = item.maxVersionCode as number;
  } else if (item.maxVersionCode === null) {
    valid.maxVersionCode = null;
  }

  return valid;
}

export function validateAnnouncementDocument(raw: unknown): AnnouncementDocument | null {
  if (!isRecord(raw) || raw.schema !== 1 || new TextEncoder().encode(JSON.stringify(raw)).byteLength > 7168) return null;
  if (!Number.isSafeInteger(raw.revision) || (raw.revision as number) < 1) return null;
  if (!Array.isArray(raw.items) || raw.items.length > 10) return null;

  const items: AnnouncementItem[] = [];
  const ids = new Set<string>();

  for (const entry of raw.items) {
    const item = validateItem(entry);
    if (item === null || ids.has(item.id)) return null;
    ids.add(item.id);
    items.push(item);
  }

  return {
    schema: 1,
    revision: raw.revision as number,
    items
  };
}

export async function readAnnouncementsDocument(kv: KVNamespace | undefined): Promise<AnnouncementDocument | null> {
  if (!kv) return null;
  const raw = await readKvText(kv, ANNOUNCEMENTS_KV_KEY);
  if (raw === null) return { schema: 1, revision: 1, items: [] };
  return validateAnnouncementDocument(parseStoredJson(raw));
}
