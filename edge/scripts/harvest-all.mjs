import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, '..', 'cache', 'harvest');

if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

const MODU_API = 'https://caiji.moduapi.cc/api.php/provide/vod';

// 抓取任务配置列表：目标 8,500 ~ 9,000 部全品类
const TASKS = [
  { name: '短剧精选', channelId: 'drama', tid: 38, maxPages: 200, categoryTag: null },
  { name: '动作电影', channelId: 'movie', tid: 10, maxPages: 25, categoryTag: '动作' },
  { name: '喜剧电影', channelId: 'movie', tid: 11, maxPages: 25, categoryTag: '喜剧' },
  { name: '爱情电影', channelId: 'movie', tid: 12, maxPages: 20, categoryTag: '爱情' },
  { name: '科幻电影', channelId: 'movie', tid: 13, maxPages: 20, categoryTag: '科幻' },
  { name: '悬疑电影', channelId: 'movie', tid: 21, maxPages: 20, categoryTag: '悬疑' },
  { name: '国产动漫', channelId: 'anime', tid: 1, maxPages: 30, categoryTag: null },
  { name: '日韩动漫', channelId: 'anime', tid: 2, maxPages: 30, categoryTag: null },
  { name: 'AI漫剧', channelId: 'anime', tid: 42, maxPages: 6, categoryTag: '科幻' },
  { name: '人文纪录', channelId: 'documentary', tid: 24, maxPages: 60, categoryTag: null },
];

async function fetchWithRetry(url, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json'
        },
        signal: controller.signal
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return data;
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise(r => setTimeout(r, 500 * attempt));
    }
  }
}

// 并发池执行器
async function runPool(items, concurrency, fn) {
  const results = [];
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const current = items[index++];
      try {
        const res = await fn(current);
        results.push(res);
      } catch (err) {
        console.error(`Task failed:`, current, err.message);
      }
    }
  }
  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);
  return results;
}

async function main() {
  console.log('=== 《光影Play》海量全品类启动数据多通道抓取引擎 ===');
  console.log(`本地断点存储目录: ${CACHE_DIR}`);

  const allPageTasks = [];
  for (const t of TASKS) {
    for (let p = 1; p <= t.maxPages; p++) {
      allPageTasks.push({
        ...t,
        page: p,
        cacheFile: path.join(CACHE_DIR, `t_${t.tid}_p_${p}.json`)
      });
    }
  }

  console.log(`总计待调度页数: ${allPageTasks.length} 页 (预计覆盖约 8,500~9,000 部全网作品)`);

  const startTime = Date.now();
  let doneCount = 0;
  let cachedCount = 0;
  let fetchedCount = 0;
  let totalDramas = 0;

  // 检查已有缓存
  for (const task of allPageTasks) {
    if (fs.existsSync(task.cacheFile)) {
      cachedCount++;
    }
  }
  console.log(`已命中本地快照: ${cachedCount} 页，剩余需抓取: ${allPageTasks.length - cachedCount} 页`);

  // 并发数 6，温和而高效，单页之间 50ms 延迟
  await runPool(allPageTasks, 6, async (task) => {
    let list = [];
    if (fs.existsSync(task.cacheFile)) {
      try {
        const raw = fs.readFileSync(task.cacheFile, 'utf8');
        const parsed = JSON.parse(raw);
        list = parsed.list || [];
      } catch {
        // 文件损坏则重抓
      }
    }

    if (list.length === 0) {
      const url = `${MODU_API}?ac=detail&t=${task.tid}&pg=${task.page}`;
      const data = await fetchWithRetry(url);
      list = data.list || [];
      fs.writeFileSync(task.cacheFile, JSON.stringify({
        tid: task.tid,
        page: task.page,
        channelId: task.channelId,
        categoryTag: task.categoryTag,
        list
      }), 'utf8');
      fetchedCount++;
      // 轻微休眠防上游拥塞
      await new Promise(r => setTimeout(r, 60));
    }

    doneCount++;
    totalDramas += list.length;
    if (doneCount % 20 === 0 || doneCount === allPageTasks.length) {
      const progress = ((doneCount / allPageTasks.length) * 100).toFixed(1);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[${progress}%] 已完成 ${doneCount}/${allPageTasks.length} 页 | 累计提取作品: ${totalDramas} 部 | 耗时: ${elapsed}s`);
    }
  });

  const totalCost = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n=== 抓取完成！===`);
  console.log(`总耗时: ${totalCost} 秒`);
  console.log(`本地缓存总页数: ${allPageTasks.length} 页`);
  console.log(`全品类总作品条目: ${totalDramas} 部`);
}

main().catch(console.error);
