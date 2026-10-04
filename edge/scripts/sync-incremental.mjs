/**
 * 每日增量追新 → R2 静态资产 + KV 清单 (SPEC-CLOUD-REFACTOR v2 §C-1 / §C-2 / §3)
 * 关键转变：采集产物**不再灌 D1 内容表**（旧脚本每天往 content_items 写几千行，正是 503 熔断根源）。
 * 现在是：h=24 温和增量 → 合并状态快照 → 按 §3.1 生成 60 条/片目录分片 + §3.2 剧集清单
 * → wrangler 推 R2 + 刷 KV `catalog:manifest`；浏览路径 D1 行读 = 0。
 * 用法：`--dry-run` 离线干跑（读本地 harvest 缓存，零云端调用）；`--network --publish` 是 CI 正式链路；
 * 另支持 `--pull`（先从 R2 取回快照）`--revision=N` `--hours=24` `--private`（私密管线复用本引擎）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  INFRA, KV_KEYS, LOCAL, PAGE_SIZE, PUBLIC_CHANNEL_IDS, TAXONOMY_VERSION,
  assertPublicAssetClean, buildCatalogChunk, buildManifest, chunkKey, crawlTargets,
  sourceConfigPayload, stableTitleKey, titleKey, validateSourceConfig
} from './config-sources.mjs';
import { assignHotFlags, buildTitleManifest, emitAliasSql, normalizeWork, sortForSharding, toCatalogItem } from './compute-hotscore.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
/** C-2.1 页间温和休眠（AC-C2-4 要求实测间隔 ≥1s）。 */
const PAGE_DELAY_BASE_MS = 1000;
const PAGE_DELAY_JITTER_MS = 1000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function parseCliArgs(argv) {
  const read = (name, fallback) => {
    const hit = argv.find((arg) => arg.startsWith(`--${name}=`));
    return hit === undefined ? fallback : Number(hit.slice(name.length + 3));
  };
  const dryRun = argv.includes('--dry-run') || process.env.PRISM_DRY_RUN === '1';
  const flag = (name) => argv.includes(name) && !dryRun;
  return {
    dryRun,
    publish: flag('--publish'),
    network: flag('--network'),
    pull: flag('--pull'),
    isPrivate: argv.includes('--private'),
    hours: read('hours', 24),
    revision: read('revision', null) === null ? null : read('revision', null)
  };
}

export function emptyState(isPrivate) {
  return { schema: 1, revision: 0, taxonomyVersion: TAXONOMY_VERSION, updatedAt: 0, isPrivate: Boolean(isPrivate), works: {} };
}

export function loadState(isPrivate = false) {
  const file = path.resolve(LOCAL.state(isPrivate));
  if (!fs.existsSync(file)) return emptyState(isPrivate);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof parsed?.works !== 'object' || parsed.works === null) return emptyState(isPrivate);
    return { ...emptyState(isPrivate), ...parsed };
  } catch {
    // 快照损坏退回空状态：下一轮 harvest-all bootstrap 会重建，绝不让半截 JSON 生成脏资产。
    return emptyState(isPrivate);
  }
}

export function saveState(state, isPrivate = false) {
  const file = path.resolve(LOCAL.state(isPrivate));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state), 'utf8');
  return file;
}

/** 上游条目 → 快照记录。firstPublishedAt 取历史最小值：增量只刷新元数据，不该让「首播时间」变新。 */
export function mergeRawsIntoState(state, entries, nowSeconds) {
  const resolved = [];
  let added = 0;
  let updated = 0;
  for (const entry of entries) {
    const record = normalizeWork(entry.target, entry.item, nowSeconds);
    if (record.title === '' || record.episodeCount === 0) continue;
    const previous = state.works[record.id];
    if (previous !== undefined) {
      if (record.firstPublishedAt > previous.firstPublishedAt) record.firstPublishedAt = previous.firstPublishedAt;
      updated += 1;
    } else {
      added += 1;
    }
    state.works[record.id] = record;
    resolved.push({ record, item: entry.item });
  }
  return { added, updated, resolved };
}

async function fetchPage(target, page, hours) {
  const url = new URL(target.provider.baseUrl);
  url.searchParams.set('ac', 'detail');
  url.searchParams.set('t', String(target.typeId));
  url.searchParams.set('pg', String(page));
  url.searchParams.set('h', String(hours));
  const response = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!response.ok) throw new Error(`HTTP ${response.status} @ ${target.provider.id}/tid=${target.typeId}/pg=${page}`);
  return response.json();
}

/** 温和增量：每个 tid 只取近 hours 小时更新的作品，**每次**翻页与换源都带 ≥1s 抖动休眠（AC-C2-4）。 */
export async function collectFromNetwork(targets, hours) {
  const entries = [];
  for (const [targetIndex, target] of targets.entries()) {
    if (targetIndex > 0) await sleep(PAGE_DELAY_BASE_MS + Math.random() * PAGE_DELAY_JITTER_MS);
    let page = 1;
    let pagecount = 1;
    while (page <= pagecount) {
      try {
        const data = await fetchPage(target, page, hours);
        pagecount = Number(data.pagecount ?? 1);
        for (const item of data.list ?? []) entries.push({ target, item });
      } catch (error) {
        console.warn(`  ! ${target.provider.id}/tid=${target.typeId} p${page} 抓取失败: ${error.message}`);
        break;
      }
      page += 1;
      if (page <= pagecount) await sleep(PAGE_DELAY_BASE_MS + Math.random() * PAGE_DELAY_JITTER_MS);
    }
  }
  return entries;
}

/**
 * 离线干跑输入：harvest-all 留在 `edge/cache/harvest/` 的分页缓存。
 * 干跑既不联网也不调 wrangler，只为在开发机上验证资产生成与私密隔离判据。
 */
export function collectFromCache(targets) {
  const cacheDir = path.resolve(LOCAL.harvestCache);
  if (!fs.existsSync(cacheDir)) return [];
  const entries = [];
  for (const target of targets) {
    const prefix = `t_${target.typeId}_p_`;
    const files = fs.readdirSync(cacheDir).filter((file) => file.startsWith(prefix) && file.endsWith('.json'));
    for (const name of files) {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(cacheDir, name), 'utf8'));
        for (const item of parsed.list ?? []) entries.push({ target, item });
      } catch {
        console.warn(`  ! 缓存页损坏，跳过: ${name}`);
      }
    }
  }
  return entries;
}

/** 本地镜像目录结构 = R2 key 结构，便于肉眼核对，`--publish` 时按 key 逐个上传。 */
function writeFileToKey(outDir, key, payload) {
  const file = path.join(outDir, key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(payload), 'utf8');
  return { key, file };
}

/**
 * 生成资产。私密管线只出剧集清单（C-2b.1：私密频道不做批量目录下发）；
 * 公开管线再按频道出 60 条/片分片，每片落盘前即过 §3 公开判据，脏资产绝不出门。
 */
export function emitAssets(state, resolved, options) {
  const { revision, outDir, isPrivate, nowSeconds, versionedTitles = true } = options;
  const files = [];
  const touched = [];
  for (const { record, item } of resolved) {
    const manifest = buildTitleManifest(record, item, { generatedAt: nowSeconds, revision });
    // bootstrap（上一快照不存在）只出稳定键：路由按「v{revision} 未命中回退稳定键」读取，
    // 首轮因此少传一半对象；日更保持双写，v{revision} 键供 changes 差分窗口整窗可回放。
    const keys = versionedTitles
      ? [titleKey(revision, record.id, isPrivate), stableTitleKey(record.id, isPrivate)]
      : [stableTitleKey(record.id, isPrivate)];
    for (const key of keys) {
      files.push(writeFileToKey(outDir, key, manifest));
    }
    touched.push(record.id);
  }
  const channels = {};
  if (isPrivate) return { files, channels, touched };

  if (touched.length > 0) assignHotFlags(Object.values(state.works), nowSeconds);
  for (const channelId of PUBLIC_CHANNEL_IDS) {
    const items = Object.values(state.works)
      .filter((record) => record.channelId === channelId && record.isPrivate === false)
      .sort(sortForSharding)
      .map(toCatalogItem);
    const pageCount = Math.ceil(items.length / PAGE_SIZE);
    channels[channelId] = { chunks: pageCount, total: items.length };
    for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
      const key = chunkKey(revision, channelId, pageIndex);
      const chunk = buildCatalogChunk(items.slice(pageIndex * PAGE_SIZE, (pageIndex + 1) * PAGE_SIZE), pageIndex, items.length, revision);
      assertPublicAssetClean(chunk, key);
      files.push(writeFileToKey(outDir, key, chunk));
    }
  }
  return { files, channels, touched };
}

/**
 * 上传与状态取回已拆至 publish.mjs（§10 的 300 行红线）。必须 import 成本地绑定再 re-export：
 * 纯 `export { x } from` 不产生本地可见符号，runPipeline 里的直接调用会 ReferenceError。
 */
import { publishFiles, pullState } from './publish.mjs';
export { publishFiles, pullState };

/** 主流程；被 harvest-all / sync-private 复用时传显式 options，不读 process.argv。 */
export async function runPipeline(options = {}) {
  const cli = {
    dryRun: true, publish: false, network: false, pull: false, hours: 24, revision: null,
    isPrivate: false, skipAliasSql: false, targets: null, ...options
  };
  const errors = validateSourceConfig();
  if (errors.length > 0) throw new Error(`源映射配置自检失败:\n  - ${errors.join('\n  - ')}`);
  const nowSeconds = cli.nowSeconds ?? Math.floor(Date.now() / 1000);
  const isPrivate = cli.isPrivate;
  const targets = cli.targets ?? crawlTargets({ privacy: isPrivate ? 'private' : 'public' });
  console.log(`=== ${isPrivate ? '私密' : '公开'}管线：${targets.length} 个采集目标（tid 归属全部来自 config-sources）===`);
  if (cli.pull) console.log(`状态快照取回: ${await pullState(isPrivate) ? 'R2' : '云端缺失，用本地空状态'}`);

  if (cli.publish && !isPrivate) {
    const { discoverRestAuth } = await import('./publish.mjs');
    const auth = await discoverRestAuth();
    if (auth === null) throw new Error('Cannot verify current catalog generation before legacy publication');
    const url = `https://api.cloudflare.com/client/v4/accounts/${auth.account}/storage/kv/namespaces/${INFRA.kvNamespaceId}/values/${encodeURIComponent(KV_KEYS.manifest)}`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${auth.token}` } });
    if (!response.ok) throw new Error(`Cannot verify catalog manifest: ${response.status}`);
    if ((await response.json()).workFacts) throw new Error('Legacy incremental publisher cannot replace a work-facts generation; preserve the current catalog');
  }
  const state = loadState(isPrivate);
  const entries = cli.network ? await collectFromNetwork(targets, cli.hours) : collectFromCache(targets);
  console.log(`本轮条目: ${entries.length} 条（${cli.network ? `上游 h=${cli.hours} 小时窗口` : '本地 harvest 缓存离线干跑'}）`);
  const { added, updated, resolved } = mergeRawsIntoState(state, entries, nowSeconds);
  const revision = cli.revision ?? state.revision + 1;
  const outDir = path.resolve(LOCAL.assets(cli.dryRun));
  const emitted = emitAssets(state, resolved, { revision, outDir, isPrivate, nowSeconds, versionedTitles: state.revision > 0 });

  const manifest = buildManifest(revision, emitted.channels, nowSeconds);
  if (!isPrivate) assertPublicAssetClean(manifest, 'catalog:manifest');
  writeFileToKey(path.resolve(LOCAL.dir), isPrivate ? 'private-manifest.json' : 'catalog-manifest.json', manifest);
  state.revision = revision;
  state.updatedAt = nowSeconds;
  const stateFile = saveState(state, isPrivate);

  const privateStats = { revision, generatedAt: nowSeconds, titles: emitted.touched.length, taxonomyVersion: TAXONOMY_VERSION };
  // 私密管线的清单键与公开 manifest 物理分离（C-2b.2）：绝不用私密统计覆盖公开 catalog:manifest。
  const kvEntries = [
    isPrivate
      ? { key: KV_KEYS.privateManifest, value: JSON.stringify(privateStats) }
      : { key: KV_KEYS.manifest, value: JSON.stringify(manifest) },
    { key: KV_KEYS.sources, value: JSON.stringify(sourceConfigPayload()) }
  ];
  const alias = cli.skipAliasSql ? null : emitAliasSql(resolved, nowSeconds, path.resolve(LOCAL.sqlOut(isPrivate)));
  await publishFiles(emitted.files, kvEntries, { dryRun: cli.dryRun, publish: cli.publish, isPrivate });

  console.log('--- 产物摘要 ---');
  console.log(`revision ${revision} | 新增 ${added} / 更新 ${updated} | 快照 ${stateFile}`);
  console.log(`R2 对象 ${emitted.files.length} 个（${state.revision > 1 ? `剧集清单双写 v${revision} 前缀键 + 稳定键` : 'bootstrap 首轮剧集清单仅稳定键'}）| 输出 ${outDir}`);
  for (const [channelId, stat] of Object.entries(emitted.channels)) {
    const inChannel = Object.values(state.works).filter((record) => record.channelId === channelId);
    const ai = inChannel.filter((record) => record.isAi).length;
    const hot = inChannel.filter((record) => record.isHot).length;
    console.log(`  ${channelId}: ${stat.total} 部 / ${stat.chunks} 片 × ${PAGE_SIZE} 条 | is_ai=${ai} | is_hot=${hot}`);
  }
  console.log(alias === null ? '归一映射 SQL: 跳过' : `归一映射 SQL: ${alias.file}（${alias.rows} 行）`);
  return { revision, files: emitted.files.length, manifest, stateFile, outDir, touched: emitted.touched, alias };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runPipeline(parseCliArgs(process.argv.slice(2))).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
