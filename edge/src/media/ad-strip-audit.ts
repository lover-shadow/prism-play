/**
 * 广告剔除审计记录（KV）。
 *
 * 每次"实际发生剔除"写一条结构化记录：哪部剧、哪个目标主机、删了几块几秒、主流占比、时间。
 * 本期纪律：只审计、不参与过滤决策——一份被污染的名单会放大错误，等数据可信后再开加速。
 * 写入失败绝不阻塞播放链路；记录 30 天自动过期。
 */

import type { Env } from '../types/env';

export interface AdStripAuditRecord {
  workId: string | null;
  targetHost: string;
  removedBlocks: number;
  removedSegments: number;
  removedSeconds: number;
  totalSeconds: number;
  dominantRatio: number;
  atSeconds: number;
}

const AUDIT_PREFIX = 'adstrip/audit/';
const AUDIT_TTL_SECONDS = 30 * 24 * 3600;

export async function recordAdStripAudit(env: Env, record: AdStripAuditRecord): Promise<void> {
  try {
    const key = `${AUDIT_PREFIX}${record.atSeconds}-${crypto.randomUUID().slice(0, 8)}`;
    await env.KV.put(key, JSON.stringify(record), { expirationTtl: AUDIT_TTL_SECONDS });
  } catch {
    // 审计失败不影响清洗结果与播放。
  }
}
