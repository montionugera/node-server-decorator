import {
  circuitBreaker,
  CircuitBreakerOpenError,
  CircuitState,
  getCircuitBreaker,
  clearCircuitBreakerRegistry,
} from './circuit-breaker';

describe('@circuitBreaker decorator', () => {
  beforeEach(() => {
    clearCircuitBreakerRegistry();
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

    // Wait for recovery timeout -> transitions to HALF_OPEN
    await new Promise((r) => setTimeout(r, 30));
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
