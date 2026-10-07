const ITERATIONS = 100000;
const encoder = new TextEncoder();

export function randomToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function digestToken(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function equalDigest(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

async function derive(password: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: encoder.encode(salt), iterations: ITERATIONS }, key, 256);
  return Array.from(new Uint8Array(bits), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function createPasswordHash(password: string): Promise<string> {
  const salt = randomToken();
  return `pbkdf2-sha256:${ITERATIONS}:${salt}:${await derive(password, salt)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split(':');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2-sha256' || parts[1] !== String(ITERATIONS) ||
      !/^[a-f0-9]{64}$/.test(parts[2]) || !/^[a-f0-9]{64}$/.test(parts[3])) return false;
  return equalDigest(await derive(password, parts[2]), parts[3]);
}
