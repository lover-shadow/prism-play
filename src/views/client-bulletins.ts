import { button, glyphInto, make } from "./history-view";
import type { AndroidRelease } from "../../edge/src/types/api";
import { checkClientBulletins, markAnnouncementRead, snoozeUpdate, type BulletinAnnouncement } from "../core/client-bulletins";
import type { PreferenceStore } from "../core/state/theme";
import { isNativeHost } from "../core/native/platform-adapters";
import type { PrismApiClient } from "../core/api/client";
import type { PrismNativeBridge } from "../core/native/bridge";
import { createNotice } from "../components/notice";

export interface BulletinModalOptions {
  root: HTMLElement;
  update?: { kind: "optional"; release: AndroidRelease } | null;
  announcement?: BulletinAnnouncement | null;
  onDownload?(url: string): void;
  onSnooze?(): void;
  onDismissAnnouncement?(): void;
  onClose?(): void;
}
export function openBulletinDialog(options: BulletinModalOptions): { close(): void } {
  const overlay = make("div", "pv-overlay"), card = make("div", "pv-dialog");
  card.setAttribute("role", "dialog"); card.setAttribute("aria-modal", "true");
  let closed = false;
  const onKey = (event: KeyboardEvent): void => { if (event.key === "Escape") close(); };
  function close(): void {
    if (closed) return;
    closed = true; document.removeEventListener("keydown", onKey); overlay.remove(); options.onClose?.();
  }
  const actions = make("div", "pv-dialog-actions"), title = make("h3", "pv-dialog-title");
  if (options.update) {
    const release = options.update.release;
    glyphInto(title, "download", 20); title.append(make("span", "", "发现新版本可用"));
    actions.append(button("立即下载", () => { options.onDownload?.(release.downloadUrl); close(); }, { icon: "download", cls: "pv-btn-primary", el: "bulletin-download" }),
      button("稍后提醒", () => { options.onSnooze?.(); close(); }, { cls: "pv-btn-ghost", el: "bulletin-snooze" }));
    card.append(title, make("p", "pv-dialog-body", `版本 ${release.versionName}（Code ${release.versionCode}）`),
      make("p", "pv-dialog-body", release.changelog ?? "可下载最新安装包查看更新。"), actions);
  } else if (options.announcement) {
    const item = options.announcement;
    glyphInto(title, "alert", 20); title.append(make("span", "", item.title));
    actions.append(button("我知道了", () => { options.onDismissAnnouncement?.(); close(); }, { icon: "check", cls: "pv-btn-primary", el: "bulletin-ack" }));
    const paras = item.body.split(/\n+/).map(p => p.trim()).filter(Boolean);
    const bodyNodes = paras.length > 0 ? paras.map(p => make("p", "pv-dialog-body", p)) : [make("p", "pv-dialog-body", item.body)];
    card.append(title, ...bodyNodes, actions);
  }
  overlay.append(card); document.addEventListener("keydown", onKey);
  overlay.addEventListener("click", (event) => { if (event.target === overlay) close(); });
  options.root.append(overlay); actions.querySelector<HTMLButtonElement>("button")?.focus();
  return { close };
}
export interface ScheduleBulletinsDeps {
  api: PrismApiClient;
  prefs: PreferenceStore;
  root: HTMLElement;
  bridge: PrismNativeBridge;
  isPlayerOpen: () => boolean;
  versionCode?: number;
  nowSeconds?: () => number;
}
export function scheduleBulletinsCheck(deps: ScheduleBulletinsDeps): () => void {
  let disposed = false, activeModal: { close(): void } | null = null;
  let timer: ReturnType<typeof setTimeout>;
  const now = deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  const report = createNotice(deps.root);
  const run = async (): Promise<void> => {
    let versionCode = deps.versionCode;
    if (versionCode === undefined) {
      if (!isNativeHost()) return;
      try { versionCode = Number((await (await import("@capacitor/app")).App.getInfo()).build); } catch { return; }
    }
    if (!Number.isSafeInteger(versionCode) || versionCode! <= 0 || disposed) return;
    const result = await checkClientBulletins({ api: deps.api, prefs: deps.prefs, currentVersionCode: versionCode!, nowSeconds: now });
    if (disposed) return;
    let update = result.update;
    let announcement: BulletinAnnouncement | undefined = result.announcements[0];
    const show = (): void => {
      if (disposed) return;
      if (deps.isPlayerOpen() || document.visibilityState === "hidden") { timer = setTimeout(show, 2000); return; }
      const onClose = (): void => { activeModal = null; if (!disposed) timer = setTimeout(show, 0); };
      if (update) {
        const selected = update; update = null;
        activeModal = openBulletinDialog({ root: deps.root, update: selected, onClose,
          onDownload: (url) => { void deps.bridge.openExternalUrl(url).catch(() => report("未能打开下载，请稍后从设置页重试。")); },
          onSnooze: () => { void snoozeUpdate(deps.prefs, selected.release.versionCode, now()).catch(() => report("稍后提醒未能保存。")); }
        });
      } else if (announcement) {
        const selected = announcement; announcement = undefined;
        if (selected.startsAt > now() || selected.endsAt <= now()) return;
        activeModal = openBulletinDialog({ root: deps.root, announcement: selected, onClose,
          onDismissAnnouncement: () => { void markAnnouncementRead(deps.prefs, selected.id, selected.revision).catch(() => report("已读状态未能保存。")); }
        });
      }
    };
    show();
  };
  timer = setTimeout(() => { void run().catch(() => {}); }, 1500);
  return () => { disposed = true; clearTimeout(timer); activeModal?.close(); };
}
