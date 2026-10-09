/**
 * 广告清单清洗的统一配置源（单一事实）。
 *
 * 三个消费方共用同一份解析结果，防止"包裹端开了、入口端关了"这类半开状态：
 * - `/proxy/hls/clean` 入口路由（是否清洗、目标白名单、引擎参数）；
 * - `/api/titles/{id}` 下发包裹（是否把 mediaUrl 换成清洗入口）；
 * - 判定引擎默认参数。
 *
 * 参数全部来自环境变量，改动不需要动代码；配置损坏一律退回默认值，
 * 绝不因为一方配置错误而中断播放链路。
 */

export interface AdStripParams {
  /**
   * 主流基线占比门槛；低于此值一条不删。
   * 实测校准（2026-10-09，provider_m1 多剧采样）：短剧集正片占比 63%~80%（1~2 分钟正片 + 2 条 17.64s 广告），
   * 长剧集 98% 以上；0.55 在实测最差值 63.2% 之下留约 8 点余量，同时仍要求正片占绝对多数。
   */
  dominantRatio: number;
  /** 同一异类签名的独立块数门槛；单次出现的异类块视为合法片段保留（实测广告每集重复 2~8 块）。 */
  repeatBlocks: number;
  /** 单块时长上限（秒）；实测广告块 17.64s，45s 留 2.5 倍余量。 */
  maxBlockSeconds: number;
  /** 清单分片数上限；超出视为异常输入，不做清洗。 */
  maxSegments: number;
  /** 清单字节上限；超出视为异常输入，不做清洗。 */
  maxBytes: number;
}

export const AD_STRIP_DEFAULT_PARAMS: Readonly<AdStripParams> = {
  dominantRatio: 0.55,
  repeatBlocks: 2,
  maxBlockSeconds: 45,
  maxSegments: 20000,
  maxBytes: 1_048_576
};

export interface AdStripSettings {
  /** 总开关：必须显式 'true' 且白名单非空才视为启用。 */
  enabled: boolean;
  /** 目标主机白名单（小写、精确匹配，绝不做子串判断）。 */
  hosts: ReadonlySet<string>;
  params: AdStripParams;
}

export interface AdStripEnv {
  AD_STRIP_ENABLED?: string;
  AD_STRIP_TARGET_HOSTS?: string;
  AD_STRIP_CONFIG?: string;
}

function bounded(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

export function readAdStripSettings(env: AdStripEnv): AdStripSettings {
  const hosts = new Set<string>();
  for (const entry of (env.AD_STRIP_TARGET_HOSTS ?? '').split(',')) {
    const host = entry.trim().toLowerCase();
    if (host !== '') hosts.add(host);
  }
  const params: AdStripParams = { ...AD_STRIP_DEFAULT_PARAMS };
  const raw = env.AD_STRIP_CONFIG;
  if (typeof raw === 'string' && raw !== '' && raw.length <= 4096) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      params.dominantRatio = bounded(parsed.dominantRatio, 0.5, 1, params.dominantRatio);
      params.repeatBlocks = Math.trunc(bounded(parsed.repeatBlocks, 2, 16, params.repeatBlocks));
      params.maxBlockSeconds = bounded(parsed.maxBlockSeconds, 5, 300, params.maxBlockSeconds);
      params.maxSegments = Math.trunc(bounded(parsed.maxSegments, 64, 100000, params.maxSegments));
      params.maxBytes = Math.trunc(bounded(parsed.maxBytes, 4096, 8_388_608, params.maxBytes));
    } catch {
      // 配置损坏退回默认：清洗是增值能力，绝不因它中断播放。
    }
  }
  const enabled = env.AD_STRIP_ENABLED === 'true' && hosts.size > 0;
  return { enabled, hosts, params };
}

/** 入口路由用：仅 https + 白名单主机，两个条件缺一不可。 */
export function resolveAllowedTarget(raw: string | null, hosts: ReadonlySet<string>): URL | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 8192) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (!hosts.has(parsed.hostname.toLowerCase())) return null;
  return parsed;
}

/** 下发包裹用：在入口条件之上再要求 .m3u8 扩展名，避免把 mp4 等媒体送进文本清洗。 */
export function isCleanableMediaUrl(raw: string | undefined, hosts: ReadonlySet<string>): boolean {
  const parsed = resolveAllowedTarget(raw ?? null, hosts);
  if (parsed === null) return false;
  return /\.m3u8(?:$|[?#])/i.test(parsed.pathname + parsed.search);
}
