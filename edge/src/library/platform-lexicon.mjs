/**
 * 上游站源品牌词表 —— **只允许打包/发布侧引用，禁止被 `src/**` 导入**。
 *
 * 为什么单独一个文件：`metadata-policy.mjs` 同时被端侧解析器（`src/core/api/title-detail.ts`、
 * `src/core/catalog-bundle-loader.ts`）引用，会随 APK 一起打包；把站源名写进那里等于把上游品牌
 * 打进交付物（AGENTS.md 二·1 彻底去平台化）。这里只被 `edge/scripts/**` 一类内部消费方引用，
 * 职责是「在脏文本进入公开资产之前物理剥掉 + 发布前拒发」，而不是指望端侧再判断。
 *
 * 词表来源：`edge/scripts/config-sources.mjs` 已配置来源的域名主机词（去协议、去子域、去 TLD），
 * 加实测混进 `vod_blurb/vod_content` 的中文品牌写法。新增来源时必须同步这里。
 */

/** @type {readonly string[]} */
export const PLATFORM_WORDS = Object.freeze(['douban', '豆瓣', '魔都', 'modu']);

const escapeRegExp = (/** @type {string} */ word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const joined = () => PLATFORM_WORDS.map(escapeRegExp).join('|');

/** 替换用正则（带 `g`）；`stripPlatformNames` 负责随后的空白折叠。 */
export const platformNamePattern = () => new RegExp(joined(), 'gi');

/**
 * 判定用正则：不能带 `g` —— `RegExp.prototype.test` 配 `g` 会在多次调用之间漂移 `lastIndex`，
 * 于是"第二次同样的文本"会被判成干净，正是发布门禁最不该有的抖法。
 */
export const containsPlatformName = (/** @type {unknown} */ text) =>
  typeof text === 'string' && new RegExp(joined(), 'i').test(text);

/** 物理删除品牌词，不替换同义词、不补解释文案。 */
export function stripPlatformNames(/** @type {string} */ text) {
  if (typeof text !== 'string' || text === '') return text;
  return text.replace(platformNamePattern(), ' ').replace(/\s{2,}/g, ' ').trim();
}
