/** 公共搜索发现独立于目录 revision；只由正式收录、撤片或清缓存移除。 */
import type { ContentItem } from '../../../edge/src/types/api';
import { PUBLIC_CHANNEL_IDS } from '../../../edge/src/types/api';
import { CACHE_KEY_NAMESPACE, decodeJson, guardItem, jsonBytes } from './cache-internals';
import type { CacheDisk, CacheWrite } from './public-cache';

const PREFIX = `${CACHE_KEY_NAMESPACE}search-discoveries/`;
const keyOf = (id: string): string => `${PREFIX}${encodeURIComponent(id)}.json`;
export class SearchDiscoveries {
  private items = new Map<string, ContentItem>();
  constructor(private readonly disk: CacheDisk) {}
  list(): ContentItem[] { return [...this.items.values()]; }
  get(id: string): ContentItem | undefined { return this.items.get(id); }
  bytes(): number { return this.list().reduce((sum, item) => sum + jsonBytes(item).byteLength, 0); }
  clear(): void { this.items.clear(); }
  private guard(item: ContentItem): void {
    guardItem('public-cache.search-discoveries', item);
    if (!item.id || !item.title || !(PUBLIC_CHANNEL_IDS as readonly string[]).includes(item.channelId)) throw new Error('Invalid public search discovery');
  }
  private compatible(item: ContentItem, base: ContentItem): boolean {
    return base.isPrivate === false && item.isPrivate === false && base.enabled !== false && item.enabled !== false
      && item.id === base.id && item.channelId === base.channelId && item.title === base.title
      && Number.isSafeInteger(item.episodeCount) && Number.isSafeInteger(base.episodeCount)
      && (base.episodeCount as number) >= 0 && (item.episodeCount as number) >= (base.episodeCount as number);
  }

  // 集数与身份足以验证覆盖，不把目录修订时间冒充内容更新时间。
  private accepts(item: ContentItem, base: ReadonlyMap<string, ContentItem>, current?: ContentItem): boolean {
    const fact = base.get(item.id);
    return item.enabled !== false && (fact === undefined || this.compatible(item, fact))
      && (current === undefined || (fact === undefined || (item.title === current.title && item.channelId === current.channelId))
        && (item.episodeCount ?? 0) >= (current.episodeCount ?? 0));
  }

  superseded(base: ReadonlyMap<string, ContentItem>): string[] {
    return this.list().filter((item) => {
      const fact = base.get(item.id);
      return fact !== undefined && (!this.compatible(item, fact) || (fact.episodeCount as number) >= (item.episodeCount as number));
    }).map((item) => item.id);
  }

  async hydrate(base: ReadonlyMap<string, ContentItem>): Promise<void> {
    const next = new Map<string, ContentItem>(), removes: string[] = [];
    for (const entry of await this.disk.list(PREFIX)) {
      const item = decodeJson<ContentItem>(await this.disk.read(entry.key));
      try {
        if (item === null) throw new Error('Invalid discovery');
        this.guard(item);
        if (entry.key !== keyOf(item.id) || !this.accepts(item, base)) throw new Error('Superseded discovery');
        next.set(item.id, item);
      } catch { removes.push(entry.key); }
    }
    if (removes.length) await this.disk.writeBatch([], removes);
    this.items = next;
  }
  async merge(items: readonly ContentItem[], base: ReadonlyMap<string, ContentItem>): Promise<ContentItem[]> {
    for (const item of items) this.guard(item); // 全批验明，不能写入半批。
    const next = new Map(this.items), writes: CacheWrite[] = [], touched = new Set<string>();
    for (const item of items) {
      if (!this.accepts(item, base, next.get(item.id))) continue;
      next.set(item.id, item);
      touched.add(item.id);
    }
    const changed = [...touched].map((id) => next.get(id) as ContentItem);
    for (const item of changed) writes.push({ key: keyOf(item.id), bytes: jsonBytes(item) });
    if (writes.length) await this.disk.writeBatch(writes, []);
    this.items = next; // 磁盘提交之后才能宣称已保存。
    return changed;
  }
  /** Ordered change batches commit removals and upserts together; base facts remain untouched. */
  async apply(changes: readonly { workId: string; operation: 'upsert' | 'withdraw'; card?: ContentItem }[], base: ReadonlyMap<string, ContentItem>): Promise<void> {
    for (const change of changes) if (change.operation === 'upsert') this.guard(change.card as ContentItem);
    const next = new Map(this.items), touched = new Set<string>();
    for (const change of changes) {
      touched.add(change.workId);
      if (change.operation === 'withdraw') next.delete(change.workId);
      else if (change.card?.id === change.workId && this.accepts(change.card, base, next.get(change.workId))) next.set(change.workId, change.card);
    }
    const writes: CacheWrite[] = [...touched].flatMap((id) => {
      const item = next.get(id);
      return item === undefined ? [] : [{ key: keyOf(id), bytes: jsonBytes(item) }];
    });
    if (touched.size) await this.disk.writeBatch(writes, [...touched].map(keyOf));
    this.items = next;
  }
  removalKeys(ids: readonly string[]): string[] { return ids.map(keyOf); }
  forget(ids: readonly string[]): void { for (const id of ids) this.items.delete(id); }
}
