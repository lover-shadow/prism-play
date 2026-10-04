import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { publicGet, parsePublicDetail, resolvePublicDetail, publicFailure } from './public-provider.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const targets = [['7688375879554042904', 118], ['7687547133393652798', 149], ['7688405253909122073', 30]];
export async function collectS1({ fetcher = fetch, sleep = pause, staging = false, outDir = path.join(ROOT, 'build/repair-harvest') } = {}) {
  const report = { providerId: 'provider_s1', startedAt: new Date().toISOString(), budget: { details: 3, players: 297, totalRequests: 310, delayMs: 1200, timeoutMs: 15000, retries: 0 }, details: 0, players: 0, totalRequests: 0, reusedDetails: 0, works: [], failures: [], complete: false };
  const candidates = [];
  // Preserve previous deliverables before any network activity, even if collection is interrupted.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const name of ['s1-candidates.json', 's1-candidates-report.json']) {
    const file = path.join(outDir, name);
    if (fs.existsSync(file)) fs.copyFileSync(file, path.join(outDir, `${name}.${stamp}.bak`));
  }
  let first = true;
  const beforeRequest = async () => {
    if (!first) await sleep(1200);
    first = false;
  };
  // No sleeping in fetcher: publicGet creates its timeout only after beforeRequest.
  const countedFetch = async (url, init) => {
    if (report.totalRequests >= report.budget.totalRequests) throw new Error('budget');
    const player = new URL(url).pathname.startsWith('/player/');
    const key = player ? 'players' : 'details';
    if (report[key] >= report.budget[key]) throw new Error('budget');
    report[key]++; report.totalRequests++;
    return fetcher(url, init);
  };
  for (const [id, expected] of targets) {
    let stage = 'detail';
    const workReport = { id, expectedEpisodes: expected, resolvedEpisodes: 0, failedEpisodes: 0, status: 'quarantined', aiClassification: 'unknown' };
    report.works.push(workReport);
    try {
      const file = path.join(outDir, 's1-detail-staging.json');
      let html;
      if (staging && id === targets[0][0] && fs.existsSync(file)) {
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (saved.id !== id) throw new Error('staging identity');
        html = saved.html; report.reusedDetails++; first = false;
      } else html = await publicGet(`/detail?series_id=${id}`, countedFetch, { beforeRequest });
      const detail = parsePublicDetail(html, id);
      workReport.title = detail.title;
      workReport.observedEpisodes = detail.episodeCount;
      if (detail.episodeCount !== expected) throw new Error('count mismatch');
      // Screenshot/navigation presence is not membership evidence. Preserve the real title;
      // until identity-bound detail tags/category rows are verified, never assert AI membership.
      detail.aiClassification = 'unknown';
      stage = 'player';
      const result = await resolvePublicDetail(detail, { maxEpisodeRequests: expected, fetcher: countedFetch, beforeRequest });
      workReport.resolvedEpisodes = result.resolvedEpisodes ?? 0;
      workReport.failedEpisodes = result.failedEpisodes ?? 0;
      if (result.status !== 'candidate') {
        report.failures.push({ id, stage, reason: result.reason, status: 'quarantined', episodes: result.failures ?? [] });
        continue;
      }
      candidates.push(result.fact);
      Object.assign(workReport, { episodes: expected, status: 'candidate', mediaValidation: 'url-only-not-playback-verified' });
    } catch (error) {
      report.failures.push({ id, stage, ...publicFailure(error), status: 'quarantined' });
    }
  }
  report.complete = report.failures.length === 0 && candidates.length === targets.length;
  report.candidateWorks = candidates.length;
  report.candidateEpisodes = candidates.reduce((n, f) => n + f.episodeCount, 0);
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(outDir, 's1-candidates.json'), JSON.stringify({ providerId: 'provider_s1', candidates }, null, 2));
  fs.writeFileSync(path.join(outDir, 's1-candidates-report.json'), JSON.stringify(report, null, 2));
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  collectS1().then((report) => { console.log(JSON.stringify(report, null, 2)); if (!report.complete) process.exitCode = 1; }).catch(() => { console.error('Collection failed; no media details logged'); process.exitCode = 1; });
}
