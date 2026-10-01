import type { ChannelId, SourceProvider, SourcesResponse } from '../types/api';
import type { Clock } from '../core/clock';
import type { Env } from '../types/env';
import { PRIVATE_SESSION_HEADER, resolvePrivateAccess } from '../core/admission';
import { buildProxyUrl } from '../core/proxy-signature';
import { isChannelId, toBoolean } from '../core/validation';
import { listProvidersForChannel, type ProviderRow } from '../db/content-repo';
import { PRIVATE_CHANNEL_ID, listEnabledChannels } from '../db/channel-repo';
import { jsonResponse, noStoreJson } from '../http/json';
import { originOf } from '../http/serialize';
import { undifferentiatedNotFound } from './catalog';

/**
 * `GET /api/sources` — Cron-probed playback sources (SPEC §5, openapi `/api/sources`).
 *
 * `upstream_url` is never read out of this layer into a response: only `id`, the neutral `name`,
 * the channel, the probe numbers and a same-origin proxy base leave the edge (API-SPEC §〇 上游地址零暴露).
 *
 * ARCHITECTURE §3.1 constraint on the shape below, stated here rather than in user-visible text:
 * this payload is a diagnostic and capability hint. A client must never use `providers[].apiBase`
 * to issue a media request — playback addresses come only from `/api/episodes/{id}/playback`, which
 * returns a single server-picked, short-lived, signed handle.
 */
export type SourcesPayload = SourcesResponse;

const PUBLIC_SOURCES_CACHE_SECONDS = 60;

/** Both credentials can change the provider set, so a shared cache must not merge the outcomes. */
const SOURCES_VARY = `Authorization, ${PRIVATE_SESSION_HEADER}`;

/**
 * openapi's `apiBase` example is `https://play.prismos.org/proxy/s1`, which the locked
 * `/proxy/{kind}/{handle}` template (kind ∈ {img, media}) cannot express: one segment would 404 and
 * would break dispatch rule 4 ("代理路由严格使用 /proxy/{kind}/{handle}"). Least-wrong same-origin form:
 * the `media` kind carrying the abstract provider id. Reported to supervision as a contract conflict.
 */
function providerApiBase(origin: string, providerId: string): string {
  return buildProxyUrl(origin, 'media', encodeURIComponent(providerId));
}

function toSourceProvider(origin: string, row: ProviderRow): SourceProvider {
  return {
    id: row.id,
    name: row.name,
    channelId: row.channel_id as ChannelId,
    apiBase: providerApiBase(origin, row.id),
    priority: Number(row.priority),
    latencyMs: Number(row.latency_ms),
    healthy: toBoolean(Number(row.healthy))
  };
}

/** Same ordering key as `listProvidersForChannel`, extended with `id` so a merged page stays stable. */
function compareProviders(left: ProviderRow, right: ProviderRow): number {
  const healthy = Number(right.healthy) - Number(left.healthy);
  if (healthy !== 0) return healthy;
  const latency = Number(left.latency_ms) - Number(right.latency_ms);
  if (latency !== 0) return latency;
  const priority = Number(left.priority) - Number(right.priority);
  if (priority !== 0) return priority;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/** Channels whose providers may be advertised to this caller. */
async function visibleChannelIds(env: Env, admitted: boolean): Promise<string[]> {
  const rows = await listEnabledChannels(env.DB);
  return rows.map((row) => row.id).filter((id) => id !== PRIVATE_CHANNEL_ID || admitted);
}

export async function handleSources(request: Request, env: Env, clock: Clock): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const rawChannel = params.get('channel');
  const filter = rawChannel === null || rawChannel === '' ? null : rawChannel;
  // Same anti-probing answer as `/api/catalog`: a 400 would enumerate the channel ids that exist.
  if (filter !== null && !isChannelId(filter)) return undifferentiatedNotFound();

  const admitted = (await resolvePrivateAccess(request, env, clock)).granted;
  if (filter === PRIVATE_CHANNEL_ID && !admitted) return undifferentiatedNotFound();

  const channels = filter === null ? await visibleChannelIds(env, admitted) : [filter];
  const collected: ProviderRow[] = [];
  for (const channelId of channels) {
    collected.push(...(await listProvidersForChannel(env.DB, channelId)));
  }
  collected.sort(compareProviders);

  const origin = originOf(request);
  const body: SourcesPayload = {
    // Newest probe over exactly the rows being served, so a private check can never be inferred from
    // a timestamp belonging to a provider that was filtered out.
    updatedAt: collected.reduce((newest, row) => Math.max(newest, Number(row.last_checked_at)), 0),
    providers: collected.map((row) => toSourceProvider(origin, row))
  };

  const carriesPrivate = collected.some((row) => row.channel_id === PRIVATE_CHANNEL_ID);
  return carriesPrivate
    ? noStoreJson(body)
    : jsonResponse(body, 200, { 'Cache-Control': `public, max-age=${PUBLIC_SOURCES_CACHE_SECONDS}`, Vary: SOURCES_VARY });
}
