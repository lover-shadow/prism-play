import type { DiscoveryConfig } from '../discovery-provider';
import { extractSpadeKey, decodeHongguoPlaybackV2 } from './s1-cipher';
import { newHongguoDeviceID, signHongguoRequest } from './s1-sign';
import { fetchAllowedWithOptions, mediaUrl, type RequestScope } from './transport';

export interface NativeEpisodeMedia {
  mediaUrl: string;
  durationSeconds?: number;
  /**
   * CENC content key (16-byte AES-128) as lowercase hex, present only when the selected variant is
   * `cenc-aes-ctr` encrypted. This is a per-playback secret: it must never be persisted to the
   * discovery catalog/checkpoint or logged (`protectedData`/`resumeState` reject it by design), so it
   * is re-derived here at resolve time and handed to the playback path, not to the cache.
   */
  cencKeyHex?: string;
  /** Encryption scheme of the selected variant; omitted for plaintext media. */
  encryptionScheme?: 'cenc-aes-ctr';
}

/** App native protocol target (P0-1: `novel.snssdk.com` returns 404; this host returns 200 + video_model). */
const APP_API_BASE = 'https://api5-normal-sinfonlineb.fqnovel.com';
const APP_REFERER = 'https://novel.snssdk.com/';
const APP_USER_AGENT = 'com.phoenix.read/73532 (Linux; U; Android 16; zh_CN; 25053RT47C; Build/BP2A.250605.031.A3; Cronet/TTNetVersion:04657795 2026-01-23 QuicVersion:c67e9834 2025-09-08)';
const PLAYBACK_API_BASE = 'https://djapi.999888456.xyz/api/hongguo/play';

/** 16-byte AES key to lowercase hex; returns undefined when the key is absent or wrong length. */
function keyHex(key: Uint8Array | null): string | undefined {
  return key && key.length === 16 ? Buffer.from(key).toString('hex') : undefined;
}

function candidateAddresses(info: Record<string, unknown>): string[] {
  const addresses: string[] = [];
  const seen = new Set<string>();
  const add = (val: unknown) => {
    if (typeof val === 'string') {
      let addr = val.trim();
      if (!addr || addr.length > 8192) return;
      if (!addr.startsWith('http://') && !addr.startsWith('https://')) {
        try {
          addr = atob(addr).trim();
        } catch {
          return;
        }
      }
      if ((addr.startsWith('http://') || addr.startsWith('https://')) && !seen.has(addr)) {
        seen.add(addr);
        addresses.push(addr);
      }
    } else if (Array.isArray(val)) {
      for (const item of val) add(item);
    }
  };
  for (const key of ['main_url', 'backup_url', 'backup_url_1', 'backup_url_2', 'backup_urls', 'url_list']) {
    add(info[key]);
  }
  return addresses;
}

export async function resolveS1AppMedia(
  config: DiscoveryConfig,
  videoId: string,
  scope: RequestScope
): Promise<NativeEpisodeMedia | null> {
  // P0-1: guoguo-juku's exact App query set. `_rticket` is injected BEFORE signing so the hashed
  // query string is byte-identical to the request URL (the earlier bug signed one string, sent another).
  const queryParams = new URLSearchParams({
    aid: '8662',
    app_name: 'novelread',
    version_code: '73532',
    version_name: '7.3.5.32',
    manifest_version_code: '73532',
    update_version_code: '73532',
    channel: 'update_64',
    device_platform: 'android',
    os: 'android',
    ssmix: 'a',
    device_type: '25053RT47C',
    device_brand: 'Redmi',
    language: 'zh',
    os_api: '36',
    os_version: '16',
    resolution: '1280*2772',
    dpi: '520',
    ac: 'wifi',
    device_id: newHongguoDeviceID(),
    iid: newHongguoDeviceID(),
    _rticket: Date.now().toString()
  });
  const rawQuery = queryParams.toString();
  const payloadStr = JSON.stringify({
    video_id: videoId,
    content_type: 1,
    biz_param: { need_all_video_definition: true, video_platform: 3 }
  });
  const bodyBytes = new TextEncoder().encode(payloadStr);
  const signHeaders = signHongguoRequest(rawQuery, bodyBytes);
  const headers = {
    ...signHeaders,
    'User-Agent': APP_USER_AGENT,
    'Referer': APP_REFERER,
    'Accept': 'application/json',
    'Content-Type': 'application/json; charset=utf-8',
    'X-XS-From-Web': '0',
    'Sdk-Version': '2'
  };

  const url = `${APP_API_BASE}/novel/player/video_model/v1/?${rawQuery}`;
  try {
    const text = await fetchAllowedWithOptions(config, url, scope, {
      method: 'POST',
      headers,
      body: bodyBytes
    });
    const result = JSON.parse(text) as Record<string, unknown>;
    const data = (result.data ?? {}) as Record<string, unknown>;
    let model = data.video_model;
    if (typeof model === 'string') {
      model = JSON.parse(model) as Record<string, unknown>;
    }
    if (!model || typeof model !== 'object') return null;
    const modelRec = model as Record<string, unknown>;
    const rawList = modelRec.video_list;
    const variants = Array.isArray(rawList)
      ? rawList
      : rawList && typeof rawList === 'object'
        ? Object.values(rawList)
        : [];

    let durationSeconds: number | undefined;
    const rawDur = modelRec.video_duration ?? modelRec.duration;
    if (typeof rawDur === 'number' && Number.isFinite(rawDur) && rawDur > 0) {
      durationSeconds = Math.max(1, Math.round(rawDur));
    }

    for (const v of variants) {
      if (!v || typeof v !== 'object') continue;
      const variant = v as Record<string, unknown>;
      const meta = (variant.video_meta ?? {}) as Record<string, unknown>;
      const codec = String(meta.codec_type ?? '').toLowerCase();
      if (codec === 'bytevc2') continue;
      if (['bytevc1', 'hevc', 'hvc1', 'hev1'].includes(codec)) {
        const width = Number(meta.vwidth ?? meta.width), height = Number(meta.vheight ?? meta.height);
        if (String(variant.definition ?? meta.definition).toLowerCase() !== '1080p' &&
            !(Number.isFinite(width) && Number.isFinite(height) && Math.min(width, height) >= 1080)) continue;
      }

      const encrypt = (variant.encrypt_info ?? {}) as Record<string, unknown>;
      const spade = String(encrypt.spade_a ?? '');
      let cencKeyHex: string | undefined;
      if (spade) {
        cencKeyHex = keyHex(extractSpadeKey(spade));
        if (!cencKeyHex) continue;
      }

      const addresses = candidateAddresses(variant);
      for (const addr of addresses) {
        try {
          const checked = mediaUrl(config, addr);
          return cencKeyHex
            ? { mediaUrl: checked, durationSeconds, cencKeyHex, encryptionScheme: 'cenc-aes-ctr' }
            : { mediaUrl: checked, durationSeconds };
        } catch {
          // Try next candidate address
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

export async function resolveS1PlaybackApi(
  config: DiscoveryConfig,
  seriesId: string,
  videoId: string,
  scope: RequestScope
): Promise<NativeEpisodeMedia | null> {
  const refObj = {
    ContentType: 1004,
    SeriesID: seriesId,
    VideoID: videoId,
    VideoPlatform: 3
  };
  let refBase64 = '';
  try {
    refBase64 = btoa(JSON.stringify(refObj));
  } catch {
    return null;
  }
  const query = new URLSearchParams({ id: refBase64 });
  const url = `${PLAYBACK_API_BASE}?${query.toString()}`;

  try {
    const rawText = await fetchAllowedWithOptions(config, url, scope, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Referer': config.origin + '/'
      }
    });
    const decryptedBytes = decodeHongguoPlaybackV2(rawText);
    if (!decryptedBytes) return null;

    const decryptedStr = new TextDecoder().decode(decryptedBytes);
    const resObj = JSON.parse(decryptedStr) as Record<string, unknown>;
    const keyUrls = Array.isArray(resObj.key_urls) ? resObj.key_urls : [];

    for (const item of keyUrls) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      const src = String(rec.src ?? '').trim();
      if (!src || src.length > 8192) continue;

      const spade = String(rec.spade_a ?? '');
      let cencKeyHex: string | undefined;
      if (spade) {
        cencKeyHex = keyHex(extractSpadeKey(spade));
        if (!cencKeyHex) continue;
      }

      try {
        const checked = mediaUrl(config, src);
        return cencKeyHex
          ? { mediaUrl: checked, cencKeyHex, encryptionScheme: 'cenc-aes-ctr' }
          : { mediaUrl: checked };
      } catch {
        // Try next
      }
    }
    return null;
  } catch {
    return null;
  }
}
