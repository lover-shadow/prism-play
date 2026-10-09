/**
 * 不可变 APK 安全上传通道模块
 * 自动分配隔离端口、启动受限临时 Worker 写入 customMetadata，并在上传后立即回下核验。
 */
import fs from 'node:fs';
import net from 'node:net';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function generateWorkerCode(token, key, bytesLen, artifactSha256, versionCode, versionName) {
  return `
interface Env { APK_BUCKET: R2Bucket }
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.headers.get('X-Release-Token') !== '${token}') return new Response(null, { status: 404 });
    const url = new URL(request.url), reqKey = url.searchParams.get('key') ?? '';
    if (reqKey !== '${key}') return new Response(null, { status: 404 });
    if (request.method === 'GET') {
      const object = await env.APK_BUCKET.get(reqKey);
      if (!object) return new Response(null, { status: 404 });
      return new Response(object.body, { headers: { 'Content-Type': 'application/vnd.android.package-archive',
        'X-Artifact-Metadata': JSON.stringify(object.customMetadata), 'Content-Length': String(object.size) } });
    }
    if (request.method !== 'PUT' || !request.body) return new Response(null, { status: 405 });
    if (request.headers.get('Content-Length') !== '${bytesLen}') return new Response(null, { status: 400 });
    const existing = await env.APK_BUCKET.head(reqKey);
    if (existing) return Response.json({ existed: true, size: existing.size, metadata: existing.customMetadata });
    const object = await env.APK_BUCKET.put(reqKey, request.body, {
      httpMetadata: { contentType: 'application/vnd.android.package-archive', cacheControl: 'public, max-age=31536000, immutable' },
      customMetadata: { sha256: '${artifactSha256}', versionCode: '${versionCode}', versionName: '${versionName}' }
    });
    return Response.json({ existed: false, size: object?.size, metadata: object?.customMetadata });
  }
};
`;
}

export async function uploadAndVerifyApk(descriptor, apkFilePath) {
  const { versionCode, versionName, artifact } = descriptor;
  const apkBytes = fs.readFileSync(apkFilePath);
  const localSha256 = crypto.createHash('sha256').update(apkBytes).digest('hex');
  if (apkBytes.length !== artifact.bytes || localSha256 !== artifact.sha256) {
    throw new Error('待上传的本地 APK 与预检描述符内容不匹配');
  }

  const token = crypto.randomBytes(32).toString('hex');
  const port = await getFreePort();
  const inspectorPort = await getFreePort();
  const tmpDir = os.tmpdir();
  const workerFile = path.join(tmpDir, `prism-r2-upload-${Date.now()}.ts`);

  fs.writeFileSync(workerFile, generateWorkerCode(token, artifact.key, apkBytes.length, artifact.sha256, versionCode, versionName), 'utf8');

  let child = null;
  const cleanup = () => {
    if (child) {
      try { child.kill('SIGTERM'); } catch {}
      child = null;
    }
    if (fs.existsSync(workerFile)) {
      try { fs.rmSync(workerFile, { force: true }); } catch {}
    }
  };

  try {
    console.log(`[R2 上传通道] 启动隔离预览服务 (端口 ${port})...`);
    child = spawn('npx', [
      'wrangler', 'dev', workerFile,
      '--config', 'edge/wrangler.toml',
      '--remote',
      '--ip', '127.0.0.1',
      '--port', String(port),
      '--inspector-port', String(inspectorPort),
      '--show-interactive-dev-session=false'
    ], {
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let isReady = false;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('R2 临时上传通道启动超时 (45s)')), 45000);
      const onData = (data) => {
        const text = data.toString();
        if (text.includes('Ready on') || text.includes(`http://127.0.0.1:${port}`)) {
          isReady = true;
          clearTimeout(timer);
          resolve();
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('error', (err) => { clearTimeout(timer); reject(err); });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (!isReady) reject(new Error(`上传通道进程意外退出，状态码 ${code}`));
      });
    });

    const targetUrl = `http://127.0.0.1:${port}/?key=${encodeURIComponent(artifact.key)}`;
    console.log(`[R2 上传通道] 正在上传 APK (${(apkBytes.length / (1024 * 1024)).toFixed(2)} MB)...`);
    const putRes = await fetch(targetUrl, {
      method: 'PUT',
      headers: {
        'X-Release-Token': token,
        'Content-Length': String(apkBytes.length)
      },
      body: apkBytes,
      signal: AbortSignal.timeout(300000)
    });

    if (!putRes.ok) {
      const errDetail = (await putRes.text()).slice(0, 200);
      throw new Error(`R2 上传请求失败 [HTTP ${putRes.status}]: ${errDetail}`);
    }

    const putOutcome = await putRes.json();
    if (putOutcome.size !== apkBytes.length || putOutcome.metadata?.sha256 !== artifact.sha256) {
      throw new Error('R2 远端对象元数据校验失败');
    }

    console.log('[R2 上传通道] 正在回下 APK 并校验完整性...');
    const getRes = await fetch(targetUrl, {
      headers: { 'X-Release-Token': token },
      signal: AbortSignal.timeout(300000)
    });
    if (!getRes.ok) throw new Error(`R2 回下验证请求失败 [HTTP ${getRes.status}]`);

    const downloaded = Buffer.from(await getRes.arrayBuffer());
    const downloadedSha256 = crypto.createHash('sha256').update(downloaded).digest('hex');
    if (downloadedSha256 !== artifact.sha256 || downloaded.length !== apkBytes.length) {
      throw new Error('R2 下载字节哈希与本地发布包不一致，拒绝发布');
    }

    const receipt = {
      verifiedAt: new Date().toISOString(),
      versionCode,
      versionName,
      key: artifact.key,
      bytes: downloaded.length,
      sha256: downloadedSha256,
      metadata: putOutcome.metadata
    };
    console.log(`[R2 上传通道] 上传与回下 SHA-256 核验成功: ${downloadedSha256}`);
    return receipt;
  } finally {
    cleanup();
  }
}
