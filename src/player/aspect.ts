/**
 * 真实画幅嗅探（SPEC §1.2.1 / AC-19、AC-20）。
 *
 * 判定只看解码后的真实像素（`videoWidth`/`videoHeight`），不看容器比例、不看片单字段：
 * 短剧里也有横构图，电影里也有竖构图海报，任何按"频道"猜画幅的实现都会在某一集上翻车。
 */

export type AspectOrientation = 'portrait' | 'landscape';

/**
 * 竖屏判据：`videoHeight > videoWidth`，且必须先有正的 `videoWidth`——
 * 元数据未就绪时两个值都是 0，此时返回 null（未知）而不是把它当成竖屏。
 */
export function orientationOf(width: number, height: number): AspectOrientation | null {
  if (!(width > 0) || !(height > 0)) return null;
  return height > width ? 'portrait' : 'landscape';
}

/** 从播放器容器里取那颗真正的 `<video>`：ArtPlayer 自己创建它，我们只读不造。 */
export function probeStageOrientation(stage: HTMLElement | null): AspectOrientation | null {
  const video = stage?.querySelector('video') as HTMLVideoElement | null | undefined;
  if (!video) return stage === null ? null : orientationOf(Number(stage.dataset.nativeVideoWidth), Number(stage.dataset.nativeVideoHeight));
  return orientationOf(video.videoWidth, video.videoHeight);
}

/**
 * 留白比例（0 表示无留白）：`contain` 等比适配后，视口未被画面覆盖的高度占比。
 *
 * 这条数学事实是 §1.2.2 定策的依据——典型短剧 1080×1920（9:16≈1.78）放进 1080×2400（20:9≈2.22）
 * 必然上下共留约 480px；改用 `cover` 铺满则要左右裁掉约 268px（≈画面宽度 20%），会切掉烧录字幕。
 * 所以本项目一律 `contain`，留白交给模糊底片填充，而不是裁内容。
 */
export function letterboxRatio(viewportWidth: number, viewportHeight: number, contentWidth: number, contentHeight: number): number {
  if (!(viewportWidth > 0) || !(viewportHeight > 0) || !(contentWidth > 0) || !(contentHeight > 0)) return 0;
  const scale = Math.min(viewportWidth / contentWidth, viewportHeight / contentHeight);
  return Math.max(0, (viewportHeight - contentHeight * scale) / viewportHeight);
}
