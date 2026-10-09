import type { AndroidRelease } from '../../edge/src/types/api';
import type { PreferenceStore } from './state/theme';

export interface BulletinAnnouncement {
  id: string;
  revision: number;
  title: string;
  body: string;
  startsAt: number;
  endsAt: number;
}

export type UpdateKind = 'optional';

export interface BulletinCheckResult {
  update: { kind: UpdateKind; release: AndroidRelease } | null;
  announcements: BulletinAnnouncement[];
}

export interface CheckBulletinsDeps {
  api: {
    version(): Promise<{ android: AndroidRelease }>;
    announcements(versionCode?: number): Promise<{ revision: number; items: BulletinAnnouncement[] }>;
  };
  prefs: PreferenceStore;
  currentVersionCode: number;
  nowSeconds?: () => number;
}

const SNOOZE_CODE_KEY = 'prism.update_snooze_code';
const SNOOZE_UNTIL_KEY = 'prism.update_snooze_until';

export async function checkClientBulletins(deps: CheckBulletinsDeps): Promise<BulletinCheckResult> {
  const now = deps.nowSeconds?.() ?? Math.floor(Date.now() / 1000);
  let updateResult: { kind: UpdateKind; release: AndroidRelease } | null = null;
  const announcementsResult: BulletinAnnouncement[] = [];

  try {
    const versionRes = await deps.api.version();
    const release = versionRes.android;
    if (Number.isSafeInteger(release.versionCode) && release.versionCode > deps.currentVersionCode) {
      const snoozeCode = await deps.prefs.get(SNOOZE_CODE_KEY);
      const snoozeUntil = Number(await deps.prefs.get(SNOOZE_UNTIL_KEY) ?? '0');
      if (snoozeCode !== String(release.versionCode) || now >= snoozeUntil) updateResult = { kind: 'optional', release };
    }
  } catch {
    // 联网读取版本失败时诚实留空，不阻止应用使用
  }

  try {
    const annoRes = await deps.api.announcements(deps.currentVersionCode);
    for (const item of annoRes.items) {
      if (item.startsAt > now || item.endsAt <= now) continue;
      const readKey = `prism.anno_read_${item.id}_${item.revision}`;
      const isRead = (await deps.prefs.get(readKey)) === '1';
      if (!isRead) announcementsResult.push(item);
    }
  } catch {
    // 公告拉取失败时不抛错
  }

  return {
    update: updateResult,
    announcements: announcementsResult
  };
}

export async function snoozeUpdate(prefs: PreferenceStore, versionCode: number, nowSeconds: number): Promise<void> {
  await prefs.set(SNOOZE_CODE_KEY, String(versionCode));
  await prefs.set(SNOOZE_UNTIL_KEY, String(nowSeconds + 24 * 3600));
}

export async function markAnnouncementRead(prefs: PreferenceStore, id: string, revision: number): Promise<void> {
  await prefs.set(`prism.anno_read_${id}_${revision}`, '1');
}
