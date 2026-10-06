import {
  withRetry,
  withCache,
  withCircuitBreaker,
  withRateLimit,
  withDistributedLock,
  withTrace,
  withTracking,
} from './functional';
import {
  CircuitBreakerOpenError,
  CircuitState,
  getCircuitBreaker,
  clearCircuitBreakerRegistry,
} from '../decorators/circuit-breaker';
import {
  RateLimitExceededError,
  clearRateLimitRegistry,
} from '../decorators/rate-limit';
import {
  RedisLockAdapter,
  LockAcquisitionError,
  RELEASE_LOCK_LUA,
  RENEW_LOCK_LUA,
  configureDistributedLock,
  clearGlobalDistributedLockAdapter,
} from '../decorators/distributed-lock';
import {
  setSpanExporter,
  getActiveTraceContext,
  TraceSpan,
} from '../decorators/trace';
import { CACHE_MISS, CacheAdapter } from '../decorators/cache';
import { globalTracker } from '../tracker';

// Mock RedisLockAdapter for testing distributedLock
class MockRedisLockAdapter implements RedisLockAdapter {
  public store = new Map<string, { token: string; expiresAt: number }>();
  public setNxCallCount = 0;
  public evalLuaCallCount = 0;

  async setNxPx(key: string, value: string, ttlMs: number): Promise<boolean> {
    this.setNxCallCount++;
    const now = Date.now();
    const existing = this.store.get(key);
    if (existing && existing.expiresAt > now) {
      return false;
    }
    this.store.set(key, { token: value, expiresAt: now + ttlMs });
    return true;
  }

  async evalLua(script: string, keys: string[], args: (string | number)[]): Promise<any> {
    this.evalLuaCallCount++;
    const key = keys[0];
    const now = Date.now();
    const entry = this.store.get(key);

    if (script === RELEASE_LOCK_LUA) {
      const token = String(args[0]);
      if (entry && entry.token === token && entry.expiresAt > now) {
        this.store.delete(key);
        return 1;
      }
      return 0;
    }

    if (script === RENEW_LOCK_LUA) {
      const token = String(args[0]);
      const extendTtlMs = Number(args[1]);
      if (entry && entry.token === token && entry.expiresAt > now) {
        entry.expiresAt = now + extendTtlMs;
        return 1;
      }
      return 0;
    }

    return null;
  }
}

describe('Standalone Functional Utility Wrappers', () => {
  describe('withRetry', () => {
    it('succeeds on first attempt without retrying', async () => {
      let calls = 0;
      const fn = async (x: number) => {
        calls++;
        return x * 2;
      };

      const retryingFn = withRetry(fn, { maxAttempts: 3, backoffMs: 5 });
      const result = await retryingFn(10);

      expect(result).toBe(20);
      expect(calls).toBe(1);
    });

    it('retries failed attempts with backoff and returns result on success', async () => {
      let calls = 0;
      const fn = async () => {
        calls++;
        if (calls < 3) {
          throw new Error('transient glitch');
        }
        return 'recovered';
      };

      const retryingFn = withRetry(fn, { maxAttempts: 4, backoffMs: 5, jitter: false });
      const result = await retryingFn();

      expect(result).toBe('recovered');
      expect(calls).toBe(3);
    });

    it('rethrows last error when maxAttempts exhausted', async () => {
      let calls = 0;
      const fn = async () => {
        calls++;
        throw new Error('permanent crash');
      };

      const retryingFn = withRetry(fn, { maxAttempts: 3, backoffMs: 2, jitter: false });
      await expect(retryingFn()).rejects.toThrow('permanent crash');
      expect(calls).toBe(3);
    });

    it('aborts immediately when retryIf predicate returns false', async () => {
      let calls = 0;
      const fn = async (msg: string) => {
        calls++;
        throw new Error(msg);
      };

      const retryingFn = withRetry(fn, {
        maxAttempts: 5,
        backoffMs: 5,
        retryIf: (err) => err.message.includes('retryable'),
      });

      await expect(retryingFn('fatal fatal')).rejects.toThrow('fatal fatal');
      expect(calls).toBe(1);
    });

    it('works cleanly with synchronous functions', async () => {
      let calls = 0;
      const syncFn = (a: number, b: number) => {
        calls++;
        if (calls === 1) throw new Error('first sync fail');
        return a + b;
      };

      const wrapped = withRetry(syncFn, { maxAttempts: 3, backoffMs: 2 });
      const result = await wrapped(3, 4);
      expect(result).toBe(7);
      expect(calls).toBe(2);
    });
  });

  describe('withCache', () => {
    it('caches results by arguments and avoids re-executing fn', async () => {
      let computeCalls = 0;
      const fetchUserData = async (userId: string) => {
        computeCalls++;
        return { userId, name: `User_${userId}` };
      };

      const cachedFetch = withCache(fetchUserData, { name: 'fetchUserData', ttl: 60 });

      // First call -> misses cache, computes
      const r1 = await cachedFetch('usr-1');
      expect(r1).toEqual({ userId: 'usr-1', name: 'User_usr-1' });
      expect(computeCalls).toBe(1);

      // Second call with same arg -> cache hit, does not call fn
      const r2 = await cachedFetch('usr-1');
      expect(r2).toEqual({ userId: 'usr-1', name: 'User_usr-1' });
      expect(computeCalls).toBe(1);

      // Third call with different arg -> computes
      const r3 = await cachedFetch('usr-2');
      expect(r3).toEqual({ userId: 'usr-2', name: 'User_usr-2' });
      expect(computeCalls).toBe(2);
    });

    it('caches falsy values via CACHE_MISS sentinel', async () => {
      let zeroCalls = 0;
      let nullCalls = 0;
      let emptyCalls = 0;

      const getZero = withCache(async () => {
        zeroCalls++;
        return 0;
      });
      const getNull = withCache(async () => {
        nullCalls++;
        return null;
      });
      const getEmpty = withCache(async () => {
        emptyCalls++;
        return '';
      });

      expect(await getZero()).toBe(0);
      expect(await getZero()).toBe(0);
      expect(zeroCalls).toBe(1);

      expect(await getNull()).toBeNull();
      expect(await getNull()).toBeNull();
      expect(nullCalls).toBe(1);

      expect(await getEmpty()).toBe('');
      expect(await getEmpty()).toBe('');
      expect(emptyCalls).toBe(1);
    });

    it('integrates with custom CacheAdapter and TTL', async () => {
      const store = new Map<string, unknown>();
      const customAdapter: CacheAdapter = {
        get: jest.fn(async (key: string) => (store.has(key) ? store.get(key) : CACHE_MISS)),
        set: jest.fn(async (key: string, value: unknown) => {
          store.set(key, value);
        }),
      };

      let calls = 0;
      const fn = async (n: number) => {
        calls++;
        return n * 10;
      };

      const cached = withCache(fn, { adapter: customAdapter, ttl: 120, name: 'multiply' });

      const res1 = await cached(5);
      expect(res1).toBe(50);
      expect(customAdapter.get).toHaveBeenCalled();
      expect(customAdapter.set).toHaveBeenCalled();
      expect(calls).toBe(1);

      const res2 = await cached(5);
      expect(res2).toBe(50);
      expect(calls).toBe(1);
    });
  });

  describe('withCircuitBreaker', () => {
    beforeEach(() => {
      clearCircuitBreakerRegistry();
    });

    it('allows calls when circuit is closed', async () => {
      const fn = async (amount: number) => `paid ${amount}`;
      const protectedFn = withCircuitBreaker(fn, {
        name: 'cb-payment-test',
        failureThreshold: 3,
      });

      const res = await protectedFn(50);
      expect(res).toBe('paid 50');

      const cb = getCircuitBreaker('cb-payment-test');
      expect(cb.state).toBe(CircuitState.CLOSED);
    });

    it('opens on repeated errors and throws CircuitBreakerOpenError', async () => {
      let calls = 0;
      const fn = async () => {
        calls++;
        throw new Error('remote service timeout');
      };

      const protectedFn = withCircuitBreaker(fn, {
        name: 'cb-unstable-test',
        failureThreshold: 2,
        recoveryTimeoutMs: 100,
      });

      const cb = getCircuitBreaker('cb-unstable-test');

      // Attempt 1: fails
      await expect(protectedFn()).rejects.toThrow('remote service timeout');
      expect(cb.state).toBe(CircuitState.CLOSED);

      // Attempt 2: fails and trips breaker to OPEN
      await expect(protectedFn()).rejects.toThrow('remote service timeout');
      expect(cb.state).toBe(CircuitState.OPEN);

      // Attempt 3: fast-fails with CircuitBreakerOpenError without invoking underlying fn
      const callsBefore = calls;
      await expect(protectedFn()).rejects.toThrow(CircuitBreakerOpenError);
      expect(calls).toBe(callsBefore);
    });

    it('recovers to closed after trial successes in half-open state', async () => {
      let fail = true;
      const fn = async () => {
        if (fail) throw new Error('service error');
        return 'healthy';
      };

      const protectedFn = withCircuitBreaker(fn, {
        name: 'cb-recover-test',
        failureThreshold: 1,
        recoveryTimeoutMs: 25,
        halfOpenSuccessThreshold: 2,
      });

      const cb = getCircuitBreaker('cb-recover-test');

      // Trip to OPEN
      await expect(protectedFn()).rejects.toThrow('service error');
      expect(cb.state).toBe(CircuitState.OPEN);

      // Wait for recovery timeout to elapse
      await new Promise((r) => setTimeout(r, 35));
      expect(cb.state).toBe(CircuitState.HALF_OPEN);

      fail = false;

      // Trial 1: success, still half-open
      const r1 = await protectedFn();
      expect(r1).toBe('healthy');
      expect(cb.state).toBe(CircuitState.HALF_OPEN);

      // Trial 2: success, reaches threshold -> CLOSED
      const r2 = await protectedFn();
      expect(r2).toBe('healthy');
      expect(cb.state).toBe(CircuitState.CLOSED);
    });

    it('executes fallback when circuit is open or throws', async () => {
      const fn = async (item: string) => {
        throw new Error('service down');
      };

      const protectedFn = withCircuitBreaker(fn, {
        name: 'cb-fallback-test',
        failureThreshold: 1,
        fallback: (err, item) => `fallback-for-${item}`,
      });

      const r1 = await protectedFn('order-1');
      expect(r1).toBe('fallback-for-order-1');

      const r2 = await protectedFn('order-2');
      expect(r2).toBe('fallback-for-order-2');
    });
  });

  describe('withRateLimit', () => {
    beforeEach(() => {
      clearRateLimitRegistry();
    });

    it('enforces token bucket rate limits and throws RateLimitExceededError when exhausted', async () => {
      const ping = async () => 'pong';
      const limitedPing = withRateLimit(ping, {
        name: 'ping-api',
        capacity: 3,
        refillRate: 10,
      });

      // 3 calls within capacity should succeed
      expect(await limitedPing()).toBe('pong');
      expect(await limitedPing()).toBe('pong');
      expect(await limitedPing()).toBe('pong');

      // 4th call should throw RateLimitExceededError
      await expect(limitedPing()).rejects.toThrow(RateLimitExceededError);
    });

    it('refills tokens over time allowing subsequent calls', async () => {
      const call = async () => 'ok';
      const limitedCall = withRateLimit(call, {
        name: 'refill-api',
        capacity: 1,
        refillRate: 20, // 1 token per 50ms
      });

      expect(await limitedCall()).toBe('ok');
      await expect(limitedCall()).rejects.toThrow(RateLimitExceededError);

      // Wait 60ms for token refill
      await new Promise((r) => setTimeout(r, 60));
      expect(await limitedCall()).toBe('ok');
    });

    it('supports per-user key extraction', async () => {
      const action = async (user: string) => `action-${user}`;
      const limitedAction = withRateLimit(action, {
        name: 'user-api',
        capacity: 1,
        refillRate: 1,
        keyExtractor: (user: string) => user,
      });

      // User A consumes token
      expect(await limitedAction('user-A')).toBe('action-user-A');
      await expect(limitedAction('user-A')).rejects.toThrow(RateLimitExceededError);

      // User B has independent token
      expect(await limitedAction('user-B')).toBe('action-user-B');
      await expect(limitedAction('user-B')).rejects.toThrow(RateLimitExceededError);
    });
  });

  describe('withDistributedLock', () => {
    let adapter: MockRedisLockAdapter;

    beforeEach(() => {
      adapter = new MockRedisLockAdapter();
      clearGlobalDistributedLockAdapter();
    });

    afterEach(() => {
      clearGlobalDistributedLockAdapter();
    });

    it('acquires lock before executing and releases lock after', async () => {
      const processOrder = async (orderId: string, amount: number) => {
        // Lock must be held while method runs
        const entry = adapter.store.get(`lock:order:${orderId}`);
        expect(entry).toBeDefined();
        return `Charged ${amount} on ${orderId}`;
      };

      const lockedFn = withDistributedLock(
        (orderId: string) => `lock:order:${orderId}`,
        processOrder,
        { ttlMs: 5000, adapter }
      );

      const result = await lockedFn('ord-100', 250);
      expect(result).toBe('Charged 250 on ord-100');

      // Lock must be released after completion
      expect(adapter.store.has('lock:order:ord-100')).toBe(false);
    });

    it('throws LockAcquisitionError on contention when waitTimeoutMs is 0', async () => {
      const task = async (ms: number) => {
        await new Promise((r) => setTimeout(r, ms));
        return 'done';
      };

      const lockedTask = withDistributedLock(
        'lock:single-resource',
        task,
        { ttlMs: 5000, waitTimeoutMs: 0, adapter }
      );

      // Task 1 acquires lock for 50ms
      const p1 = lockedTask(50);

      // Task 2 contends immediately and fails fast
      await expect(lockedTask(10)).rejects.toThrow(LockAcquisitionError);

      expect(await p1).toBe('done');
    });

    it('executes fallback when lock acquisition times out', async () => {
      const runJob = async (ms: number) => {
        await new Promise((r) => setTimeout(r, ms));
        return 'executed';
      };

      const lockedJob = withDistributedLock(
        'lock:cron-job',
        runJob,
        {
          ttlMs: 5000,
          waitTimeoutMs: 10,
          fallback: () => 'skipped',
          adapter,
        }
      );

      const p1 = lockedJob(50);
      const p2 = await lockedJob(10); // Contended, falls back

      expect(p2).toBe('skipped');
      expect(await p1).toBe('executed');
    });

    it('supports alternative signature withDistributedLock(fn, options)', async () => {
      const execute = async (id: string) => `executed-${id}`;
      const locked = withDistributedLock(execute, {
        key: (id: string) => `lock:alt:${id}`,
        ttlMs: 3000,
        adapter,
      });

      const res = await locked('test-id');
      expect(res).toBe('executed-test-id');
      expect(adapter.store.has('lock:alt:test-id')).toBe(false);
    });

    it('heartbeat watchdog extends lock TTL for long-running functions', async () => {
      const longTask = async () => {
        await new Promise((r) => setTimeout(r, 200));
        const entry = adapter.store.get('lock:watchdog');
        expect(entry).toBeDefined();
        expect(entry!.expiresAt).toBeGreaterThan(Date.now());
        return 'finished';
      };

      const lockedLongTask = withDistributedLock('lock:watchdog', longTask, {
        ttlMs: 200, // Safe TTL: 200ms (watchdog runs every ~66ms)
        autoRenew: true,
        adapter,
      });

      const result = await lockedLongTask();
      expect(result).toBe('finished');
      expect(adapter.store.has('lock:watchdog')).toBe(false);
    });
  });

  describe('withTrace', () => {
    let capturedSpans: TraceSpan[] = [];

    beforeEach(() => {
      capturedSpans = [];
      setSpanExporter((span) => {
        capturedSpans.push(span);
      });
    });

    afterEach(() => {
      setSpanExporter(null);
    });

    it('records spans with generated traceId and spanId', async () => {
      const getUser = async (id: string) => {
        const ctx = getActiveTraceContext();
        expect(ctx).toBeDefined();
        expect(ctx?.traceId).toMatch(/^[0-9a-f]{32}$/);
        return { id, name: 'Bob' };
      };

      const tracedGetUser = withTrace('users.getUser', getUser, {
        attributes: (id: string) => ({ 'user.id': id }),
      });

      const user = await tracedGetUser('u-456');
      expect(user).toEqual({ id: 'u-456', name: 'Bob' });

      expect(capturedSpans.length).toBe(1);
      const span = capturedSpans[0];
      expect(span.name).toBe('users.getUser');
      expect(span.attributes['user.id']).toBe('u-456');
      expect(span.status).toBe('OK');
      expect(span.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('propagates parent trace context across nested calls', async () => {
      const childOp = withTrace('child.step', async () => {
        return getActiveTraceContext();
      });

      const parentOp = withTrace('parent.workflow', async () => {
        return await childOp();
      });

      const childCtx = await parentOp();

      expect(capturedSpans.length).toBe(2);
      const childSpan = capturedSpans.find((s) => s.name === 'child.step')!;
      const parentSpan = capturedSpans.find((s) => s.name === 'parent.workflow')!;

      expect(childSpan).toBeDefined();
      expect(parentSpan).toBeDefined();
      expect(childSpan.traceId).toBe(parentSpan.traceId);
      expect(childSpan.parentSpanId).toBe(parentSpan.spanId);
      expect(childCtx?.parentSpanId).toBe(parentSpan.spanId);
    });

    it('records error status and exception attributes when fn throws', async () => {
      const failingFn = withTrace('failing.action', async () => {
        throw new Error('Network partition');
      });

      await expect(failingFn()).rejects.toThrow('Network partition');

      expect(capturedSpans.length).toBe(1);
      const span = capturedSpans[0];
      expect(span.status).toBe('ERROR');
      expect(span.attributes['exception.type']).toBe('Error');
      expect(span.attributes['exception.message']).toBe('Network partition');
    });
  });

  describe('withTracking', () => {
    it('tracks latency and event key on success', async () => {
      const trackSpy = jest.spyOn(globalTracker, 'track').mockImplementation(() => {});

      const calculate = withTracking('order.calculate', async (x: number) => x * 3);
      const res = await calculate(4);

      expect(res).toBe(12);
      expect(trackSpy).toHaveBeenCalled();
      const [key, latency, isError] = trackSpy.mock.calls[0];
      expect(key).toBe('order.calculate');
      expect(typeof latency).toBe('number');
      expect(isError).toBe(false);

      trackSpy.mockRestore();
    });

    it('tracks error flag on exception', async () => {
      const trackSpy = jest.spyOn(globalTracker, 'track').mockImplementation(() => {});

      const buggy = withTracking('critical.crash', async () => {
        throw new Error('Kaboom');
      });

      await expect(buggy()).rejects.toThrow('Kaboom');
      expect(trackSpy).toHaveBeenCalled();
      const [key, , isError] = trackSpy.mock.calls[0];
      expect(key).toBe('critical.crash');
      expect(isError).toBe(true);

      trackSpy.mockRestore();
    });

    it('infers event key from function name or options when fn is first argument', async () => {
      const trackSpy = jest.spyOn(globalTracker, 'track').mockImplementation(() => {});

      const namedFn = withTracking(async function processPayment(x: number) {
        return x + 1;
      });
      const res = await namedFn(5);
      expect(res).toBe(6);
      expect(trackSpy.mock.calls[0][0]).toBe('processPayment');

      const customNamed = withTracking(
        async function anon() {
          return 42;
        },
        { name: 'custom.event' }
      );
      await customNamed();
      expect(trackSpy.mock.calls[1][0]).toBe('custom.event');

      trackSpy.mockRestore();
    });
  });

  describe('functional utils edge cases & branch coverage', () => {
    it('withRetry respects maxBackoffMs cap, jitter, and exhausted attempts', async () => {
      let tries = 0;
      const capped = withRetry(
        async () => {
          tries++;
          throw new Error('fail');
        },
        {
          maxAttempts: 3,
          backoffMs: 10,
          factor: 100,
          maxBackoffMs: 20,
          jitter: true,
        }
      );

      await expect(capped()).rejects.toThrow('fail');
      expect(tries).toBe(3);

      const exhausted = withRetry(async () => 'ok', { maxAttempts: 0 });
      await expect(exhausted()).rejects.toThrow('Retry exhausted without result');
    });

    it('withCache supports number TTL, CacheAdapter instance, TTL option, and default cache expiration', async () => {
      let callCount = 0;
      const fn = async (id: string) => {
        callCount++;
        return `val:${id}`;
      };

      // Numeric TTL
      const cachedNum = withCache(fn, 60);
      expect(await cachedNum('a')).toBe('val:a');
      expect(await cachedNum('a')).toBe('val:a');
      expect(callCount).toBe(1);

      // CacheAdapter instance directly
      const customStore = new Map<string, any>();
      const customAdapter: CacheAdapter = {
        get: (k) => (customStore.has(k) ? customStore.get(k) : CACHE_MISS),
        set: (k, v) => {
          customStore.set(k, v);
        },
      };
      const cachedAdapter = withCache(fn, customAdapter);
      expect(await cachedAdapter('b')).toBe('val:b');
      expect(callCount).toBe(2);

      // Capital TTL option
      const cachedCapital = withCache(fn, { TTL: 10, name: 'custom_cap' });
      expect(await cachedCapital('c')).toBe('val:c');
      expect(callCount).toBe(3);

      // Default in-memory cache expiration branch
      const shortLived = withCache(async () => ++callCount, { ttl: 0.005 });
      const first = await shortLived();
      await new Promise((r) => setTimeout(r, 20));
      const second = await shortLived();
      expect(second).toBeGreaterThan(first);
    });

    it('withTrace supports function as first argument with and without options', async () => {
      const traceFn = withTrace(async function testSpan() {
        return 'traced';
      });
      expect(await traceFn()).toBe('traced');

      const traceWithOpts = withTrace(
        async () => 'traced_opts',
        { name: 'explicit_span' }
      );
      expect(await traceWithOpts()).toBe('traced_opts');
    });

    it('withDistributedLock handles missing adapter, watchdog lost, and fallback', async () => {
      const fnWithoutAdapter = withDistributedLock(
        'test-lock',
        async () => 'should fail',
        { adapter: null as any }
      );
      await expect(fnWithoutAdapter()).rejects.toThrow('No RedisLockAdapter provided');

      // Fallback branch
      const mockAdapter: RedisLockAdapter = {
        setNxPx: jest.fn().mockResolvedValue(false),
        evalLua: jest.fn().mockResolvedValue(1),
      };
      const lockedWithFallback = withDistributedLock(
        'test-lock-fb',
        async () => 'main',
        {
          adapter: mockAdapter,
          waitTimeoutMs: 10,
          fallback: async () => 'fallback_value',
        }
      );
      expect(await lockedWithFallback()).toBe('fallback_value');

      // Watchdog lost / error branch
      let evalCount = 0;
      const watchdogAdapter: RedisLockAdapter = {
        setNxPx: jest.fn().mockResolvedValue(true),
        evalLua: jest.fn().mockImplementation(async (script: string) => {
          evalCount++;
          if (evalCount === 1) return 0; // lock lost
          if (evalCount === 2) throw new Error('evalLua fail');
          return 1;
        }),
      };
      const watchdogFn = withDistributedLock(
        'watchdog-test',
        async () => {
          await new Promise((r) => setTimeout(r, 60));
          return 'ok';
        },
        {
          adapter: watchdogAdapter,
          ttlMs: 30,
          autoRenew: true,
        }
      );
      expect(await watchdogFn()).toBe('ok');
    });
  });
});
