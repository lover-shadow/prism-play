/**
 * Cloudflare REST API 认证与 KV/Worker 操作辅助模块
 * 提供给 release-pipeline 统一调用，杜绝每次发布硬编码请求逻辑。
 */
import fs from 'node:fs';
import { discoverRestAuth } from './publish.mjs';
import { INFRA } from './config-sources.mjs';

export const CLOUD_CONSTANTS = {
  account: '3d11a910907ee5175e7f807cd34a2ada',
  workerName: 'prism-play-edge',
  domain: 'https://play.prismos.org',
  namespace: INFRA.kvNamespaceId,
  r2Bucket: INFRA.r2Bucket
};

export async function getCloudflareClient() {
  const auth = await discoverRestAuth();
  if (!auth || auth.account !== CLOUD_CONSTANTS.account) {
    throw new Error('未检测到有效的 Cloudflare 认证凭据或账号不匹配，请先运行 wrangler whoami 或配置 CLOUDFLARE_API_TOKEN');
  }
  const base = `https://api.cloudflare.com/client/v4/accounts/${auth.account}`;

  async function request(apiPath, init = {}) {
    const timeoutMs = init.timeoutMs ?? 60000;
    const response = await fetch(base + apiPath, {
      ...init,
      headers: {
        Authorization: `Bearer ${auth.token}`,
        ...init.headers
      },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok && !init.allowNotFound) {
      const errText = (await response.text()).slice(0, 200);
      throw new Error(`Cloudflare API 请求失败 [${response.status}] ${apiPath}: ${errText}`);
    }
    return response;
  }

  const kvKeyUrl = (key) => `/storage/kv/namespaces/${CLOUD_CONSTANTS.namespace}/values/${encodeURIComponent(key)}`;

  async function getKv(key) {
    const res = await request(kvKeyUrl(key), { allowNotFound: true, timeoutMs: 30000 });
    if (res.status === 404) return null;
    return await res.text();
  }

  async function putKv(key, value) {
    const res = await request(kvKeyUrl(key), {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body: typeof value === 'string' ? value : JSON.stringify(value),
      timeoutMs: 30000
    });
    return res.ok;
  }

  async function deleteKv(key) {
    const res = await request(kvKeyUrl(key), { method: 'DELETE', allowNotFound: true, timeoutMs: 30000 });
    return res.ok;
  }

  async function getDeployments() {
    const res = await request(`/workers/scripts/${CLOUD_CONSTANTS.workerName}/deployments`);
    return await res.json();
  }

  async function getSettings() {
    const res = await request(`/workers/scripts/${CLOUD_CONSTANTS.workerName}/settings`);
    return await res.json();
  }

  return { auth, base, request, getKv, putKv, deleteKv, getDeployments, getSettings };
}

export function saveJsonFile(relPath, data) {
  fs.writeFileSync(relPath, JSON.stringify(data, null, 2), 'utf8');
}

export function readJsonFile(relPath) {
  return JSON.parse(fs.readFileSync(relPath, 'utf8'));
}
