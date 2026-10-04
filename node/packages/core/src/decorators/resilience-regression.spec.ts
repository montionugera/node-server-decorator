import { performance } from 'perf_hooks';
import { globalLogger } from '../logger';
import {
  circuitBreaker,
  CircuitBreaker,
  CircuitBreakerOpenError,
  CircuitState,
  circuitBreakerRegistry,
  clearCircuitBreakerRegistry,
  getCircuitBreaker,
} from './circuit-breaker';
import {
  rateLimit,
  RateLimitExceededError,
  rateLimitRegistry,
  clearRateLimitRegistry,
  TokenBucket,
} from './rate-limit';
import { retry } from './retry';

// Deterministic monotonic clock: the breaker reads perf_hooks' performance.now(), so tests step
// it by hand instead of sleeping against 10-30 ms recovery windows.
const mockClock = () => {
  let now = 1000;
  jest.spyOn(performance, 'now').mockImplementation(() => now);
  return {
    advance: (ms: number) => {
      now += ms;
    },
  };
};

describe('resilience regressions', () => {
  beforeEach(() => {
    clearCircuitBreakerRegistry();
    clearRateLimitRegistry();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('@retry maxAttempts validation', () => {
    it.each([0, -1, NaN, 2.5, Infinity])('rejects maxAttempts=%p at decoration time', (bad) => {
      expect(() => {
        class Svc {
          @retry({ maxAttempts: bad, backoffMs: 0 })
          async write(): Promise<string> {
            return 'ok';
          }
        }
        return Svc;
      }).toThrow(RangeError);
    });

    it('defaults to 3 attempts when maxAttempts is omitted', async () => {
      let calls = 0;
      class Svc {
        @retry({ backoffMs: 0 })
        async write(): Promise<string> {
          calls++;
          throw new Error('boom');
        }
      }
      await expect(new Svc().write()).rejects.toThrow('boom');
      expect(calls).toBe(3);
    });

    it('runs exactly once and propagates the error with maxAttempts=1', async () => {
      let calls = 0;
      class Svc {
        @retry({ maxAttempts: 1, backoffMs: 0 })
        async write(): Promise<string> {
          calls++;
          throw new Error('boom');
        }
      }
      await expect(new Svc().write()).rejects.toThrow('boom');
      expect(calls).toBe(1);
    });
  });

  describe('half-open probe limit', () => {
    it('admits at most halfOpenSuccessThreshold concurrent probes', async () => {
      const clock = mockClock();
      let calls = 0;
      class Svc {
        @circuitBreaker({
          name: 'probe-limit',
          failureThreshold: 1,
          recoveryTimeoutMs: 30,
          halfOpenSuccessThreshold: 2,
        })
        async call(): Promise<string> {
          calls++;
          await Promise.resolve();
          throw new Error('still down');
        }
      }
      const svc = new Svc();
      await expect(svc.call()).rejects.toThrow('still down');
      expect(calls).toBe(1);
      clock.advance(31);

      calls = 0;
      const results = await Promise.allSettled(Array.from({ length: 50 }, () => svc.call()));
      expect(calls).toBe(2);
      const rejectedOpen = results.filter(
        (r) => r.status === 'rejected' && r.reason instanceof CircuitBreakerOpenError,
      );
      expect(rejectedOpen.length).toBe(50 - calls);
    });

    it('ignores results of calls admitted before the trip (no stale close)', async () => {
      const clock = mockClock();
      const gates: Array<() => void> = [];
      let fail = false;
      class Svc {
        @circuitBreaker({
          name: 'stale',
          failureThreshold: 1,
          recoveryTimeoutMs: 20,
          halfOpenSuccessThreshold: 2,
        })
        async call(): Promise<string> {
          if (fail) throw new Error('down');
          await new Promise<void>((resolve) => gates.push(resolve));
          return 'ok';
        }
      }
      const svc = new Svc();
      // Two slow calls admitted while CLOSED.
      const slow1 = svc.call();
      const slow2 = svc.call();
      fail = true;
      await expect(svc.call()).rejects.toThrow('down');
      const cb = getCircuitBreaker('stale');
      expect(cb.state).toBe(CircuitState.OPEN);

      clock.advance(21);
      expect(cb.state).toBe(CircuitState.HALF_OPEN);
      // The old in-flight calls now succeed; they are not probes.
      gates.forEach((g) => g());
      await Promise.all([slow1, slow2]);
      expect(cb.state).toBe(CircuitState.HALF_OPEN);
    });

    it('releases a probe slot when the probe completes and closes after enough successes', () => {
      const clock = mockClock();
      const cb = new CircuitBreaker({
        name: 'seq',
        failureThreshold: 1,
        recoveryTimeoutMs: 10,
        halfOpenSuccessThreshold: 2,
      });
      cb.recordFailure();
      clock.advance(11);
      expect(cb.allowRequest()).toBe(true);
      expect(cb.allowRequest()).toBe(true);
      expect(cb.allowRequest()).toBe(false);
      cb.recordSuccess();
      expect(cb.allowRequest()).toBe(true);
      cb.recordSuccess();
      expect(cb.state).toBe(CircuitState.CLOSED);
    });

    it('reclaims probe slots abandoned for longer than the recovery timeout', () => {
      const clock = mockClock();
      const cb = new CircuitBreaker({
        name: 'abandoned',
        failureThreshold: 1,
        recoveryTimeoutMs: 10,
        halfOpenSuccessThreshold: 1,
      });
      cb.recordFailure();
      clock.advance(11);
      expect(cb.allowRequest()).toBe(true); // never recorded
      expect(cb.allowRequest()).toBe(false);
      clock.advance(9);
      expect(cb.allowRequest()).toBe(false); // not abandoned yet
      clock.advance(2);
      expect(cb.allowRequest()).toBe(true);
    });

    it('discards a late result from an abandoned probe once its slot is reclaimed', () => {
      const clock = mockClock();
      const cb = new CircuitBreaker({
        name: 'abandoned-late',
        failureThreshold: 1,
        recoveryTimeoutMs: 10,
        halfOpenSuccessThreshold: 1,
      });
      cb.recordFailure();
      clock.advance(11);
      const abandoned = cb.acquire();
      clock.advance(11);
      const fresh = cb.acquire(); // reclaims the abandoned slot
      expect(fresh).not.toBeNull();
      expect(fresh).not.toBe(abandoned);

      // The abandoned probe finally reports: it must not close (or re-open) the breaker.
      cb.recordSuccess(abandoned as number);
      expect(cb.state).toBe(CircuitState.HALF_OPEN);
      cb.recordFailure(abandoned as number);
      expect(cb.state).toBe(CircuitState.HALF_OPEN);

      cb.recordSuccess(fresh as number);
      expect(cb.state).toBe(CircuitState.CLOSED);
    });

    it('ignores an unpaired epoch-less success in half-open', () => {
      const clock = mockClock();
      const cb = new CircuitBreaker({
        name: 'unpaired',
        failureThreshold: 1,
        recoveryTimeoutMs: 10,
        halfOpenSuccessThreshold: 1,
      });
      cb.allowRequest();
      cb.recordFailure();
      expect(cb.state).toBe(CircuitState.OPEN);
      clock.advance(11);
      expect(cb.state).toBe(CircuitState.HALF_OPEN);
      cb.recordSuccess();
      expect(cb.state).toBe(CircuitState.HALF_OPEN);
      expect(cb.allowRequest()).toBe(true);
      cb.recordSuccess();
      expect(cb.state).toBe(CircuitState.CLOSED);
    });
  });

  describe('monotonic clock', () => {
    it('TokenBucket keeps admitting calls when the wall clock steps backwards', () => {
      const realNow = Date.now();
      const bucket = new TokenBucket(10, 5);
      expect(bucket.allow()).toBe(true);
      jest.spyOn(Date, 'now').mockReturnValue(realNow - 3_600_000);
      expect(bucket.allow()).toBe(true);
      expect(bucket.availableTokens()).toBeGreaterThanOrEqual(0);
    });

    it('TokenBucket clamps a negative elapsed time to zero', () => {
      const spy = jest.spyOn(performance, 'now').mockReturnValue(1_000_000);
      const bucket = new TokenBucket(10, 5);
      spy.mockReturnValue(0);
      expect(bucket.availableTokens()).toBe(10);
      expect(bucket.allow()).toBe(true);
      expect(bucket.availableTokens()).toBe(9);
    });

    it('CircuitBreaker recovery is unaffected by wall-clock steps', () => {
      const realNow = Date.now();
      const clock = mockClock();
      const cb = new CircuitBreaker({ name: 'clock', failureThreshold: 1, recoveryTimeoutMs: 20 });
      cb.recordFailure();
      // Forward step must not half-open early.
      const spy = jest.spyOn(Date, 'now').mockReturnValue(realNow + 3_600_000);
      expect(cb.state).toBe(CircuitState.OPEN);
      // Backward step must not keep it open past the timeout.
      spy.mockReturnValue(realNow - 3_600_000);
      clock.advance(19);
      expect(cb.state).toBe(CircuitState.OPEN);
      clock.advance(1);
      expect(cb.state).toBe(CircuitState.HALF_OPEN);
    });
  });

  describe('rate-limit bucket eviction', () => {
    it('evicts fully refilled buckets so the registry stays bounded', async () => {
      let now = 1000;
      jest.spyOn(performance, 'now').mockImplementation(() => now);
      class Api {
        @rateLimit({ capacity: 1, refillRate: 1, keyExtractor: (id) => String(id) })
        async hit(_id: number): Promise<string> {
          return 'ok';
        }
      }
      const api = new Api();
      for (let i = 0; i < 2000; i++) await api.hit(i);
      now += 10_000; // every bucket above has refilled to capacity
      for (let i = 2000; i < 2100; i++) await api.hit(i);
      expect(rateLimitRegistry.size).toBeLessThan(200);
    });

    it('never evicts a drained bucket (limits still enforced after a sweep)', async () => {
      let now = 1000;
      jest.spyOn(performance, 'now').mockImplementation(() => now);
      class Api {
        @rateLimit({ capacity: 1, refillRate: 0.001, keyExtractor: (id) => String(id) })
        async hit(_id: number): Promise<string> {
          return 'ok';
        }
      }
      const api = new Api();
      for (let i = 0; i < 2100; i++) await api.hit(i);
      now += 1000; // 1s: 0.001 tokens refilled, nowhere near capacity
      await expect(api.hit(0)).rejects.toThrow(RateLimitExceededError);
      expect(rateLimitRegistry.size).toBe(2100);
    });
  });

  describe('static method naming', () => {
    it('gives same-named static methods of different classes separate breakers', async () => {
      class A {
        @circuitBreaker({ failureThreshold: 1 })
        static async s1(): Promise<string> {
          throw new Error('a-down');
        }
      }
      class B {
        @circuitBreaker({ failureThreshold: 1 })
        static async s1(): Promise<string> {
          return 'b-ok';
        }
      }
      await expect(A.s1()).rejects.toThrow('a-down');
      await expect(B.s1()).resolves.toBe('b-ok');
      expect(circuitBreakerRegistry.has('A.s1')).toBe(true);
      expect(circuitBreakerRegistry.has('B.s1')).toBe(true);
      expect(circuitBreakerRegistry.has('Function.s1')).toBe(false);
    });

    it('gives same-named static methods of different classes separate buckets', async () => {
      class A {
        @rateLimit({ capacity: 1, refillRate: 0.001 })
        static async s1(): Promise<string> {
          return 'a';
        }
      }
      class B {
        @rateLimit({ capacity: 1, refillRate: 0.001 })
        static async s1(): Promise<string> {
          return 'b';
        }
      }
      await expect(A.s1()).resolves.toBe('a');
      await expect(A.s1()).rejects.toThrow(RateLimitExceededError);
      await expect(B.s1()).resolves.toBe('b');
    });

    it('warns when a second decorator reuses a breaker name with different options', () => {
      const warn = jest.spyOn(globalLogger, 'warn').mockImplementation(() => undefined);
      class A {
        @circuitBreaker({ name: 'shared', failureThreshold: 1 })
        async a(): Promise<string> {
          return 'a';
        }
        @circuitBreaker({ name: 'shared', failureThreshold: 1 })
        async same(): Promise<string> {
          return 'same';
        }
      }
      expect(warn).not.toHaveBeenCalled();
      class B {
        @circuitBreaker({ name: 'shared', failureThreshold: 7 })
        async b(): Promise<string> {
          return 'b';
        }
      }
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('shared');
      expect([A, B]).toHaveLength(2);
    });

    it('gives same-named methods of different anonymous classes separate breakers', async () => {
      const makeA = () => {
        const Cls = (() =>
          class {
            async get(): Promise<string> {
              throw new Error('down');
            }
          })();
        const desc = Object.getOwnPropertyDescriptor(Cls.prototype, 'get')!;
        circuitBreaker({ failureThreshold: 1 })(Cls.prototype, 'get', desc);
        Object.defineProperty(Cls.prototype, 'get', desc);
        return Cls;
      };
      const makeB = () => {
        const Cls = (() =>
          class {
            async get(): Promise<string> {
              return 'ok';
            }
          })();
        const desc = Object.getOwnPropertyDescriptor(Cls.prototype, 'get')!;
        circuitBreaker({ failureThreshold: 1 })(Cls.prototype, 'get', desc);
        Object.defineProperty(Cls.prototype, 'get', desc);
        return Cls;
      };
      const A = makeA();
      const B = makeB();
      expect(A.name).toBe('');
      expect(B.name).toBe('');
      const a = new A();
      const b = new B();
      await expect(a.get()).rejects.toThrow('down');
      await expect(b.get()).resolves.toBe('ok');
    });

    it('gives same-named methods of different anonymous classes separate buckets', async () => {
      const makeA = () => {
        const Cls = (() =>
          class {
            async get(): Promise<string> {
              return 'a';
            }
          })();
        const desc = Object.getOwnPropertyDescriptor(Cls.prototype, 'get')!;
        rateLimit({ capacity: 1, refillRate: 0.001 })(Cls.prototype, 'get', desc);
        Object.defineProperty(Cls.prototype, 'get', desc);
        return Cls;
      };
      const makeB = () => {
        const Cls = (() =>
          class {
            async get(): Promise<string> {
              return 'b';
            }
          })();
        const desc = Object.getOwnPropertyDescriptor(Cls.prototype, 'get')!;
        rateLimit({ capacity: 1, refillRate: 0.001 })(Cls.prototype, 'get', desc);
        Object.defineProperty(Cls.prototype, 'get', desc);
        return Cls;
      };
      const A = makeA();
      const B = makeB();
      expect(A.name).toBe('');
      expect(B.name).toBe('');
      const a = new A();
      const b = new B();
      await expect(a.get()).resolves.toBe('a');
      await expect(b.get()).resolves.toBe('b');
    });

    it('warns when a second decorator reuses a rate-limit bucket with different options', async () => {
      const warn = jest.spyOn(globalLogger, 'warn').mockImplementation(() => undefined);
      let aInstance: { get(): Promise<string> };
      let bInstance: { get(): Promise<string> };
      {
        class Svc {
          @rateLimit({ capacity: 1, refillRate: 0.001 })
          async get(): Promise<string> {
            return 'a';
          }
        }
        aInstance = new Svc();
      }
      {
        class Svc {
          @rateLimit({ capacity: 100, refillRate: 0.001 })
          async get(): Promise<string> {
            return 'b';
          }
        }
        bInstance = new Svc();
      }

      await expect(aInstance.get()).resolves.toBe('a');
      await expect(bInstance.get()).rejects.toThrow(RateLimitExceededError);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('already registered with different options');
      await expect(bInstance.get()).rejects.toThrow(RateLimitExceededError);
      expect(warn).toHaveBeenCalledTimes(1);

      warn.mockClear();
      clearRateLimitRegistry();
      let i1Instance: { get(): Promise<string> };
      let i2Instance: { get(): Promise<string> };
      {
        class Svc {
          @rateLimit({ capacity: 5, refillRate: 1.0 })
          async get(): Promise<string> {
            return 'ok';
          }
        }
        i1Instance = new Svc();
      }
      {
        class Svc {
          @rateLimit({ capacity: 5, refillRate: 1.0 })
          async get(): Promise<string> {
            return 'ok';
          }
        }
        i2Instance = new Svc();
      }
      await expect(i1Instance.get()).resolves.toBe('ok');
      await expect(i2Instance.get()).resolves.toBe('ok');
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('registry clear', () => {
    it('resets decorated methods and keeps the registry instance in sync', async () => {
      let fail = true;
      class A {
        @circuitBreaker({ failureThreshold: 1, recoveryTimeoutMs: 60_000 })
        async probe(): Promise<string> {
          if (fail) throw new Error('down');
          return 'ok';
        }
      }
      const a = new A();
      await expect(a.probe()).rejects.toThrow('down');
      await expect(a.probe()).rejects.toThrow(CircuitBreakerOpenError);

      clearCircuitBreakerRegistry();
      fail = false;
      await expect(a.probe()).resolves.toBe('ok');

      // The registry breaker is the one the method uses, with its options.
      const cb = getCircuitBreaker('A.probe');
      expect(cb.failureThreshold).toBe(1);
      fail = true;
      await expect(a.probe()).rejects.toThrow('down');
      expect(cb.state).toBe(CircuitState.OPEN);
      cb.reset();
      fail = false;
      await expect(a.probe()).resolves.toBe('ok');
    });

    it('warns when a cleared registry is repopulated with other options', async () => {
      const warn = jest.spyOn(globalLogger, 'warn').mockImplementation(() => undefined);
      class A {
        @circuitBreaker({ failureThreshold: 1, recoveryTimeoutMs: 10_000 })
        async probe(): Promise<string> {
          return 'ok';
        }
      }
      expect(warn).not.toHaveBeenCalled();
      clearCircuitBreakerRegistry();
      getCircuitBreaker('A.probe');
      const a = new A();
      await expect(a.probe()).resolves.toBe('ok');
      await expect(a.probe()).resolves.toBe('ok');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('already registered with different options');
    });
  });
});
