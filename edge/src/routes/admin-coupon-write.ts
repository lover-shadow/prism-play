import type { Clock } from '../core/clock';
import { cookieToken, type AdminEnv } from '../auth/admin-session';
import { digestToken } from '../auth/admin-password';
import { mintCouponCode, generateCouponBatch, claimCouponForDispatch, confirmCouponStock, revokeCoupon } from '../db/coupon-admin-repo';
import { adminJson } from './admin-auth';
import { readAdminBody } from './admin-body';

const tiers = {
  Q: { name: '季度畅享卡', days: 90 }, B: { name: '高级全源卡', days: 90 },
  Y: { name: '年度尊享卡', days: 365 }, S: { name: '极客纪念卡', days: -1 }
};

async function resolveCode(db: D1Database, id: string): Promise<string | null> {
  const rows = await db.prepare('SELECT code FROM card_coupons').all<{ code: string }>();
  for (const row of rows.results) if (await digestToken(row.code) === id) return row.code;
  return null;
}

export async function handleAdminCouponWrite(request: Request, env: AdminEnv, clock: Clock): Promise<Response> {
  const body = await readAdminBody(request);
  if (body instanceof Response) return body;
  if (typeof body.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(body.requestId)) return adminJson({ code: 'VALIDATION_ERROR' }, 400);
  const note = body.note ?? '';
  if (typeof note !== 'string' || note.length > 200) return adminJson({ code: 'VALIDATION_ERROR' }, 400);
  const path = new URL(request.url).pathname;
  const nowSeconds = clock.nowSeconds();
  if (path === '/api/admin/coupons/generate') {
    if (typeof body.tier !== 'string' || !Object.hasOwn(tiers, body.tier) || !Number.isInteger(body.count) || Number(body.count) < 1 || Number(body.count) > 100) {
      return adminJson({ code: 'VALIDATION_ERROR' }, 400);
    }
    const rateKey = `generate:${await digestToken(cookieToken(request)!)}`;
    const window = Math.floor(nowSeconds / 60) * 60;
    const reserved = await env.DB.prepare('INSERT INTO admin_login_limits (ip_hash,window_start,attempts,updated_at) VALUES (?,?,1,?) ' +
      'ON CONFLICT(ip_hash,window_start) DO UPDATE SET attempts=attempts+1,updated_at=excluded.updated_at WHERE attempts<5 RETURNING attempts')
      .bind(rateKey, window, nowSeconds).first<{ attempts: number }>();
    if (!reserved) return adminJson({ code: 'RATE_LIMITED' }, 429);
    const tier = body.tier as keyof typeof tiers;
    const codes = Array.from({ length: Number(body.count) }, () => mintCouponCode());
    try {
      const result = await generateCouponBatch(env.DB, { requestId: body.requestId, tier, tierName: tiers[tier].name,
        durationDays: tiers[tier].days, count: codes.length, note, codes, nowSeconds });
      return adminJson(result);
    } catch (error) {
      if (error instanceof Error && error.message === 'Coupon requestId conflict') return adminJson({ code: 'CONFLICT' }, 409);
      throw error;
    }
  }
  const match = /^\/api\/admin\/coupons\/([a-f0-9]{64})\/(reveal|confirm-stock|dispatch|revoke)$/.exec(path);
  if (!match) return adminJson({ code: 'NOT_FOUND' }, 404);
  const code = await resolveCode(env.DB, match[1]);
  if (code === null) return adminJson({ code: 'NOT_FOUND' }, 404);
  if (match[2] === 'reveal') {
    await env.DB.prepare("INSERT INTO admin_audit_logs (request_id,actor,action,target_hash,created_at) VALUES (?,'admin','COUPON_REVEAL',?,?) ON CONFLICT(request_id) DO NOTHING")
      .bind(body.requestId, match[1], nowSeconds).run();
    const audit = await env.DB.prepare('SELECT action,target_hash FROM admin_audit_logs WHERE request_id=?')
      .bind(body.requestId).first<{ action: string; target_hash: string }>();
    if (audit?.action !== 'COUPON_REVEAL' || audit.target_hash !== match[1]) return adminJson({ code: 'CONFLICT' }, 409);
    return adminJson({ code });
  }
  const input = { code, requestId: body.requestId, nowSeconds };
  if (match[2] === 'dispatch') {
    const result = await claimCouponForDispatch(env.DB, { ...input, note });
    return adminJson(result, result.status === 'dispatched' ? 200 : result.status === 'not_found' ? 404 : 409);
  }
  if (match[2] === 'confirm-stock') {
    const result = await confirmCouponStock(env.DB, input);
    return adminJson(result, result.status === 'confirmed' ? 200 : result.status === 'not_found' ? 404 : 409);
  }
  if (typeof body.reason !== 'string' || body.reason.trim().length === 0 || body.reason.length > 200) return adminJson({ code: 'VALIDATION_ERROR' }, 400);
  const result = await revokeCoupon(env.DB, { ...input, reason: body.reason });
  return adminJson(result, result.status === 'revoked' ? 200 : result.status === 'not_found' ? 404 : 409);
}
