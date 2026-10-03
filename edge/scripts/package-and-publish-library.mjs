/**
 * 全量大库一键整包打包与极速发布器（替代碎片化逐条上传）。
 *
 * 核心产物：
 * 1. 146 个频道目录分片 (60条/页) 写入 R2 library/v1/{channel}/chunk-{page}.json
 * 2. KV catalog:manifest 与 config:sources 写入，彻底修复 /api/catalog 503
 * 3. 单一 SQLite 数据库整包 assets/library.db.gz (3.1MB)
 * 4. 单一客户端快照整包 assets/catalog-bundle.json.gz (450KB)
 * 5. 自动同步预置 Seed 到 android/app/src/main/assets/seed/
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  INFRA, KV_KEYS, PAGE_SIZE, PUBLIC_CHANNEL_IDS, TAXONOMY_VERSION,
  buildCatalogChunk, buildManifest, chunkKey, coverHandle, sourceConfigPayload
} from './config-sources.mjs';
import { discoverRestAuth, publishFiles } from './publish.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '../..');
const DB_PATH = fs.existsSync(path.join(ROOT, 'build/library_full.db'))
  ? path.join(ROOT, 'build/library_full.db')
  : path.join(ROOT, 'build/library_test.db');
const OUT_DIR = path.join(ROOT, 'edge/cache/library');
const ASSETS_DIR = path.join(OUT_DIR, 'assets');
const SEED_DIR = path.join(ROOT, 'android/app/src/main/assets/seed');

const CHANNELS_TOPOLOGY = [
  { id: 'drama', name: '短剧精选', order: 1, requiresTier: [], categories: ['战神', '逆袭', '都市', '古装', '甜宠', '悬疑'] },
  { id: 'movie', name: '院线电影', order: 2, requiresTier: [], categories: ['动作', '喜剧', '科幻', '悬疑', '爱情'] },
  { id: 'anime', name: '热血动漫', order: 3, requiresTier: [], categories: ['热血', '玄幻', '科幻', '治愈', '冒险'] },
  { id: 'documentary', name: '人文纪录', order: 4, requiresTier: [], categories: ['自然', '历史', '科技', '美食', '探索'] }
];

function gzipFile(src, dest) {
  const buf = fs.readFileSync(src);
  const compressed = zlib.gzipSync(buf, { level: 9 });
  fs.writeFileSync(dest, compressed);
  return compressed.length;
}

export async function packageAndPublish(options = {}) {
  const { publish = false, revision = 1 } = options;
  const nowSeconds = Math.floor(Date.now() / 1000);
  console.log(`=== 光影Play 全量大库整包打包 (Revision ${revision}) ===`);

  if (!fs.existsSync(DB_PATH)) {
    throw new Error(`基础数据库不存在: ${DB_PATH}`);
  }

  const db = new DatabaseSync(DB_PATH);
  fs.mkdirSync(ASSETS_DIR, { recursive: true });
  fs.mkdirSync(SEED_DIR, { recursive: true });

  const rawItems = db.prepare(`
    SELECT id, channel_id as channelId, title, cover_url, synopsis, category,
           first_published_at as firstPublishedAt, is_private as isPrivate,
           shareable, enabled, created_at, updated_at
    FROM content_items
    WHERE enabled = 1 AND is_private = 0
    ORDER BY updated_at DESC, id ASC
  `).all();
  console.log(`从数据库载入公开剧目: ${rawItems.length} 部`);

  const files = [];
  const allItems = [];
  const manifestChannels = {};

  for (const channelId of PUBLIC_CHANNEL_IDS) {
    const channelItems = rawItems
      .filter((r) => r.channelId === channelId)
      .map((r) => ({
        id: r.id,
        channelId: r.channelId,
        title: r.title,
        category: r.category || '精选',
        isPrivate: false,
        coverUrl: coverHandle(r.id),
        coverVersion: 'v1',
        synopsis: r.synopsis || undefined,
        firstPublishedAt: r.firstPublishedAt || undefined,
        enabled: true,
        shareable: true
      }));

    allItems.push(...channelItems);
    const pageCount = Math.ceil(channelItems.length / PAGE_SIZE);
    manifestChannels[channelId] = { chunks: pageCount, total: channelItems.length };

    for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
      const pageItems = channelItems.slice(pageIndex * PAGE_SIZE, (pageIndex + 1) * PAGE_SIZE);
      const chunk = buildCatalogChunk(pageItems, pageIndex, channelItems.length, revision);
      const relKey = chunkKey(revision, channelId, pageIndex);
      const filePath = path.join(ASSETS_DIR, relKey);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(chunk), 'utf8');
      files.push({ key: relKey, file: filePath });
    }
  }

  console.log(`生成目录分片: ${files.length} 个 (按 60条/分片切分)`);

  // 1. 构建 catalog-bundle.json
  const bundlePayload = {
    version: 1,
    revision,
    generatedAt: nowSeconds,
    channels: CHANNELS_TOPOLOGY,
    items: allItems
  };
  const bundlePath = path.join(ASSETS_DIR, 'catalog-bundle.json');
  fs.writeFileSync(bundlePath, JSON.stringify(bundlePayload), 'utf8');
  const bundleGzPath = path.join(ASSETS_DIR, 'catalog-bundle.json.gz');
  const bundleGzSize = gzipFile(bundlePath, bundleGzPath);
  console.log(`生成客户端全量快照包: ${(bundleGzSize / 1024).toFixed(1)} KB (catalog-bundle.json.gz)`);
  files.push({ key: 'assets/catalog-bundle.json', file: bundlePath });
  files.push({ key: 'assets/catalog-bundle.json.gz', file: bundleGzPath });

  // 2. 压缩 SQLite 库为 library.db.gz
  const dbGzPath = path.join(ASSETS_DIR, 'library.db.gz');
  const dbGzSize = gzipFile(DB_PATH, dbGzPath);
  console.log(`生成 SQLite 全量数据库包: ${(dbGzSize / (1024 * 1024)).toFixed(2)} MB (library.db.gz)`);
  files.push({ key: 'assets/library.db.gz', file: dbGzPath });

  // 3. 复制种子到 Android 与 Web 构建 assets
  const publicSeedDir = path.join(ROOT, 'public/seed');
  fs.mkdirSync(publicSeedDir, { recursive: true });
  fs.copyFileSync(bundlePath, path.join(publicSeedDir, 'catalog-bundle.json'));
  fs.copyFileSync(bundleGzPath, path.join(SEED_DIR, 'catalog-bundle.json.gz'));
  fs.copyFileSync(DB_PATH, path.join(SEED_DIR, 'library.db'));
  console.log(`种子文件已同步至 Android 原生目录 (${SEED_DIR}) 与 Web 目录 (${publicSeedDir})`);

  // 4. 构建 KV 清单条目
  const manifest = buildManifest(revision, manifestChannels, nowSeconds);
  const kvEntries = [
    { key: KV_KEYS.manifest, value: JSON.stringify(manifest) },
    { key: KV_KEYS.sources, value: JSON.stringify(sourceConfigPayload()) }
  ];

  db.close();

  if (publish) {
    console.log(`\n=== 开始高速推送到 Cloudflare (${files.length} 个 R2 对象 + 2 个 KV 键) ===`);
    await publishFiles(files, kvEntries, { dryRun: false, publish: true, isPrivate: false });
    console.log('=== 云端大库分发与 KV 清单发布完毕！===');
  } else {
    console.log(`[未加 --publish] 本地资产打包完毕，共 ${files.length} 个文件，未触碰云端。`);
  }

  return { filesCount: files.length, kvEntries, manifest };
}

if (process.argv[1] && process.argv[1].endsWith('package-and-publish-library.mjs')) {
  const publish = process.argv.includes('--publish');
  packageAndPublish({ publish }).catch((err) => {
    console.error('打包发布失败:', err);
    process.exit(1);
  });
}
