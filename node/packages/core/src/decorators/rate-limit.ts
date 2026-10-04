import { performance } from 'perf_hooks';
import { globalLogger } from '../logger';
import { resolveClassName } from './_class-name';

export class RateLimitExceededError extends Error {
  readonly limitKey: string;
  constructor(limitKey: string, message?: string) {
    super(message || `Rate limit exceeded for '${limitKey}'`);
    this.name = 'RateLimitExceededError';
    this.limitKey = limitKey;
  }
}

export interface RateLimitOptions {
  capacity?: number;
  refillRate?: number; // tokens per second
  cost?: number;
  keyExtractor?: (...args: unknown[]) => string;
}

export class TokenBucket {
  readonly capacity: number;
  readonly refillRate: number;
  private tokens: number;
  private lastRefill: number;

  constructor(capacity: number = 10, refillRate: number = 5.0) {
    this.capacity = capacity;
    this.refillRate = refillRate;
    this.tokens = capacity;
    this.lastRefill = performance.now();
  }

  allow(cost: number = 1): boolean {
    const now = performance.now();
    const elapsed = Math.max(0, now - this.lastRefill) / 1000;
    this.lastRefill = now;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillRate);

    if (this.tokens >= cost) {
      this.tokens -= cost;
      return true;
    }
    return false;
  }

  availableTokens(): number {
    const elapsed = Math.max(0, performance.now() - this.lastRefill) / 1000;
    return Math.min(this.capacity, this.tokens + elapsed * this.refillRate);
  }
}

export const rateLimitRegistry = new Map<string, TokenBucket>();

// Idle-bucket eviction (contracts/rules/resilience.md): a bucket that has refilled to
// capacity is indistinguishable from a fresh one, so dropping it loses no state.
const EVICTION_SWEEP_MIN_SIZE = 1024;
let nextSweepSize = EVICTION_SWEEP_MIN_SIZE;

function evictIdleBuckets(): void {
  for (const [key, bucket] of rateLimitRegistry) {
    if (bucket.availableTokens() >= bucket.capacity) {
      rateLimitRegistry.delete(key);
    }
  }
  nextSweepSize = Math.max(EVICTION_SWEEP_MIN_SIZE, rateLimitRegistry.size * 2);
}

export function clearRateLimitRegistry(): void {
  rateLimitRegistry.clear();
  nextSweepSize = EVICTION_SWEEP_MIN_SIZE;
}

const isThenable = (v: unknown): v is PromiseLike<unknown> =>
  v != null && typeof (v as { then?: unknown }).then === 'function';

/**
 * @rateLimit decorator wraps a method with token-bucket rate limiting.
 */
export function rateLimit(options: RateLimitOptions = {}) {
  const capacity = options.capacity ?? 10;
  const refillRate = options.refillRate ?? 5.0;
  const cost = options.cost ?? 1;

  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;
    // For a static method `target` is the constructor itself.
    const className = resolveClassName(target);
    const baseKey = `${className}.${propertyKey}`;
    let warned = false;

    descriptor.value = async function (...args: unknown[]) {
      const key = options.keyExtractor ? `${baseKey}:${options.keyExtractor(...args)}` : baseKey;

      let bucket = rateLimitRegistry.get(key);
      if (!bucket) {
        if (rateLimitRegistry.size >= nextSweepSize) {
          evictIdleBuckets();
        }
        bucket = new TokenBucket(capacity, refillRate);
        rateLimitRegistry.set(key, bucket);
      }

      if (!warned && (bucket.capacity !== capacity || bucket.refillRate !== refillRate)) {
        warned = true;
        globalLogger.warn(
          `@rateLimit: bucket '${key}' is already registered with different options; ` +
            `${baseKey} shares it and its own capacity/refillRate are ignored`,
        );
      }

      if (!bucket.allow(cost)) {
        throw new RateLimitExceededError(key);
      }

      const res = originalMethod.apply(this, args);
      return isThenable(res) ? await res : res;
    };
    return descriptor;
  };
}
