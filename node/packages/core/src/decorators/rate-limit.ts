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
    this.lastRefill = Date.now();
  }

  allow(cost: number = 1): boolean {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.lastRefill = now;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillRate);

    if (this.tokens >= cost) {
      this.tokens -= cost;
      return true;
    }
    return false;
  }

  availableTokens(): number {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    return Math.min(this.capacity, this.tokens + elapsed * this.refillRate);
  }
}

export const rateLimitRegistry = new Map<string, TokenBucket>();

export function clearRateLimitRegistry(): void {
  rateLimitRegistry.clear();
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
    const baseKey = `${target.constructor.name}.${propertyKey}`;

    descriptor.value = async function (...args: unknown[]) {
      const key = options.keyExtractor ? `${baseKey}:${options.keyExtractor(...args)}` : baseKey;

      let bucket = rateLimitRegistry.get(key);
      if (!bucket) {
        bucket = new TokenBucket(capacity, refillRate);
        rateLimitRegistry.set(key, bucket);
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
