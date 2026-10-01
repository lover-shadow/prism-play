/**
 * `GET /api/config/monetization` - the cloud-delivered commercial policy (openapi MonetizationConfig).
 *
 * There is exactly one source of money truth: the operator's KV entry. SPEC 10 pins the consequence
 * 「接口无有效配置时不显示付费入口，不启用本地猜测价格」, so an absent or invalid entry is a 503 and NOT a
 * built-in default: a hardcoded fallback price would silently resurrect a second 口径 the moment KV
 * is wiped, and the client would render a paywall nobody approved. Prices and thresholds therefore
 * appear in this codebase only as pass-through data.
 *
 * Ruling A-3: `privateAccessTiers` is served from this public endpoint so the settings screen can
 * decide whether to reveal the 【个人探索】 switch without `/api/channels` ever leaking the private
 * node. It is passed through when configured and omitted when not (M-3: eligibility is cloud
 * configuration, never a code default).
 */

import type { Clock } from '../core/clock';
import type { Env } from '../types/env';
import {
  configUnavailableResponse,
  publicConfigHeaders,
  readMonetizationConfig
} from '../config/kv-config';
import { jsonResponse } from '../http/json';

export async function handleMonetizationConfig(
  _request: Request,
  env: Env,
  _clock: Clock
): Promise<Response> {
  const config = await readMonetizationConfig(env.KV);
  if (config === null) return configUnavailableResponse();
  return jsonResponse(config, 200, publicConfigHeaders());
}
