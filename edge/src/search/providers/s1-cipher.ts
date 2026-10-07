import { createDecipheriv } from 'node:crypto';

export function countOnes(n: number): number {
  let count = 0;
  let val = n >>> 0;
  while (val > 0) {
    count += val & 1;
    val >>>= 1;
  }
  return count;
}

export function rotateLeft8(b: number, n: number): number {
  const shift = n % 8;
  const byte = b & 0xff;
  return ((byte << shift) | (byte >>> (8 - shift))) & 0xff;
}

export function reverse8(b: number): number {
  let val = b & 0xff;
  val = ((val & 0xaa) >>> 1) | ((val & 0x55) << 1);
  val = ((val & 0xcc) >>> 2) | ((val & 0x33) << 2);
  val = ((val & 0xf0) >>> 4) | ((val & 0x0f) << 4);
  return val & 0xff;
}

export function decodeBase64Safe(value: string): Uint8Array | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return new Uint8Array(Buffer.from(trimmed, 'base64'));
  } catch {
    return null;
  }
}

export function extractSpadeKey(spadeA: string): Uint8Array | null {
  if (!spadeA || spadeA.length > 1024) return null;
  const raw = decodeBase64Safe(spadeA);
  if (!raw || raw.length < 3) return null;

  const tagLength = ((raw[0]! ^ raw[1]! ^ raw[2]!) & 0xff) - 48;
  const contentLength = raw.length - tagLength - 1;
  if (tagLength < 1 || contentLength < 33 || contentLength >= raw.length) return null;

  const seed = (raw[raw.length - tagLength - 2]! ^ raw[raw.length - tagLength - 1]!) & 0xff;
  const tagBytes = new Uint8Array(tagLength);
  for (let index = 0; index < tagLength; index++) {
    tagBytes[index] = (raw[raw.length - tagLength + index]! ^ seed) & 0xff;
  }
  const tag = new TextDecoder().decode(tagBytes);
  if (tag === 'app_v2' || tag === 'web_v2') return null;

  const decoded = new Uint8Array(contentLength);
  let previousEven = 250;
  let previousOdd = 85;
  for (let index = 0; index < contentLength; index++) {
    const current = raw[1 + index]!;
    let previous = previousEven;
    if (index % 2 === 0) {
      previousEven = current;
    } else {
      previous = previousOdd;
      previousOdd = current;
    }
    const delta = (previous ^ current) - 21 - countOnes(index);
    decoded[index] = delta & 0xff;
  }

  const padChar = String.fromCharCode(decoded[0]!);
  const padding = parseInt(padChar, 36);
  if (isNaN(padding) || contentLength - padding - 1 !== 32) return null;

  const hexString = new TextDecoder().decode(decoded.slice(1, 33));
  if (!/^[0-9a-fA-F]{32}$/.test(hexString)) return null;

  try {
    const key = new Uint8Array(Buffer.from(hexString, 'hex'));
    return key.length === 16 ? key : null;
  } catch {
    return null;
  }
}

const PLAYBACK_MASK = new Uint8Array([
  104, 64, 70, 166, 190, 168, 143, 130, 225, 254, 251, 217, 196, 34, 45, 60, 29, 20, 103, 105
]);

export function decodeHongguoPlaybackV2(body: string): Uint8Array | null {
  const text = body.trim();
  if (!text.startsWith('v2.')) {
    return new TextEncoder().encode(text);
  }
  const parts = text.split('.');
  if (parts.length !== 3 || parts[1]!.length <= 4 || parts[1]!.length > 1028) return null;

  const keyHex = parts[1]!.slice(4);
  let encoded: Uint8Array;
  try {
    encoded = new Uint8Array(Buffer.from(keyHex, 'hex'));
  } catch {
    return null;
  }
  if (encoded.length < 32) return null;

  const material = new Uint8Array(encoded.length);
  for (let index = 0; index < encoded.length; index++) {
    const current = encoded[index]!;
    const previous = index > 0 ? encoded[index - 1]! : 109;
    const slot = index % PLAYBACK_MASK.length;
    const salt = (PLAYBACK_MASK[slot]! ^ (90 + 13 * slot) ^ 85) & 0xff;
    const shifted = ((current + 215 - 11 * index) & 0xff);
    material[index] = (previous ^ salt ^ rotateLeft8(shifted, 3)) & 0xff;
  }

  const ciphertext = decodeBase64Safe(parts[2]!);
  if (!ciphertext || ciphertext.length === 0 || ciphertext.length % 16 !== 0) return null;

  try {
    const key = material.slice(0, 16);
    const iv = material.slice(16, 32);
    const decipher = createDecipheriv('aes-128-cbc', key, iv);
    decipher.setAutoPadding(true);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return new Uint8Array(decrypted);
  } catch {
    return null;
  }
}
