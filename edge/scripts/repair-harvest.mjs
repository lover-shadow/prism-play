import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { publicTargets, LOCAL } from './config-sources.mjs';
import { publicGet, parsePublicDetail, parsePublicPlayer } from './public-provider.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_OUT = path.join(ROOT, 'build/repair-harvest');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Three total attempts, bounded timeout; authentication failures are never retried. */
export async function requestJson(url, { fetcher = fetch, sleep: pause = sleep, timeoutMs = 15000 } = {}) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { Accept: 'application/json', 'User-Agent': 'PrismPlay-PublicRepair/1.0' } });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        error.terminal = [400, 401, 403, 404].includes(response.status);
        throw error;
      }
      return await response.json();
    } catch (error) {
      if (attempt === 3 || error.terminal) throw error;
      await pause(1000 * attempt);
    }
  }
}
function preserveWrite(file, value) {
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.previous-${Date.now()}-${process.hrtime.bigint()}`);
  fs.writeFileSync(file, JSON.stringify(value));
}
function isolatedDirectory(outDir) {
  const directory = path.resolve(outDir);
  const legacy = path.join(ROOT, LOCAL.harvestCache);
  if (directory === legacy || directory.startsWith(legacy + path.sep)) throw new Error('Original harvest cache is protected');
  return directory;
}
function validatePage(data, page, typeId) {
  if (!Array.isArray(data?.list) || !Number.isSafeInteger(Number(data.pagecount)) || Number(data.pagecount) < page ||
      (data.page !== undefined && Number(data.page) !== page)) throw new Error('Invalid live pagination');
  for (const item of data.list) {
    if (!/^[0-9]+$/.test(String(item.vod_id)) || Number(item.type_id ?? typeId) !== typeId) throw new Error('Invalid AI source identity/type');
  }
}
/** Always probe LIVE page one; stop after the first exhausted failure, no cloud pipeline. */
export async function harvestAi(options = {}) {
  const { outDir = DEFAULT_OUT, maxPages = 96, delayMs = 1200, dryRun = false, sleep: pause = sleep } = options;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 96 || !Number.isFinite(delayMs) || delayMs < 1000) throw new Error('Invalid page/delay budget');
  const directory = isolatedDirectory(outDir);
  const target = publicTargets().find((entry) => entry.forceAi && entry.typeId === 42);
  if (!target) throw new Error('Configured public AI target missing');
  const report = { providerId: target.provider.id, typeId: target.typeId, dryRun, pagecount: 0,
    pages: 0, rows: 0, uniqueWorks: 0, limited: false, complete: false, failures: [] };
  if (dryRun) return { ...report, outDir: directory };
  fs.mkdirSync(directory, { recursive: true });
  const ids = new Set();
  let planned = 1;
  for (let page = 1; page <= planned; page++) {
    if (page > 1) await pause(delayMs);
    try {
      const url = new URL(target.provider.baseUrl);
      for (const [key, value] of Object.entries({ ac: 'detail', t: target.typeId, pg: page })) url.searchParams.set(key, String(value));
      const data = await requestJson(url.href, { ...options, sleep: pause });
      validatePage(data, page, target.typeId);
      if (page === 1) {
        report.pagecount = Number(data.pagecount); planned = Math.min(report.pagecount, maxPages);
        report.limited = report.pagecount > planned;
      } else if (Number(data.pagecount) !== report.pagecount) throw new Error('Live pagination changed; incomplete snapshot');
      preserveWrite(path.join(directory, `t_${target.typeId}_p_${page}.json`), { ...data, tid: target.typeId, page });
      report.pages++; report.rows += data.list.length;
      for (const item of data.list) ids.add(String(item.vod_id));
      console.log(`AI page ${page}/${planned}: ${data.list.length} rows, ${ids.size} unique`);
    } catch (error) { report.failures.push({ page, reason: error.message }); break; }
  }
  report.uniqueWorks = ids.size;
  report.complete = !report.limited && !report.failures.length && report.pages === report.pagecount;
  preserveWrite(path.join(directory, 'harvest-report.json'), report);
  return report;
}

/** At most three already-evidenced details and ONE player, never resolve a whole series. */
export async function probePublicWorks(ids, { outDir = DEFAULT_OUT, dryRun = false, fetcher = fetch, sleep: pause = sleep } = {}) {
  if (!Array.isArray(ids) || ids.length > 3 || new Set(ids).size !== ids.length || ids.some((id) => !/^\d{1,32}$/.test(id))) throw new Error('Invalid public detail budget');
  const directory = isolatedDirectory(outDir), report = { dryRun, details: [], player: null, failures: [] };
  if (dryRun) return report;
  fs.mkdirSync(directory, { recursive: true });
  for (const id of ids) {
    try {
      const html = await publicGet(`/detail?series_id=${id}`, fetcher);
      preserveWrite(path.join(directory, `s1-detail-${id}.json`), { html });
      const detail = parsePublicDetail(html, id);
      report.details.push(detail);
    } catch (error) { report.failures.push({ id, reason: error.message }); break; }
    await pause(1200);
  }
  const first = report.details[0];
  if (first && !report.failures.length) {
    try {
      const videoId = first.episodes[0].sourceEpisodeId;
      const html = await publicGet(`/player/${first.sourceItemId}/${videoId}`, fetcher);
      preserveWrite(path.join(directory, 's1-player.json'), { html });
      const parsed = parsePublicPlayer(html, first.sourceItemId, videoId);
      const response = await fetcher(parsed.lines[0].mediaUrl, { redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { Range: 'bytes=0-1023' } });
      const reader = response.body?.getReader();
      const bytes = reader ? (await reader.read()).value?.length ?? 0 : 0;
      if (reader) await reader.cancel();
      report.player = { sourceItemId: first.sourceItemId, sourceEpisodeId: videoId, status: response.status,
        contentType: response.headers.get('content-type'), contentRange: response.headers.get('content-range'),
        sampledBytes: bytes, verified: response.ok && /^(video\/|application\/(octet-stream|vnd.apple.mpegurl|x-mpegurl))/i.test(response.headers.get('content-type') ?? '') };
      // A verified single episode is evidence only, never a complete publishable candidate.
    } catch (error) { report.failures.push({ stage: 'player/media', reason: error.message }); }
  }
  preserveWrite(path.join(directory, 's1-probe-report.json'), report);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const argv = process.argv.slice(2), read = (name) => argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const allowed = /^(--dry-run|--out=.+|--max-pages=\d+|--delay-ms=\d+|--public-ids=[\d,]+)$/;
  const run = async () => {
    if (argv.some((arg) => !allowed.test(arg))) throw new Error('Unsupported argument (no publish support)');
    const options = { dryRun: argv.includes('--dry-run'), outDir: read('out') ?? DEFAULT_OUT,
      maxPages: Number(read('max-pages') ?? 96), delayMs: Number(read('delay-ms') ?? 1200) };
    const result = read('public-ids') ? await probePublicWorks(read('public-ids').split(','), options) : await harvestAi(options);
    console.log(JSON.stringify(result, null, 2));
    if (result.failures?.length) process.exitCode = 1;
  };
  run().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
