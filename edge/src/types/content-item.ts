/**
 * `ContentItem` 从 `api.ts` 拆出，原因与 `manifest.ts` 完全相同：§10 的 300 行单文件红线。
 * `api.ts` 原样重导出，`../types/api` 的公共导入面不变——这里只是**落点搬迁**，不是第二套契约。
 *
 * 字段集与 `docs/03-contracts/openapi.yaml` 的 `ContentItem` 一一对应；
 * 文本边界（240 / 6×12 / 64 / 年份区间）与清洗规则的**唯一实现口径**在
 * `edge/src/library/metadata-policy.mjs`，本文件只声明形状，不复制数字。
 */
import type { ChannelId } from './api';

export interface ContentItem {
  /** 稳定 content_id（即分享短链中的 drama_id）。 */
  id: string;
  channelId: ChannelId;
  title: string;
  /** 主分类/筛选口径。部分由 type_id 与片名推断，不得被当作原料多题材的证明（HP-12）。 */
  category: string;
  isPrivate: boolean;
  coverUrl?: string;
  coverVersion?: string;
  /** 清洗后的真实列表摘要，最多 SYNOPSIS_MAX_CODE_POINTS 个 Unicode 码点；无摘要时省略字段。 */
  synopsis?: string;
  episodeCount?: number;
  enabled?: boolean;
  shareable?: boolean;
  /** AI 短剧/漫剧形式标记（CLOUD-SYNC-JIT-PIPELINE-SPEC §3.3）；缺省即 0。 */
  isAi?: boolean;
  /** 全网热门标记：HotScore 排名前 15%（SPEC §3.2）；缺省即 0。 */
  isHot?: boolean;
  /** 榜单本地排序键（SPEC-CLOUD-REFACTOR v2 §3.1）：仅目录分片携带，供端侧新剧榜/热播榜排序。 */
  firstPublishedAt?: number;
  hitsTotal?: number;
  /**
   * HP-12 展示副标签：只来自 metadata-policy 的受控题材/风格词表，最多 TAGS_MAX_ITEMS 项、
   * 每项 TAG_MIN–TAG_MAX 码点。搜索词、片名与制作类型都不得升格到这里；
   * 无可信供给时整个省略（不是空数组），界面按缺字段压缩信息块。
   */
  tags?: string[];
  /** HP-11 来源明确的四位年份（RELEASE_YEAR_MIN–RELEASE_YEAR_MAX）；严禁用上架/采集/发布时间冒充。 */
  releaseYear?: number;
  /** HP-11 来源明确的地区，多值原样清洗保留，最多 SOURCE_TEXT_MAX_CODE_POINTS 码点。 */
  region?: string;
  /** HP-11 来源明确的语言，多值原样清洗保留，最多 SOURCE_TEXT_MAX_CODE_POINTS 码点。 */
  language?: string;
}
