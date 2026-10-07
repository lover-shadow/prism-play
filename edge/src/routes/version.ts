/**
 * `GET /api/version` - the OTA bulletin board (openapi `VersionResponse`).
 *
 * Two hard rules from API-SPEC 四.2 shape this route:
 *   1. the response carries `android` only. There is no `windows` field in this period's machine
 *      contract, so none is ever emitted - the response object is rebuilt field by field from
 *      validated values, which also drops a stray `windows` key stored by an operator;
 *   2. `downloadUrl` must be same-origin AND point at `/dl/latest/android`, the single entry that
 *      `/dl` owns. A cross-origin value would let a compromised KV record push every device to
 *      download an APK from a host this project does not control, so it is a 503, not a warning.
 *
 * As with monetization, an absent or invalid entry is a 503 rather than a fabricated version.
 */

import type { Clock } from '../core/clock';
import type { Env } from '../types/env';
import {
  configUnavailableResponse,
  publicConfigHeaders,
  readVersionRelease
} from '../config/kv-config';
import { jsonResponse } from '../http/json';
import { originOf } from '../http/serialize';

export async function handleVersion(request: Request, env: Env, _clock: Clock): Promise<Response> {
  const release = await readVersionRelease(env.KV, originOf(request));
  if (release === null) return configUnavailableResponse();
  const metadata = env.CF_VERSION_METADATA;
  return jsonResponse({ ...release, ...(metadata ? {
    service: { buildId: metadata.id, deployedAt: metadata.timestamp }
  } : {}) }, 200, publicConfigHeaders());
}
