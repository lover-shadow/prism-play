/**
 * HP-11 / HP-12 元数据文本边界单测（HOME-PLAYER-REPAIR-SPEC-AND-PLAN §3.3、§5.1）。
 * 单一策略源 `edge/src/library/metadata-policy.mjs` 的口径钉在这里；
 * 任何模块想再写一份 240/6/12/64，都会被本文件的对账断言指为第二口径。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SYNOPSIS_MAX_CODE_POINTS, TAGS_MAX_ITEMS, TAG_MAX_CODE_POINTS, SOURCE_TEXT_MAX_CODE_POINTS,
  RELEASE_YEAR_MIN, RELEASE_YEAR_MAX, PUBLIC_METADATA_FIELDS, CATALOG_DIRECTORY_MAX_BYTES,
  cleanPlainText, normalizeSynopsis, normalizeReleaseYear, normalizeSourceText,
  normalizeDisplayTags, publicWorkMetadata, assertMetadataBounds
} from '../../edge/src/library/metadata-policy.mjs';
import { containsPlatformName, platformNamePattern, stripPlatformNames } from '../../edge/src/library/platform-lexicon.mjs';

test('HP-11 boundary constants are single-valued and match the OpenAPI ContentItem', () => {
  assert.equal(SYNOPSIS_MAX_CODE_POINTS, 240);
  assert.equal(TAGS_MAX_ITEMS, 6);
  assert.equal(TAG_MAX_CODE_POINTS, 12);
  assert.equal(SOURCE_TEXT_MAX_CODE_POINTS, 64);
  assert.deepEqual([...PUBLIC_METADATA_FIELDS], ['synopsis', 'tags', 'releaseYear', 'region', 'language']);
  assert.equal(CATALOG_DIRECTORY_MAX_BYTES, 20 * 1024 * 1024);
  assert.ok(RELEASE_YEAR_MIN < RELEASE_YEAR_MAX);
});

test('HP-11 long synopsis keeps real prose past the old 30-character wall and stays safe', () => {
  const long = '深夜的码头下着雨。'.repeat(40);
  const raw = `<p> ${long} </p> 详见 http://site.douban.com/12345 以及 www.example.com/PV第101集 &amp; 完`;
  const value = normalizeSynopsis(raw);
  assert.ok(value !== undefined);
  assert.ok([...value].length <= SYNOPSIS_MAX_CODE_POINTS);
  assert.ok([...value].length > 30, '30 字硬截断必须已被 240 码点边界取代');
  assert.doesNotMatch(value, /<|>|&amp|http|www\./);
  assert.equal(value, [...long].slice(0, SYNOPSIS_MAX_CODE_POINTS).join(''));
});

test('HP-11 astral-plane prose is counted in code points, not UTF-16 units', () => {
  const value = normalizeSynopsis('𠀀'.repeat(300));
  assert.equal([...value].length, SYNOPSIS_MAX_CODE_POINTS);
  assert.equal(value.length, SYNOPSIS_MAX_CODE_POINTS * 2, 'UTF-16 长度是码点的两倍，证明截断按码点而非代理对计数');
});

test('HP-11 absent or placeholder-only source omits the field instead of inventing copy', () => {
  for (const raw of [undefined, null, '', '   ', '<p></p>', '&nbsp;', '暂无简介', '暂无简介。']) {
    const metadata = publicWorkMetadata('movie', { vod_blurb: raw });
    assert.equal('synopsis' in metadata, false, `占位与空值不得长出 synopsis：${String(raw)}`);
  }
});

test('HP-11 only explicit four-digit years survive; release dates are never a year', () => {
  assert.equal(normalizeReleaseYear('2024'), 2024);
  assert.equal(normalizeReleaseYear(' 1998 '), 1998);
  for (const dirty of ['2026–', '0', '内详', '202', '20260', '20,24', '19.98', '', null, undefined, '２０２４']) {
    assert.equal(normalizeReleaseYear(dirty), undefined, `脏年份必须被拒：${String(dirty)}`);
  }
  assert.equal(normalizeReleaseYear(2024), 2024);
});

test('HP-11 region and language keep multi-value truth and omit instead of half-truncating', () => {
  assert.equal(normalizeSourceText('美国,英国'), '美国,英国');
  assert.equal(normalizeSourceText(' 中国大陆 '), '中国大陆');
  assert.equal(normalizeSourceText(`国,${'X'.repeat(SOURCE_TEXT_MAX_CODE_POINTS)}`), undefined);
  assert.equal(normalizeSourceText('<b>法国</b> http://x.fr/a'), '法国');
  const metadata = publicWorkMetadata('movie', { vod_area: '英国,爱尔兰', vod_lang: '英语,威尔士语' });
  assert.equal(metadata.region, '英国,爱尔兰');
  assert.equal(metadata.language, '英语,威尔士语');
});

test('HP-12 display tags accept only the controlled genre vocabulary', () => {
  const raw = '剧情, 喜剧,TomHiddleston,本片,）,…,&amp;,http://movie.example/x,动作，动作, 奇幻 ';
  assert.deepEqual(normalizeDisplayTags('movie', raw), ['剧情', '喜剧', '动作', '奇幻']);
  assert.deepEqual(normalizeDisplayTags('anime', '动画,纪录片,短片,电影,故事,影片'), [],
    '制作类型/载体词不得冒充多题材证据');
  assert.deepEqual(normalizeDisplayTags('documentary', '自然,美食,社会'), ['自然', '美食', '社会']);
});

test('HP-12 zero supply yields zero tags and more than six accepted words is capped', () => {
  assert.deepEqual(normalizeDisplayTags('drama', undefined), []);
  assert.deepEqual(normalizeDisplayTags('drama', ''), []);
  assert.equal('tags' in publicWorkMetadata('drama', { vod_tag: '' }), false,
    'drama 实测 vod_tag 覆盖为 0，字段必须整个省略');
  const many = ['剧情', '喜剧', '爱情', '动作', '科幻', '悬疑', '恐怖', '惊悚'].join(',');
  assert.equal(normalizeDisplayTags('movie', many).length, TAGS_MAX_ITEMS);
});

test('HP-12 public metadata omits every unsupplied field and keeps only bound-checked keys', () => {
  const metadata = publicWorkMetadata('movie', {
    vod_blurb: '一部关于时间的电影。', vod_year: '2026–', vod_area: '', vod_lang: '普通话', vod_tag: '演员张三,科幻'
  });
  assert.deepEqual(metadata, { synopsis: '一部关于时间的电影。', language: '普通话', tags: ['科幻'] });
  for (const key of Object.keys(metadata)) assert.ok(PUBLIC_METADATA_FIELDS.includes(key));
});

test('HP-11 packaging gate rejects out-of-bound metadata before any artifact is written', () => {
  assert.equal(assertMetadataBounds({ synopsis: 'a'.repeat(SYNOPSIS_MAX_CODE_POINTS), tags: ['剧情'],
    releaseYear: 2024, region: '中国大陆', language: '普通话' }, 'in-bound'), true);
  const rejected = [
    { synopsis: 'a'.repeat(SYNOPSIS_MAX_CODE_POINTS + 1) },
    { synopsis: '<b>带标签</b>' },
    { synopsis: '见 http://upstream.example/a' },
    { tags: Array.from({ length: TAGS_MAX_ITEMS + 1 }, (_, i) => `题材${i}`) },
    { tags: ['x'.repeat(TAG_MAX_CODE_POINTS + 1)] },
    { tags: ['剧情', '剧情'] },
    { tags: ['', '动作'] },
    { tags: [] },
    { releaseYear: 20240 },
    { releaseYear: '2024' },
    { region: 'x'.repeat(SOURCE_TEXT_MAX_CODE_POINTS + 1) },
    { language: '<i>普通话</i>' }
  ];
  for (const item of rejected) {
    assert.throws(() => assertMetadataBounds(item, 'out-of-bound'), /公开元数据判据失败/, JSON.stringify(item));
  }
});

test('HP-11 cleanPlainText drops HTML, entities, URLs and control characters', () => {
  assert.equal(cleanPlainText('<div>正片&nbsp;上线\u0007了</div> http://a.b/c www.a.b/d'), '正片 上线 了');
  assert.equal(cleanPlainText(null), '');
});

/* 真实 harvest 实测（t_13_p_20/vod_id 25373、t_15_p_266/vod_id 35239、t_15_p_274/vod_id 30652）：
   上游把站源品牌以「非 http 协议 + 写残的 host」和中文词两种形态混进简介，
   旧的 `\S*` 贪婪匹配还会把紧贴 URL 的中文正文一起吞掉。三条都必须被策略源钉住。 */
/* 站源品牌词表**只在打包/边缘侧注入**（`platform-lexicon.mjs` 文件头解释为何不能进策略源）：
   端侧读取路径不传该参数，所以品牌必须在进入公开资产前就被剥掉，而不是靠 App 再判断一次。 */
test('HP-11 upstream platform names are physically removed, not just the http scheme', () => {
  const obfuscated = normalizeSynopsis('《哈利·波特与死亡圣器》小站 mac://site.douban./108361/ 邓不利多死后，伏地魔入侵魔法学校', stripPlatformNames);
  assert.ok(obfuscated !== undefined);
  assert.doesNotMatch(obfuscated, /douban|site\.|:\/\//i);
  assert.ok(obfuscated.startsWith('《哈利·波特与死亡圣器》小站'));
  assert.ok(obfuscated.includes('邓不利多死后'));

  const chineseBrand = normalizeSynopsis('https://site.douban.com/106682/ 西风烈豆瓣小站张宁是一名香港黑拳手', stripPlatformNames);
  assert.doesNotMatch(chineseBrand, /豆瓣|douban/);
  assert.ok(chineseBrand.includes('西风烈'));
  assert.ok(chineseBrand.includes('张宁是一名香港黑拳手'));

  const bareHost = normalizeSynopsis('本片见 site.douban.com/107923/ 春秋时期晋灵公不喜权臣', stripPlatformNames);
  assert.doesNotMatch(bareHost, /douban|site\./i);
  assert.ok(bareHost.includes('春秋时期晋灵公不喜权臣'));

  // 词表只删品牌，绝不顺手删真正文；地区/语言同一条注入路径。
  assert.equal(normalizeSourceText('中国大陆', stripPlatformNames), '中国大陆');
  assert.equal(normalizeSynopsis('豆瓣评分其实不在这里给', stripPlatformNames), '评分其实不在这里给');
});

test('HP-11 URL stripping stops at CJK and does not swallow the synopsis behind it', () => {
  const glued = normalizeSynopsis('赛德克·巴莱(上)太阳旗http://movie.douban.com/subject/10450409/赛德克·巴莱(下)彩虹桥', stripPlatformNames);
  assert.doesNotMatch(glued, /http|douban|subject/i);
  assert.ok(glued.includes('赛德克·巴莱(下)彩虹桥'), '紧贴 URL 的中文正文必须留下，清洗不能变成删内容');
});

test('HP-11 packaging gate rejects any residual platform name', () => {
  const brandResidue = (text) => new RegExp(platformNamePattern().source, 'i').test(text);
  assert.equal(containsPlatformName('某片 豆瓣小站推荐'), true);
  for (const item of [
    { synopsis: '某片 豆瓣小站推荐' },
    { synopsis: 'see Site.Douban.For Details' },
    { region: '豆瓣' },
    { language: 'mac://site.douban./1' }
  ]) {
    assert.throws(() => assertMetadataBounds(item, 'brand', brandResidue), /公开元数据判据失败/, JSON.stringify(item));
  }
  // 缺省不注入词表时，形态判据仍然拦得住 URL/HTML —— 端侧读取路径就是这条。
  assert.throws(() => assertMetadataBounds({ synopsis: 'x http://a.b/c 正文' }, 'shape-only'), /公开元数据判据失败/);
  assert.equal(assertMetadataBounds({ synopsis: '正常简介' }, 'shape-ok', brandResidue), true);
});
