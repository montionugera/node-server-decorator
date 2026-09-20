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

      // Acquisition loop
      while (!acquired) {
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
        return await originalMethod.apply(this, args);
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

    return descriptor;
  };
}
