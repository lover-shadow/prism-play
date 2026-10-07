/**
 * 运营后台卡密仓储（ADMIN-ANALYTICS-AND-COUPON-SPEC-AND-PLAN §2.5）。
 *
 * 与 `coupon-repo.ts` 同一条纪律：状态迁移与审计是一个原子单元，任何“条件未命中却想留下记录”
 * 的情况都必须整批回滚。条件 UPDATE 后以 changes() 判定是否命中；未命中时把审计行的
 * NOT NULL `action` 判成 NULL，触发约束错误让 `batch()` 整体回滚，不会残留成功审计。
 *
 * 三条正交状态轴：核销 `status`、首次绑定 `device_count`、手动分发 `dispatch_status`。
 * 作废只停后续核销，绝不触碰 devices / 授权期限（计划 §1.1、§2.5）。
 */

const COUPON_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const COUPON_GROUP_LEN = 4;
const COUPON_GROUPS = 3;

function randomGroup(length: number): string {
  const bytes = new Uint8Array(length);
  const limit = 256 - (256 % COUPON_ALPHABET.length);
  let out = '';
  while (out.length < length) {
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte < limit) out += COUPON_ALPHABET[byte % COUPON_ALPHABET.length];
      if (out.length === length) break;
    }
  }
  return out;
}

/** GY-XXXX-XXXX-XXXX，全段 crypto 随机；满足正则不等于防伪，故不用固定 Q90D 段或序号。 */
export function mintCouponCode(): string {
  const groups: string[] = [];
  for (let i = 0; i < COUPON_GROUPS; i += 1) groups.push(randomGroup(COUPON_GROUP_LEN));
  return `GY-${groups.join('-')}`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

interface GenerateInput {
  readonly requestId: string;
  readonly tier: 'Q' | 'B' | 'Y' | 'S';
  readonly tierName: string;
  readonly durationDays: number;
  readonly count: number;
  readonly note: string | null;
  readonly codes: readonly string[];
  readonly nowSeconds: number;
}

interface AuditIdentity {
  requestId: string;
  action: string;
  targetHash: string | null;
  batchId: string | null;
  details: string | null;
}

/** Request identity excludes timestamps and newly generated code candidates. */
async function auditReplay(db: D1Database, identity: AuditIdentity): Promise<'same' | 'conflict' | null> {
  const row = await db.prepare(
    'SELECT action, target_hash, batch_id, details_json FROM admin_audit_logs WHERE request_id = ?'
  ).bind(identity.requestId).first<{
    action: string; target_hash: string | null; batch_id: string | null; details_json: string | null;
  }>();
  if (row === null) return null;
  return row.action === identity.action && row.target_hash === identity.targetHash &&
    row.batch_id === identity.batchId && row.details_json === identity.details ? 'same' : 'conflict';
}

/**
 * 一批生成 = 批次行 + N 张 ACTIVE/IDLE 卡密 + 审计，单 `batch()` 原子提交。
 * `request_id` UNIQUE 承载幂等：重试先命中已存在批次，直接回原码，不再造资产。
 */
export async function generateCouponBatch(
  db: D1Database,
  input: GenerateInput
): Promise<{ codes: readonly string[]; created: boolean }> {
  const batchId = `bat_${input.requestId}`;
  const identity: AuditIdentity = {
    requestId: input.requestId, action: 'COUPON_CREATE', targetHash: null, batchId,
    details: JSON.stringify({ tier: input.tier, tierName: input.tierName,
      durationDays: input.durationDays, count: input.count, note: input.note })
  };
  const replay = async () => {
    const match = await auditReplay(db, identity);
    if (match === 'conflict') throw new Error('Coupon requestId conflict');
    if (match === null) return null;
    // Preserve insertion order without exposing plaintext codes in audit details.
    const stored = await db.prepare('SELECT code FROM card_coupons WHERE batch_id = ? ORDER BY rowid')
      .bind(batchId).all<{ code: string }>();
    return { codes: stored.results.map((row) => row.code), created: false };
  };
  const existing = await replay();
  if (existing !== null) return existing;
  if (input.codes.length !== input.count) throw new Error('Coupon batch count mismatch');
  const statements: D1PreparedStatement[] = [
    db.prepare(
      'INSERT INTO coupon_batches (batch_id, request_id, tier, count, note, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(batchId, input.requestId, input.tier, input.count, input.note, input.nowSeconds)
  ];
  for (const code of input.codes) {
    statements.push(
      db
        .prepare(
          'INSERT INTO card_coupons (code, tier, tier_name, duration_days, status, max_devices, device_count, ' +
            'batch_id, dispatch_status, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .bind(code, input.tier, input.tierName, input.durationDays, 'ACTIVE', 10, 0, batchId, 'IDLE', input.note, input.nowSeconds, input.nowSeconds)
    );
  }
  statements.push(
    db
      .prepare(
        'INSERT INTO admin_audit_logs (request_id, actor, action, target_hash, batch_id, details_json, created_at) ' +
          "VALUES (?, 'admin', 'COUPON_CREATE', NULL, ?, ?, ?)"
      )
      .bind(input.requestId, batchId, identity.details, input.nowSeconds)
  );
  try {
    await db.batch(statements);
    return { codes: [...input.codes], created: true };
  } catch (error) {
    if (isConstraintViolation(error)) {
      const committed = await replay();
      if (committed !== null) return committed;
    }
    throw error;
  }
}

interface MutationInput {
  readonly code: string;
  readonly requestId: string;
  readonly nowSeconds: number;
}

/**
 * The preceding conditional UPDATE must change one row. Otherwise audit.action becomes
 * NULL (NOT NULL tripwire), rolling back the batch even when the target is absent.
 * Audit failures and request-ID races also roll back the mutation.
 */
async function mutate(
  db: D1Database, input: MutationInput, action: string, details: string | null,
  update: D1PreparedStatement
): Promise<'success' | 'conflict' | 'unmatched'> {
  const identity: AuditIdentity = {
    requestId: input.requestId, action, targetHash: await sha256Hex(input.code), batchId: null, details
  };
  const existing = await auditReplay(db, identity);
  if (existing !== null) return existing === 'same' ? 'success' : 'conflict';
  try {
    await db.batch([
      update,
      db.prepare(
        'INSERT INTO admin_audit_logs (request_id, actor, action, target_hash, details_json, created_at) ' +
        "VALUES (?, 'admin', CASE WHEN changes() = 1 THEN ? ELSE NULL END, ?, ?, ?)"
      ).bind(input.requestId, action, identity.targetHash, details, input.nowSeconds)
    ]);
    return 'success';
  } catch (error) {
    if (!isConstraintViolation(error)) throw error;
    const committed = await auditReplay(db, identity);
    if (committed !== null) return committed === 'same' ? 'success' : 'conflict';
    return 'unmatched';
  }
}

async function dispatchState(db: D1Database, code: string): Promise<{ dispatch_status: string } | null> {
  return db.prepare('SELECT dispatch_status FROM card_coupons WHERE code = ?')
    .bind(code).first<{ dispatch_status: string }>();
}

/** Claim only unredeemed, unbound, non-revoked IDLE stock. */
export async function claimCouponForDispatch(
  db: D1Database, input: MutationInput & { readonly note: string }
): Promise<{ status: 'dispatched' | 'conflict' | 'needs_confirm' | 'not_found' }> {
  const result = await mutate(db, input, 'COUPON_DISPATCH', JSON.stringify({ note: input.note }),
    db.prepare(
      "UPDATE card_coupons SET dispatch_status = 'DISPATCHED', dispatch_note = ?, dispatched_at = ?, " +
      'dispatch_request_id = ?, updated_at = ? WHERE code = ? AND ' +
      "dispatch_status = 'IDLE' AND device_count = 0 AND first_redeemed_at IS NULL AND status <> 'REVOKED'"
    ).bind(input.note, input.nowSeconds, input.requestId, input.nowSeconds, input.code));
  if (result === 'success') return { status: 'dispatched' };
  if (result === 'conflict') return { status: 'conflict' };
  const row = await dispatchState(db, input.code);
  return { status: row === null ? 'not_found' : row.dispatch_status === 'UNKNOWN' ? 'needs_confirm' : 'conflict' };
}

/** UNKNOWN → IDLE only for stock never redeemed or revoked. */
export async function confirmCouponStock(
  db: D1Database, input: MutationInput
): Promise<{ status: 'confirmed' | 'noop' | 'not_found' | 'conflict' }> {
  const result = await mutate(db, input, 'STOCK_CONFIRM', null, db.prepare(
    "UPDATE card_coupons SET dispatch_status = 'IDLE', updated_at = ? WHERE code = ? " +
    "AND dispatch_status = 'UNKNOWN' AND device_count = 0 AND first_redeemed_at IS NULL AND status <> 'REVOKED'"
  ).bind(input.nowSeconds, input.code));
  if (result === 'success') return { status: 'confirmed' };
  if (result === 'conflict') return { status: 'conflict' };
  return { status: await dispatchState(db, input.code) === null ? 'not_found' : 'noop' };
}

/** Revoke future redemption, preserving devices, expiry and historical bindings. */
export async function revokeCoupon(
  db: D1Database, input: MutationInput & { readonly reason: string }
): Promise<{ status: 'revoked' | 'not_found' | 'conflict' }> {
  const result = await mutate(db, input, 'COUPON_REVOKE', JSON.stringify({ reason: input.reason }),
    db.prepare("UPDATE card_coupons SET status = 'REVOKED', updated_at = ? WHERE code = ? AND status <> 'REVOKED'")
      .bind(input.nowSeconds, input.code));
  if (result === 'success') return { status: 'revoked' };
  if (result === 'conflict') return { status: 'conflict' };
  return { status: await dispatchState(db, input.code) === null ? 'not_found' : 'conflict' };
}

/** 与 `coupon-repo.ts` 同一约束判定：本路径只会命中唯一键 / NOT NULL trip-wire。 */
function isConstraintViolation(error: unknown): boolean {
  return error instanceof Error && /constraint failed/i.test(error.message);
}
