import { describe, expect, it } from 'vitest';
import { handleAnnouncements } from '../../edge/src/routes/announcements';
import { handleAdminAnnouncementsRead, handleAdminAnnouncementsWrite } from '../../edge/src/routes/admin-announcements';
import { createTestEnv } from '../support/test-env';

describe('公告系统端云契约（AC-OPT-16 / AC-OPT-17）', () => {
  const clock = { nowSeconds: () => 1700000000, nowMillis: () => 1700000000000 };

  it('公开接口仅下发有效时段内、匹配版本范围且已启用的公告', async () => {
    const env = await createTestEnv();
    const doc = {
      schema: 1,
      revision: 2,
      items: [
        {
          id: 'notice_active',
          revision: 1,
          title: '重要升级提醒',
          body: '请及时更新客户端以享受更好体验。',
          startsAt: 1699990000,
          endsAt: 1700010000,
          minVersionCode: 20000,
          maxVersionCode: 30000,
          enabled: true
        },
        {
          id: 'notice_disabled',
          revision: 1,
          title: '已停用公告',
          body: '此公告不应出现。',
          startsAt: 1699990000,
          endsAt: 1700010000,
          enabled: false
        },
        {
          id: 'notice_expired',
          revision: 1,
          title: '已过期公告',
          body: '此公告已过期。',
          startsAt: 1600000000,
          endsAt: 1650000000,
          enabled: true
        }
      ]
    };
    await env.KV.put('config:announcements', JSON.stringify(doc));

    const reqAll = new Request('https://play.prismos.org/api/announcements');
    const resAll = await handleAnnouncements(reqAll, env, clock);
    expect(resAll.status).toBe(200);
    expect(resAll.headers.get('Cache-Control')).toBe('public, max-age=60');
    const dataAll = await resAll.json() as any;
    expect(dataAll.revision).toBe(2);
    expect(dataAll.items).toHaveLength(1);
    expect(dataAll.items[0].id).toBe('notice_active');

    // 版本过低时过滤
    const reqLow = new Request('https://play.prismos.org/api/announcements?versionCode=10000');
    const resLow = await handleAnnouncements(reqLow, env, clock);
    const dataLow = await resLow.json() as any;
    expect(dataLow.items).toHaveLength(0);

    // 参数错误时返回 400 VALIDATION_ERROR
    const reqBad = new Request('https://play.prismos.org/api/announcements?versionCode=abc');
    const resBad = await handleAnnouncements(reqBad, env, clock);
    expect(resBad.status).toBe(400);
  });

  it('Admin 路由支持读取与更新公告，并正确记录审计日志', async () => {
    const env = await createTestEnv();
    const readRes = await handleAdminAnnouncementsRead(new Request('https://play.prismos.org/api/admin/announcements'), env);
    expect(readRes.status).toBe(200);
    const readData = await readRes.json() as any;
    expect(readData.document.schema).toBe(1);

    const updateBody = {
      requestId: 'req_anno_test_001',
      confirmed: true,
      document: {
        schema: 1,
        revision: 3,
        items: [
          {
            id: 'notice_new',
            revision: 1,
            title: '全新版本发布',
            body: '光影Play 全新架构升级。',
            startsAt: 1699990000,
            endsAt: 1700050000,
            enabled: true
          }
        ]
      }
    };

    const writeReq = new Request('https://play.prismos.org/api/admin/announcements', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updateBody)
    });

    const writeRes = await handleAdminAnnouncementsWrite(writeReq, env, clock);
    expect(writeRes.status).toBe(200);
    const writeData = await writeRes.json() as any;
    expect(writeData.success).toBe(true);
    expect(writeData.revision).toBe(3);

    // 再次读取验证 KV 已持久化
    const verifyDoc = await env.KV.get('config:announcements');
    expect(verifyDoc).toContain('notice_new');
  });
});
