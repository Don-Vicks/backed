// Small in-process caches for the web server's RPC reads. One server process serves every viewer,
// so memory is the right place: nothing here needs to survive a restart.

// A Map that keeps at most `max` entries, dropping the least recently used one first.
export class LruMap<K, V> {
  private readonly map = new Map<K, V>()
  constructor(readonly max: number) {}

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined
    const value = this.map.get(key)!
    this.map.delete(key) // re-insert: Map iteration order is insertion order
    this.map.set(key, value)
    return value
  }

  set(key: K, value: V) {
    this.map.delete(key)
    this.map.set(key, value)
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as K)
  }

  delete(key: K) {
    return this.map.delete(key)
  }

  get size() {
    return this.map.size
  }
}

export type TtlCache<T> = {
  // The cached value while it is younger than its TTL, else load() once for every caller waiting on it.
  get(key: string, load: () => Promise<T>): Promise<T>
  set(key: string, value: T): void
  fresh(key: string): T | undefined
  delete(key: string): void
}

// Values expire after ttlMs (or ttlMs(value), for values that should not be kept as long); concurrent
// misses on one key share a single load. A failed load is not cached, so the next caller tries again.
export function ttlCache<T>(ttlMs: number | ((value: T) => number), max = 5000, now: () => number = Date.now): TtlCache<T> {
  const values = new LruMap<string, { value: T; expiresAt: number }>(max)
  const inFlight = new Map<string, Promise<T>>()

  const fresh = (key: string) => {
    const hit = values.get(key)
    return hit && now() < hit.expiresAt ? hit.value : undefined
  }
  const set = (key: string, value: T) => values.set(key, { value, expiresAt: now() + (typeof ttlMs === 'function' ? ttlMs(value) : ttlMs) })

  return {
    fresh,
    set,
    delete: (key) => void values.delete(key),
    get(key, load) {
      const hit = values.get(key)
      if (hit && now() < hit.expiresAt) return Promise.resolve(hit.value)
      const pending = inFlight.get(key)
      if (pending) return pending
      const p = load()
        .then((value) => {
          set(key, value)
          return value
        })
        .finally(() => inFlight.delete(key))
      inFlight.set(key, p)
      return p
    },
  }
}
