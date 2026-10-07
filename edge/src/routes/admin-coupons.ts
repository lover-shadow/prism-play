import { digestToken } from '../auth/admin-password';
import type { AdminEnv } from '../auth/admin-session';
import { adminJson } from './admin-auth';

interface CouponRow {
  code: string;
  tier: string;
  tier_name: string;
  status: string;
  device_count: number;
  max_devices: number;
  dispatch_status: string;
  note: string | null;
  dispatch_note: string | null;
  created_at: number;
}

const columns = 'code,tier,tier_name,status,device_count,max_devices,dispatch_status,note,dispatch_note,created_at';

async function masked(row: CouponRow) {
  const { code, ...rest } = row;
  return { ...rest, id: await digestToken(code), maskedCode: `${code.slice(0, 3)}****-****-${code.slice(-4)}` };
}

export async function handleAdminCouponRead(request: Request, env: AdminEnv): Promise<Response> {
  const url = new URL(request.url);
  const detail = /^\/api\/admin\/coupons\/([a-f0-9]{64})$/.exec(url.pathname);
  if (detail) {
    // Existing ledger keys are codes; hash resolution stays in the admin path until indexed IDs are migrated.
    const rows = await env.DB.prepare(`SELECT ${columns} FROM card_coupons`).all<CouponRow>();
    for (const row of rows.results) {
      if (await digestToken(row.code) !== detail[1]) continue;
      const bindings = await env.DB.prepare('SELECT device_id,bound_at FROM coupon_bindings WHERE coupon_code = ? ORDER BY bound_at DESC')
        .bind(row.code).all<{ device_id: string; bound_at: number }>();
      return adminJson({ ...await masked(row), bindings: bindings.results });
    }
    return adminJson({ code: 'NOT_FOUND' }, 404);
  }
  const pageRaw = url.searchParams.get('page') ?? '1';
  const limitRaw = url.searchParams.get('limit') ?? '20';
  if (!/^[1-9][0-9]{0,5}$/.test(pageRaw) || !['20', '50'].includes(limitRaw)) return adminJson({ code: 'VALIDATION_ERROR' }, 400);
  const conditions: string[] = [];
  const values: string[] = [];
  for (const [parameter, column, allowed] of [
    ['tier', 'tier', ['Q', 'A', 'B', 'Y', 'S']],
    ['status', 'status', ['UNUSED', 'ACTIVE', 'REVOKED']],
    ['dispatch', 'dispatch_status', ['UNKNOWN', 'IDLE', 'DISPATCHED']]
  ] as const) {
    const value = url.searchParams.get(parameter);
    if (!value) continue;
    if (!(allowed as readonly string[]).includes(value)) return adminJson({ code: 'VALIDATION_ERROR' }, 400);
    conditions.push(`${column} = ?`);
    values.push(value);
  }
  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  const page = Number(pageRaw);
  const limit = Number(limitRaw);
  const count = await env.DB.prepare(`SELECT COUNT(*) AS total FROM card_coupons${where}`).bind(...values).first<{ total: number }>();
  const rows = await env.DB.prepare(`SELECT ${columns} FROM card_coupons${where} ORDER BY created_at DESC,code LIMIT ? OFFSET ?`)
    .bind(...values, limit, (page - 1) * limit).all<CouponRow>();
  return adminJson({ items: await Promise.all(rows.results.map(masked)), total: count?.total ?? 0, page, limit });
}
