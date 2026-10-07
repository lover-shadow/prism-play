import type { Clock } from '../core/clock';
import type { Env } from '../types/env';
import { readVersionRelease } from '../config/kv-config';
import { adminJson } from './admin-auth';

export async function handleAdminOperations(request: Request, env: Env, clock: Clock): Promise<Response> {
  const devices = await env.DB.prepare(
    "SELECT tier, COUNT(*) AS devices FROM devices WHERE tier <> '0' AND (expires_at = -1 OR expires_at > ?) GROUP BY tier"
  ).bind(clock.nowSeconds()).all<{ tier: string; devices: number }>();
  const signals = await env.DB.prepare(
    'SELECT provider_id,failure_code,COUNT(*) AS reports FROM line_health_signals WHERE reported_at BETWEEN ? AND ? ' +
    'GROUP BY provider_id,failure_code ORDER BY reports DESC LIMIT 20'
  ).bind(clock.nowSeconds() - 86400, clock.nowSeconds()).all();
  return adminJson({ authorizedDevices: devices.results, lineSignals: signals.results,
    lineSignalNotice: '未经认证的失败上报样本，不代表失败率或健康状态',
    version: await readVersionRelease(env.KV, new URL(request.url).origin) });
}
