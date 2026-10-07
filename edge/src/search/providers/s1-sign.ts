import { createHash } from 'node:crypto';
import { reverse8, rotateLeft8 } from './s1-cipher';

const SIGN_KEY = new Uint8Array([
  0x44, 0xb9, 0xb9, 0xd9, 0xa4, 0xae, 0xf9, 0xfc, 0xa4, 0x93,
  0xaa, 0x75, 0x7c, 0xa3, 0xc2, 0xc4, 0xa4, 0x96, 0x93, 0x8f
]);

export function md5Bytes(data: Uint8Array | string): Uint8Array {
  const hash = createHash('md5');
  hash.update(data);
  return new Uint8Array(hash.digest());
}

export function newHongguoDeviceID(): string {
  const randomInt = Math.floor(Math.random() * 8000000000);
  return (1000000000000000000n + BigInt(randomInt)).toString();
}

export function signHongguoRequest(rawQuery: string, body?: Uint8Array, nowMs = Date.now()): Record<string, string> {
  const nowSec = Math.floor(nowMs / 1000);
  const timestamp = nowSec >>> 0;
  const queryHash = md5Bytes(new TextEncoder().encode(rawQuery));

  const payload = new Uint8Array(20);
  payload.set(queryHash.slice(0, 4), 0);

  const headers: Record<string, string> = {
    'X-Khronos': timestamp.toString(),
    'X-SS-Req-Ticket': nowMs.toString()
  };

  if (body && body.length > 0) {
    const bodyHash = md5Bytes(body);
    payload.set(bodyHash.slice(0, 4), 4);
    headers['X-SS-STUB'] = Buffer.from(bodyHash).toString('hex').toUpperCase();
  }

  payload[12] = 0;
  payload[13] = 6;
  payload[14] = 11;
  payload[15] = 28;

  payload[16] = (timestamp >>> 24) & 0xff;
  payload[17] = (timestamp >>> 16) & 0xff;
  payload[18] = (timestamp >>> 8) & 0xff;
  payload[19] = timestamp & 0xff;

  for (let index = 0; index < 20; index++) {
    payload[index] = payload[index]! ^ SIGN_KEY[index]!;
  }

  for (let index = 0; index < 20; index++) {
    const nextVal = payload[(index + 1) % 20]!;
    const mixed = rotateLeft8(payload[index]!, 4) ^ nextVal;
    payload[index] = reverse8(mixed) ^ 0xff ^ 20;
  }

  const prefix = new Uint8Array([0x84, 0x04, 0x40, 0x1c, 0, 0]);
  const signature = new Uint8Array(prefix.length + payload.length);
  signature.set(prefix, 0);
  signature.set(payload, prefix.length);

  headers['X-Gorgon'] = Buffer.from(signature).toString('hex');
  return headers;
}
