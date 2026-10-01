/** Injected time source so expiry, rate-limit windows and retry backoff are testable. */

export interface Clock {
  nowSeconds(): number;
  nowMillis(): number;
}

export const systemClock: Clock = {
  nowSeconds: () => Math.floor(Date.now() / 1000),
  nowMillis: () => Date.now()
};

export function secondsFromMillis(millis: number): number {
  return Math.floor(millis / 1000);
}
