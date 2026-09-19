import { AsyncLocalStorage } from 'async_hooks';

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
}

interface QueuedItem<K, V> {
  key: K;
  resolve: (value: V) => void;
  reject: (reason: any) => void;
}

class BatchQueue<K, V> {
  private queue: QueuedItem<K, V>[] = [];
  private scheduled = false;
  private inFlightPromises = new Map<K, Promise<V>>();

  constructor(
    private loaderFn: (keys: K[]) => Promise<Map<K, V> | V[] | Record<string, V>>,
    private maxBatchSize: number,
    private windowMs: number,
    private deduplicate: boolean,
    private keyOf?: (item: V) => K
  ) {}

  public load(key: K): Promise<V> {
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

    // Extract unique keys
    const uniqueKeys: K[] = [];
    const seen = new Set<any>();
    for (const item of batch) {
      if (!seen.has(item.key)) {
        seen.add(item.key);
        uniqueKeys.push(item.key);
      }
    }

    try {
      const result = await this.loaderFn(uniqueKeys);
      const resultMap = this.normalizeResult(result);

      for (const item of batch) {
        if (resultMap.has(item.key)) {
          item.resolve(resultMap.get(item.key)!);
        } else {
          // If key not found in batch result, resolve with undefined / null
          item.resolve(undefined as unknown as V);
        }
      }
    } catch (err) {
      for (const item of batch) {
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
 * Method decorator that transparently coalesces concurrent individual lookups into a single batch execution.
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

    descriptor.value = async function (...args: any[]) {
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
        queue = new BatchQueue<K, V>(batchFn, maxBatchSize, windowMs, deduplicate, options.keyOf);
        queues.set(scopeTarget, queue);
      }

      return queue.load(key);
    };

    return descriptor;
  };
}
