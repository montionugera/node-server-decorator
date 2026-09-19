import { retry } from './retry';

describe('@retry decorator', () => {
  it('succeeds on first attempt without retrying', async () => {
    let calls = 0;

    class TestService {
      @retry({ maxAttempts: 3, backoffMs: 5 })
      async compute(x: number): Promise<number> {
        calls++;
        return x * 2;
      }
    }

    const svc = new TestService();
    const result = await svc.compute(10);
    expect(result).toBe(20);
    expect(calls).toBe(1);
  });

  it('retries until success within maxAttempts', async () => {
    let calls = 0;

    class TestService {
      @retry({ maxAttempts: 4, backoffMs: 5, jitter: false })
      async flaky(): Promise<string> {
        calls++;
        if (calls < 3) {
          throw new Error('transient error');
        }
        return 'success';
      }
    }

    const svc = new TestService();
    const result = await svc.flaky();
    expect(result).toBe('success');
    expect(calls).toBe(3);
  });

  it('rethrows last error when maxAttempts exhausted', async () => {
    let calls = 0;

    class TestService {
      @retry({ maxAttempts: 3, backoffMs: 2, jitter: false })
      async failing(): Promise<void> {
        calls++;
        throw new Error('permanent error');
      }
    }

    const svc = new TestService();
    await expect(svc.failing()).rejects.toThrow('permanent error');
    expect(calls).toBe(3);
  });

  it('respects retryIf predicate to abort non-retryable errors', async () => {
    let calls = 0;

    class TestService {
      @retry({
        maxAttempts: 3,
        backoffMs: 5,
        retryIf: (err) => err.message.includes('retryable'),
      })
      async testPredicate(msg: string): Promise<void> {
        calls++;
        throw new Error(msg);
      }
    }

    const svc = new TestService();
    await expect(svc.testPredicate('fatal error')).rejects.toThrow('fatal error');
    expect(calls).toBe(1);
  });
});
