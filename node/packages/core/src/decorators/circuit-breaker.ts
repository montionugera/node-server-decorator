import { performance } from 'perf_hooks';
import { globalLogger } from '../logger';
import { resolveClassName } from './_class-name';

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

const resolveThresholds = (options: CircuitBreakerOptions) => ({
  failureThreshold: options.failureThreshold ?? 5,
  recoveryTimeoutMs: options.recoveryTimeoutMs ?? 5000,
  halfOpenSuccessThreshold: options.halfOpenSuccessThreshold ?? 2,
});

export class CircuitBreaker {
  readonly name: string;
  readonly failureThreshold: number;
  readonly recoveryTimeoutMs: number;
  readonly halfOpenSuccessThreshold: number;

  private _state: CircuitState = CircuitState.CLOSED;
  private failureCount: number = 0;
  private consecutiveSuccessCount: number = 0;
  // Monotonic clock: wall-clock steps must not stretch or shorten the recovery timeout.
  private lastStateChange: number = performance.now();
  // Probes admitted in HALF_OPEN whose result has not been recorded yet.
  private halfOpenInFlight: number = 0;
  // Bumped on every state transition; a result recorded with an older epoch is stale.
  private epoch: number = 0;

  constructor(options: CircuitBreakerOptions = {}) {
    this.name = options.name ?? 'default';
    const thresholds = resolveThresholds(options);
    this.failureThreshold = thresholds.failureThreshold;
    this.recoveryTimeoutMs = thresholds.recoveryTimeoutMs;
    this.halfOpenSuccessThreshold = thresholds.halfOpenSuccessThreshold;
  }

  private transition(to: CircuitState): void {
    this._state = to;
    this.epoch++;
    this.halfOpenInFlight = 0;
    this.consecutiveSuccessCount = 0;
    this.lastStateChange = performance.now();
  }

  get state(): CircuitState {
    if (
      this._state === CircuitState.OPEN &&
      performance.now() - this.lastStateChange >= this.recoveryTimeoutMs
    ) {
      this.transition(CircuitState.HALF_OPEN);
      this.failureCount = 0;
    }
    return this._state;
  }

  /**
   * Admit a call. Returns the admission epoch to hand back to recordSuccess/recordFailure,
   * or null when the call must be rejected. In HALF_OPEN at most halfOpenSuccessThreshold
   * probes are in flight at once.
   */
  acquire(): number | null {
    const s = this.state;
    if (s === CircuitState.OPEN) {
      return null;
    }
    if (s === CircuitState.HALF_OPEN) {
      if (this.halfOpenInFlight >= this.halfOpenSuccessThreshold) {
        const now = performance.now();
        if (now - this.lastStateChange < this.recoveryTimeoutMs) {
          return null;
        }
        // Probes that never reported back are treated as abandoned; the epoch bump makes any
        // late result from them stale instead of counting it against the new probes.
        this.epoch++;
        this.halfOpenInFlight = 0;
        this.lastStateChange = now;
      }
      this.halfOpenInFlight++;
    }
    return this.epoch;
  }

  allowRequest(): boolean {
    return this.acquire() !== null;
  }

  recordSuccess(epoch?: number): void {
    const s = this.state;
    if (epoch !== undefined && epoch !== this.epoch) {
      return;
    }
    if (s === CircuitState.HALF_OPEN) {
      if (epoch === undefined && this.halfOpenInFlight === 0) {
        return;
      }
      if (this.halfOpenInFlight > 0) this.halfOpenInFlight--;
      this.consecutiveSuccessCount++;
      if (this.consecutiveSuccessCount >= this.halfOpenSuccessThreshold) {
        this.transition(CircuitState.CLOSED);
        this.failureCount = 0;
      }
    } else if (s === CircuitState.CLOSED) {
      this.failureCount = 0;
    }
  }

  recordFailure(epoch?: number): void {
    const s = this.state;
    if (epoch !== undefined && epoch !== this.epoch) {
      return;
    }
    if (s === CircuitState.HALF_OPEN) {
      this.transition(CircuitState.OPEN);
      this.failureCount++;
    } else if (s === CircuitState.CLOSED) {
      this.failureCount++;
      if (this.failureCount >= this.failureThreshold) {
        this.transition(CircuitState.OPEN);
      }
    }
  }

  reset(): void {
    this.transition(CircuitState.CLOSED);
    this.failureCount = 0;
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
    // For a static method `target` is the constructor itself.
    const className = resolveClassName(target);
    const breakerName = options.name ?? `${className}.${propertyKey}`;
    const breakerOptions = { ...options, name: breakerName };

    const wanted = resolveThresholds(options);
    let warnedFor: CircuitBreaker | undefined;
    const resolve = (): CircuitBreaker => {
      // Resolved per call so a registry clear/replace is honoured by decorated methods.
      const cb = getCircuitBreaker(breakerName, breakerOptions);
      if (
        cb !== warnedFor &&
        (cb.failureThreshold !== wanted.failureThreshold ||
          cb.recoveryTimeoutMs !== wanted.recoveryTimeoutMs ||
          cb.halfOpenSuccessThreshold !== wanted.halfOpenSuccessThreshold)
      ) {
        warnedFor = cb;
        globalLogger.warn(
          `@circuitBreaker: breaker '${breakerName}' is already registered with different options; ` +
            `${className}.${propertyKey} shares it and its own thresholds are ignored`,
        );
      }
      return cb;
    };
    resolve();

    descriptor.value = async function (...args: unknown[]) {
      const cb = resolve();
      const epoch = cb.acquire();
      if (epoch === null) {
        const err = new CircuitBreakerOpenError(breakerName);
        if (options.fallback) {
          return options.fallback(err, ...args);
        }
        throw err;
      }

      try {
        const res = originalMethod.apply(this, args);
        const resolved = isThenable(res) ? await res : res;
        cb.recordSuccess(epoch);
        return resolved;
      } catch (err) {
        cb.recordFailure(epoch);
        if (options.fallback) {
          return options.fallback(err as Error, ...args);
        }
        throw err;
      }
    };
    return descriptor;
  };
}
