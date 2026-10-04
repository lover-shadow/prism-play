// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SQLiteConnection, type CapacitorSQLitePlugin } from '@capacitor-community/sqlite';
import { createHistorySqlite } from '../../src/core/native/platform-adapters';
import { HISTORY_DATABASE } from '../../src/core/storage/history-store';

describe('追剧历史域 SQLite 备份命名', () => {
  it('真实 SQLite 包装层与 Android 文件命名对应精确备份白名单', async () => {
    let nativeName = '';
    const plugin = {
      isConnection: async () => ({ result: false }),
      createConnection: async (options: { database: string }) => { nativeName = options.database; },
      open: async () => undefined
    } as unknown as CapacitorSQLitePlugin;
    const sqlite = await createHistorySqlite({ driver: new SQLiteConnection(plugin), platform: () => true });
    await sqlite.open(HISTORY_DATABASE);
    expect(nativeName).toBe('prism_local');
    const java = readFileSync(resolve('node_modules/@capacitor-community/sqlite/android/src/main/java/com/getcapacitor/community/database/sqlite/CapacitorSQLite.java'), 'utf8');
    expect(java).toMatch(/dbName = getDatabaseName\(dbName\);/);
    expect(java).toMatch(/new Database\(\s*context,\s*dbName \+ "SQLite\.db"/);
    const database = readFileSync(resolve('node_modules/@capacitor-community/sqlite/android/src/main/java/com/getcapacitor/community/database/sqlite/SQLite/Database.java'), 'utf8');
    expect(database).toContain('this._context.getDatabasePath(dbName)');
    const actualFile = `${nativeName}SQLite.db`;
    for (const file of ['backup_rules.xml', 'data_extraction_rules.xml']) {
      const xml = new DOMParser().parseFromString(readFileSync(resolve('android/app/src/main/res/xml', file), 'utf8'), 'application/xml');
      expect(xml.querySelector('parsererror')).toBeNull();
      const sections = file === 'backup_rules.xml' ? [xml.documentElement] : [...xml.querySelectorAll('cloud-backup, device-transfer')];
      expect(sections).toHaveLength(file === 'backup_rules.xml' ? 1 : 2);
      for (const section of sections) {
        const includes = [...section.querySelectorAll('include')].map((node) => `${node.getAttribute('domain')}:${node.getAttribute('path')}`).sort();
        expect(includes).toEqual([
          ...['', '-wal', '-shm', '-journal'].map((suffix) => `database:${actualFile}${suffix}`),
          'sharedpref:CapacitorStorage.xml'
        ].sort());
        // 凭证、公开缓存、搜索与私密数据都不能通过目录或额外文件白名单混入。
        for (const forbidden of ['prism_credentials_encrypted.xml', 'prism_catalog.db', 'prism_catalogSQLite.db', 'prism_searchSQLite.db', 'private.db', '.', 'cache']) {
          expect(includes.some((entry) => entry.endsWith(`:${forbidden}`))).toBe(false);
        }
      }
    }
  });
});
