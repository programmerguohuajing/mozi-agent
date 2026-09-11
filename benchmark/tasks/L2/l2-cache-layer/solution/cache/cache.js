export class TTLCache {
  #store = new Map();

  get(key) {
    const entry = this.#store.get(key);
    if (!entry) return undefined;
    if (entry.expires <= Date.now()) {
      this.#store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value, ttlMs) {
    this.#store.set(key, { value, expires: Date.now() + ttlMs });
    return this;
  }

  clear() {
    this.#store.clear();
  }
}
