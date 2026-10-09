import { describe, expect, it } from 'vitest';
import { checkClientBulletins, markAnnouncementRead, snoozeUpdate } from '../../src/core/client-bulletins';
import { createPreferenceStore } from '../../src/core/native/platform-adapters';
import type { PreferenceStore } from '../../src/core/state/theme';

function memoryPrefs(): PreferenceStore {
  const map = new Map<string, string>();
  return createPreferenceStore({ platform: () => false, storage: {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value); }
  } });
}

describe('端侧版本提醒与公告逻辑（AC-OPT-14 / AC-OPT-15 / AC-OPT-16）', () => {
  const now = 1700000000;

  it('发现高于当前版本的非强制更新时返回 optional', async () => {
    const prefs = memoryPrefs();
    const api = {
      version: async () => ({
        android: {
          versionCode: 21606,
          versionName: '2.6.6',
          downloadUrl: 'https://play.prismos.org/dl/latest/android',
          force: false
        }
      }),
      announcements: async () => ({ revision: 1, items: [] })
    };

    const res = await checkClientBulletins({
      api,
      prefs,
      currentVersionCode: 21605,
      nowSeconds: () => now
    });

    expect(res.update?.kind).toBe('optional');
    expect(res.update?.release.versionCode).toBe(21606);
  });

  it('本批即使最低版本配置较高也只给可选更新提醒', async () => {
    const prefs = memoryPrefs();
    const api = {
      version: async () => ({
        android: {
          versionCode: 21606,
          versionName: '2.6.6',
          downloadUrl: 'https://play.prismos.org/dl/latest/android',
          minVersionCode: 21606,
          force: false
        }
      }),
      announcements: async () => ({ revision: 1, items: [] })
    };

    const res = await checkClientBulletins({
      api,
      prefs,
      currentVersionCode: 21605,
      nowSeconds: () => now
    });

    expect(res.update?.kind).toBe('optional');
  });

  it('稍后提醒（snooze）在 24 小时内不重复提示同一版本', async () => {
    const prefs = memoryPrefs();
    await snoozeUpdate(prefs, 21606, now);

    const api = {
      version: async () => ({
        android: {
          versionCode: 21606,
          versionName: '2.6.6',
          downloadUrl: 'https://play.prismos.org/dl/latest/android',
          force: false
        }
      }),
      announcements: async () => ({ revision: 1, items: [] })
    };

    const res = await checkClientBulletins({
      api,
      prefs,
      currentVersionCode: 21605,
      nowSeconds: () => now + 3600 // 1小时后
    });

    expect(res.update).toBeNull();

    // 25小时后再次检查
    const resAfter = await checkClientBulletins({
      api,
      prefs,
      currentVersionCode: 21605,
      nowSeconds: () => now + 25 * 3600
    });

    expect(resAfter.update?.kind).toBe('optional');
  });

  it('已读公告不重复下发，未读公告正常进入队列', async () => {
    const prefs = memoryPrefs();
    const api = {
      version: async () => ({
        android: {
          versionCode: 21605,
          versionName: '2.6.5',
          downloadUrl: 'https://play.prismos.org/dl/latest/android'
        }
      }),
      announcements: async () => ({
        revision: 1,
        items: [
          {
            id: 'anno_1',
            revision: 1,
            title: '公告一',
            body: '内容一',
            startsAt: now - 100,
            endsAt: now + 1000
          }
        ]
      })
    };

    const first = await checkClientBulletins({
      api,
      prefs,
      currentVersionCode: 21605,
      nowSeconds: () => now
    });
    expect(first.announcements).toHaveLength(1);

    await markAnnouncementRead(prefs, 'anno_1', 1);

    const second = await checkClientBulletins({
      api,
      prefs,
      currentVersionCode: 21605,
      nowSeconds: () => now
    });
    expect(second.announcements).toHaveLength(0);
  });
});
