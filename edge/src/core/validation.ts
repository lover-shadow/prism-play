import type { DeviceTier, CouponTier, ChannelId } from '../types/api';
import { COUPON_TIERS, DEVICE_TIERS } from '../types/api';

/** Patterns copied verbatim from openapi.yaml RedeemRequest — a second dialect is a contract break. */
export const COUPON_CODE_PATTERN = /^GY-(?:Q|A|B|Y|S)[A-Z0-9]{3,4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
export const DEVICE_ID_PATTERN = /^GY-[A-Z0-9]{8}$/;

export function isValidCouponCode(value: unknown): value is string {
  return typeof value === 'string' && COUPON_CODE_PATTERN.test(value);
}

export function isValidDeviceId(value: unknown): value is string {
  return typeof value === 'string' && DEVICE_ID_PATTERN.test(value);
}

export function isDeviceTier(value: unknown): value is DeviceTier {
  return typeof value === 'string' && (DEVICE_TIERS as readonly string[]).includes(value);
}

export function isCouponTier(value: unknown): value is CouponTier {
  return typeof value === 'string' && (COUPON_TIERS as readonly string[]).includes(value);
}

export function isChannelId(value: unknown): value is ChannelId {
  return value === 'drama' || value === 'movie' || value === 'anime' || value === 'documentary' || value === 'private';
}

/**
 * `channels.requires_tier` is a cloud-editable CSV (M-3): '0' means public,
 * anything else is a tier set with 'ADVANCED' kept as the legacy alias for B,Y,S.
 */
export function parseRequiresTier(raw: string): DeviceTier[] {
  if (raw.trim() === '0') return [];
  if (raw.trim().toUpperCase() === 'ADVANCED') return ['B', 'Y', 'S'];
  return raw
    .split(',')
    .map((part) => part.trim().toUpperCase())
    .filter(isCouponTier);
}

/** D1 stores booleans as 0/1 integers; centralize the conversion instead of leaking it to callers. */
export function toBoolean(value: number | null | undefined): boolean {
  return value === 1;
}

export function fromBoolean(value: boolean): number {
  return value ? 1 : 0;
}
