import { AsyncLocalStorage } from 'async_hooks';

export interface MGetCacheAdapter {
  mget(keys: string[]): Promise<Map<string, any> | Record<string, any>>;
  setMany(items: Map<string, any> | Record<string, any>, ttlSeconds?: number): Promise<void>;
  del?(keys: string[]): Promise<void>;
}

export interface PrefetchRule<P = any, C = any> {
  extract: (parent: P) => C | C[] | null | undefined;
  loader: () => ((key: C) => Promise<any>) | { load?: (key: C) => Promise<any>; prefetch?: (keys: C[]) => Promise<any> | void };
}

export interface BatchLoadOptions<K, V> {
  /**
   * The name of the method on `this` that accepts `K[]` and returns `Promise<Map<K, V> | V[] | Record<string, V>>`.
   */
  batchMethod?: string;
  /**
   * Directly supplied batch loader function.
   */
  batchFn?: (keys: K[]) => Promise<Map<K, V> | V[] | Record<string, V>>;
  /**
   * Maximum batch size before dispatching immediately. Default is 100.
   */
  maxBatchSize?: number;
  /**
   * Window duration in milliseconds. If 0 or omitted, coalesces on microtask queue (queueMicrotask/process.nextTick).
   */
  windowMs?: number;
  /**
   * In-flight deduplication: multiple calls with identical key share the same promise. Default is true.
   */
  deduplicate?: boolean;
  /**
   * Function to extract the unique key string/value from an item if batch returns an array. Default: item.id or item.key.
   */
  keyOf?: (item: V) => K;
  /**
   * Relationship cardinality: 'one' (1-to-1 scalar lookup, default) or 'many' (1-to-many list aggregation).
   * When 'many', maps key to an array of matching items.
   */
  relation?: 'one' | 'many';
  /**
   * Optional AsyncLocalStorage for request-scoped context isolation.
   */
  contextStorage?: AsyncLocalStorage<any>;
  /**
   * Optional multi-tier caching configuration (L1 memory LRU + L2 distributed Redis MGET).
   */
  cache?: {
    l1?: { maxEntries?: number; ttlMs?: number } | false;
    l2?: { adapter: MGetCacheAdapter; ttlSeconds?: number };
    negativeTtlSeconds?: number;
  };
  /**
   * Optional cascading graph pre-fetch rules triggered when parent entities resolve.
   */
  prefetch?: PrefetchRule<V, any>[];
}

interface QueuedItem<K, V> {
  key: K;
  resolve: (value: V) => void;
  reject: (reason: any) => void;
  /** Set by clear(): the value this load reads may predate the invalidation; do not cache it. */
  stale?: boolean;
}

// WeakRef exists on every supported runtime (Node >= 18) but not in this package's `es6` TS lib.
interface WeakRefLike<T> {
  deref(): T | undefined;
}
const WeakRefCtor: new <T extends object>(target: T) => WeakRefLike<T> = (globalThis as any).WeakRef;

/**
 * Ambient batching scope. While a call runs inside `batchLoadScopeStorage.run(scope, ...)`, every
 * `@batchLoad` method keys its queue (and L1 cache) by `scope.scopeFor(instance)` instead of the
 * service instance, so the state belongs to the scope owner (e.g. one GraphQL request).
 */
export interface BatchLoadScope {
  scopeFor(identity: object): object;
}
export const batchLoadScopeStorage = new AsyncLocalStorage<BatchLoadScope>();

const MISSING_SENTINEL = Symbol('MISSING_SENTINEL');

class LruCache<K, V> {
  private items = new Map<K, { value: V; expiresAt?: number }>();

  constructor(
    private maxEntries: number = 10000,
    private ttlMs: number = 0
  ) {}

  get(key: K): V | undefined {
    const entry = this.items.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.items.delete(key);
      return undefined;
    }
    // Refresh for LRU
    this.items.delete(key);
    this.items.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V, customTtlMs?: number): void {
    const ttl = customTtlMs !== undefined ? customTtlMs : this.ttlMs;
    const expiresAt = ttl > 0 ? Date.now() + ttl : undefined;
    if (this.items.has(key)) {
      this.items.delete(key);
    } else if (this.maxEntries > 0 && this.items.size >= this.maxEntries) {
      const oldestKey = this.items.keys().next().value;
      if (oldestKey !== undefined) {
        this.items.delete(oldestKey);
      }
    }
    this.items.set(key, { value, expiresAt });
  }

  delete(key: K): boolean {
    return this.items.delete(key);
  }

  clear(): void {
    this.items.clear();
  }
}

class BatchQueue<K, V> {
  private queue: QueuedItem<K, V>[] = [];
  private scheduled = false;
  private inFlightPromises = new Map<K, Promise<V>>();
  // Every load that has not settled yet; clear() marks the matching ones stale so that a value
  // read before the invalidation is never written back to L1/L2.
  private pending = new Set<QueuedItem<K, V>>();
  private l1Cache: LruCache<K, any> | null = null;
  private l2Adapter: MGetCacheAdapter | null = null;
  private l2TtlSeconds = 300;
  private negativeTtlMs = 5000;

  constructor(
    private loaderFn: (keys: K[]) => Promise<Map<K, V> | V[] | Record<string, V>>,
    private maxBatchSize: number,
    private windowMs: number,
    private deduplicate: boolean,
    private keyOf?: (item: V) => K,
    cacheOptions?: BatchLoadOptions<K, V>['cache'],
    private prefetchRules?: PrefetchRule<V, any>[],
    private relation: 'one' | 'many' = 'one'
  ) {
    if (cacheOptions?.l1 !== false && (cacheOptions?.l1 !== null)) {
      this.l1Cache = new LruCache<K, any>(
        cacheOptions?.l1?.maxEntries ?? 10000,
        cacheOptions?.l1?.ttlMs ?? 10000
      );
    }
    if (cacheOptions?.l2) {
      this.l2Adapter = cacheOptions.l2.adapter;
      this.l2TtlSeconds = cacheOptions.l2.ttlSeconds ?? 300;
    }
    if (cacheOptions?.negativeTtlSeconds !== undefined) {
      this.negativeTtlMs = cacheOptions.negativeTtlSeconds * 1000;
    }
  }

  public prime(key: K, value: V): void {
    if (!this.l1Cache) {
      this.l1Cache = new LruCache<K, any>(10000, 10000);
    }
    this.l1Cache.set(key, value);
    if (this.l2Adapter) {
      const items = new Map<string, any>([[String(key), value]]);
      this.l2Adapter.setMany(items, this.l2TtlSeconds).catch(() => {});
    }
  }

  public prefetch(keys: K[]): void {
    if (!keys || keys.length === 0) return;
    for (const key of keys) {
      this.load(key).catch(() => {});
    }
  }

  public load(key: K): Promise<V> {
    // 1. Immediate L1 check
    if (this.l1Cache) {
      const cached = this.l1Cache.get(key);
      if (cached !== undefined) {
        if (cached === MISSING_SENTINEL) {
          return Promise.resolve(undefined as unknown as V);
        }
        return Promise.resolve(cached);
      }
    }

    if (this.deduplicate) {
      const existing = this.inFlightPromises.get(key);
      if (existing) {
        return existing;
      }
    }

    let item!: QueuedItem<K, V>;
    const promise = new Promise<V>((resolve, reject) => {
      item = { key, resolve, reject };
      this.pending.add(item);
      this.queue.push(item);

      if (this.queue.length >= this.maxBatchSize) {
        this.dispatch().catch(() => {});
      } else if (!this.scheduled) {
        this.scheduleDispatch();
      }
    });

    if (this.deduplicate) {
      this.inFlightPromises.set(key, promise);
    }
    // Clean up once settled without creating an unhandled rejection branch. Only drop the
    // in-flight entry if it is still ours: clear() may have let a newer flight take the slot.
    const cleanup = () => {
      this.pending.delete(item);
      if (this.inFlightPromises.get(key) === promise) {
        this.inFlightPromises.delete(key);
      }
    };
    promise.then(cleanup, cleanup);

    return promise;
  }

  /** Invalidate this queue's own state for `key`: L1 entry and any load still in flight. */
  public clearLocal(key: K): void {
    if (this.l1Cache) {
      this.l1Cache.delete(key);
    }
    // A load in flight may already have read the pre-invalidation value: later reads must not
    // join it, and it must not write that value back to L1/L2 when it settles.
    this.inFlightPromises.delete(key);
    for (const item of this.pending) {
      if (item.key === key) {
        item.stale = true;
      }
    }
  }

  public async clear(key: K): Promise<void> {
    this.clearLocal(key);
    if (this.l2Adapter?.del) {
      await this.l2Adapter.del([String(key)]);
    }
  }

  private scheduleDispatch() {
    this.scheduled = true;
    if (this.windowMs > 0) {
      setTimeout(() => {
        this.dispatch().catch(() => {});
      }, this.windowMs);
    } else {
      queueMicrotask(() => {
        this.dispatch().catch(() => {});
      });
    }
  }

  private triggerPrefetch(items: V[]) {
    if (!this.prefetchRules || this.prefetchRules.length === 0 || items.length === 0) return;

    for (const rule of this.prefetchRules) {
      try {
        const rawLoader = rule.loader();
        if (!rawLoader) continue;

        const childKeys: any[] = [];
        const seen = new Set<any>();

        for (const item of items) {
          if (item == null) continue;
          const extracted = rule.extract(item);
          if (extracted == null) continue;

          if (Array.isArray(extracted)) {
            for (const k of extracted) {
              if (k != null && !seen.has(k)) {
                seen.add(k);
                childKeys.push(k);
              }
            }
          } else if (!seen.has(extracted)) {
            seen.add(extracted);
            childKeys.push(extracted);
          }
        }

        if (childKeys.length === 0) continue;

        if (typeof (rawLoader as any).prefetch === 'function') {
          (rawLoader as any).prefetch(childKeys);
        } else if (typeof (rawLoader as any).load === 'function') {
          for (const ck of childKeys) {
            (rawLoader as any).load(ck).catch(() => {});
          }
        } else if (typeof rawLoader === 'function') {
          for (const ck of childKeys) {
            rawLoader(ck).catch(() => {});
          }
        }
      } catch {
        // Suppress prefetch errors so parent never fails
      }
    }
  }

  private async dispatch() {
    if (this.queue.length === 0) return;

    this.scheduled = false;
    const batch = this.queue;
    this.queue = [];

    // Phase A: L1 Check
    const l1Misses: QueuedItem<K, V>[] = [];
    for (const item of batch) {
      if (this.l1Cache) {
        const cached = this.l1Cache.get(item.key);
        if (cached !== undefined) {
          if (cached === MISSING_SENTINEL) {
            item.resolve(undefined as unknown as V);
          } else {
            item.resolve(cached);
          }
          continue;
        }
      }
      l1Misses.push(item);
    }

    if (l1Misses.length === 0) return;

    // Phase B: L2 Distributed Cache Check (MGET)
    const l2Misses: QueuedItem<K, V>[] = [];
    const l2ResolvedItems: V[] = [];
    if (this.l2Adapter) {
      try {
        const strKeys = Array.from(new Set(l1Misses.map((it) => String(it.key))));
        const mgetRes = await this.l2Adapter.mget(strKeys);
        const l2Map = this.normalizeResult(mgetRes as any);

        for (const item of l1Misses) {
          const strKey = String(item.key) as unknown as K;
          if (l2Map.has(strKey) || l2Map.has(item.key)) {
            const val = l2Map.get(strKey) ?? l2Map.get(item.key)!;
            if (this.l1Cache && !item.stale) {
              this.l1Cache.set(item.key, val);
            }
            l2ResolvedItems.push(val);
            item.resolve(val);
          } else {
            l2Misses.push(item);
          }
        }
      } catch {
        // Fallback to L3 on L2 error
        l2Misses.push(...l1Misses);
      }
    } else {
      l2Misses.push(...l1Misses);
    }

    if (l2ResolvedItems.length > 0) {
      this.triggerPrefetch(l2ResolvedItems);
    }

    if (l2Misses.length === 0) return;

    // Phase C: L3 Batch Loader
    const uniqueKeys: K[] = [];
    const seen = new Set<any>();
    for (const item of l2Misses) {
      if (!seen.has(item.key)) {
        seen.add(item.key);
        uniqueKeys.push(item.key);
      }
    }

    try {
      const result = await this.loaderFn(uniqueKeys);
      const resultMap = this.normalizeResult(result);
      // A plain-object result has string keys only, so a non-string caller key (e.g. a number)
      // must be looked up by its string form (the same compensation Phase B applies).
      const stringKeyed = !(result instanceof Map) && !Array.isArray(result);
      const l2SetItems = new Map<string, any>();
      const l3ResolvedItems: V[] = [];

      for (const item of l2Misses) {
        const resultKey =
          stringKeyed && !resultMap.has(item.key) ? (String(item.key) as unknown as K) : item.key;
        if (resultMap.has(resultKey)) {
          const val = resultMap.get(resultKey)!;
          l3ResolvedItems.push(val);
          if (this.l1Cache && !item.stale) {
            this.l1Cache.set(item.key, val);
          }
          if (this.l2Adapter && !item.stale) {
            l2SetItems.set(String(item.key), val);
          }
          item.resolve(val);
        } else {
          // Negative cache missing key
          if (this.l1Cache && !item.stale) {
            this.l1Cache.set(item.key, MISSING_SENTINEL, this.negativeTtlMs);
          }
          item.resolve(undefined as unknown as V);
        }
      }

      if (this.l2Adapter && l2SetItems.size > 0) {
        this.l2Adapter.setMany(l2SetItems, this.l2TtlSeconds).catch(() => {});
      }

      if (l3ResolvedItems.length > 0) {
        this.triggerPrefetch(l3ResolvedItems);
      }
    } catch (err) {
      for (const item of l2Misses) {
        item.reject(err);
      }
    }
  }

  private normalizeResult(result: Map<K, V> | V[] | Record<string, V>): Map<K, V> {
    if (result instanceof Map) {
      return result;
    }
    const map = new Map<K, any>();
    if (Array.isArray(result)) {
      for (const item of result) {
        if (item != null) {
          const k = this.keyOf ? this.keyOf(item) : ((item as any).id ?? (item as any).key);
          if (k !== undefined) {
            if (this.relation === 'many') {
              const existing = map.get(k) || [];
              existing.push(item);
              map.set(k, existing);
            } else {
              map.set(k, item);
            }
          }
        }
      }
    } else if (result && typeof result === 'object') {
      for (const [k, v] of Object.entries(result)) {
        map.set(k as unknown as K, v as V);
      }
    }
    return map;
  }
}

/**
 * Method decorator that transparently coalesces concurrent individual lookups into a single batch execution,
 * with optional multi-tier L1 memory LRU and L2 distributed Redis MGET caching, plus cascading graph pre-fetching.
 */
export function batchLoad<K = any, V = any>(options: BatchLoadOptions<K, V> = {}) {
  const maxBatchSize = options.maxBatchSize ?? 100;
  const windowMs = options.windowMs ?? 0;
  const deduplicate = options.deduplicate ?? true;

  return function (
    target: any,
    propertyKey: string,
    descriptor: TypedPropertyDescriptor<(...args: any[]) => Promise<any>>
  ) {
    const originalMethod = descriptor.value;
    const queues = new WeakMap<any, BatchQueue<K, V>>();
    // Weak registry of every live queue, for clear() across scopes. It must not keep a queue
    // (and its L1 cache) alive once its scope (request store, service instance) is gone.
    const queueRefs = new Set<WeakRefLike<BatchQueue<K, V>>>();
    let sweepAt = 64;

    function liveQueues(): BatchQueue<K, V>[] {
      const live: BatchQueue<K, V>[] = [];
      for (const ref of queueRefs) {
        const queue = ref.deref();
        if (queue) {
          live.push(queue);
        } else {
          queueRefs.delete(ref);
        }
      }
      return live;
    }

    function getOrCreateQueue(instance: any): BatchQueue<K, V> | null {
      // Determine the loader batch function
      let batchFn = options.batchFn;
      if (!batchFn && options.batchMethod && instance) {
        const method = (instance as any)[options.batchMethod];
        if (typeof method === 'function') {
          batchFn = method.bind(instance);
        }
      }

      if (!batchFn) {
        return null;
      }

      const ambientScope = batchLoadScopeStorage.getStore();
      const scopeTarget = ambientScope
        ? ambientScope.scopeFor(instance ?? target)
        : options.contextStorage
          ? (options.contextStorage.getStore() ?? instance ?? target)
          : (instance ?? target);

      let queue = queues.get(scopeTarget);
      if (!queue) {
        queue = new BatchQueue<K, V>(
          batchFn,
          maxBatchSize,
          windowMs,
          deduplicate,
          options.keyOf,
          options.cache,
          options.prefetch,
          options.relation ?? 'one'
        );
        queues.set(scopeTarget, queue);
        if (queueRefs.size >= sweepAt) {
          sweepAt = Math.max(64, liveQueues().length * 2);
        }
        queueRefs.add(new WeakRefCtor(queue));
      }
      return queue;
    }

    const wrappedMethod: any = async function (this: any, ...args: any[]) {
      const key = args[0] as K;
      const queue = getOrCreateQueue(this);

      if (!queue) {
        // Fallback to original method if no batch implementation exists
        return originalMethod?.apply(this, args);
      }

      return queue.load(key);
    };

    wrappedMethod.prime = function (key: K, value: V, instance?: any) {
      const queue = getOrCreateQueue(instance);
      if (queue) {
        queue.prime(key, value);
      }
    };

    wrappedMethod.prefetch = function (keys: K[], instance?: any) {
      const queue = getOrCreateQueue(instance);
      if (queue) {
        queue.prefetch(keys);
      }
    };

    wrappedMethod.clear = async function (key: K, instance?: any) {
      if (instance) {
        const queue = queues.get(instance);
        if (queue) {
          await queue.clear(key);
          return;
        }
      }
      // Every queue of this method shares one L2 adapter: invalidate each live queue's own
      // state, then delete from L2 once instead of once per queue.
      for (const queue of liveQueues()) {
        queue.clearLocal(key);
      }
      await options.cache?.l2?.adapter.del?.([String(key)]);
    };

    descriptor.value = wrappedMethod;
    return descriptor;
  };
}
