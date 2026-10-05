import { randomUUID } from 'crypto';
import { retry, RetryOptions } from '../decorators/retry';
import { cache, CacheAdapter, CACHE_MISS } from '../decorators/cache';
import { buildCacheKey } from '../decorators/_cache_key';
import {
  circuitBreaker,
  CircuitBreakerOpenError,
  CircuitBreakerOptions,
  getCircuitBreaker,
} from '../decorators/circuit-breaker';
import {
  rateLimitRegistry,
  RateLimitExceededError,
  RateLimitOptions,
  TokenBucket,
} from '../decorators/rate-limit';
import {
  DistributedLockOptions,
  getGlobalDistributedLockAdapter,
  LockAcquisitionError,
  RELEASE_LOCK_LUA,
  RENEW_LOCK_LUA,
} from '../decorators/distributed-lock';
import { trace, TraceOptions, getActiveTraceContext } from '../decorators/trace';
import { globalTracker } from '../tracker';
import { globalLogger } from '../logger';

const isThenable = (v: unknown): v is PromiseLike<unknown> =>
  v != null && typeof (v as { then?: unknown }).then === 'function';

/**
 * Functional wrapper for retry with exponential backoff and jitter.
 */
export function withRetry<T, Args extends any[] = any[]>(
  fn: (...args: Args) => Promise<T> | T,
  options: RetryOptions = {}
): (...args: Args) => Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const backoffMs = options.backoffMs ?? 50;
  const maxBackoffMs = options.maxBackoffMs ?? 2000;
  const factor = options.factor ?? 2.0;
  const jitter = options.jitter ?? true;
  const retryIf = options.retryIf;

  return async (...args: Args): Promise<T> => {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = fn(...args);
        return (isThenable(res) ? await res : res) as T;
      } catch (err) {
        if (attempt >= maxAttempts) {
          throw err;
        }
        if (retryIf && !retryIf(err as Error)) {
          throw err;
        }

        let delay = backoffMs * Math.pow(factor, attempt - 1);
        if (delay > maxBackoffMs) {
          delay = maxBackoffMs;
        }
        if (jitter && delay > 0) {
          delay = Math.random() * delay;
        }

        if (delay > 0) {
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
    throw new Error('Retry exhausted without result');
  };
}

export interface WithCacheOptions {
  adapter?: CacheAdapter;
  cacheAdapter?: CacheAdapter;
  ttl?: number;
  TTL?: number;
  name?: string;
}

class DefaultInMemoryCacheAdapter implements CacheAdapter {
  private store = new Map<string, { value: unknown; expiresAt?: number }>();

  get(key: string): unknown {
    const entry = this.store.get(key);
    if (!entry) return CACHE_MISS;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return CACHE_MISS;
    }
    return entry.value;
  }

  set(key: string, value: unknown, ttl: number): void {
    const expiresAt = ttl > 0 ? Date.now() + ttl * 1000 : undefined;
    this.store.set(key, { value, expiresAt });
  }
}

const defaultCacheAdapter = new DefaultInMemoryCacheAdapter();

/**
 * Functional wrapper for caching function results.
 */
export function withCache<T, Args extends any[] = any[]>(
  fn: (...args: Args) => Promise<T> | T,
  options?: WithCacheOptions | CacheAdapter | number
): (...args: Args) => Promise<T> {
  let adapter: CacheAdapter = defaultCacheAdapter;
  let ttl = 60;
  let nameOption: string | undefined;

  if (typeof options === 'number') {
    ttl = options;
  } else if (
    options &&
    typeof (options as CacheAdapter).get === 'function' &&
    typeof (options as CacheAdapter).set === 'function'
  ) {
    adapter = options as CacheAdapter;
  } else if (options && typeof options === 'object') {
    const opts = options as WithCacheOptions;
    if (opts.adapter) adapter = opts.adapter;
    else if (opts.cacheAdapter) adapter = opts.cacheAdapter;
    if (opts.ttl !== undefined) ttl = opts.ttl;
    else if (opts.TTL !== undefined) ttl = opts.TTL;
    if (opts.name) nameOption = opts.name;
  }

  const qualname =
    nameOption || (fn.name && fn.name !== 'anonymous' ? fn.name : `cache_${randomUUID()}`);

  return async (...args: Args): Promise<T> => {
    const key = buildCacheKey(qualname, args);
    const cached = adapter.get(key);
    const awaited = isThenable(cached) ? await cached : cached;

    if (awaited !== CACHE_MISS) {
      return awaited as T;
    }

    const res = fn(...args);
    const resolved = isThenable(res) ? await res : res;
    const setResult = adapter.set(key, resolved, ttl);
    if (isThenable(setResult)) {
      await setResult;
    }
    return resolved as T;
  };
}

/**
 * Functional wrapper for 3-state circuit breaker protection.
 */
export function withCircuitBreaker<T, Args extends any[] = any[]>(
  fn: (...args: Args) => Promise<T> | T,
  options: CircuitBreakerOptions = {}
): (...args: Args) => Promise<T> {
  const breakerName =
    options.name || (fn.name && fn.name !== 'anonymous' ? fn.name : `cb_${randomUUID()}`);
  const cb = getCircuitBreaker(breakerName, { ...options, name: breakerName });

  return async (...args: Args): Promise<T> => {
    if (!cb.allowRequest()) {
      const err = new CircuitBreakerOpenError(breakerName);
      if (options.fallback) {
        const fallbackRes = options.fallback(err, ...args);
        return (isThenable(fallbackRes) ? await fallbackRes : fallbackRes) as T;
      }
      throw err;
    }

    try {
      const res = fn(...args);
      const resolved = isThenable(res) ? await res : res;
      cb.recordSuccess();
      return resolved as T;
    } catch (err) {
      cb.recordFailure();
      if (options.fallback) {
        const fallbackRes = options.fallback(err as Error, ...args);
        return (isThenable(fallbackRes) ? await fallbackRes : fallbackRes) as T;
      }
      throw err;
    }
  };
}

export interface WithRateLimitOptions<Args extends any[] = any[]>
  extends Omit<RateLimitOptions, 'keyExtractor'> {
  name?: string;
  keyExtractor?: (...args: Args) => string;
}

/**
 * Functional wrapper for token-bucket rate limiting.
 */
export function withRateLimit<T, Args extends any[] = any[]>(
  fn: (...args: Args) => Promise<T> | T,
  options: WithRateLimitOptions<Args> = {}
): (...args: Args) => Promise<T> {
  const capacity = options.capacity ?? 10;
  const refillRate = options.refillRate ?? 5.0;
  const cost = options.cost ?? 1;
  const baseKey =
    options.name || (fn.name && fn.name !== 'anonymous' ? fn.name : `rl_${randomUUID()}`);

  return async (...args: Args): Promise<T> => {
    const key = options.keyExtractor ? `${baseKey}:${options.keyExtractor(...args)}` : baseKey;

    let bucket = rateLimitRegistry.get(key);
    if (!bucket) {
      bucket = new TokenBucket(capacity, refillRate);
      rateLimitRegistry.set(key, bucket);
    }

    if (!bucket.allow(cost)) {
      throw new RateLimitExceededError(key);
    }

    const res = fn(...args);
    return (isThenable(res) ? await res : res) as T;
  };
}

/**
 * Functional wrapper for distributed locking.
 */
export function withDistributedLock<T, Args extends any[] = any[]>(
  lockKeyOrResolver: string | ((...args: any[]) => string),
  fn: (...args: Args) => Promise<T> | T,
  options?: Omit<DistributedLockOptions, 'key'>
): (...args: Args) => Promise<T>;
export function withDistributedLock<T, Args extends any[] = any[]>(
  fn: (...args: Args) => Promise<T> | T,
  options: DistributedLockOptions
): (...args: Args) => Promise<T>;
export function withDistributedLock<T, Args extends any[] = any[]>(
  first: (string | ((...args: any[]) => string)) | ((...args: Args) => Promise<T> | T),
  second?: ((...args: Args) => Promise<T> | T) | DistributedLockOptions,
  third?: Omit<DistributedLockOptions, 'key'>
): (...args: Args) => Promise<T> {
  let lockKeyOrResolver: string | ((...args: any[]) => string);
  let fn: (...args: Args) => Promise<T> | T;
  let opts: Partial<DistributedLockOptions>;

  if (
    typeof first === 'function' &&
    typeof second === 'object' &&
    second !== null &&
    'key' in second
  ) {
    fn = first as (...args: Args) => Promise<T> | T;
    opts = second as DistributedLockOptions;
    lockKeyOrResolver = (second as DistributedLockOptions).key;
  } else {
    lockKeyOrResolver = first as string | ((...args: any[]) => string);
    fn = second as (...args: Args) => Promise<T> | T;
    opts = third ?? {};
  }

  const ttlMs = opts.ttlMs ?? 10000;
  const waitTimeoutMs = opts.waitTimeoutMs ?? 0;
  const retryIntervalMs = opts.retryIntervalMs ?? 100;
  const autoRenew = opts.autoRenew ?? true;

  return async (...args: Args): Promise<T> => {
    const adapter = opts.adapter ?? getGlobalDistributedLockAdapter();
    if (!adapter) {
      throw new Error(
        `DistributedLock: No RedisLockAdapter provided. Pass an adapter in options or call configureDistributedLock({ adapter }).`
      );
    }

    const lockKey =
      typeof lockKeyOrResolver === 'function' ? lockKeyOrResolver(...args) : lockKeyOrResolver;
    const token = randomUUID();

    const startTime = Date.now();
    let acquired = false;

    // Acquisition loop
    while (!acquired) {
      acquired = await adapter.setNxPx(lockKey, token, ttlMs);
      if (acquired) break;

      const elapsed = Date.now() - startTime;
      if (elapsed >= waitTimeoutMs) {
        break;
      }

      // Add randomized jitter (±20%)
      const jitter = Math.floor(Math.random() * (retryIntervalMs * 0.4)) - retryIntervalMs * 0.2;
      const sleepMs = Math.max(10, Math.min(retryIntervalMs + jitter, waitTimeoutMs - elapsed));
      await new Promise((resolve) => setTimeout(resolve, sleepMs));
    }

    if (!acquired) {
      if (opts.fallback) {
        const fbRes = opts.fallback(...args);
        return (isThenable(fbRes) ? await fbRes : fbRes) as T;
      }
      throw new LockAcquisitionError(
        `Failed to acquire distributed lock for key "${lockKey}" within ${waitTimeoutMs}ms`
      );
    }

    // Heartbeat renewal watchdog
    let watchdogTimer: NodeJS.Timeout | null = null;
    let lockLost = false;

    if (autoRenew) {
      const renewPeriodMs = Math.max(20, Math.floor(ttlMs / 3));
      watchdogTimer = setInterval(async () => {
        try {
          const renewed = await adapter.evalLua(RENEW_LOCK_LUA, [lockKey], [token, ttlMs]);
          if (!renewed || renewed === 0) {
            lockLost = true;
            if (watchdogTimer) {
              clearInterval(watchdogTimer);
              watchdogTimer = null;
            }
          }
        } catch {
          lockLost = true;
        }
      }, renewPeriodMs);

      if (watchdogTimer && typeof watchdogTimer.unref === 'function') {
        watchdogTimer.unref();
      }
    }

    try {
      const res = fn(...args);
      return (isThenable(res) ? await res : res) as T;
    } finally {
      if (watchdogTimer) {
        clearInterval(watchdogTimer);
        watchdogTimer = null;
      }

      // Release lock only if we haven't lost it
      if (!lockLost) {
        try {
          await adapter.evalLua(RELEASE_LOCK_LUA, [lockKey], [token]);
        } catch {
          // Ignore release errors on shutdown
        }
      }
    }
  };
}

/**
 * Functional wrapper for OpenTelemetry tracing and context propagation.
 */
export function withTrace<T, Args extends any[] = any[]>(
  spanName: string,
  fn: (...args: Args) => Promise<T> | T,
  options?: TraceOptions
): (...args: Args) => Promise<T>;
export function withTrace<T, Args extends any[] = any[]>(
  fn: (...args: Args) => Promise<T> | T,
  options?: TraceOptions
): (...args: Args) => Promise<T>;
export function withTrace<T, Args extends any[] = any[]>(
  first: string | ((...args: Args) => Promise<T> | T),
  second?: ((...args: Args) => Promise<T> | T) | TraceOptions,
  third?: TraceOptions
): (...args: Args) => Promise<T> {
  let spanName: string;
  let fn: (...args: Args) => Promise<T> | T;
  let options: TraceOptions | undefined;

  if (typeof first === 'function') {
    fn = first;
    options = second as TraceOptions | undefined;
    spanName = options?.name || fn.name || 'anonymous';
  } else {
    spanName = first;
    fn = second as (...args: Args) => Promise<T> | T;
    options = third;
  }

  const desc = trace({ ...options, name: spanName })({}, spanName, { value: fn as any });
  return desc.value as (...args: Args) => Promise<T>;
}

/**
 * Functional wrapper for metric latency and error tracking.
 */
export function withTracking<T, Args extends any[] = any[]>(
  eventType: string,
  fn: (...args: Args) => Promise<T> | T,
  options?: any
): (...args: Args) => Promise<T>;
export function withTracking<T, Args extends any[] = any[]>(
  fn: (...args: Args) => Promise<T> | T,
  options?: any
): (...args: Args) => Promise<T>;
export function withTracking<T, Args extends any[] = any[]>(
  first: string | ((...args: Args) => Promise<T> | T),
  second?: ((...args: Args) => Promise<T> | T) | any,
  third?: any
): (...args: Args) => Promise<T> {
  let eventType: string;
  let fn: (...args: Args) => Promise<T> | T;
  let options: any;

  if (typeof first === 'function') {
    fn = first;
    options = second;
    eventType = options?.name || options?.eventType || fn.name || 'anonymous';
  } else {
    eventType = first;
    fn = second as (...args: Args) => Promise<T> | T;
    options = third;
  }

  return async (...args: Args): Promise<T> => {
    const start = Date.now();
    let result: any;
    let isError = false;
    let foundError: Error | null = null;
    try {
      const res = fn(...args);
      result = isThenable(res) ? await res : res;
      return result;
    } catch (error) {
      foundError = error as Error;
      isError = true;
      throw error;
    } finally {
      const latency = Date.now() - start;
      const key = eventType;
      if (isError) {
        globalLogger.error(`[Tracking] ${key} - Latency: ${latency}ms, Error: ${foundError}`);
      }
      globalTracker.track(key, latency, isError);
    }
  };
}
