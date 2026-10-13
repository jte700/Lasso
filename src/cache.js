/** Least-recently-used storage with entry and weight limits. Eviction only
 * discards derived data; callers always retain a way to recompute it. */
export class BoundedCache {
  constructor({ maxEntries = 8, maxWeight = Infinity, weight = () => 1 } = {}) {
    this.maxEntries = maxEntries;
    this.maxWeight = maxWeight;
    this.weightOf = weight;
    this.entries = new Map();
    this.weight = 0;
  }

  get size() { return this.entries.size; }
  has(key) { return this.entries.has(key); }
  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }
  set(key, value) {
    this.delete(key);
    const weight = Math.max(0, this.weightOf(value));
    if (!Number.isFinite(weight) || weight > this.maxWeight || this.maxEntries < 1) return this;
    this.entries.set(key, { value, weight });
    this.weight += weight;
    while (this.size > this.maxEntries || this.weight > this.maxWeight) {
      this.delete(this.entries.keys().next().value);
    }
    return this;
  }
  delete(key) {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.weight -= entry.weight;
    return this.entries.delete(key);
  }
  clear() { this.entries.clear(); this.weight = 0; }
}
