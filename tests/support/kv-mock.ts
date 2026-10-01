/** Minimal KV stand-in: string keys, TTL ignored, eventual consistency is out of scope here. */
export class MemoryKv {
  private readonly store = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.store.get(key);
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(): Promise<{ keys: { name: string }[] }> {
    return { keys: [...this.store.keys()].map((name) => ({ name })) };
  }

  snapshot(): ReadonlyMap<string, string> {
    return this.store;
  }
}
