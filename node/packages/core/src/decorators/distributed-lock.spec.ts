import {
  distributedLock,
  configureDistributedLock,
  clearGlobalDistributedLockAdapter,
  LockAcquisitionError,
  RedisLockAdapter,
  RELEASE_LOCK_LUA,
  RENEW_LOCK_LUA,
} from './distributed-lock';

class MockRedisLockAdapter implements RedisLockAdapter {
  public store = new Map<string, { token: string; expiresAt: number }>();
  public setNxCallCount = 0;
  public evalLuaCallCount = 0;

  async setNxPx(key: string, value: string, ttlMs: number): Promise<boolean> {
    this.setNxCallCount++;
    const now = Date.now();
    const existing = this.store.get(key);
    if (existing && existing.expiresAt > now) {
      return false; // Key already held and not expired
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

describe('@distributedLock Decorator', () => {
  let adapter: MockRedisLockAdapter;

  beforeEach(() => {
    adapter = new MockRedisLockAdapter();
    clearGlobalDistributedLockAdapter();
  });

  afterEach(() => {
    clearGlobalDistributedLockAdapter();
  });

  it('acquires lock, executes method, and safely releases lock', async () => {
    class PaymentService {
      @distributedLock({
        key: (orderId: string) => `lock:order:${orderId}`,
        ttlMs: 5000,
        adapter,
      })
      async processPayment(orderId: string, amount: number) {
        // While inside method, lock must be held in store
        const entry = adapter.store.get(`lock:order:${orderId}`);
        expect(entry).toBeDefined();
        return `Paid ${amount} for ${orderId}`;
      }
    }

    const service = new PaymentService();
    const result = await service.processPayment('ord-1', 100);

    expect(result).toBe('Paid 100 for ord-1');
    // Lock must be released after method returns
    expect(adapter.store.has('lock:order:ord-1')).toBe(false);
  });

  it('throws LockAcquisitionError on contention when waitTimeoutMs is 0', async () => {
    class InventoryService {
      @distributedLock({
        key: 'lock:stock:item-1',
        ttlMs: 5000,
        waitTimeoutMs: 0,
        adapter,
      })
      async reserveStock(ms: number) {
        await new Promise((r) => setTimeout(r, ms));
        return 'reserved';
      }
    }

    const service = new InventoryService();

    // First call acquires and holds lock for 50ms
    const p1 = service.reserveStock(50);

    // Second call immediate contention
    await expect(service.reserveStock(10)).rejects.toThrow(LockAcquisitionError);

    const res1 = await p1;
    expect(res1).toBe('reserved');
  });

  it('executes fallback when lock acquisition times out', async () => {
    class JobService {
      @distributedLock({
        key: 'lock:cron',
        ttlMs: 5000,
        waitTimeoutMs: 10,
        fallback: () => 'skipped',
        adapter,
      })
      async runJob(ms: number) {
        await new Promise((r) => setTimeout(r, ms));
        return 'executed';
      }
    }

    const service = new JobService();
    const p1 = service.runJob(50);
    const p2 = await service.runJob(10); // Contended, falls back

    expect(p2).toBe('skipped');
    expect(await p1).toBe('executed');
  });

  it('waits and acquires lock when waitTimeoutMs is sufficient', async () => {
    class WorkerService {
      @distributedLock({
        key: 'lock:worker',
        ttlMs: 5000,
        waitTimeoutMs: 200,
        retryIntervalMs: 20,
        adapter,
      })
      async doWork(ms: number, tag: string) {
        await new Promise((r) => setTimeout(r, ms));
        return tag;
      }
    }

    const service = new WorkerService();
    const p1 = service.doWork(40, 'task-1');
    const p2 = service.doWork(10, 'task-2');

    const [res1, res2] = await Promise.all([p1, p2]);
    expect(res1).toBe('task-1');
    expect(res2).toBe('task-2');
  });

  it('enforces strict mutual exclusion across 20 concurrent callers', async () => {
    let concurrentExecutions = 0;
    let maxConcurrent = 0;

    class CriticalService {
      @distributedLock({
        key: 'lock:critical',
        ttlMs: 5000,
        waitTimeoutMs: 1000,
        retryIntervalMs: 10,
        adapter,
      })
      async executeCritical(idx: number) {
        concurrentExecutions++;
        if (concurrentExecutions > maxConcurrent) {
          maxConcurrent = concurrentExecutions;
        }
        await new Promise((r) => setTimeout(r, 10));
        concurrentExecutions--;
        return idx;
      }
    }

    const service = new CriticalService();
    const promises = Array.from({ length: 20 }, (_, i) => service.executeCritical(i));
    const results = await Promise.all(promises);

    expect(results.length).toBe(20);
    expect(maxConcurrent).toBe(1); // AT MOST 1 AT ANY GIVEN INSTANT
    expect(concurrentExecutions).toBe(0);
  });

  it('heartbeat watchdog extends lock TTL for long-running methods', async () => {
    class LongRunningService {
      @distributedLock({
        key: 'lock:long',
        ttlMs: 60, // Short TTL: 60ms (watchdog runs every ~20ms)
        autoRenew: true,
        adapter,
      })
      async runLongTask() {
        // Runs for 120ms (2x the initial TTL)
        await new Promise((r) => setTimeout(r, 120));
        // Verify lock is still present and valid
        const entry = adapter.store.get('lock:long');
        expect(entry).toBeDefined();
        expect(entry!.expiresAt).toBeGreaterThan(Date.now());
        return 'completed';
      }
    }

    const service = new LongRunningService();
    const result = await service.runLongTask();

    expect(result).toBe('completed');
    expect(adapter.store.has('lock:long')).toBe(false); // Released at end
  });

  it('uses globally configured adapter when not passed in options', async () => {
    configureDistributedLock({ adapter });

    class ConfiguredService {
      @distributedLock({
        key: 'lock:global',
        ttlMs: 2000,
      })
      async run() {
        return 'global-ok';
      }
    }

    const service = new ConfiguredService();
    const res = await service.run();
    expect(res).toBe('global-ok');
    expect(adapter.setNxCallCount).toBe(1);
  });
});
