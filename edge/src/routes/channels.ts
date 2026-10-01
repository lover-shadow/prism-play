import type { ChannelItem, ChannelsResponse } from '../types/api';
import type { Clock } from '../core/clock';
import type { Env } from '../types/env';
import { PRIVATE_SESSION_HEADER, resolvePrivateAccess } from '../core/admission';
import { jsonResponse, noStoreJson } from '../http/json';
import { PRIVATE_CHANNEL_ID, listEnabledChannels, readTopologyVersion } from '../db/channel-repo';

/** Short positive TTL for the public topology only; a granted response is always no-store. */
const PUBLIC_TOPOLOGY_CACHE_SECONDS = 60;

/** The response depends on both credentials, so a shared cache must not merge the two outcomes. */
const TOPOLOGY_VARY = `Authorization, ${PRIVATE_SESSION_HEADER}`;

export async function handleChannels(request: Request, env: Env, clock: Clock): Promise<Response> {
  // Stage 1 deliberately does not read the topology from KV: D1 is the authority and a stale KV copy
  // must never be able to decide whether 个人探索 is visible (ARCHITECTURE §3.1).
  // One call for the whole system: bearer identity + cloud-configured tier set + double predicate.
  const access = await resolvePrivateAccess(request, env, clock);

  const rows = await listEnabledChannels(env.DB);
  const version = await readTopologyVersion(env.DB);
  // AC-02-3 physical stripping: when admission is not granted the node is filtered out of the array,
  // so it is absent from the JSON tree — not null, not empty, not a placeholder "locked" entry.
  const channels: ChannelItem[] = access.granted ? rows : rows.filter((row) => row.id !== PRIVATE_CHANNEL_ID);
  const body: ChannelsResponse = { version, channels };

  return access.granted ? noStoreJson(body) : publicTopologyResponse(body);
}

function publicTopologyResponse(body: ChannelsResponse): Response {
  return jsonResponse(body, 200, {
    'Cache-Control': `public, max-age=${PUBLIC_TOPOLOGY_CACHE_SECONDS}`,
    Vary: TOPOLOGY_VARY
  });
}
