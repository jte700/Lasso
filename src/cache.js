// Default memory budget for every derived-data cache that shares one, and the
// floor it shrinks to while the server has nothing to do.
export const DEFAULT_CACHE_BYTES = 64 * 1024 * 1024;
export const IDLE_CACHE_BYTES = 8 * 1024 * 1024;

/**
 * One limit on the bytes many caches hold together. Each entry carries a
 * tick from a shared clock, so when the caches are over the limit the entry
 * used longest ago goes first, whichever cache holds it.
 */
export class MemoryBudget {
  constructor({ maxBytes = DEFAULT_CACHE_BYTES, idleBytes = IDLE_CACHE_BYTES } = {}) {
    this.maxBytes = maxBytes;
    this.idleBytes = Math.min(idleBytes, maxBytes);
    this.limit = maxBytes;
    this.bytes = 0;
    this.clock = 0;
    this.caches = new Set();
  }

  tick() { this.clock += 1; return this.clock; }

  join(cache) { this.caches.add(cache); }

  added(bytes) {
    this.bytes += bytes;
    this.fit();
  }

  removed(bytes) { this.bytes = Math.max(0, this.bytes - bytes); }

  /** Evicts the oldest entries across every cache until the total fits. */
  fit() {
    while (this.bytes > this.limit) {
      let oldest = null;
      for (const cache of this.caches) {
        const entry = cache.oldestEntry();
        if (entry && (!oldest || entry.tick < oldest.entry.tick)) oldest = { cache, entry };
      }
      if (!oldest) return;
      oldest.cache.delete(oldest.entry.key);
    }
  }

  /** Shrinks to the idle floor, keeping the most recently used entries. */
  idle() {
    this.limit = this.idleBytes;
    this.fit();
  }

  /** Lets the caches use the whole budget again. */
  active() { this.limit = this.maxBytes; }
}

/** Least-recently-used storage with entry and weight limits. Eviction only
 * discards derived data; callers always retain a way to recompute it.
 * With a `budget`, each entry also counts `bytes(value)` against it. */
export class BoundedCache {
  constructor({ maxEntries = 8, maxWeight = Infinity, weight = () => 1, budget = null, bytes = null } = {}) {
    this.maxEntries = maxEntries;
    this.maxWeight = maxWeight;
    this.weightOf = weight;
    this.budget = budget;
    this.bytesOf = bytes;
    this.entries = new Map();
    this.weight = 0;
    budget?.join(this);
  }

  get size() { return this.entries.size; }
  has(key) { return this.entries.has(key); }
  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    if (this.budget) entry.tick = this.budget.tick();
    return entry.value;
  }
  set(key, value) {
    this.delete(key);
    const weight = Math.max(0, this.weightOf(value));
    if (!Number.isFinite(weight) || weight > this.maxWeight || this.maxEntries < 1) return this;
    const bytes = this.budget ? Math.max(0, this.bytesOf?.(value) ?? 0) : 0;
    if (this.budget && (!Number.isFinite(bytes) || bytes > this.budget.limit)) return this;
    const entry = { key, value, weight, bytes, tick: this.budget?.tick() ?? 0 };
    this.entries.set(key, entry);
    this.weight += weight;
    while (this.size > this.maxEntries || this.weight > this.maxWeight) {
      this.delete(this.entries.keys().next().value);
    }
    this.budget?.added(bytes);
    return this;
  }
  delete(key) {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.weight -= entry.weight;
    this.budget?.removed(entry.bytes);
    return this.entries.delete(key);
  }
  /** The entry used longest ago, which a shared budget evicts first. */
  oldestEntry() {
    return this.entries.values().next().value ?? null;
  }
  clear() {
    for (const entry of this.entries.values()) this.budget?.removed(entry.bytes);
    this.entries.clear();
    this.weight = 0;
  }
}
