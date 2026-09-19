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

  it('supports multi-tier L1 memory LRU and L2 distributed cache with backfill and eviction', async () => {
    let dbCallCount = 0;
    const l2Store = new Map<string, any>();
    let mgetCallCount = 0;
    let setManyCallCount = 0;
    let delCallCount = 0;

    const mockL2Adapter = {
      async mget(keys: string[]) {
        mgetCallCount++;
        const res = new Map();
        for (const k of keys) {
          if (l2Store.has(k)) {
            res.set(k, l2Store.get(k));
          }
        }
        return res;
      },
      async setMany(items: Map<string, any>) {
        setManyCallCount++;
        for (const [k, v] of items.entries()) {
          l2Store.set(k, v);
        }
      },
      async del(keys: string[]) {
        delCallCount++;
        for (const k of keys) {
          l2Store.delete(k);
        }
      },
    };

    class CachedUserService {
      async findUsers(ids: string[]): Promise<Map<string, { id: string; name: string }>> {
        dbCallCount++;
        const map = new Map();
        for (const id of ids) {
          if (id !== 'missing') {
            map.set(id, { id, name: 'User ' + id });
          }
        }
        return map;
      }

      @batchLoad({
        batchMethod: 'findUsers',
        cache: {
          l1: { maxEntries: 100, ttlMs: 5000 },
          l2: { adapter: mockL2Adapter, ttlSeconds: 300 },
          negativeTtlSeconds: 5,
        },
      })
      async findUser(id: string): Promise<{ id: string; name: string } | undefined> {
        return undefined;
      }
    }

    const service = new CachedUserService();

    // 1. Initial lookup -> misses L1 & L2 -> fetches from L3 DB
    const u1 = await service.findUser('1');
    expect(u1).toEqual({ id: '1', name: 'User 1' });
    expect(dbCallCount).toBe(1);
    expect(setManyCallCount).toBe(1);
    expect(l2Store.get('1')).toEqual({ id: '1', name: 'User 1' });

    // 2. Second lookup -> hits L1 immediately without DB or L2
    const u1Again = await service.findUser('1');
    expect(u1Again).toEqual({ id: '1', name: 'User 1' });
    expect(dbCallCount).toBe(1);
    expect(mgetCallCount).toBe(1); // Didn't increase

    // 3. Pre-populate L2 for user '2', then query -> hits L2, backfills L1, skips DB
    l2Store.set('2', { id: '2', name: 'From Redis' });
    const u2 = await service.findUser('2');
    expect(u2).toEqual({ id: '2', name: 'From Redis' });
    expect(dbCallCount).toBe(1); // No new DB call!
    expect(mgetCallCount).toBe(2);

    // 4. Negative caching: query nonexistent key
    const missing1 = await service.findUser('missing');
    expect(missing1).toBeUndefined();
    expect(dbCallCount).toBe(2);

    // Immediate second query for 'missing' hits negative cache -> 0 new DB calls
    const missing2 = await service.findUser('missing');
    expect(missing2).toBeUndefined();
    expect(dbCallCount).toBe(2);

    // 5. Eviction test: clear user '1'
    await (service.findUser as any).clear('1');
    expect(delCallCount).toBe(1);
    expect(l2Store.has('1')).toBe(false);

    // Fetching user '1' again after eviction must hit DB again
    const u1Refetched = await service.findUser('1');
    expect(u1Refetched).toEqual({ id: '1', name: 'User 1' });
    expect(dbCallCount).toBe(3);
  });

  it('should prime cache directly and bypass database execution', async () => {
    let dbCallCount = 0;
    class PrimeService {
      async batchUsers(ids: string[]) {
        dbCallCount++;
        return ids.map((id) => ({ id, name: `DB User ${id}` }));
      }

      @batchLoad({
        batchMethod: 'batchUsers',
      })
      async findUser(id: string): Promise<any> {
        return undefined;
      }
    }

    const service = new PrimeService();

    // Prime cache before lookup
    (service.findUser as any).prime('user-1', { id: 'user-1', name: 'Primed User' }, service);

    const user = await service.findUser('user-1');
    expect(user).toEqual({ id: 'user-1', name: 'Primed User' });
    expect(dbCallCount).toBe(0);
  });

  it('should cascadingly prefetch 1-to-1 and 1-to-many child relations', async () => {
    let userDbCalls = 0;
    let itemDbCalls = 0;

    class UserService {
      async batchUsers(ids: string[]) {
        userDbCalls++;
        return ids.map((id) => ({ id, name: `User ${id}` }));
      }

      @batchLoad({ batchMethod: 'batchUsers' })
      async findUser(id: string): Promise<any> {
        return undefined;
      }
    }

    class ItemService {
      async batchItems(ids: string[]) {
        itemDbCalls++;
        return ids.map((id) => ({ id, title: `Item ${id}` }));
      }

      @batchLoad({ batchMethod: 'batchItems' })
      async findItem(id: string): Promise<any> {
        return undefined;
      }
    }

    const userService = new UserService();
    const itemService = new ItemService();

    class OrderService {
      async batchOrders(ids: string[]) {
        return ids.map((id) => ({
          id,
          userId: `u-${id}`,
          itemIds: [`it-1-${id}`, `it-2-${id}`],
        }));
      }

      @batchLoad({
        batchMethod: 'batchOrders',
        prefetch: [
          {
            extract: (order: any) => order.userId,
            loader: () => userService.findUser.bind(userService),
          },
          {
            extract: (order: any) => order.itemIds,
            loader: () => itemService.findItem.bind(itemService),
          },
        ],
      })
      async findOrder(id: string): Promise<any> {
        return undefined;
      }
    }

    const orderService = new OrderService();

    // 1. Fetch order -> triggers background prefetch for userId 'u-1' and itemIds ['it-1-1', 'it-2-1']
    const order = await orderService.findOrder('1');
    expect(order).toEqual({
      id: '1',
      userId: 'u-1',
      itemIds: ['it-1-1', 'it-2-1'],
    });

    // Wait a tick for microtask prefetching to complete
    await new Promise((r) => setTimeout(r, 20));

    expect(userDbCalls).toBe(1);
    expect(itemDbCalls).toBe(1);

    // 2. Downstream calls to userService and itemService should hit primed cache with 0 extra DB calls
    const user = await userService.findUser('u-1');
    expect(user).toEqual({ id: 'u-1', name: 'User u-1' });
    expect(userDbCalls).toBe(1); // No new DB call!

    const item1 = await itemService.findItem('it-1-1');
    const item2 = await itemService.findItem('it-2-1');
    expect(item1).toEqual({ id: 'it-1-1', title: 'Item it-1-1' });
    expect(item2).toEqual({ id: 'it-2-1', title: 'Item it-2-1' });
    expect(itemDbCalls).toBe(1); // No new DB call!
  });
});
