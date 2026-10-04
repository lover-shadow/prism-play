/**
 * 全量 bootstrap 抓取 + 资产生成 (SPEC-CLOUD-REFACTOR v2 §C-1 / §C-2 / §五 施工顺序)
 *
 * 频道归属与 tid 全部来自 config-sources.mjs —— 旧版本在这里硬编码 42→anime（把 AI 漫剧从
 * 【短剧精选】里变没了）并且从不采集 tid 7，本文件不再持有任何映射字面量。
 *
 * 两阶段职责：
 *   1) 抓取：按 `ac=detail` 逐 tid 翻页（先读上游 pagecount 再决定页数），分页快照落
 *      `edge/cache/harvest/`，已存在的页直接命中跳过，因此中断可续跑；
 *   2) 建库：把缓存交给 sync-incremental 的同一套引擎，生成 §3.1 目录分片 + §3.2 剧集清单 +
 *      §3.3 KV 清单；私密分类走 `private/` 前缀独立产物。默认不碰云端，`--publish` 才调 wrangler。
 *
 * 用法：
 *   node edge/scripts/harvest-all.mjs --dry-run     离线：只用现有缓存重建全套资产（零联网零云端）
 *   node edge/scripts/harvest-all.mjs               联网全量抓取 + 本地重建资产
 *   node edge/scripts/harvest-all.mjs --publish     抓取 + 重建 + 推 R2/KV（首轮 bootstrap 专用）
 *   可选：--max-pages=N 每 tid 页数上限 | --concurrency=N 并发 | --public-only | --private-only
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { LOCAL, crawlTargets, validateSourceConfig } from './config-sources.mjs';
import { parseCliArgs, runPipeline } from './sync-incremental.mjs';
import { verifyPublicPrefix } from './sync-private.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE_RETRY_LIMIT = 3;
const REQUEST_TIMEOUT_MS = 15000;
const REQUEST_DELAY_BASE_MS = 400;
const REQUEST_DELAY_JITTER_MS = 400;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function optionValue(argv, name, fallback) {
  const hit = argv.find((arg) => arg.startsWith(`--${name}=`));
  return hit === undefined ? fallback : Number(hit.slice(name.length + 3));
}

async function fetchJson(url) {
  for (let attempt = 1; attempt <= PAGE_RETRY_LIMIT; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      if (attempt === PAGE_RETRY_LIMIT) throw error;
      await sleep(500 * attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/** 分页快照文件名即断点：`t_<tid>_p_<page>.json`，与 sync-incremental 离线干跑的读取口径一致。 */
const cacheFileFor = (typeId, page) => path.join(LOCAL.harvestCache, `t_${typeId}_p_${page}.json`);
const detailUrl = (target, page) => `${target.provider.baseUrl}?ac=detail&t=${target.typeId}&pg=${page}`;

function cacheInventory() {
  const dir = path.resolve(LOCAL.harvestCache);
  if (!fs.existsSync(dir)) return [];
  const counts = new Map();
  for (const name of fs.readdirSync(dir)) {
    const matched = /^t_(\d+)_p_\d+\.json$/.exec(name);
    if (matched === null) continue;
    counts.set(matched[1], (counts.get(matched[1]) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => Number(a[0]) - Number(b[0]));
}

/** 并发池：温和限流；任一页失败只丢该页，不让整轮 bootstrap 报废。 */
async function runPool(jobs, concurrency, worker) {
  let cursor = 0;
  let failures = 0;
  const lanes = Array.from({ length: concurrency }, async () => {
    while (cursor < jobs.length) {
      const job = jobs[cursor++];
      try {
        await worker(job);
      } catch (error) {
        failures += 1;
        console.warn(`  ! tid=${job.typeId} p${job.page} 失败: ${error.message}`);
      }
      await sleep(REQUEST_DELAY_BASE_MS + Math.random() * REQUEST_DELAY_JITTER_MS);
    }
  });
  await Promise.all(lanes);
  return failures;
}

/** 首页探测决定每个 tid 要翻多少页：上游 pagecount 比旧代码写死的 maxPages 准。 */
export async function planCrawl(targets, maxPages, { cacheDir = LOCAL.harvestCache, fetch: probe = fetchJson } = {}) {
  const cacheFile = (typeId, page) => path.join(cacheDir, `t_${typeId}_p_${page}.json`);
  const validPagecount = (value) => (typeof value === 'number' || typeof value === 'string')
    && Number.isSafeInteger(Number(value)) && Number(value) > 0;
  const jobs = [];
  for (const target of targets) {
    let pagecount;
    const firstFile = cacheFile(target.typeId, 1);
    if (fs.existsSync(firstFile)) {
      try {
        pagecount = JSON.parse(fs.readFileSync(firstFile, 'utf8'))?.pagecount;
      } catch {
        // 损坏快照仅触发探测；规划不覆写或删除旧缓存。
      }
    }
    if (!validPagecount(pagecount)) {
      try {
        const data = await probe(detailUrl(target, 1));
        pagecount = data?.pagecount;
        if (!validPagecount(pagecount)) throw new Error('首页未返回有效正整数 pagecount');
      } catch (error) {
        throw new Error(`tid=${target.typeId} pagecount 探测失败，无法规划: ${error.message}`, { cause: error });
      }
    }
    pagecount = Number(pagecount);
    const pages = Math.max(1, Math.min(pagecount, maxPages));
    const suffix = pagecount > pages ? `（上游 ${pagecount} 页，受 --max-pages 截断）` : '';
    console.log(`  ${target.provider.id} tid=${target.typeId} → ${target.channelId}${target.isPrivate ? ' [私密]' : ''}: ${pages} 页${suffix}`);
    for (let page = 1; page <= pages; page += 1) {
      if (fs.existsSync(cacheFile(target.typeId, page))) continue;
      jobs.push({ typeId: target.typeId, page, url: detailUrl(target, page) });
    }
  }
  return jobs;
}

async function crawl(jobs, concurrency) {
  fs.mkdirSync(path.resolve(LOCAL.harvestCache), { recursive: true });
  const started = Date.now();
  let done = 0;
  let works = 0;
  const failures = await runPool(jobs, concurrency, async (job) => {
    const data = await fetchJson(job.url);
    const list = data?.list ?? [];
    const file = cacheFileFor(job.typeId, job.page);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ tid: job.typeId, page: job.page, pagecount: Number(data?.pagecount ?? job.page), list }), 'utf8');
    works += list.length;
    done += 1;
    if (done % 20 === 0 || done === jobs.length) {
      console.log(`  [${((done / jobs.length) * 100).toFixed(0)}%] ${done}/${jobs.length} 页 | 累计条目 ${works} | 耗时 ${((Date.now() - started) / 1000).toFixed(0)}s`);
    }
  });
  console.log(`抓取结束：新增 ${done} 页 / 失败 ${failures} 页 / 新条目 ${works} 条 / 耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return { done, failures, works };
}

async function main(argv) {
  const cli = parseCliArgs(argv);
  const errors = validateSourceConfig();
  if (errors.length > 0) throw new Error(`源映射配置自检失败:\n  - ${errors.join('\n  - ')}`);
  const wantPublic = !argv.includes('--private-only');
  const wantPrivate = !argv.includes('--public-only');
  const targets = [
    ...(wantPublic ? crawlTargets({ privacy: 'public' }) : []),
    ...(wantPrivate ? crawlTargets({ privacy: 'private' }) : [])
  ];

  console.log('=== 《光影Play》全量 bootstrap：抓取 → 状态快照 → R2 资产 ===');
  const inventory = cacheInventory();
  console.log(`采集目标 ${targets.length} 个 tid（归属来自 config-sources）| 本地分页缓存 ${inventory.length} 个 tid / ${inventory.reduce((sum, [, count]) => sum + count, 0)} 页`);

  if (cli.dryRun) {
    console.log('[dry-run] 跳过联网抓取，直接用本地 harvest 缓存重建资产。');
  } else {
    const jobs = await planCrawl(targets, optionValue(argv, 'max-pages', 400));
    console.log(`待抓取 ${jobs.length} 页（已命中缓存的页自动跳过，可断点续跑）`);
    if (jobs.length > 0) await crawl(jobs, optionValue(argv, 'concurrency', 4));
  }

  const shared = { dryRun: cli.dryRun, publish: cli.publish, network: false, pull: false, revision: cli.revision, nowSeconds: cli.nowSeconds };
  const publicResult = wantPublic ? await runPipeline({ ...shared, isPrivate: false }) : null;
  const privateResult = wantPrivate ? await runPipeline({ ...shared, isPrivate: true, skipAliasSql: true }) : null;
  verifyPublicPrefix(path.resolve(LOCAL.assets(cli.dryRun)));

  console.log('=== bootstrap 完成 ===');
  if (publicResult !== null) console.log(`公开 revision ${publicResult.revision}｜R2 对象 ${publicResult.files} 个`);
  if (privateResult !== null) console.log(`私密 revision ${privateResult.revision}｜剧集清单 ${privateResult.touched.length} 部`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
