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
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  KV_KEYS, PAGE_SIZE, PUBLIC_CHANNEL_IDS,
  buildCatalogChunk, buildManifest, chunkKey, sourceConfigPayload, assertPublicAssetClean
} from './config-sources.mjs';
import { buildLibraryCatalog, readHarvestMetadata } from './library-catalog.mjs';
import { buildWorkFacts, buildWorkFactPacks, serializeManifest } from './work-fact-packs.mjs';
import { buildPublicSearch, readSearchVocabulary } from './public-search-projection.mjs';
import { assertMetadataBounds, CATALOG_DIRECTORY_MAX_BYTES } from '../src/library/metadata-policy.mjs';
import { containsPlatformName } from '../src/library/platform-lexicon.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '../..');
const DB_PATH = path.join(ROOT, 'build/library_full.db');
const OUT_DIR = path.join(ROOT, 'edge/cache/library');
const SEED_DIR = path.join(ROOT, 'android/app/src/main/assets/seed');

const CHANNELS_TOPOLOGY = [
  { id: 'drama', name: '精彩短剧', order: 1, requiresTier: [], categories: ['战神', '逆袭', '都市', '古装', '甜宠', '悬疑'] },
  { id: 'movie', name: '电影仓库', order: 2, requiresTier: [], categories: ['动作', '喜剧', '科幻', '悬疑', '爱情'] },
  { id: 'documentary', name: '纪录片', order: 3, requiresTier: [], categories: ['自然', '历史', '科技', '美食', '探索'] },
  { id: 'anime', name: '动漫', order: 4, requiresTier: [], categories: ['热血', '玄幻', '科幻', '治愈', '冒险'] }
];

function gzipFile(src, dest) {
  const buf = fs.readFileSync(src);
  const compressed = zlib.gzipSync(buf, { level: 9 });
  fs.writeFileSync(dest, compressed);
  return compressed.length;
}

// Stage all destinations before replacing any; per-file rename is atomic, failures roll back.
export function syncSeedFiles(entries) {
  const token = randomUUID();
  const staged = entries.map(([source, dest]) => ({ source, dest, temp: `${dest}.${token}.tmp`,
    backup: `${dest}.${token}.bak`, replaced: false, saved: false }));
  try {
    for (const entry of staged) {
      fs.mkdirSync(path.dirname(entry.dest), { recursive: true });
      fs.copyFileSync(entry.source, entry.temp);
      if (!fs.readFileSync(entry.source).equals(fs.readFileSync(entry.temp))) throw new Error('Seed staging mismatch');
    }
    for (const entry of staged) {
      if (fs.existsSync(entry.dest)) { fs.copyFileSync(entry.dest, entry.backup); entry.saved = true; }
      fs.renameSync(entry.temp, entry.dest);
      entry.replaced = true;
    }
  } catch (error) {
    for (const entry of [...staged].reverse()) if (entry.replaced) {
      if (entry.saved) fs.renameSync(entry.backup, entry.dest);
      else fs.rmSync(entry.dest);
    }
    throw error;
  } finally {
    for (const entry of staged) for (const file of [entry.temp, entry.backup]) fs.rmSync(file, { force: true });
  }
}

/**
 * §3.1 目录总量守门（HP-11）。新增可选元数据把目录推过端侧快照配额时**拒绝发布并报错**，
 * 绝不为凑绿灯丢掉条目——丢条目是拿覆盖率换颜色，比超限更坏。
 * 同时逐条复核策略源边界，越界元数据根本出不了这道门。返回目录实际字节数供打包日志与测试对账。
 */
export function assertCatalogDirectoryBudget(channels) {
  let bytes = 0;
  for (const items of Object.values(channels)) {
    for (const item of items) {
      assertMetadataBounds(item, `catalog item ${item.id}`, containsPlatformName);
      bytes += Buffer.byteLength(JSON.stringify(item), 'utf8');
    }
  }
  if (bytes > CATALOG_DIRECTORY_MAX_BYTES) {
    throw new Error(`Catalog directory exceeds the byte budget: ${bytes} > ${CATALOG_DIRECTORY_MAX_BYTES}（拒绝发布，不截断条目）`);
  }
  return bytes;
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
  let search;
  try {
    const metadata = readHarvestMetadata([path.join(ROOT, 'edge/cache/harvest'), path.resolve(harvestDir)]);
    catalog = buildLibraryCatalog(db, metadata, nowSeconds);
    const facts = buildWorkFacts(db, catalog, metadata);
    factPacks = buildWorkFactPacks(facts);
    search = buildPublicSearch(facts, revision, readSearchVocabulary(db));
  } finally {
    db.close();
  }
  console.log('真实字段统计:', JSON.stringify(catalog.report));
  const catalogBytes = assertCatalogDirectoryBudget(catalog.channels);
  console.log(`公开元数据供给覆盖: ${JSON.stringify(catalog.report.metadataCoverage)}`);
  console.log(`目录分片合计体积: ${catalogBytes} 字节 (配额 ${CATALOG_DIRECTORY_MAX_BYTES})`);
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

  // Facts are internal R2 assets, not public routes. The manifest KV pointer is published last.
  const manifest = { ...buildManifest(revision, manifestChannels, nowSeconds),
    workFacts: factPacks.workFacts, coverOrigins: factPacks.coverOrigins, publicSearch: search.publicSearch };
  const manifestValue = serializeManifest(manifest);
  for (const { key, value } of [...factPacks.objects, search.object]) {
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

  // Validate persisted artifacts, hashes and all three public projections before any seed mutation.
  const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const projected = JSON.parse(search.object.value);
  const searchItems = new Map(projected.entries.map((entry) => [entry.item.id, entry.item]));
  const catalogItems = new Map(allItems.map((item) => [item.id, item]));
  const seen = new Set();
  for (const [prefix, entry] of Object.entries(factPacks.workFacts.packs)) {
    const info = factPacks.workFacts.schema === 2
      ? { bytes: entry[0], sha256: entry[1], key: `library/facts/${entry[1]}.json` } : entry;
    const bytes = fs.readFileSync(path.join(ASSETS_DIR, info.key));
    if (bytes.length !== info.bytes || sha(bytes) !== info.sha256) throw new Error('Persisted fact hash mismatch');
    for (const [id, fact] of Object.entries(JSON.parse(bytes).works)) {
      if (seen.has(id) || !sha(Buffer.from(id)).startsWith(prefix)) throw new Error('Fact directory mismatch');
      seen.add(id);
      const item = catalogItems.get(id), searchItem = searchItems.get(id);
      if (!item || !searchItem || fact.episodes.length !== item.episodeCount) throw new Error('Public projection count mismatch');
      for (const [key, value] of Object.entries(item)) {
        if (JSON.stringify(fact[key]) !== JSON.stringify(value) || JSON.stringify(searchItem[key]) !== JSON.stringify(value)) {
          throw new Error(`Public projection mismatch: ${id}/${key}`);
        }
      }
    }
  }
  const searchBytes = fs.readFileSync(path.join(ASSETS_DIR, search.object.key));
  if (searchBytes.length !== search.publicSearch.bytes || sha(searchBytes) !== search.publicSearch.sha256 ||
      seen.size !== allItems.length || searchItems.size !== seen.size || projected.revision !== revision ||
      !zlib.gunzipSync(fs.readFileSync(bundleGzPath)).equals(fs.readFileSync(bundlePath)) ||
      !zlib.gunzipSync(fs.readFileSync(dbGzPath)).equals(fs.readFileSync(inputPath))) throw new Error('Final artifact validation failed');

  if (publish) {
    const { publishFiles } = await import('./publish.mjs');
    console.log(`\n=== 开始高速推送到 Cloudflare (${files.length} 个 R2 对象 + 2 个 KV 键) ===`);
    await publishFiles(files, kvEntries, { dryRun: false, publish: true, isPrivate: false, skipState: true });
    console.log('=== 云端大库分发与 KV 清单发布完毕！===');
  } else {
    console.log(`[未加 --publish] 本地资产打包完毕，共 ${files.length} 个文件，未触碰云端。`);
  }

  if (syncSeed) {
    syncSeedFiles([[bundlePath, path.join(ROOT, 'public/seed/catalog-bundle.json')],
      [bundleGzPath, path.join(SEED_DIR, 'catalog-bundle.json.gz')]]);
    console.log('全部验证完成，种子文件已原子替换至 Android 与 Web 目录');
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
