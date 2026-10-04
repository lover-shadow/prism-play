/**
 * R2 / KV 发布器（SPEC-CLOUD-REFACTOR v2 §C-2）— 从 sync-incremental 拆出，守 §10 的 300 行红线。
 *
 * 职责只有一条：把本地镜像目录里生成好的资产按 key 推到云端。
 *
 * 为什么是 REST 而不是 `wrangler r2 object put`：本机实测三种池宽（8/10/40）吞吐都卡在
 * 120~133 对象/分钟——瓶颈是每个对象都要 cmd→wrangler.cmd→node 冷启动一次 V8，2 万对象要 2.5 小时+，
 * 加并发只会加剧进程争抢。改为单进程直连 Cloudflare REST（fetch 自带连接池），实测 PUT/DELETE 200，
 * 吞吐提升两个数量级。CLI 路径保留为兜底（拿不到 token 时，例如 CI 未注入凭据的调试场景）。
 *
 * put 幂等：重跑即从失败处续传（已上传对象被同内容覆写），KV 键与状态快照量小仍走 CLI。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { INFRA, LOCAL, stateKey } from './config-sources.mjs';
import { validatePublication } from './publication-guard.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function runCommand(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'], shell: process.platform === 'win32' });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${args.join(' ')} 退出码 ${code}: ${stderr.slice(0, 200)}`))));
  });
}

/**
 * CI 里每轮要发起数百次上传：默认走 `npx wrangler`（首次会解析包），
 * 若 workflow 预先 `npm i -g wrangler` 并设 PRISM_WRANGLER_BIN=wrangler，可省掉每次解析开销。
 */
const WRANGLER_BIN = process.env.PRISM_WRANGLER_BIN ?? 'npx';
const wrangler = (...args) => runCommand(WRANGLER_BIN, WRANGLER_BIN === 'npx' ? ['wrangler', ...args] : args, path.resolve(INFRA.wranglerCwd));

/* ── REST 凭据发现：CI 用环境变量，本机回退 wrangler 的 OAuth 配置 ───────────────────── */

const WRANGLER_CONFIG_CANDIDATES = [
  process.env.APPDATA && path.join(process.env.APPDATA, 'xdg.config', '.wrangler', 'config', 'default.toml'),
  process.env.XDG_CONFIG_HOME && path.join(process.env.XDG_CONFIG_HOME, '.wrangler', 'config', 'default.toml'),
  path.join(os.homedir(), '.config', '.wrangler', 'config', 'default.toml')
].filter(Boolean);

function readTomlValue(text, key) {
  const match = new RegExp(`${key}\\s*=\\s*"([^"]+)"`).exec(text);
  return match === null ? null : match[1];
}

/** @returns {Promise<{token: string, account: string} | null>} null = 走 CLI 兜底。 */
export async function discoverRestAuth() {
  const token = process.env.CLOUDFLARE_API_TOKEN ?? null;
  const envAccount = process.env.CLOUDFLARE_ACCOUNT_ID ?? null;
  if (token !== null) {
    return envAccount === null ? null : { token, account: envAccount };
  }
  for (const file of WRANGLER_CONFIG_CANDIDATES) {
    if (!fs.existsSync(file)) continue;
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const oauth = readTomlValue(text, 'oauth_token');
    if (oauth === null) continue;
    // 本机 wrangler 登录只存 token 不存账户；账户经 /accounts 一次性解析并缓存。
    const account = readTomlValue(text, 'account_id') ?? (await resolveAccountFromApi(oauth));
    return account === null ? null : { token: oauth, account };
  }
  return null;
}

let accountPromise = null;
function resolveAccountFromApi(token) {
  if (accountPromise === null) {
    accountPromise = fetch('https://api.cloudflare.com/client/v4/accounts', { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then((body) => (body.success === true && body.result.length > 0 ? body.result[0].id : null))
      .catch(() => null);
  }
  return accountPromise;
}

/* ── REST 上传 ─────────────────────────────────────────────────────────────────────── */

const UPLOAD_POOL = Number(process.env.PRISM_UPLOAD_POOL ?? 32);
const UPLOAD_ATTEMPTS = 5;
const retrySleep = (attempt, retryAfterMs) => sleep(Math.max(retryAfterMs ?? 0, 300 * 2 ** attempt) + Math.random() * 200);

function encodeKeyPath(key) {
  return key.split('/').map(encodeURIComponent).join('/');
}

async function restPut(auth, key, body) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${auth.account}/r2/buckets/${INFRA.r2Bucket}/objects/${encodeKeyPath(key)}`;
  const contentType = key.endsWith('.gz') ? 'application/gzip' : (key.endsWith('.webp') ? 'image/webp' : 'application/json');
  const response = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${auth.token}`, 'content-type': contentType },
    body
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 160);
    const error = new Error(`REST PUT ${key} → ${response.status} ${detail}`);
    error.retryAfterMs = response.status === 429 ? Number(response.headers.get('retry-after') ?? '1') * 1000 : undefined;
    throw error;
  }
  await response.arrayBuffer(); // 读完响应体，连接才能回池。
}

async function restKvPut(auth, key, value) {
  const namespaceId = INFRA.kvNamespaceId;
  const url = `https://api.cloudflare.com/client/v4/accounts/${auth.account}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}`;
  const response = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${auth.token}`, 'content-type': 'text/plain; charset=utf-8' },
    body: value
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 160);
    throw new Error(`REST KV PUT ${key} → ${response.status} ${detail}`);
  }
}

async function putWithRetry(upload, key, file) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await upload(key, file);
      return;
    } catch (error) {
      if (attempt >= UPLOAD_ATTEMPTS - 1) throw new Error(`上传失败 ${key}（已重试 ${UPLOAD_ATTEMPTS} 次）: ${error.message}`);
      await retrySleep(attempt, error.retryAfterMs);
    }
  }
}

/** 上传：分片与清单走 R2，KV 键走 kv key put，状态快照回写供下一日增量续算。 */
export async function publishFiles(files, kvEntries, options) {
  const { dryRun, publish, isPrivate, skipState = false } = options;
  if (dryRun || !publish) {
    console.log(`${dryRun ? '[dry-run]' : '[未加 --publish]'} 跳过 ${files.length} 个 R2 对象与 ${kvEntries.length} 个 KV 键的上传（未触碰云端）。`);
    return;
  }
  validatePublication(files, kvEntries, isPrivate);
  const auth = await discoverRestAuth();
  if (auth !== null) {
    console.log(`上传通道：REST 直传（${UPLOAD_POOL} 路并发，${files.length} 个对象）`);
    const upload = async (key, file) => await restPut(auth, key, fs.readFileSync(file));
    await uploadPool(files, upload);
  } else {
    console.log(`上传通道：wrangler CLI 兜底（每对象一次进程，慢）`);
    await uploadPool(files, async (key, file) => {
      const cType = key.endsWith('.gz') ? 'application/gzip' : (key.endsWith('.webp') ? 'image/webp' : 'application/json');
      await wrangler('r2', 'object', 'put', `${INFRA.r2Bucket}/${key}`, '--file', file, '--content-type', cType, '--remote');
    });
  }
  const statePath = path.resolve(LOCAL.state(isPrivate));
  if (!skipState && fs.existsSync(statePath)) {
    if (auth !== null) await restPut(auth, stateKey(isPrivate), fs.readFileSync(statePath));
    else await wrangler('r2', 'object', 'put', `${INFRA.r2Bucket}/${stateKey(isPrivate)}`, '--file', statePath, '--content-type', 'application/json', '--remote');
  }
  for (const { key, value } of kvEntries) {
    if (auth !== null) {
      await restKvPut(auth, key, value);
    } else {
      const tmp = path.join(os.tmpdir(), `prism-${key.replace(/:/g, '-')}.tmp.json`);
      fs.writeFileSync(tmp, value, 'utf8');
      await wrangler('kv', 'key', 'put', key, '--binding', INFRA.kvBinding, '--path', tmp, '--remote');
      fs.rmSync(tmp, { force: true });
    }
  }
}

/** 固定宽度工作池：游标共享，进度每 1,000 个对象报一次。 */
async function uploadPool(files, upload) {
  let cursor = 0;
  let done = 0;
  const worker = async () => {
    while (cursor < files.length) {
      const { key, file } = files[cursor];
      cursor += 1;
      await putWithRetry(upload, key, file);
      done += 1;
      if (done % 1000 === 0) console.log(`  …已上传 ${done}/${files.length}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(UPLOAD_POOL, files.length) }, worker));
  console.log(`  …已上传 ${done}/${files.length}（完成）`);
}

/** 取回云端状态快照；首轮没有快照时退回 false，由本地空状态建立第一代。 */
export async function pullState(isPrivate) {
  const target = path.resolve(LOCAL.state(isPrivate));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    await wrangler('r2', 'object', 'get', `${INFRA.r2Bucket}/${stateKey(isPrivate)}`, '--file', target, '--remote');
    return true;
  } catch {
    return false;
  }
}
