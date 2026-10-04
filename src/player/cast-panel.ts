/**
 * 局域网大屏投屏的状态机（SPEC §1.5.1 与 §1.5.2，AC-24）。
 * 分工：DOM 在 `cast-view.ts`，状态→文案的映射在 `cast-present.ts`，连播计时在 `cast-relay.ts`，
 * 外界端口在 `cast-ports.ts`，原生桥在 `src/core/native/cast.ts`。本文件只持有状态与跃迁规则，
 * 且是**唯一**一处投屏状态权威——操作岛上的键态由 `onPhase` 外抛得到；另起一份状态就是全屏缺陷复发过的老路。
 *
 * 两条在本文件里是结构性约束、不是口头约定：
 *   1. 私密内容进不到这里：`isPrivate()` 命中即不发起组播扫描、不发任何控制报文。把"个人探索"推到
 *      客厅大屏，等于把用户的私密观看暴露给同网段的任何设备，这种暴露不能靠一行提示文案来兜。
 *   2. 推给大屏的永远是**公网 https 流**：A-7.5 之后优先是当前剧集清单里的直连上游地址，清单缺席才退回
 *      云端代理句柄（`cast-ports.ts` 的两个流源）。两条都不得是局域网地址、明文或内嵌凭据——这一条由
 *      `requireCastableStreamUrl` 与原生 `LanAddressPolicy` 各校一遍，口径一致。
 *
 * NOTHING HERE HAS EVER RUN AGAINST A REAL RENDERER：jsdom 没有 UDP，也没有电视。
 */
import { createCastClient, type CastDevice } from '../core/native/cast';
import { createCastView, type CastView } from './cast-view';
import { bannerTextFor, errorTextFor, PRIVATE_REFUSAL, scanOutcome, statusTextFor } from './cast-present';
import { createCastRelay } from './cast-relay';
import {
  defaultCastStreamSource,
  episodeLabel,
  episodeNumber,
  nextEpisodeId,
  wallClock,
  type CastPanel,
  type CastPanelDeps,
  type CastPhase
} from './cast-ports';
import './cast.css';

export function createCastPanel(deps: CastPanelDeps): CastPanel {
  const client = deps.client ?? createCastClient();
  const stream = deps.stream ?? defaultCastStreamSource();
  const timers = deps.timers ?? wallClock();
  const view: CastView = createCastView(deps.root.ownerDocument, {
    onClose: close,
    onRescan: () => void scan(),
    onPause: () => void togglePause(),
    onExit: () => void leave(),
    onPick: (device) => void castTo(device)
  });

  let phase: CastPhase = 'idle';
  let visible = false;
  let devices: CastDevice[] = [];
  let active: CastDevice | null = null;
  let message = '';
  let destroyed = false;
  const relay = createCastRelay({
    timers,
    episodes: () => deps.episodes,
    currentEpisodeId: deps.currentEpisodeId,
    hasTarget: () => active !== null,
    onDue: () => void handleEpisodeEnded()
  });

  function render(): void {
    if (destroyed) return;
    view.render({
      visible,
      phase,
      status: statusTextFor({ phase, message, deviceCount: devices.length, activeName: active?.name ?? null }),
      devices,
      activeId: active?.id ?? null,
      bannerVisible: active !== null,
      // "支持自动无缝连播"只在定时器真的武装了的时候出现：界面不许承诺机器没做到的事。
      bannerText: bannerTextFor({ activeName: active?.name ?? null, relayArmed: relay.armed() }),
      paused: phase === 'paused',
      rescanDisabled: !client.supported || phase === 'scanning' || phase === 'connecting'
    });
    deps.onPhase?.(phase, active);
  }

  async function scan(): Promise<void> {
    if (deps.isPrivate()) {
      visible = true;
      phase = 'error';
      message = PRIVATE_REFUSAL;
      render();
      return;
    }
    if (!client.supported) {
      visible = true;
      phase = 'unsupported';
      message = '';
      render();
      return;
    }
    visible = true;
    phase = 'scanning';
    message = '';
    devices = [];
    render();
    try {
      const report = await client.discover();
      if (destroyed || phase !== 'scanning') return;
      devices = report.devices;
      const outcome = scanOutcome(report);
      phase = outcome.phase;
      message = outcome.message;
    } catch (error) {
      if (destroyed) return;
      phase = 'error';
      message = errorTextFor(error, '设备扫描失败，请重新扫描');
    }
    render();
  }

  /** 把某一集推给当前设备并重新武装连播；成功返回 true，失败已把原因落进状态里。 */
  async function push(episodeId: number): Promise<boolean> {
    const device = active;
    if (device === null) return false;
    try {
      const media = await stream(episodeId);
      if (destroyed || active !== device || deps.isPrivate()) return false;
      await client.cast(device, {
        url: media.url,
        title: episodeLabel(deps.episodes, deps.titleOf(), episodeId),
        mimeType: media.mimeType
      });
      if (destroyed || active !== device) { await client.control(device, 'stop').catch(() => undefined); return false; }
      // Duration is not renderer playback state. Never infer an ended event from wall time.
      return true;
    } catch (error) {
      phase = 'error';
      message = errorTextFor(error, `${device.name} 拒绝了本次投屏`);
      return false;
    }
  }

  async function castTo(device: CastDevice): Promise<void> {
    if (deps.isPrivate()) {
      phase = 'error';
      message = PRIVATE_REFUSAL;
      render();
      return;
    }
    active = device;
    phase = 'connecting';
    message = `正在连接 ${device.name}…`;
    render();
    if (await push(deps.currentEpisodeId())) {
      if (destroyed) return;
      phase = 'casting';
      message = '';
      visible = false;
    } else {
      active = null;
      relay.cancel();
    }
    render();
  }

  async function togglePause(): Promise<void> {
    const device = active;
    if (device === null) return;
    const next: 'play' | 'pause' = phase === 'paused' ? 'play' : 'pause';
    try {
      await client.control(device, next);
      if (destroyed) return;
      if (next === 'pause') {
        relay.cancel();
        phase = 'paused';
      } else {
        // 恢复后按整集时长重新计时：暂停掉的这段时间不该被算进"本集已播完"。
        phase = 'casting';
        // Receiver transport/position reporting is unavailable: no timer-based auto-advance.
      }
      message = '';
    } catch (error) {
      phase = 'error';
      message = errorTextFor(error, '大屏没有响应该指令');
      visible = true;
    }
    render();
  }

  async function leave(): Promise<void> {
    const device = active;
    relay.cancel();
    active = null;
    phase = 'idle';
    message = '';
    visible = false;
    render();
    if (device !== null) {
      // 退出投屏必须让大屏真的停下：只收掉手机上的状态条，等于把用户的电视留在下一集继续放。
      try {
        await client.control(device, 'stop');
      } catch {
        /* 设备已断连时无需再报：状态条已收起，用户看到的就是结果。 */
      }
    }
  }

  /**
   * 把大屏推进到某一集（手机换集跟随 = `syncNow`，本集播完连播 = `handleEpisodeEnded`）。
   * 两条路径的跃迁完全同形，分成两个函数就会有两个"connecting→casting 的失败口径"各自漂移；
   * 合一处后唯一的差别只剩标题动词，由 `verb` 传入。
   */
  async function advanceTo(episodeId: number, verb: string): Promise<void> {
    if (active === null || destroyed) return;
    relay.cancel();
    phase = 'connecting';
    message = `${verb} 第${episodeNumber(deps.episodes, episodeId)}集…`;
    render();
    if (await push(episodeId)) {
      if (destroyed) return;
      phase = 'casting';
      message = '';
    }
    render();
  }

  /** 手机侧切集：大屏必须跟上同一集，否则遥控器就成了摆设。 */
  async function syncNow(): Promise<void> {
    await advanceTo(deps.currentEpisodeId(), '正在把大屏切到');
  }

  /** 连播接缝：末集不推下一集而是优雅收场，用户对着黑屏等下一集是最差的收尾。 */
  async function handleEpisodeEnded(): Promise<void> {
    const next = nextEpisodeId(deps.episodes, deps.currentEpisodeId());
    if (next === null) {
      await leave();
      return;
    }
    await advanceTo(next, '正在推送');
  }

  function open(): void {
    visible = true;
    if (active === null && phase !== 'scanning' && phase !== 'ready') {
      void scan();
      return;
    }
    render();
  }

  function close(): void {
    const wasScanning = phase === 'scanning';
    visible = false;
    if (active === null && phase !== 'idle') phase = 'idle';
    message = '';
    render();
    // 关掉面板就把原生扫描窗口收掉：组播锁多持有一秒，用户就多付一秒的电。
    if (wasScanning) void client.stop().catch(() => undefined);
  }

  function toggle(): void {
    if (visible) close();
    else open();
  }

  function attach(anchor: HTMLElement): void {
    anchor.after(view.banner);
    (anchor.parentElement ?? deps.root).append(view.sheet);
  }

  function destroy(): void {
    destroyed = true;
    relay.cancel();
    const device = active; active = null;
    if (device !== null) void client.control(device, 'stop').catch(() => undefined);
    void client.stop().catch(() => undefined);
    view.destroy();
  }

  return {
    attach,
    open,
    close,
    toggle,
    isOpen: () => visible,
    phase: () => phase,
    activeDevice: () => active,
    syncNow,
    handleEpisodeEnded,
    destroy
  };
}
