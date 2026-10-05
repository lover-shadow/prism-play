/**
 * 选集面板的纯判据（R26-05 / AC-21）。
 *
 * 将"集号怎么显示""面板开在哪一侧""超过多少集要分段"这三件事从 DOM 里拔出来：
 * 它们都是可以在 Node 侧逐值钉死的判定，留在抽屉组件里只会让那个文件同时长出第二套口径
 * （历史上就是按钮把 `第 N 集 · 标题 · 90 分钟` 拼在一起，宽度撑破网格、真机上溢出成两行）。
 *
 * 一条文案铁律：**按钮上只允许出现集号**。真实集名进 `aria-label`（读屏与焦点播报仍拿得到），
 * 因为视觉栅格是给拇指点的 44px 方块，不是给标题用的；时长与"第 N 集"重复字样一律不上按钮。
 */

import type { EpisodeItem } from '../../edge/src/types/api';

/** 分段容量：与 §1.5.1 的操作岛栅格对齐，一段最多 30 集（6×5 一眼扫完，不必纵向滚动）。 */
export const EPISODE_SEGMENT_SIZE = 30;

/** 面板三态：inline=非全屏（视频下方的正文流）、sheet=全屏竖屏（底部限高）、side=全屏横屏（右侧让位）。 */
export type SheetMode = 'inline' | 'sheet' | 'side';

/** 只有全屏才允许浮动态；非全屏永远走正文流——这正是"不盖视频"的判据本身。 */
export function episodeSheetMode(input: { fullscreen: boolean; viewportWidth: number; viewportHeight: number }): SheetMode {
  if (!input.fullscreen) return 'inline';
  return input.viewportWidth > input.viewportHeight ? 'side' : 'sheet';
}

/** 分段页码：越界一律收敛到合法区间，末段不满 30 集也算一段。 */
export function segmentPage(total: number, index: number): number {
  if (total <= EPISODE_SEGMENT_SIZE) return 0;
  const page = Math.floor(Math.max(0, index) / EPISODE_SEGMENT_SIZE);
  return Math.min(page, Math.ceil(total / EPISODE_SEGMENT_SIZE) - 1);
}

/** 某一段覆盖的集号区间（1 起、闭区间）。 */
export function segmentRange(total: number, page: number): { from: number; to: number } {
  const at = Math.max(0, Math.min(page, Math.ceil(Math.max(total, 1) / EPISODE_SEGMENT_SIZE) - 1));
  const from = at * EPISODE_SEGMENT_SIZE + 1;
  return { from, to: Math.min(Math.max(total, from), from + EPISODE_SEGMENT_SIZE - 1) };
}

export function segmentLabel(from: number, to: number): string {
  return from === to ? `${from}` : `${from}–${to}`;
}

/** 徽章只放数字：两位数栅格，破百集才占三位，读屏不受影响。 */
export function episodeBadge(episodeNumber: number, total: number): string {
  const width = total > 99 ? 3 : 2;
  return String(Math.max(0, Math.trunc(episodeNumber))).padStart(width, '0');
}

/** 真实集名走无障碍名，不挤占视觉宽度（缺集名时只报集号，不编造副标题）。 */
export function episodeAriaLabel(episode: EpisodeItem): string {
  const title = episode.title === undefined || episode.title === '' ? '' : ` ${episode.title}`;
  return `播放第 ${episode.episodeNumber} 集${title}`;
}
