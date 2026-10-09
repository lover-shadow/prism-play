import { CACHE_KEY_NAMESPACE, decodeJson, jsonBytes } from './cache-internals';
import type { CacheDisk, CacheWrite } from './public-cache';

export const DISCOVERY_META_KEY = `${CACHE_KEY_NAMESPACE}discovery-sync-meta.json`;
export interface PendingDiscoveryIndex { generation: string; cursor: number; ids: string[] }
interface DiscoveryMeta { generation: string; cursor: number; pending?: PendingDiscoveryIndex }
export class DiscoveryJournal {
  private readonly key = DISCOVERY_META_KEY;
  private meta: DiscoveryMeta = { generation: crypto.randomUUID(), cursor: 0 };
  constructor(private readonly disk: CacheDisk) {}
  cursor(): number { return this.meta.cursor; }
  receipt(): PendingDiscoveryIndex | null { return this.meta.pending ? { ...this.meta.pending, ids: [...this.meta.pending.ids] } : null; }
  private write(meta: DiscoveryMeta): CacheWrite { return { key: this.key, bytes: jsonBytes(meta) }; }
  async hydrate(): Promise<void> {
    const stored = decodeJson<DiscoveryMeta>(await this.disk.read(this.key));
    const cursor = stored && Number.isSafeInteger(stored.cursor) && stored.cursor >= 0 ? stored.cursor : 0;
    const generation = typeof stored?.generation === 'string' && stored.generation ? stored.generation : crypto.randomUUID();
    const pending = stored?.pending;
    this.meta = { cursor, generation };
    if (pending?.generation === generation && Number.isSafeInteger(pending.cursor) && pending.cursor >= cursor &&
        Array.isArray(pending.ids) && pending.ids.every((id) => typeof id === 'string' && id.length > 0)) {
      this.meta.pending = { generation, cursor: pending.cursor, ids: [...new Set(pending.ids)] };
    }
  }
  prepare(cursor: number, ids: string[]): { write: CacheWrite; accept(): void } {
    if (!Number.isSafeInteger(cursor) || cursor < this.meta.cursor || this.meta.pending) throw new Error('Discovery index receipt must settle before next page');
    const next: DiscoveryMeta = { ...this.meta, pending: { generation: this.meta.generation, cursor, ids: [...new Set(ids)] } };
    return { write: this.write(next), accept: () => { this.meta = next; } };
  }
  async commit(cursor: number): Promise<void> {
    if (!Number.isSafeInteger(cursor) || cursor < this.meta.cursor || this.meta.pending && this.meta.pending.cursor !== cursor) throw new Error('Invalid discovery cursor');
    const next = { generation: this.meta.generation, cursor };
    await this.disk.writeBatch([this.write(next)], []);
    this.meta = next;
  }
  reset(): void {
    this.meta = { generation: crypto.randomUUID(), cursor: 0 };
  }
}
