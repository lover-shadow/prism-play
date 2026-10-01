const HKDF_SALT = 'prism-proxy-media-v1';
const HKDF_INFO = 'media-handle';
const IV_BYTES = 12;

/**
 * Opaque, self-contained media handles for `/proxy/media/{handle}`.
 *
 * A child URI of an HLS playlist (segment, key, subtitle) has to survive the rewrite without ever
 * exposing the upstream address. base64url is reversible, so the target is sealed with AES-256-GCM
 * under a key derived from the proxy secret: the client can replay a handle inside its signed window
 * but cannot read or steer the upstream target, and the proxy still re-checks the D1 whitelist and
 * the content's current visibility on every single sub-request.
 */
export interface ParsedMediaHandle {
  episodeId: number;
  /** Absolute upstream URL for the manifest itself or one of its children. */
  targetUrl: string;
}

export interface MediaHandleCodec {
  mint(episodeId: number, targetUrl: string): Promise<string>;
  parse(handle: string): Promise<ParsedMediaHandle | null>;
}

async function deriveAesKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'HKDF', false, [
    'deriveKey'
  ]);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode(HKDF_SALT),
      info: new TextEncoder().encode(HKDF_INFO)
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array {
  const withPadding = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(withPadding + '='.repeat((4 - (withPadding.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

const HANDLE_SHAPE = /^e_(\d+)\.([A-Za-z0-9_-]{8,})\.([A-Za-z0-9_-]{16,})$/;

export async function createMediaHandleCodec(secret: string): Promise<MediaHandleCodec> {
  const key = await deriveAesKey(secret);

  return {
    async mint(episodeId: number, targetUrl: string): Promise<string> {
      const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
      const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(targetUrl));
      return `e_${episodeId}.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(sealed))}`;
    },

    async parse(handle: string): Promise<ParsedMediaHandle | null> {
      const match = HANDLE_SHAPE.exec(handle);
      if (match === null) return null;
      const episodeId = Number(match[1]);
      if (!Number.isSafeInteger(episodeId) || episodeId <= 0) return null;
      try {
        const iv = fromBase64Url(match[2] as string);
        const sealed = fromBase64Url(match[3] as string);
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, sealed);
        return { episodeId, targetUrl: new TextDecoder().decode(plain) };
      } catch {
        // A tampered or foreign handle fails the GCM tag and is indistinguishable from a bad one.
        return null;
      }
    }
  };
}
