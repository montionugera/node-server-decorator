import { AsyncLocalStorage } from 'async_hooks';
import { batchLoad } from './batch-load';

describe('@batchLoad Decorator', () => {
  it('coalesces multiple concurrent calls in the same microtask tick into a single batch call', async () => {
    let batchCallCount = 0;
    let batchRequestedKeys: string[] = [];

    class UserService {
      async findUsersByIds(ids: string[]): Promise<Map<string, { id: string; name: string }>> {
        batchCallCount++;
        batchRequestedKeys.push(...ids);
        const map = new Map();
        for (const id of ids) {
          map.set(id, { id, name: 'User ' + id });
        }
        return map;
      }

      @batchLoad({ batchMethod: 'findUsersByIds' })
      async findUserById(id: string): Promise<{ id: string; name: string } | undefined> {
        return undefined;
      }
    }

    const service = new UserService();

    // Call 4 distinct IDs concurrently in the same tick
    const [u1, u2, u3, u4] = await Promise.all([
      service.findUserById('1'),
      service.findUserById('2'),
      service.findUserById('3'),
      service.findUserById('4'),
    ]);

    expect(batchCallCount).toBe(1);
    expect(batchRequestedKeys).toEqual(['1', '2', '3', '4']);
    expect(u1).toEqual({ id: '1', name: 'User 1' });
    expect(u2).toEqual({ id: '2', name: 'User 2' });
    expect(u3).toEqual({ id: '3', name: 'User 3' });
    expect(u4).toEqual({ id: '4', name: 'User 4' });
  });

  it('deduplicates identical keys in-flight (SingleFlight)', async () => {
    let batchCallCount = 0;
    let batchRequestedKeys: string[] = [];

    class OrderService {
      async findOrdersByIds(ids: string[]): Promise<Map<string, { id: string; total: number }>> {
        batchCallCount++;
        batchRequestedKeys.push(...ids);
        const map = new Map();
        for (const id of ids) {
          map.set(id, { id, total: 100 });
        }
        return map;
      }

      @batchLoad({ batchMethod: 'findOrdersByIds', deduplicate: true })
      async findOrderById(id: string): Promise<{ id: string; total: number } | undefined> {
        return undefined;
      }
    }

    const service = new OrderService();

    // 5 concurrent calls for the SAME key
    const results = await Promise.all([
      service.findOrderById('o1'),
      service.findOrderById('o1'),
      service.findOrderById('o1'),
      service.findOrderById('o2'),
      service.findOrderById('o2'),
    ]);

    expect(batchCallCount).toBe(1);
    expect(batchRequestedKeys).toEqual(['o1', 'o2']);
    expect(results[0]).toEqual({ id: 'o1', total: 100 });
    expect(results[1]).toEqual({ id: 'o1', total: 100 });
    expect(results[3]).toEqual({ id: 'o2', total: 100 });
  });

  it('isolates batch queues across distinct request scopes using AsyncLocalStorage', async () => {
    const requestContext = new AsyncLocalStorage<{ tenantId: string }>();
    let batchCallCount = 0;

    class MultiTenantService {
      async findItems(ids: string[]): Promise<Map<string, string>> {
        batchCallCount++;
        const map = new Map();
        for (const id of ids) {
          map.set(id, 'item:' + id);
        }
        return map;
      }

      @batchLoad({ batchMethod: 'findItems', contextStorage: requestContext })
      async getItem(id: string): Promise<string | undefined> {
        return undefined;
      }
    }

    const service = new MultiTenantService();

    // Run Tenant A and Tenant B concurrently in separate context stores
    const [resA, resB] = await Promise.all([
      requestContext.run({ tenantId: 'tenant-a' }, async () => {
        return Promise.all([service.getItem('1'), service.getItem('2')]);
      }),
      requestContext.run({ tenantId: 'tenant-b' }, async () => {
        return Promise.all([service.getItem('3'), service.getItem('4')]);
      }),
    ]);

    // Should result in 2 isolated batches, one per tenant
    expect(batchCallCount).toBe(2);
    expect(resA).toEqual(['item:1', 'item:2']);
    expect(resB).toEqual(['item:3', 'item:4']);
  });

  it('propagates rejection if the batch loader rejects', async () => {
    class FailingService {
      async findBad(ids: string[]): Promise<any> {
        throw new Error('Database connection failed');
      }

      @batchLoad({ batchMethod: 'findBad' })
      async getBad(id: string): Promise<any> {
        return undefined;
      }
    }

    const service = new FailingService();

    const [res1, res2] = await Promise.allSettled([service.getBad('1'), service.getBad('2')]);
    expect(res1.status).toBe('rejected');
    expect((res1 as PromiseRejectedResult).reason.message).toBe('Database connection failed');
    expect(res2.status).toBe('rejected');
    expect((res2 as PromiseRejectedResult).reason.message).toBe('Database connection failed');
  });
});
