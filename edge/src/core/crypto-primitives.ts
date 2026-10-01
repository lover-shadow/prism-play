/**
 * Shared WebCrypto primitives.
 * Everything here is the Workers-compatible subset only: `crypto.subtle`, `btoa`/`atob` and
 * `TextEncoder`/`TextDecoder`. Node built-ins must never be imported from `edge/src`.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const textEncoder = encoder;
export const textDecoder = decoder;

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function stringToBase64Url(value: string): string {
  return bytesToBase64Url(encoder.encode(value));
}

export function base64UrlToBytes(value: string): Uint8Array {
  const withPadding = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(withPadding + '='.repeat((4 - (withPadding.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function base64UrlToString(value: string): string {
  return decoder.decode(base64UrlToBytes(value));
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

const HMAC_SHA256 = { name: 'HMAC', hash: 'SHA-256' } as const;

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), HMAC_SHA256, false, ['sign', 'verify']);
}

/** Signature bytes are compared inside WebCrypto, which keeps the check constant-time. */
export async function hmacSign(secret: string, payload: string): Promise<string> {
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(payload));
  return bytesToBase64Url(new Uint8Array(signature));
}

export async function hmacVerify(secret: string, payload: string, signatureBase64Url: string): Promise<boolean> {
  try {
    return await crypto.subtle.verify(
      'HMAC',
      await hmacKey(secret),
      base64UrlToBytes(signatureBase64Url),
      encoder.encode(payload)
    );
  } catch {
    return false;
  }
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return bytesToHex(new Uint8Array(digest));
}

export function randomHex(byteLength: number): string {
  const buffer = new Uint8Array(byteLength);
  crypto.getRandomValues(buffer);
  return bytesToHex(buffer);
}
