import { randomUUID } from 'crypto';

export interface RedisLockAdapter {
  setNxPx(key: string, value: string, ttlMs: number): Promise<boolean>;
  evalLua(script: string, keys: string[], args: (string | number)[]): Promise<any>;
}

export const RELEASE_LOCK_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
else
    return 0
end
`.trim();

export const RENEW_LOCK_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("pexpire", KEYS[1], ARGV[2])
else
    return 0
end
`.trim();

export class LockAcquisitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockAcquisitionError';
  }
}

/**
 * Thrown after the protected method settles when the lock lease was lost while it was running
 * (a renewal returned 0, or renewals kept failing for a full TTL). The method's own result must
 * be treated as unsafe: another instance may have been inside the same critical section.
 */
export class LockLostError extends Error {
  cause?: unknown;

  constructor(message: string) {
    super(message);
    this.name = 'LockLostError';
  }
}

export interface DistributedLockOptions {
  /**
   * Lock key string or dynamic key generator function based on invocation arguments.
   */
  key: string | ((...args: any[]) => string);
  /**
   * Lock lease duration in milliseconds. Default is 10,000ms (10 seconds).
   */
  ttlMs?: number;
  /**
   * Maximum duration in milliseconds to wait for lock acquisition. Default is 0 (fail-fast).
   */
  waitTimeoutMs?: number;
  /**
   * Base interval in milliseconds between retry attempts. Default is 100ms.
   */
  retryIntervalMs?: number;
  /**
   * Enable automatic lock extension watchdog while target method is executing. Default is true.
   */
  autoRenew?: boolean;
  /**
   * Fallback function invoked if the lock cannot be acquired within waitTimeoutMs.
   */
  fallback?: (...args: any[]) => any;
  /**
   * Dedicated RedisLockAdapter. If omitted, falls back to globally configured adapter.
   */
  adapter?: RedisLockAdapter;
}

let globalLockAdapter: RedisLockAdapter | null = null;

export function configureDistributedLock(config: { adapter: RedisLockAdapter }): void {
  globalLockAdapter = config.adapter;
}

export function getGlobalDistributedLockAdapter(): RedisLockAdapter | null {
  return globalLockAdapter;
}

export function clearGlobalDistributedLockAdapter(): void {
  globalLockAdapter = null;
}

/**
 * Method decorator that guarantees distributed mutual exclusion backed by a Redis lock.
 */
export function distributedLock(options: DistributedLockOptions) {
  const ttlMs = options.ttlMs ?? 10000;
  const waitTimeoutMs = options.waitTimeoutMs ?? 0;
  const retryIntervalMs = options.retryIntervalMs ?? 100;
  const autoRenew = options.autoRenew ?? true;

  return function (
    target: any,
    propertyKey: string,
    descriptor: TypedPropertyDescriptor<(...args: any[]) => Promise<any>>
  ) {
    const originalMethod = descriptor.value;
    if (!originalMethod) return descriptor;

    descriptor.value = async function (this: any, ...args: any[]) {
      const adapter = options.adapter ?? globalLockAdapter;
      if (!adapter) {
        throw new Error(
          `DistributedLock: No RedisLockAdapter provided for method "${propertyKey}". ` +
            `Pass an adapter in @distributedLock({ adapter }) or call configureDistributedLock({ adapter }).`
        );
      }

      const lockKey = typeof options.key === 'function' ? options.key(...args) : options.key;
      const token = randomUUID();

      const startTime = Date.now();
      let acquired = false;
      // Last instant the lease was known to be ours (taken before the call that confirmed it).
      let lastConfirmedAt = startTime;

      // Acquisition loop
      while (!acquired) {
        lastConfirmedAt = Date.now();
        acquired = await adapter.setNxPx(lockKey, token, ttlMs);
        if (acquired) break;

        const elapsed = Date.now() - startTime;
        if (elapsed >= waitTimeoutMs) {
          break;
        }

        // Add randomized jitter (±20%)
        const jitter = Math.floor(Math.random() * (retryIntervalMs * 0.4)) - (retryIntervalMs * 0.2);
        const sleepMs = Math.max(10, Math.min(retryIntervalMs + jitter, waitTimeoutMs - elapsed));
        await new Promise((resolve) => setTimeout(resolve, sleepMs));
      }

      if (!acquired) {
        if (options.fallback) {
          return options.fallback.apply(this, args);
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
        const markLost = () => {
          lockLost = true;
          if (watchdogTimer) {
            clearInterval(watchdogTimer);
            watchdogTimer = null;
          }
        };
        watchdogTimer = setInterval(async () => {
          const sentAt = Date.now();
          try {
            const renewed = await adapter.evalLua(RENEW_LOCK_LUA, [lockKey], [token, ttlMs]);
            if (!renewed || renewed === 0) {
              markLost();
            } else {
              lastConfirmedAt = Math.max(lastConfirmedAt, sentAt);
            }
          } catch {
            // A thrown renewal is "unknown", not "lost": retry on the next tick. Only once a
            // full TTL has passed without a confirmed renewal has the lease certainly expired.
            if (Date.now() - lastConfirmedAt >= ttlMs) {
              markLost();
            }
          }
        }, renewPeriodMs);

        if (watchdogTimer && typeof watchdogTimer.unref === 'function') {
          watchdogTimer.unref();
        }
      }

      let result: any;
      let methodError: unknown;
      let methodFailed = false;
      try {
        result = await originalMethod.apply(this, args);
      } catch (err) {
        methodFailed = true;
        methodError = err;
      }

      if (watchdogTimer) {
        clearInterval(watchdogTimer);
        watchdogTimer = null;
      }

      // Always attempt the release: the script is token-guarded, so it is a no-op when the
      // lease is no longer ours and frees the key immediately when it still is.
      try {
        await adapter.evalLua(RELEASE_LOCK_LUA, [lockKey], [token]);
      } catch {
        // Ignore release errors on shutdown
      }

      if (lockLost) {
        const lost = new LockLostError(
          `Distributed lock for key "${lockKey}" was lost while "${propertyKey}" was running`
        );
        if (methodFailed) lost.cause = methodError;
        throw lost;
      }
      if (methodFailed) throw methodError;
      return result;
    };

    return descriptor;
  };
}
