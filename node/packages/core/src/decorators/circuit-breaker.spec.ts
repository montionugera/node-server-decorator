import { performance } from 'perf_hooks';
import {
  circuitBreaker,
  CircuitBreakerOpenError,
  CircuitState,
  getCircuitBreaker,
  clearCircuitBreakerRegistry,
} from './circuit-breaker';

// Deterministic monotonic clock: the breaker reads perf_hooks' performance.now(), so the tests
// step it by hand. Sleeping against a 20-50 ms recovery window races the assertions under load
// (the OPEN breaker lazily turns HALF_OPEN as soon as the window has elapsed).
const mockClock = () => {
  let now = 1000;
  jest.spyOn(performance, 'now').mockImplementation(() => now);
  return {
    advance: (ms: number) => {
      now += ms;
    },
  };
};

describe('@circuitBreaker decorator', () => {
  beforeEach(() => {
    clearCircuitBreakerRegistry();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('allows calls when circuit is closed and records successes', async () => {
    class PaymentService {
      @circuitBreaker({ name: 'payment-svc', failureThreshold: 3 })
      async charge(amount: number): Promise<string> {
        return `charged $${amount}`;
      }
    }

    const svc = new PaymentService();
    const result = await svc.charge(100);
    expect(result).toBe('charged $100');

    const cb = getCircuitBreaker('payment-svc');
    expect(cb.state).toBe(CircuitState.CLOSED);
  });

  it('trips to open after reaching failureThreshold and fast-fails', async () => {
    mockClock();
    let calls = 0;

    class UnstableService {
      @circuitBreaker({
        name: 'unstable-svc',
        failureThreshold: 2,
        recoveryTimeoutMs: 50,
      })
      async call(): Promise<void> {
        calls++;
        throw new Error('network timeout');
      }
    }

    const svc = new UnstableService();
    const cb = getCircuitBreaker('unstable-svc');

    // Call 1: fails
    await expect(svc.call()).rejects.toThrow('network timeout');
    expect(cb.state).toBe(CircuitState.CLOSED);

    // Call 2: fails and trips
    await expect(svc.call()).rejects.toThrow('network timeout');
    expect(cb.state).toBe(CircuitState.OPEN);

    // Call 3: fast-fails with CircuitBreakerOpenError without invoking method
    const callsBefore = calls;
    await expect(svc.call()).rejects.toThrow(CircuitBreakerOpenError);
    expect(calls).toBe(callsBefore);
  });

  it('recovers to closed after trial successes in half-open state', async () => {
    const clock = mockClock();
    let fail = true;

    class RecoveringService {
      @circuitBreaker({
        name: 'recovering-svc',
        failureThreshold: 1,
        recoveryTimeoutMs: 20,
        halfOpenSuccessThreshold: 2,
      })
      async query(): Promise<string> {
        if (fail) throw new Error('down');
        return 'up';
      }
    }

    const svc = new RecoveringService();
    const cb = getCircuitBreaker('recovering-svc');

    // Trip to OPEN
    await expect(svc.query()).rejects.toThrow('down');
    expect(cb.state).toBe(CircuitState.OPEN);

    // Just short of the recovery timeout: still OPEN
    clock.advance(19);
    expect(cb.state).toBe(CircuitState.OPEN);

    // Recovery timeout elapsed -> transitions to HALF_OPEN
    clock.advance(1);
    expect(cb.state).toBe(CircuitState.HALF_OPEN);

    // Now service recovers
    fail = false;

    // Trial 1: success, still half-open
    const res1 = await svc.query();
    expect(res1).toBe('up');
    expect(cb.state).toBe(CircuitState.HALF_OPEN);

    // Trial 2: success, reaches halfOpenSuccessThreshold (2), state moves to CLOSED!
    const res2 = await svc.query();
    expect(res2).toBe('up');
    expect(cb.state).toBe(CircuitState.CLOSED);
  });

  it('invokes fallback when circuit is open or throws', async () => {
    class FallbackService {
      @circuitBreaker({
        name: 'fallback-svc',
        failureThreshold: 1,
        fallback: (err, ...args) => `fallback-for-${args[0]}`,
      })
      async fetchData(id: string): Promise<string> {
        throw new Error('database down');
      }
    }

    const svc = new FallbackService();
    const res1 = await svc.fetchData('user-1');
    expect(res1).toBe('fallback-for-user-1');

    // Circuit is now OPEN, second call also triggers fallback
    const res2 = await svc.fetchData('user-2');
    expect(res2).toBe('fallback-for-user-2');
  });
});
