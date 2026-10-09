/**
 * 《光影Play》(Prism Play) 生产发布流水线标准工具 (SPEC §6.3 / RELEASE-SOP-AND-PIPELINE)
 * 集成：preflight -> upload -> deploy-worker -> promote -> verify -> rollback
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { runPreflight } from './publish-client-release.mjs';
import { getCloudflareClient, saveJsonFile, readJsonFile, CLOUD_CONSTANTS } from './release-client-auth.mjs';
import { uploadAndVerifyApk } from './release-r2-uploader.mjs';

const BACKUP_PATH = 'outputs/release-backup.json';
const UPLOAD_RECEIPT_PATH = 'outputs/release-upload-receipt.json';
const LIVE_RECEIPT_PATH = 'outputs/release-live-receipt.json';

function parseCliArgs() {
  const args = process.argv.slice(2);
  const command = args[0] ?? 'help';
  const flags = {};
  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const parts = [];
      while (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        parts.push(args[++i]);
      }
      flags[key] = parts.length > 0 ? parts.join(' ') : true;
    }
  }
  return { command, flags };
}

function resolveApkPath(explicitPath) {
  if (explicitPath && fs.existsSync(explicitPath)) return path.resolve(explicitPath);
  const dirs = fs.readdirSync('build').filter((d) => d.startsWith('apk')).sort().reverse();
  for (const dir of dirs) {
    const apks = fs.readdirSync(path.join('build', dir))
      .filter((f) => f.endsWith('.apk') && !f.includes('.probe'))
      .map((f) => path.join('build', dir, f));
    if (apks.length > 0) return path.resolve(apks[apks.length - 1]);
  }
  throw new Error('未指定 --apk 且在 build/ 目录下未找到任何可用 APK');
}

async function runStepPreflight(apkPath, allowSameCode = false) {
  console.log(`[步骤 1/5] 执行本地预检与云端基线捕获...`);
  const resolvedApk = resolveApkPath(apkPath);
  console.log(`- 选中发布包: ${resolvedApk}`);
  const client = await getCloudflareClient();
  const oldVersionRaw = await client.getKv('config:version');
  if (!oldVersionRaw) throw new Error('无法读取云端当前 config:version 基准');
  const oldVersion = JSON.parse(oldVersionRaw);
  const currentCode = oldVersion.android.versionCode;
  console.log(`- 云端运行版本: Code ${currentCode} (${oldVersion.android.versionName})`);

  const descriptor = runPreflight(resolvedApk, allowSameCode ? {} : { previousVersionCode: currentCode });
  console.log(`- 发布包合规: Code ${descriptor.versionCode} (${descriptor.versionName}), SHA: ${descriptor.artifact.sha256}`);

  const oldAnnRaw = await client.getKv('config:announcements');
  const deployments = await client.getDeployments();
  const settings = await client.getSettings();
  const liveVersionRes = await fetch(`${CLOUD_CONSTANTS.domain}/api/version`, { signal: AbortSignal.timeout(15000) });
  const liveVersion = liveVersionRes.ok ? await liveVersionRes.json() : null;

  const backup = {
    timestamp: new Date().toISOString(),
    apkPath: resolvedApk,
    descriptor,
    previousWorkerId: liveVersion?.service?.buildId ?? deployments.result?.deployments?.[0]?.id ?? null,
    previousVersionRaw: oldVersionRaw,
    previousAnnouncementsRaw: oldAnnRaw,
    bindings: (settings.result?.bindings ?? []).map((b) => ({ name: b.name, type: b.type, ...(b.type === 'plain_text' ? { text: b.text } : {}) }))
  };
  saveJsonFile(BACKUP_PATH, backup);
  console.log(`- 生产备份快照已保存: ${BACKUP_PATH}`);
  return backup;
}

async function runStepUpload(apkPath) {
  console.log(`[步骤 2/5] 上传不可变 APK 至 R2 并验证 SHA...`);
  if (!fs.existsSync(BACKUP_PATH)) await runStepPreflight(apkPath);
  const backup = readJsonFile(BACKUP_PATH);
  const receipt = await uploadAndVerifyApk(backup.descriptor, backup.apkPath);
  saveJsonFile(UPLOAD_RECEIPT_PATH, receipt);
  console.log(`- R2 上传收据已固化: ${UPLOAD_RECEIPT_PATH}`);
  return receipt;
}

async function runStepDeployWorker(message) {
  console.log(`[步骤 3/5] 部署 Edge Worker (保持既有变量与 Secret)...`);
  const deployMsg = message || 'Release pipeline deployment';
  const dryRun = spawnSync('npx', ['wrangler', 'deploy', '--config', 'edge/wrangler.toml', '--dry-run'], {
    shell: process.platform === 'win32', encoding: 'utf8'
  });
  if (dryRun.status !== 0) throw new Error(`Worker dry-run 失败: ${dryRun.stderr || dryRun.stdout}`);

  const safeMsg = '"' + String(deployMsg).replace(/["\\]/g, '') + '"';
  const deploy = spawnSync('npx', ['wrangler', 'deploy', '--config', 'edge/wrangler.toml', '--keep-vars', '--message', safeMsg], {
    shell: process.platform === 'win32', encoding: 'utf8'
  });
  if (deploy.status !== 0) throw new Error(`Worker 部署失败: ${deploy.stderr || deploy.stdout}`);
  const match = /Current Version ID:\s*([a-f0-9-]+)/i.exec(deploy.stdout);
  const newWorkerId = match ? match[1] : null;
  console.log(`- Worker 部署成功，Version ID: ${newWorkerId ?? '未知'}`);

  if (fs.existsSync(BACKUP_PATH)) {
    const backup = readJsonFile(BACKUP_PATH);
    backup.newWorkerId = newWorkerId;
    saveJsonFile(BACKUP_PATH, backup);
  }
  return newWorkerId;
}

async function runStepPromote() {
  console.log(`[步骤 4/5] 原子切换版本指针与生效启动确认通告...`);
  if (!fs.existsSync(BACKUP_PATH) || !fs.existsSync(UPLOAD_RECEIPT_PATH)) {
    throw new Error('未找到前置阶段备份或上传收据，禁止切换指针');
  }
  const backup = readJsonFile(BACKUP_PATH);
  const upload = readJsonFile(UPLOAD_RECEIPT_PATH);
  if (upload.sha256 !== backup.descriptor.artifact.sha256) throw new Error('上传收据 SHA-256 与预检包不匹配');

  const client = await getCloudflareClient();
  const oldVer = JSON.parse(backup.previousVersionRaw);
  const newVersionDoc = { ...oldVer, android: backup.descriptor };
  await client.putKv('config:version', JSON.stringify(newVersionDoc));

  const nowSec = Math.floor(Date.now() / 1000);
  const oldAnnDoc = backup.previousAnnouncementsRaw ? JSON.parse(backup.previousAnnouncementsRaw) : { schema: 1, revision: 1, items: [] };
  const noticeItem = {
    id: 'content-feedback-notice',
    revision: 1,
    title: '内容来源与反馈说明',
    body: '本程序的内容来自网络搜索聚合。部分来源的视频可能带有广告，我们正在逐步完善识别与剔除；目前无法保证所有内容均无广告。\n\n程序目前仍处于完善阶段。如遇到 BUG 或有改进建议，欢迎通过【我的 → 作者支持 → 联系作者】反馈，帮助我们持续完善。反馈时可附上剧名、操作步骤、截图或运行诊断报告；请勿提供卡密、授权令牌等敏感信息。',
    startsAt: nowSec,
    endsAt: nowSec + 365 * 86400,
    minVersionCode: 1,
    maxVersionCode: null,
    enabled: true
  };
  const filteredOld = (oldAnnDoc.items || []).filter((i) => i.id !== noticeItem.id);
  const newAnnDoc = { schema: 1, revision: (oldAnnDoc.revision || 1) + 1, items: [noticeItem, ...filteredOld] };
  await client.putKv('config:announcements', JSON.stringify(newAnnDoc));

  const readbackVer = await client.getKv('config:version');
  const readbackAnn = await client.getKv('config:announcements');
  if (!readbackVer || !readbackAnn) throw new Error('KV 回读核验失败');
  console.log(`- KV 版本与通告指针生效成功 (版本号 Code ${backup.descriptor.versionCode})`);
}

async function runStepVerify() {
  console.log(`[步骤 5/5] 执行全链路生产端到端回归校验...`);
  const backup = fs.existsSync(BACKUP_PATH) ? readJsonFile(BACKUP_PATH) : null;
  const targetCode = backup?.descriptor?.versionCode ?? 21607;
  const targetSha = backup?.descriptor?.artifact?.sha256;
  const receipt = { checkedAt: new Date().toISOString(), endpoints: [] };

  async function check(urlPath, expectedStatus = 200) {
    const start = Date.now();
    const res = await fetch(`${CLOUD_CONSTANTS.domain}${urlPath}`, { signal: AbortSignal.timeout(45000) });
    const text = await res.text();
    receipt.endpoints.push({ path: urlPath, status: res.status, latencyMs: Date.now() - start });
    if (res.status !== expectedStatus) throw new Error(`生产端点异常 [${res.status}] ${urlPath}`);
    return text;
  }

  const verJson = JSON.parse(await check(`/api/version?check=${Date.now()}`));
  if (verJson.android?.versionCode !== targetCode) throw new Error(`云端公开版本尚未生效，当前仍为 ${verJson.android?.versionCode}`);

  const dlEntry = await fetch(`${CLOUD_CONSTANTS.domain}/dl/latest/android`, { redirect: 'manual', signal: AbortSignal.timeout(30000) });
  if (dlEntry.status !== 302) throw new Error(`下载入口未 302 重定向: ${dlEntry.status}`);
  const artifactUrl = dlEntry.headers.get('Location');
  const apkRes = await fetch(artifactUrl, { signal: AbortSignal.timeout(240000) });
  if (!apkRes.ok) throw new Error(`不可变 APK 下载失败: ${apkRes.status}`);
  const apkBytes = Buffer.from(await apkRes.arrayBuffer());
  const actualSha = crypto.createHash('sha256').update(apkBytes).digest('hex');
  if (targetSha && actualSha !== targetSha) throw new Error(`公开下载包哈希与发布包不符: ${actualSha} vs ${targetSha}`);

  const portalText = await check(`/?check=${Date.now()}`);
  if (!portalText.includes(verJson.android.versionName)) throw new Error('官网主页未显示最新版本号');

  const annJson = JSON.parse(await check(`/api/announcements?versionCode=${targetCode}`));
  if (annJson.items?.[0]?.id !== 'content-feedback-notice') throw new Error('首条有效通告非预期内容');

  await check('/api/channels');
  await check('/api/catalog/changes?after=4');
  await check('/api/search/discoveries?after=105&limit=100');
  await check('/api/catalog?channel=private', 404);
  await check('/api/admin/session', 401);

  receipt.verified = true;
  receipt.download = { targetCode, sha256: actualSha, bytes: apkBytes.length };
  saveJsonFile(LIVE_RECEIPT_PATH, receipt);
  console.log(`- 全链路生产验证通过，报告已保存: ${LIVE_RECEIPT_PATH}`);
  return receipt;
}

async function runStepRollback() {
  console.log(`[紧急回滚] 启动生产一键灾备回滚...`);
  if (!fs.existsSync(BACKUP_PATH)) throw new Error(`未找到备份快照 ${BACKUP_PATH}，无法自动回滚`);
  const backup = readJsonFile(BACKUP_PATH);
  const client = await getCloudflareClient();

  if (backup.previousVersionRaw) {
    console.log(`- 正在恢复 KV config:version 至上个版本...`);
    await client.putKv('config:version', backup.previousVersionRaw);
  }
  if (backup.previousAnnouncementsRaw !== undefined) {
    console.log(`- 正在恢复 KV config:announcements...`);
    if (backup.previousAnnouncementsRaw === null) await client.deleteKv('config:announcements');
    else await client.putKv('config:announcements', backup.previousAnnouncementsRaw);
  }
  if (backup.previousWorkerId) {
    console.log(`- 正在回滚 Worker 至上一版本: ${backup.previousWorkerId}...`);
    const rb = spawnSync('npx', ['wrangler', 'rollback', backup.previousWorkerId, '--yes'], {
      shell: process.platform === 'win32', encoding: 'utf8'
    });
    console.log(rb.stdout || rb.stderr);
  }
  console.log('[紧急回滚] 回滚完成，请运行 verify 进行复查。');
}

async function main() {
  const { command, flags } = parseCliArgs();
  switch (command) {
    case 'preflight': await runStepPreflight(flags.apk, Boolean(flags['allow-same-code'])); break;
    case 'upload': await runStepUpload(flags.apk); break;
    case 'deploy-worker': await runStepDeployWorker(flags.message); break;
    case 'promote': await runStepPromote(); break;
    case 'verify': await runStepVerify(); break;
    case 'rollback': await runStepRollback(); break;
    case 'all':
      await runStepPreflight(flags.apk);
      await runStepUpload(flags.apk);
      await runStepDeployWorker(flags.message);
      await runStepPromote();
      await runStepVerify();
      break;
    default:
      console.log(`
《光影Play》标准化生产发布管线 (release-pipeline)
用法: node edge/scripts/release-pipeline.mjs <command> [options]

命令:
  preflight      步骤 1: 预检待发 APK (签名/seed/Code)，抓取并备份云端基准
  upload         步骤 2: 上传不可变 APK 至 R2，并立即回下校验 SHA-256
  deploy-worker  步骤 3: 部署 Worker (保持既有变量/Secret)
  promote        步骤 4: 原子切换 KV 版本指针与启动确认通告
  verify         步骤 5: 全链路生产端点与不可变下载校验
  rollback       紧急: 从备份快照恢复旧版 KV 与 Worker
  all            全流程: 顺序自动执行 preflight -> upload -> deploy -> promote -> verify

选项:
  --apk <path>        指定发布包路径 (默认自动探测最新 build/apk*/*.apk)
  --message <text>    指定部署日志说明
`);
  }
}

main().catch((err) => {
  console.error(`[发布管线中断] ${err.message}`);
  process.exit(1);
});
