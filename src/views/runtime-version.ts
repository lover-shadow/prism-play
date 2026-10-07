import { band, make } from './history-view';
import type { VersionResponse } from '../../edge/src/types/api';

export interface RuntimeVersionSource {
  app(): Promise<{ version: string; build: string }>;
  cloud(): Promise<VersionResponse>;
}
export function createRuntimeVersionBand(source: RuntimeVersionSource) {
  const section = band('运行版本', 'runtime-version');
  const app = make('p', 'pv-note', 'APP版本：正在读取…');
  const cloud = make('p', 'pv-note', '云端版本：尚未确认');
  section.body.append(app, cloud);
  let disposed = false;
  async function refresh(): Promise<void> {
    await Promise.all([
      source.app().then((info) => {
        if (!disposed) app.textContent = `APP版本：${info.version}（Build ${info.build}）`;
      }).catch(() => { if (!disposed) app.textContent = 'APP版本：未能读取宿主信息'; }),
      source.cloud().then((info) => {
        if (disposed) return;
        cloud.textContent = info.service
          ? `云端版本：${info.service.buildId} · 部署时间：${info.service.deployedAt}`
          : '云端版本：服务未提供构建标识';
      }).catch(() => { if (!disposed) cloud.textContent = '云端版本：联网读取失败，未确认'; })
    ]);
  }
  return { wrap: section.wrap, refresh, destroy: () => { disposed = true; } };
}
