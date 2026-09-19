import {
  rateLimit,
  RateLimitExceededError,
  TokenBucket,
  clearRateLimitRegistry,
} from './rate-limit';

describe('@rateLimit decorator', () => {
  beforeEach(() => {
    clearRateLimitRegistry();
  });

  it('allows bursts up to capacity and rejects excess requests', async () => {
    class RateLimitedApi {
      @rateLimit({ capacity: 3, refillRate: 10 })
      async ping(): Promise<string> {
        return 'pong';
      }
    }

    const api = new RateLimitedApi();

    // 3 calls within capacity should succeed
    expect(await api.ping()).toBe('pong');
    expect(await api.ping()).toBe('pong');
    expect(await api.ping()).toBe('pong');

    // 4th call should be rejected
    await expect(api.ping()).rejects.toThrow(RateLimitExceededError);
  });

  it('refills tokens over time allowing subsequent calls', async () => {
    class BurstApi {
      @rateLimit({ capacity: 1, refillRate: 20 }) // 1 token per 50ms
      async call(): Promise<string> {
        return 'ok';
      }
    }

    const api = new BurstApi();
    expect(await api.call()).toBe('ok');
    await expect(api.call()).rejects.toThrow(RateLimitExceededError);

    // Wait 60ms for refill
    await new Promise((r) => setTimeout(r, 60));
    expect(await api.call()).toBe('ok');
  });

  it('supports per-user key extraction', async () => {
    class MultiTenantService {
      @rateLimit({
        capacity: 1,
        refillRate: 1,
        keyExtractor: (userId: unknown) => String(userId),
      })
      async action(userId: string): Promise<string> {
        return `done-${userId}`;
      }
    }

    const svc = new MultiTenantService();

    // Alice consumes her token
    expect(await svc.action('alice')).toBe('done-alice');
    await expect(svc.action('alice')).rejects.toThrow(RateLimitExceededError);

    // Bob still has his token!
    expect(await svc.action('bob')).toBe('done-bob');
    await expect(svc.action('bob')).rejects.toThrow(RateLimitExceededError);
  });
});
