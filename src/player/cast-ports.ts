/**
 * 投屏会话的端口与选集编排（SPEC §1.5.1 连播段，AC-24）。
 *
 * 这个文件存在的唯一理由是"把可变的外界留在状态机之外"：
 *   • `CastStreamSource` 是**取流句柄**的端口。生产实现走 edge 的 `/api/episodes/{id}/playback`，
 *     测试实现是一只查表闭包。状态机因此永远不需要知道 edge、鉴权、签名句柄的存在。
 *   • `TimerPort` 是**时间**的端口。jsdom 里等不到 3.2 秒的真实时间，注入后连播时序可以被确定性断言——
 *     "提前掐片尾"这种缺陷只有把时钟变成可控量才测得出来。
 *   • 选集顺序与集数文案在这里是**纯函数**：投屏面板与状态机共用同一份"下一集是谁"的口径，
 *     不各算各的（同一状态两个权威，正是本项目全屏缺陷复发过的根因）。
 */
import type { EpisodeItem } from '../../edge/src/types/api';
import type { CastClient, CastDevice } from '../core/native/cast';
import { PrismApiClient } from '../core/api/client';
import { SHARE_ORIGIN } from '../core/share';

/**
 * 投屏状态机的全部合法态。放在端口层而不是状态机文件里，是因为视图层与文案层都要按它分支，
 * 而那两个文件都不该反过来依赖状态机的实现（`cast-panel.ts` 已经贴着 300 行红线）。
 */
export type CastPhase =
  | 'idle' | 'unsupported' | 'scanning' | 'ready' | 'empty' | 'error' | 'connecting' | 'casting' | 'paused';

/** 分集流地址的唯一来源：`api.playback()` 的原样返回。本包不拼地址、不改协议、不猜主机。 */
export type CastStreamSource = (episodeId: number) => Promise<{
  url: string;
  mimeType?: string;
  durationSeconds?: number;
}>;

export interface TimerPort {
  set(callback: () => void, ms: number): number;
  clear(handle: number): void;
}

/** 宁可让大屏多停在最后一帧，也绝不因为时长口径偏差而掐掉片尾。 */
export const AUTO_CONTINUE_GRACE_MS = 8_000;

const WALL_CLOCK: TimerPort = {
  set: (callback, ms) => globalThis.setTimeout(callback, ms) as unknown as number,
  clear: (handle) => globalThis.clearTimeout(handle)
};

export function wallClock(): TimerPort {
  return WALL_CLOCK;
}

/**
 * 生产缺省流源：与主应用同一个 edge、同一个播放句柄接口。
 * 为什么另起一个客户端、而不是复用 `main.ts` 那只：投屏要的是**大屏能直连的新签名句柄**，不是手机上
 * 那只已经跑到一半的（句柄两小时过期，连播时旧的可能正在半路上）。它不读任何私密凭据——私密内容在
 * 投屏面板第一行就被挡掉了，所以这条路上没有私密会话可泄露。
 */
export function defaultCastStreamSource(): CastStreamSource {
  const api = new PrismApiClient({ baseUrl: SHARE_ORIGIN });
  return async (episodeId: number) => {
    const info = await api.playback(episodeId);
    return { url: info.url, mimeType: info.mimeType, durationSeconds: info.durationSeconds };
  };
}

/** 按集数排序后的下一集；末集返回 null，状态机据此收掉连播定时器而不是空转。 */
export function nextEpisodeId(episodes: EpisodeItem[], currentEpisodeId: number): number | null {
  const ordered = orderedByNumber(episodes);
  const index = ordered.findIndex((item) => item.episodeId === currentEpisodeId);
  return index < 0 || index + 1 >= ordered.length ? null : ordered[index + 1].episodeId;
}

export function episodeNumber(episodes: EpisodeItem[], episodeId: number): number {
  return episodes.find((item) => item.episodeId === episodeId)?.episodeNumber ?? 1;
}

/** 投给大屏的标题：渲染器只显示这一行，所以剧名与集数缺一不可，与分享文案同一口径。 */
export function episodeLabel(episodes: EpisodeItem[], title: string, episodeId: number): string {
  return `${title} 第${episodeNumber(episodes, episodeId)}集`;
}

/**
 * 连播等待：已知时长才计时。时长缺失时返回 0，调用方据此**不武装**定时器——
 * 没有依据的"自动连播"等于赌博，赌输了就是在大屏正播到一半时把下一集压上去。
 */
export function autoContinueDelayMs(durationSeconds: number | undefined): number {
  if (durationSeconds === undefined || !(durationSeconds > 0)) return 0;
  return Math.round(durationSeconds * 1_000) + AUTO_CONTINUE_GRACE_MS;
}

function orderedByNumber(episodes: EpisodeItem[]): EpisodeItem[] {
  return [...episodes].sort((a, b) => a.episodeNumber - b.episodeNumber);
}

/**
 * 投屏面板的注入面。与 `CastPhase` 同住在端口层：状态机文件本身贴着 §10 的 300 行红线，
 * 契约留在实现文件里只会让它为了腾行数而牺牲说明注释——而那些注释正是这些约束的出处。
 */
export interface CastPanelDeps {
  root: HTMLElement;
  episodes: EpisodeItem[];
  titleOf: () => string;
  currentEpisodeId: () => number;
  /** 私密判定沿用 `isPrivateSubject` 的口径，由详情台传入；本模块不再另立一套私密规则。 */
  isPrivate: () => boolean;
  /** 状态外抛：操作岛的【投屏】键要跟着"正在投屏"亮起，另起一份状态权威才是老缺陷的根。 */
  onPhase?: (phase: CastPhase, active: CastDevice | null) => void;
  stream?: CastStreamSource;
  client?: CastClient;
  timers?: TimerPort;
}

export interface CastPanel {
  /** 呼吸状态条插在操作岛之后、面板挂在详情台末尾：二者都是浮层子节点，随播放器一起拆装。 */
  attach(anchor: HTMLElement): void;
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
  phase(): CastPhase;
  activeDevice(): CastDevice | null;
  /** 手机上手动切集时把大屏跟到同一集；未在投屏时是空操作。 */
  syncNow(): Promise<void>;
  /** 自动连播触发点：由持有 `ended` 事件的一方在播完时调用；未接线时本状态机按定时自行推进。 */
  handleEpisodeEnded(): Promise<void>;
  destroy(): void;
}
