import type { Clock } from '../core/clock';
import type { Env } from '../types/env';
import { ANNOUNCEMENTS_KV_KEY } from '../core/constants';
import { readAnnouncementsDocument, validateAnnouncementDocument } from '../config/announcements';
import { adminJson } from './admin-auth';
import { readAdminBody } from './admin-body';

export async function handleAdminAnnouncementsRead(
  _request: Request,
  env: Env
): Promise<Response> {
  const doc = await readAnnouncementsDocument(env.KV);
  return doc === null ? adminJson({ code: 'UNAVAILABLE' }, 503) : adminJson({ document: doc });
}

export async function handleAdminAnnouncementsWrite(
  request: Request,
  env: Env,
  clock: Clock
): Promise<Response> {
  const body = await readAdminBody(request);
  if (body instanceof Response) return body;

  const { document, requestId, confirmed } = body as {
    document?: unknown;
    requestId?: unknown;
    confirmed?: unknown;
  };

  if (confirmed !== true) return adminJson({ code: 'VALIDATION_ERROR', message: '必须明确确认更新' }, 400);
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(requestId)) {
    return adminJson({ code: 'VALIDATION_ERROR', message: 'requestId 格式无效' }, 400);
  }

  const validated = validateAnnouncementDocument(document);
  if (validated === null) return adminJson({ code: 'VALIDATION_ERROR', message: '公告文档格式不合法' }, 400);

  if (!env.DB || !env.KV) return adminJson({ code: 'UNAVAILABLE' }, 503);
  try {
    await env.DB.prepare(`INSERT INTO admin_audit_logs(request_id, actor, action, details_json, created_at)
      VALUES(?, 'admin', 'ANNOUNCEMENT_UPDATE', ?, ?)`).bind(requestId,
      JSON.stringify({ revision: validated.revision, count: validated.items.length }), clock.nowSeconds()).run();
  } catch {
    try {
      const existing = await env.DB.prepare('SELECT id FROM admin_audit_logs WHERE request_id = ?').bind(requestId).first();
      if (existing) return adminJson({ code: 'CONFLICT', message: '请求已认领，请读取配置确认结果' }, 409);
    } catch { return adminJson({ code: 'UNAVAILABLE' }, 503); }
    return adminJson({ code: 'UNAVAILABLE' }, 503);
  }
  try {
    await env.KV.put(ANNOUNCEMENTS_KV_KEY, JSON.stringify(validated));
  } catch {
    try { await env.DB.prepare('DELETE FROM admin_audit_logs WHERE request_id = ?').bind(requestId).run(); }
    catch { return adminJson({ code: 'UNAVAILABLE', message: '写入结果未确认，请读取配置核对' }, 503); }
    return adminJson({ code: 'UNAVAILABLE', message: '公告写入未成功，请读取配置核对后重试' }, 503);
  }
  return adminJson({ success: true, revision: validated.revision, message: '已写入，边缘传播可能延迟' });
}
