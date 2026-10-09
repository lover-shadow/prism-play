import type { Clock } from '../core/clock';
import type { Env } from '../types/env';
import { readAnnouncementsDocument } from '../config/announcements';
import { configUnavailableResponse } from '../config/kv-config';
import { jsonResponse } from '../http/json';

export async function handleAnnouncements(
  request: Request,
  env: Env,
  clock: Clock
): Promise<Response> {
  const url = new URL(request.url);
  const rawVersion = url.searchParams.get('versionCode');
  let versionCode: number | undefined = undefined;

  if (rawVersion !== null && rawVersion !== '') {
    if (!/^\d+$/.test(rawVersion) || !Number.isSafeInteger(Number(rawVersion)) || Number(rawVersion) < 1) {
      return jsonResponse({ success: false, code: 'VALIDATION_ERROR', message: 'versionCode 必须为正整数' }, 400, {
        'Cache-Control': 'no-store'
      });
    }
    versionCode = Number(rawVersion);
  }

  const doc = await readAnnouncementsDocument(env.KV);
  if (doc === null) return configUnavailableResponse();

  const now = clock.nowSeconds();
  const visible = doc.items.filter((item) => {
    if (!item.enabled || item.startsAt > now || item.endsAt <= now) return false;
    if (versionCode !== undefined) {
      if (item.minVersionCode !== undefined && versionCode < item.minVersionCode) return false;
      if (item.maxVersionCode !== undefined && item.maxVersionCode !== null && versionCode > item.maxVersionCode) return false;
    }
    return true;
  });

  visible.sort((a, b) => b.startsAt - a.startsAt || a.id.localeCompare(b.id));

  const items = visible.map((item) => ({
    id: item.id,
    revision: item.revision,
    title: item.title,
    body: item.body,
    startsAt: item.startsAt,
    endsAt: item.endsAt
  }));

  const boundaries = doc.items.filter((item) => item.enabled).flatMap((item) => [item.startsAt, item.endsAt]).filter((time) => time > now);
  const ttl = Math.min(60, ...boundaries.map((time) => time - now));
  return jsonResponse({ revision: doc.revision, items }, 200, { 'Cache-Control': `public, max-age=${ttl}` });
}
