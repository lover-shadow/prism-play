/**
 * 全量大库一键整包打包与极速发布器（替代碎片化逐条上传）。
 *
 * 核心产物：
 * 1. 频道目录分片 (60条/页)，带真实 AI/热门/点击/集数候选字段。
 * 2. 生成 KV catalog:manifest 与 config:sources；仅 --publish 才云写。
 * 3. 压缩必需输入 build/library_full.db（或 --db=<path>），不重建、不回退测试库。
 * 4. 生成 assets/catalog-bundle.json.gz；--out=<path> 可隔离验证产物。
 * 5. 仅 --sync-seed 才同步 Android/Web seed；--harvest=<path> 指定离线采集缓存。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  KV_KEYS, PAGE_SIZE, PUBLIC_CHANNEL_IDS,
  buildCatalogChunk, buildManifest, chunkKey, sourceConfigPayload, assertPublicAssetClean
} from './config-sources.mjs';
import { buildLibraryCatalog, readHarvestMetadata } from './library-catalog.mjs';
import { buildWorkFacts, buildWorkFactPacks, serializeManifest } from './work-fact-packs.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '../..');
const DB_PATH = path.join(ROOT, 'build/library_full.db');
const OUT_DIR = path.join(ROOT, 'edge/cache/library');
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
  const { publish = false, revision = 1, dbPath = DB_PATH,
    outDir = OUT_DIR, harvestDir = path.join(ROOT, 'edge/cache/harvest'), syncSeed = false } = options;
  const inputPath = path.resolve(dbPath);
  const ASSETS_DIR = path.join(path.resolve(outDir), 'assets');
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('revision must be a positive safe integer');
  if (publish && options.revision === undefined) throw new Error('Publishing requires an explicit revision');
  console.log(`=== 光影Play 全量大库整包打包 (Revision ${revision}) ===`);

  if (!fs.existsSync(inputPath)) {
    throw new Error(`Required input database missing: ${inputPath}; use --db=<complete-library.db> (no test DB fallback)`);
  }

  const db = new DatabaseSync(inputPath, { readOnly: true });
  let catalog;
  let factPacks;
  try {
    const metadata = readHarvestMetadata(path.resolve(harvestDir));
    catalog = buildLibraryCatalog(db, metadata, nowSeconds);
    factPacks = buildWorkFactPacks(buildWorkFacts(db, catalog, metadata));
  } finally {
    db.close();
  }
  console.log('真实字段统计:', JSON.stringify(catalog.report));
  fs.mkdirSync(ASSETS_DIR, { recursive: true });

  const files = [];
  const allItems = [];
  const manifestChannels = {};

  for (const channelId of PUBLIC_CHANNEL_IDS) {
    const channelItems = catalog.channels[channelId];
    assertPublicAssetClean({ items: channelItems }, channelId);

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
  const dbGzSize = gzipFile(inputPath, dbGzPath);
  console.log(`生成 SQLite 全量数据库包: ${(dbGzSize / (1024 * 1024)).toFixed(2)} MB (library.db.gz)`);
  files.push({ key: 'assets/library.db.gz', file: dbGzPath });

  // 3. 复制种子到 Android 与 Web 构建 assets
  if (syncSeed) {
    const publicSeedDir = path.join(ROOT, 'public/seed');
    fs.mkdirSync(publicSeedDir, { recursive: true });
    fs.mkdirSync(SEED_DIR, { recursive: true });
    fs.copyFileSync(bundlePath, path.join(publicSeedDir, 'catalog-bundle.json'));
    fs.copyFileSync(bundleGzPath, path.join(SEED_DIR, 'catalog-bundle.json.gz'));
    fs.copyFileSync(inputPath, path.join(SEED_DIR, 'library.db'));
    console.log(`种子文件已同步至 Android 与 Web 目录`);
  }

  // Facts are internal R2 assets, not public routes. The manifest KV pointer is published last.
  const manifest = { ...buildManifest(revision, manifestChannels, nowSeconds),
    workFacts: factPacks.workFacts, coverOrigins: factPacks.coverOrigins };
  const manifestValue = serializeManifest(manifest);
  for (const { key, value } of factPacks.objects) {
    const file = path.join(ASSETS_DIR, key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value, 'utf8');
    files.push({ key, file });
  }
  fs.writeFileSync(path.join(path.resolve(outDir), 'catalog-manifest.json'), manifestValue, 'utf8');
  console.log('公开事实包统计:', JSON.stringify(factPacks.report));
  const kvEntries = [
    { key: KV_KEYS.sources, value: JSON.stringify(sourceConfigPayload()) },
    { key: KV_KEYS.manifest, value: manifestValue }
  ];

  if (publish) {
    const { publishFiles } = await import('./publish.mjs');
    console.log(`\n=== 开始高速推送到 Cloudflare (${files.length} 个 R2 对象 + 2 个 KV 键) ===`);
    await publishFiles(files, kvEntries, { dryRun: false, publish: true, isPrivate: false, skipState: true });
    console.log('=== 云端大库分发与 KV 清单发布完毕！===');
  } else {
    console.log(`[未加 --publish] 本地资产打包完毕，共 ${files.length} 个文件，未触碰云端。`);
  }

  return { filesCount: files.length, kvEntries, manifest, report: catalog.report,
    factsReport: factPacks.report, manifestBytes: Buffer.byteLength(manifestValue, 'utf8') };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const argv = process.argv.slice(2);
  const options = { publish: argv.includes('--publish'), syncSeed: argv.includes('--sync-seed') };
  const revisionArg = argv.find((arg) => arg.startsWith('--revision='));
  if (revisionArg) options.revision = Number(revisionArg.slice('--revision='.length));
  for (const [flag, key] of [['--db=', 'dbPath'], ['--out=', 'outDir'], ['--harvest=', 'harvestDir']]) {
    const value = argv.find((arg) => arg.startsWith(flag));
    if (value) options[key] = path.resolve(value.slice(flag.length));
  }
  packageAndPublish(options).catch((err) => {
    console.error('打包发布失败:', err);
    process.exit(1);
  });
}
