// 生产内容采集与入库构建脚本
const MODU_API = 'https://caiji.moduapi.cc/api.php/provide/vod';

// CJK 字符判断
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
function isCjkChar(char) {
  return CJK_RUN.test(char);
}

function normalized(value) {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function gramsOfRun(run) {
  const grams = [];
  for (const char of run) grams.push(char);
  const characters = [...run];
  for (let index = 0; index + 1 < characters.length; index += 1) grams.push(characters[index] + characters[index + 1]);
  if (characters.length > 1) grams.push(run);
  return grams;
}

export function indexTokens(value) {
  const source = normalized(value);
  if (source === '') return [];
  const tokens = [];
  let cjkRun = '';
  let latinRun = '';

  const flushCjk = () => {
    if (cjkRun !== '') {
      tokens.push(...gramsOfRun(cjkRun));
      cjkRun = '';
    }
  };
  const flushLatin = () => {
    if (latinRun !== '') {
      tokens.push(latinRun);
      latinRun = '';
    }
  };

  for (const char of source) {
    if (isCjkChar(char)) {
      flushLatin();
      cjkRun += char;
      continue;
    }
    flushCjk();
    if (char === ' ') {
      flushLatin();
      continue;
    }
    latinRun += char;
  }
  flushCjk();
  flushLatin();

  return [...new Set(tokens)];
}

export function indexTokenColumn(value) {
  return indexTokens(value).join(' ');
}

function cleanSynopsis(raw) {
  if (!raw) return '暂无简介';
  return raw.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

function classifyDrama(title, desc) {
  const text = `${title} ${desc}`;
  if (/神医|千亿|总裁|首富|亿万|豪门|逆袭|继承|暴富|打脸|首富/i.test(text)) return '逆袭';
  if (/战神|修罗|龙王|至尊|兵王|镇天|无双|狂龙|天下|盖世/i.test(text)) return '战神';
  if (/娇妻|甜宠|夫人|闪婚|替嫁|心动|虐恋|独宠|青梅|初恋/i.test(text)) return '甜宠';
  if (/王妃|驸马|皇|侯门|古代|穿书|重回|大唐|大明|公主|逍遥|前夫|和离/i.test(text)) return '古装';
  if (/天师|通灵|诡|悬案|惊魂|猎罪|破案|迷局|镇命|玄术/i.test(text)) return '悬疑';
  return '都市';
}

function classifyAnime(title, desc, index) {
  const text = `${title} ${desc}`;
  if (/玄幻|修仙|斗罗|仙尊|九天|天道|神级/i.test(text)) return '玄幻';
  if (/机甲|星际|未来|科技|觉醒|机械/i.test(text)) return '科幻';
  if (/治愈|日常|搞笑|萌|欢乐|轻松/i.test(text)) return '治愈';
  if (/冒险|猎人|旅行|征途|海贼|探索/i.test(text)) return '冒险';
  return '热血';
}

function classifyDoc(title, desc, index) {
  const text = `${title} ${desc}`;
  if (/地球|自然|海洋|动物|生态|森林|荒野/i.test(text)) return '自然';
  if (/历史|古国|文明|王朝|考古|遗迹|封建/i.test(text)) return '历史';
  if (/科技|宇宙|量子|人工智能|能源|探索|未来/i.test(text)) return '科技';
  if (/美食|味道|食堂|烟火|舌尖|小吃|厨/i.test(text)) return '美食';
  return '探索';
}

async function fetchPage(tid, page = 1) {
  const url = `${MODU_API}?ac=detail&t=${tid}&pg=${page}`;
  const res = await fetch(url);
  const data = await res.json();
  return data.list || [];
}

export async function collectAllContent() {
  console.log('1. 开始抓取短剧...');
  const dramaRaw = [
    ...(await fetchPage(38, 1)),
    ...(await fetchPage(38, 2)),
    ...(await fetchPage(38, 3))
  ];
  console.log(`获取短剧原始数据: ${dramaRaw.length} 条`);

  console.log('2. 开始抓取院线电影 (动作/喜剧/科幻/悬疑/爱情)...');
  const movieRaw = [
    ...(await fetchPage(10, 1)).slice(0, 6).map(x => ({ ...x, _cat: '动作' })),
    ...(await fetchPage(11, 1)).slice(0, 6).map(x => ({ ...x, _cat: '喜剧' })),
    ...(await fetchPage(13, 1)).slice(0, 6).map(x => ({ ...x, _cat: '科幻' })),
    ...(await fetchPage(21, 1)).slice(0, 6).map(x => ({ ...x, _cat: '悬疑' })),
    ...(await fetchPage(12, 1)).slice(0, 6).map(x => ({ ...x, _cat: '爱情' }))
  ];
  console.log(`获取电影数据: ${movieRaw.length} 条`);

  console.log('3. 开始抓取动漫 (国产/日韩/AI漫剧)...');
  const animeRaw = [
    ...(await fetchPage(1, 1)).slice(0, 10),
    ...(await fetchPage(2, 1)).slice(0, 10),
    ...(await fetchPage(42, 1)).slice(0, 6)
  ];
  console.log(`获取动漫数据: ${animeRaw.length} 条`);

  console.log('4. 开始抓取纪录片...');
  const docRaw = (await fetchPage(24, 1)).slice(0, 25);
  console.log(`获取纪录片数据: ${docRaw.length} 条`);

  return { dramaRaw, movieRaw, animeRaw, docRaw };
}
