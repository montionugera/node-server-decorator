export enum CircuitState {
  CLOSED = 'closed',
  OPEN = 'open',
  HALF_OPEN = 'half-open',
}

export class CircuitBreakerOpenError extends Error {
  readonly breakerName: string;
  constructor(breakerName: string, message?: string) {
    super(message || `Circuit breaker '${breakerName}' is open`);
    this.name = 'CircuitBreakerOpenError';
    this.breakerName = breakerName;
  }
}

export interface CircuitBreakerOptions {
  name?: string;
  failureThreshold?: number;
  recoveryTimeoutMs?: number;
  halfOpenSuccessThreshold?: number;
  fallback?: (error: Error, ...args: unknown[]) => unknown | Promise<unknown>;
}

export class CircuitBreaker {
  readonly name: string;
  readonly failureThreshold: number;
  readonly recoveryTimeoutMs: number;
  readonly halfOpenSuccessThreshold: number;

  private _state: CircuitState = CircuitState.CLOSED;
  private failureCount: number = 0;
  private consecutiveSuccessCount: number = 0;
  private lastStateChange: number = Date.now();

  constructor(options: CircuitBreakerOptions = {}) {
    this.name = options.name ?? 'default';
    this.failureThreshold = options.failureThreshold ?? 5;
    this.recoveryTimeoutMs = options.recoveryTimeoutMs ?? 5000;
    this.halfOpenSuccessThreshold = options.halfOpenSuccessThreshold ?? 2;
  }

  get state(): CircuitState {
    if (
      this._state === CircuitState.OPEN &&
      Date.now() - this.lastStateChange >= this.recoveryTimeoutMs
    ) {
      this._state = CircuitState.HALF_OPEN;
      this.consecutiveSuccessCount = 0;
      this.failureCount = 0;
      this.lastStateChange = Date.now();
    }
    return this._state;
  }

  allowRequest(): boolean {
    const s = this.state;
    return s === CircuitState.CLOSED || s === CircuitState.HALF_OPEN;
  }

  recordSuccess(): void {
    if (this.state === CircuitState.HALF_OPEN) {
      this.consecutiveSuccessCount++;
      if (this.consecutiveSuccessCount >= this.halfOpenSuccessThreshold) {
        this._state = CircuitState.CLOSED;
        this.failureCount = 0;
        this.consecutiveSuccessCount = 0;
        this.lastStateChange = Date.now();
      }
    } else if (this.state === CircuitState.CLOSED) {
      this.failureCount = 0;
    }
  }

  recordFailure(): void {
    if (this.state === CircuitState.HALF_OPEN) {
      this._state = CircuitState.OPEN;
      this.failureCount++;
      this.consecutiveSuccessCount = 0;
      this.lastStateChange = Date.now();
    } else if (this.state === CircuitState.CLOSED) {
      this.failureCount++;
      if (this.failureCount >= this.failureThreshold) {
        this._state = CircuitState.OPEN;
        this.lastStateChange = Date.now();
      }
    }
  }

  reset(): void {
    this._state = CircuitState.CLOSED;
    this.failureCount = 0;
    this.consecutiveSuccessCount = 0;
    this.lastStateChange = Date.now();
  }
}

export const circuitBreakerRegistry = new Map<string, CircuitBreaker>();

export function getCircuitBreaker(name: string, options?: CircuitBreakerOptions): CircuitBreaker {
  let cb = circuitBreakerRegistry.get(name);
  if (!cb) {
    cb = new CircuitBreaker({ ...options, name });
    circuitBreakerRegistry.set(name, cb);
  }
  return cb;
}

export function clearCircuitBreakerRegistry(): void {
  circuitBreakerRegistry.clear();
}

const isThenable = (v: unknown): v is PromiseLike<unknown> =>
  v != null && typeof (v as { then?: unknown }).then === 'function';

/**
 * @circuitBreaker decorator wraps a method with 3-state circuit breaker protection.
 */
export function circuitBreaker(options: CircuitBreakerOptions = {}) {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;
    const breakerName = options.name ?? `${target.constructor.name}.${propertyKey}`;
    const cb = getCircuitBreaker(breakerName, { ...options, name: breakerName });

    descriptor.value = async function (...args: unknown[]) {
      if (!cb.allowRequest()) {
        const err = new CircuitBreakerOpenError(breakerName);
        if (options.fallback) {
          return options.fallback(err, ...args);
        }
        throw err;
      }

      try {
        const res = originalMethod.apply(this, args);
        const resolved = isThenable(res) ? await res : res;
        cb.recordSuccess();
        return resolved;
      } catch (err) {
        cb.recordFailure();
        if (options.fallback) {
          return options.fallback(err as Error, ...args);
        }
        throw err;
      }
    };
    return descriptor;
  };
}
