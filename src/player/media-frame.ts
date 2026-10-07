/**
 * 画面内容矩形（AC-19 的工具栏定位依据）。
 *
 * `object-fit: contain` 之后，**元素盒子**铺满舞台，**画面**只在盒子里居中就座。
 * 历史上工具栏与手势带都以元素盒子为基准，于是竖屏短剧在 16:9 详情舞台里被拉成一根居中窄柱时，
 * 工具栏照样横穿整条舞台宽度压在画面上——观感就是"工具栏从画面中间穿过去"。
 *
 * 本模块把 contain 之后真实可见的那块矩形量出来，以 CSS 自定义属性写回播放器根节点，
 * 样式正本（`player.css`）只消费这几个变量：**布局数值在这里量，视觉规则在那里写**，两处各司一职，
 * 不出现第二套全屏权威（SPEC §1.2.0 的同一纪律）。量不到（元数据未就绪、盒宽为 0）时一律回落到
 * 铺满容器，绝不猜一个偏移出来——猜错就是工具栏跑到画面中间。
 */

export interface MediaBox { width: number; height: number }
export interface ContentRect { top: number; left: number; width: number; height: number }

/** 等比适配后的可见矩形：与浏览器 `contain` 的算法同一条数学，不做任何取整以外的加工。 */
export function containedRect(box: MediaBox, video: MediaBox | null): ContentRect {
  if (!(box.width > 0) || !(box.height > 0)) return { top: 0, left: 0, width: box.width, height: box.height };
  if (video === null || !(video.width > 0) || !(video.height > 0)) return { top: 0, left: 0, width: box.width, height: box.height };
  const scale = Math.min(box.width / video.width, box.height / video.height);
  const width = video.width * scale;
  const height = video.height * scale;
  return { top: (box.height - height) / 2, left: (box.width - width) / 2, width, height };
}

/** 写回样式正本的四个基准变量（px 长度，不是颜色，P0-3 无涉）。 */
export function applyMediaFrame(target: HTMLElement, rect: ContentRect): void {
  target.style.setProperty('--prism-media-top', `${rect.top}px`);
  target.style.setProperty('--prism-media-left', `${rect.left}px`);
  target.style.setProperty('--prism-media-width', `${rect.width}px`);
  target.style.setProperty('--prism-media-height', `${rect.height}px`);
}

/** `<video>` 由内核自己创建，这里只读不造；解码尺寸未就绪即视为未知。 */
function videoSizeOf(container: HTMLElement): MediaBox | null {
  const video = container.querySelector('video') as HTMLVideoElement | null;
  if (video === null) {
    const width = Number(container.dataset.nativeVideoWidth), height = Number(container.dataset.nativeVideoHeight);
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (!(video.videoWidth > 0) || !(video.videoHeight > 0)) return null;
  return { width: video.videoWidth, height: video.videoHeight };
}

/**
 * 重测一次并写回：`measure` 是画面所在的盒子（舞台），`target` 是消费变量的根节点（播放器根）。
 * 宽度量不到（jsdom、display:none、刚拆树）时保持上一次的值不动，避免把工具栏甩到 0×0。
 */
export function updateMediaFrame(target: HTMLElement, measure: HTMLElement): ContentRect | null {
  const box = measure.getBoundingClientRect();
  if (!(box.width > 0) || !(box.height > 0)) return null;
  const rect = containedRect({ width: box.width, height: box.height }, videoSizeOf(measure));
  applyMediaFrame(target, rect);
  return rect;
}
