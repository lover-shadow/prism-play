import { PERMANENT_EXPIRES_AT } from '../types/api';
import { INVITE_REWARD_DAYS } from '../core/constants';
import { isCredentialLive, readDeviceIdentity } from '../auth/guard';
import { DEVICE_ID_PATTERN } from '../core/validation';

export const INVITE_REWARD_SECONDS = INVITE_REWARD_DAYS * 86400;

/**
 * `settled_*` means the ledger row and the inviter's grant were written in one batch.
 * `skipped_*` means no settlement happened and the redemption itself is untouched — openapi.yaml
 * `RedeemRequest.inviteRef` says "无可靠归因时不结算", so an unusable referral must never turn a
 * valid card redemption into a failed request.
 */
export type InviteSettlement =
  | 'settled_tier_extend'
  | 'settled_nudge_free'
  | 'skipped_no_ref'
  | 'skipped_invalid_ref'
  | 'skipped_unknown_inviter'
  | 'skipped_self_invite'
  | 'skipped_already_settled';

function reasonFromMessage(message: string): InviteSettlement | null {
  if (/invitation_logs\.invitee_device_id/.test(message)) return 'skipped_already_settled';
  return null;
}

/**
 * M-4: the reward's shape is decided by the *inviter's* status, not the invitee's.
 * The increment is written to `devices` only and never back to `card_coupons`, so revoking the
 * invitee's coupon cannot claw back days the inviter already earned.
 * `UNIQUE(invitee_device_id)` and `CHECK(inviter_device_id <> invitee_device_id)` in the schema are
 * the authorities for one-settlement-per-invitee and no self-invite; both are caught here instead
 * of being re-implemented in JS.
 */
export async function settleFirstInvite(input: {
  db: D1Database;
  inviteeDeviceId: string;
  inviteRef: string | undefined;
  nowSeconds: number;
}): Promise<InviteSettlement> {
  const { db, inviteeDeviceId, inviteRef, nowSeconds } = input;
  if (inviteRef === undefined) return 'skipped_no_ref';
  if (!DEVICE_ID_PATTERN.test(inviteRef)) return 'skipped_invalid_ref';
  if (inviteRef === inviteeDeviceId) return 'skipped_self_invite';

  const inviter = await readDeviceIdentity(db, inviteRef);
  if (inviter === null) return 'skipped_unknown_inviter';

  const isMember = inviter.tier !== '0' && isCredentialLive(inviter, nowSeconds);
  const rewardType = isMember ? 'TIER_EXTEND' : 'NUDGE_FREE';
  // A permanent inviter has nothing to extend: the -1 sentinel is preserved, and the settlement
  // is still logged so the ledger reflects the referral.
  const inviterValue = isMember
    ? inviter.expiresAt === PERMANENT_EXPIRES_AT
      ? PERMANENT_EXPIRES_AT
      : inviter.expiresAt + INVITE_REWARD_SECONDS
    : Math.max(inviter.exemptUntil, nowSeconds) + INVITE_REWARD_SECONDS;
  const inviterColumn = isMember ? 'expires_at' : 'exempt_until';

  try {
    await db.batch([
      db
        .prepare(
          'INSERT INTO invitation_logs (inviter_device_id, invitee_device_id, reward_type, reward_days, settled, ' +
            'created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        )
        .bind(inviteRef, inviteeDeviceId, rewardType, INVITE_REWARD_DAYS, 1, nowSeconds, nowSeconds),
      db
        .prepare(`UPDATE devices SET ${inviterColumn} = ?, updated_at = ? WHERE device_id = ?`)
        .bind(inviterValue, nowSeconds, inviteRef),
      db
        .prepare('UPDATE devices SET invited_by = ?, updated_at = ? WHERE device_id = ?')
        .bind(inviteRef, nowSeconds, inviteeDeviceId)
    ]);
  } catch (error) {
    const reason = error instanceof Error ? reasonFromMessage(error.message) : null;
    if (reason !== null) return reason;
    throw error;
  }
  return isMember ? 'settled_tier_extend' : 'settled_nudge_free';
}
