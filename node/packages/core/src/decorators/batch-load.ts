import { AsyncLocalStorage } from 'async_hooks';

export interface MGetCacheAdapter {
  mget(keys: string[]): Promise<Map<string, any> | Record<string, any>>;
  setMany(items: Map<string, any> | Record<string, any>, ttlSeconds?: number): Promise<void>;
  del?(keys: string[]): Promise<void>;
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
   * Optional AsyncLocalStorage for request-scoped context isolation.
   */
  contextStorage?: AsyncLocalStorage<any>;
  /**
   * Optional multi-tier caching configuration (L1 memory LRU + L2 distributed Redis MGET).
   */
  cache?: {
    l1?: { maxEntries?: number; ttlMs?: number };
    l2?: { adapter: MGetCacheAdapter; ttlSeconds?: number };
    negativeTtlSeconds?: number;
  };
}

interface QueuedItem<K, V> {
  key: K;
  resolve: (value: V) => void;
  reject: (reason: any) => void;
}

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
    cacheOptions?: BatchLoadOptions<K, V>['cache']
  ) {
    if (cacheOptions?.l1) {
      this.l1Cache = new LruCache<K, any>(
        cacheOptions.l1.maxEntries ?? 10000,
        cacheOptions.l1.ttlMs ?? 10000
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

    const promise = new Promise<V>((resolve, reject) => {
      this.queue.push({ key, resolve, reject });

      if (this.queue.length >= this.maxBatchSize) {
        this.dispatch().catch(() => {});
      } else if (!this.scheduled) {
        this.scheduleDispatch();
      }
    });

    if (this.deduplicate) {
      this.inFlightPromises.set(key, promise);
      // Clean up from in-flight cache once settled without creating an unhandled rejection branch
      const cleanup = () => {
        this.inFlightPromises.delete(key);
      };
      promise.then(cleanup, cleanup);
    }

    return promise;
  }

  public async clear(key: K): Promise<void> {
    if (this.l1Cache) {
      this.l1Cache.delete(key);
    }
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
    if (this.l2Adapter) {
      try {
        const strKeys = Array.from(new Set(l1Misses.map((it) => String(it.key))));
        const mgetRes = await this.l2Adapter.mget(strKeys);
        const l2Map = this.normalizeResult(mgetRes as any);

        for (const item of l1Misses) {
          const strKey = String(item.key) as unknown as K;
          if (l2Map.has(strKey) || l2Map.has(item.key)) {
            const val = l2Map.get(strKey) ?? l2Map.get(item.key)!;
            if (this.l1Cache) {
              this.l1Cache.set(item.key, val);
            }
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
      const l2SetItems = new Map<string, any>();

      for (const item of l2Misses) {
        if (resultMap.has(item.key)) {
          const val = resultMap.get(item.key)!;
          if (this.l1Cache) {
            this.l1Cache.set(item.key, val);
          }
          if (this.l2Adapter) {
            l2SetItems.set(String(item.key), val);
          }
          item.resolve(val);
        } else {
          // Negative cache missing key
          if (this.l1Cache) {
            this.l1Cache.set(item.key, MISSING_SENTINEL, this.negativeTtlMs);
          }
          item.resolve(undefined as unknown as V);
        }
      }

      if (this.l2Adapter && l2SetItems.size > 0) {
        this.l2Adapter.setMany(l2SetItems, this.l2TtlSeconds).catch(() => {});
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
    const map = new Map<K, V>();
    if (Array.isArray(result)) {
      for (const item of result) {
        if (item != null) {
          const k = this.keyOf ? this.keyOf(item) : ((item as any).id ?? (item as any).key);
          if (k !== undefined) {
            map.set(k, item);
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
 * with optional multi-tier L1 memory LRU and L2 distributed Redis MGET caching.
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
    const allQueues = new Set<BatchQueue<K, V>>();

    const wrappedMethod: any = async function (this: any, ...args: any[]) {
      const key = args[0] as K;

      // Determine the loader batch function
      let batchFn = options.batchFn;
      if (!batchFn && options.batchMethod) {
        const method = (this as any)[options.batchMethod];
        if (typeof method === 'function') {
          batchFn = method.bind(this);
        }
      }

      if (!batchFn) {
        // Fallback to original method if no batch implementation exists
        return originalMethod?.apply(this, args);
      }

      // If request-scoped AsyncLocalStorage is provided, scope queue to store context
      const scopeTarget = options.contextStorage ? (options.contextStorage.getStore() ?? this) : this;

      let queue = queues.get(scopeTarget);
      if (!queue) {
        queue = new BatchQueue<K, V>(
          batchFn,
          maxBatchSize,
          windowMs,
          deduplicate,
          options.keyOf,
          options.cache
        );
        queues.set(scopeTarget, queue);
        allQueues.add(queue);
      }

      return queue.load(key);
    };

    wrappedMethod.clear = async function (key: K, instance?: any) {
      if (instance) {
        const queue = queues.get(instance);
        if (queue) {
          await queue.clear(key);
          return;
        }
      }
      for (const queue of allQueues) {
        await queue.clear(key);
      }
    };

    descriptor.value = wrappedMethod;
    return descriptor;
  };
}
