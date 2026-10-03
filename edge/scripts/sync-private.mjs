/**
 * 私密内容独立管线 (SPEC-CLOUD-REFACTOR v2 §2.2 / §C-2b)
 *
 * §2.2 双条款在这里落地，归属判定全部来自 config-sources.mjs，本脚本不含任何 tid 字面量：
 *   分类级 —— 公开源里被标为 `channelId: "private"` 的分类（魔都 tid 6 里番动漫 / tid 39 伦理片）；
 *   源级   —— `privacy: "private-all"` 的五个源的全部内容（baseUrl 回填后置 crawlable=true 即自动接入）。
 * 产物只到 `private/` 前缀：仅剧集清单（C-2b.1，私密频道不做批量目录下发）+ 私密 KV 清单（C-2b.2）。
 *
 * 第二个用途是公开前缀扫描判据（AC-C2b-1）：`--verify` 遍历 library/ 下所有目录分片与公开清单，
 * 断言 is_private 计数恒为 0、无上游域名、目录侧无播放地址——这是「私密永不混入公开分片」的机器证明。
 *
 * 诚实边界：本管线只能证明**产物侧**不含私密内容混入；私密清单的最终可见性仍由 Worker 路由的
 * 「有效高级授权 + 当次手动开启」双重准入决定（C-3b），脚本无法验证用户是否真的在设备上点了开启。
 *
 * 用法：`node edge/scripts/sync-private.mjs --dry-run | --network [--publish] | --verify`
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  LOCAL, PROVIDERS, assertPublicAssetClean, crawlTargets, isSourcePrivate
} from './config-sources.mjs';
import { parseCliArgs, runPipeline } from './sync-incremental.mjs';

function listFiles(dir, predicate) {
  if (!fs.existsSync(dir)) return [];
  const found = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) found.push(...listFiles(full, predicate));
    else if (predicate(name, full)) found.push(full);
  }
  return found;
}

/**
 * 公开前缀扫描判据（AC-C2b-1）。只扫目录分片与公开清单：剧集清单按 §3.2 契约**必须**携带
 * mediaUrl，把它纳入同一条判据反而会把正确产物误判成违规，进而诱使人把检查调松。
 */
export function verifyPublicPrefix(assetsDir) {
  const chunks = listFiles(path.join(assetsDir, 'library'), (name) => name.startsWith('chunk-'));
  const manifests = listFiles(path.resolve(LOCAL.dir), (name) => name === 'catalog-manifest.json');
  let privateFlags = 0;
  for (const file of [...chunks, ...manifests]) {
    const text = fs.readFileSync(file, 'utf8');
    privateFlags += (text.match(/"isPrivate"\s*:\s*true/g) ?? []).length + (text.match(/"is_private"\s*:\s*1/g) ?? []).length;
    const label = path.relative(path.resolve('.'), file).replace(/\\/g, '/');
    assertPublicAssetClean(text, label);
  }
  if (privateFlags > 0) throw new Error(`[AC-C2b-1 失败] 公开前缀出现 is_private=true 共 ${privateFlags} 处`);
  console.log(`公开前缀判据通过：${chunks.length} 份目录分片 + ${manifests.length} 份公开清单，is_private 计数 0、上游域名 0 次命中。`);
  return { chunks: chunks.length, manifests: manifests.length, privateFlags };
}

/** 打印本轮私密归属判定，让 CI 日志能自证「哪些内容为什么进了个人探索」。 */
function describePrivatePlan() {
  const targets = crawlTargets({ privacy: 'private' });
  const grouped = new Map();
  for (const target of targets) {
    const list = grouped.get(target.provider.id) ?? [];
    list.push(target.typeId);
    grouped.set(target.provider.id, list);
  }
  console.log('个人探索采集计划（§2.2 双条款）：');
  for (const [providerId, typeIds] of grouped) {
    const kind = isSourcePrivate(PROVIDERS.find((p) => p.id === providerId)) ? '源级私密（全部内容）' : '分类级私密';
    console.log(`  ${providerId}: tid ${typeIds.join(', ')} —— ${kind}`);
  }
  const declaredOnly = PROVIDERS.filter((provider) => isSourcePrivate(provider) && provider.crawlable === false);
  if (declaredOnly.length > 0) {
    console.log(`  已声明但暂不可采集的源级私密源：${declaredOnly.map((p) => p.id).join(', ')}（crawlable=false，等 baseUrl）`);
  }
  if (targets.length === 0 && declaredOnly.length === 0) console.log('  （当前配置下没有任何私密来源）');
}

async function main(argv) {
  if (argv.includes('--verify')) {
    const dirIndex = argv.indexOf('--assets-dir');
    const assetsDir = dirIndex >= 0 ? path.resolve(argv[dirIndex + 1]) : path.resolve(LOCAL.assets(true));
    verifyPublicPrefix(assetsDir);
    return;
  }
  describePrivatePlan();
  const cli = parseCliArgs(argv);
  await runPipeline({ ...cli, isPrivate: true, skipAliasSql: true });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
