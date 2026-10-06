import {
  GraphQLLoaderRegistry,
  createGraphQLLoaderContext,
  graphQLLoaderStorage,
  graphqlLoader,
} from './graphql';
import { batchLoadScopeStorage } from '../decorators/batch-load';

describe('GraphQLLoaderRegistry coverage', () => {
  it('scopeFor returns one stable token per identity and distinct tokens across identities', () => {
    const registry = new GraphQLLoaderRegistry();
    const a = {};
    const b = {};

    const tokenA = registry.scopeFor(a);

    expect(registry.scopeFor(a)).toBe(tokenA);
    expect(registry.scopeFor(b)).not.toBe(tokenA);
    expect(tokenA).not.toBe(a);
  });

  it('scope tokens are not shared between registries', () => {
    const identity = {};

    expect(new GraphQLLoaderRegistry().scopeFor(identity)).not.toBe(
      new GraphQLLoaderRegistry().scopeFor(identity)
    );
  });

  it('serviceFor builds once per source identity', () => {
    const registry = new GraphQLLoaderRegistry();
    class Svc {}
    let builds = 0;
    const factory = () => {
      builds += 1;
      return new Svc();
    };

    const first = registry.serviceFor(Svc, factory);
    const second = registry.serviceFor(Svc, factory);
    const other = registry.serviceFor('another-source', factory);

    expect(second).toBe(first);
    expect(other).not.toBe(first);
    expect(builds).toBe(2);
  });

  it('serviceFor caches a falsy factory result instead of rebuilding it', () => {
    const registry = new GraphQLLoaderRegistry();
    let builds = 0;
    const factory = () => {
      builds += 1;
      return null;
    };

    expect(registry.serviceFor('k', factory)).toBeNull();
    expect(registry.serviceFor('k', factory)).toBeNull();
    expect(builds).toBe(1);
  });

  it('getOrCreate builds once per name', () => {
    const registry = new GraphQLLoaderRegistry();
    let builds = 0;
    const factory = () => ({ n: ++builds });

    const first = registry.getOrCreate('users', factory);

    expect(registry.getOrCreate('users', factory)).toBe(first);
    expect(registry.getOrCreate('posts', factory)).toEqual({ n: 2 });
    expect(builds).toBe(2);
  });

  it('dispose awaits disposers in registration order', async () => {
    const registry = new GraphQLLoaderRegistry();
    const order: string[] = [];
    registry.onDispose(async () => {
      await new Promise((r) => setTimeout(r, 15));
      order.push('slow');
    });
    registry.onDispose(() => {
      order.push('fast');
    });

    await registry.dispose();

    expect(order).toEqual(['slow', 'fast']);
  });

  it('dispose swallows sync and async disposer failures and still runs the rest', async () => {
    const registry = new GraphQLLoaderRegistry();
    const ran: string[] = [];
    registry.onDispose(() => {
      throw new Error('sync cleanup failure');
    });
    registry.onDispose(async () => {
      throw new Error('async cleanup failure');
    });
    registry.onDispose(() => {
      ran.push('last');
    });

    await expect(registry.dispose()).resolves.toBeUndefined();

    expect(ran).toEqual(['last']);
  });

  it('dispose drops loaders, services, scopes and the disposers themselves', async () => {
    const registry = new GraphQLLoaderRegistry();
    const identity = {};
    let disposed = 0;
    let loaderBuilds = 0;
    let serviceBuilds = 0;
    const scopeBefore = registry.scopeFor(identity);
    registry.getOrCreate('users', () => ++loaderBuilds);
    registry.serviceFor('svc', () => ++serviceBuilds);
    registry.onDispose(() => {
      disposed += 1;
    });

    await registry.dispose();
    await registry.dispose();

    expect(disposed).toBe(1);
    expect(registry.scopeFor(identity)).not.toBe(scopeBefore);
    expect(registry.getOrCreate('users', () => ++loaderBuilds)).toBe(2);
    expect(registry.serviceFor('svc', () => ++serviceBuilds)).toBe(2);
  });
});

describe('createGraphQLLoaderContext coverage', () => {
  it('returns a fresh registry per call whose cleanupLoaders disposes it', async () => {
    const first = createGraphQLLoaderContext();
    const second = createGraphQLLoaderContext();
    let disposed = 0;
    first.loaders.onDispose(() => {
      disposed += 1;
    });

    expect(first.loaders).toBeInstanceOf(GraphQLLoaderRegistry);
    expect(second.loaders).not.toBe(first.loaders);

    await second.cleanupLoaders();
    expect(disposed).toBe(0);

    await first.cleanupLoaders();
    expect(disposed).toBe(1);
  });
});

describe('graphqlLoader coverage', () => {
  describe('short circuits', () => {
    it.each([[null], [undefined]])('returns null without loading when the parent is %s', async (parent) => {
      let calls = 0;
      const resolve = graphqlLoader<any, number, string>({
        key: () => 1,
        loader: async () => {
          calls += 1;
          return 'x';
        },
      });

      await expect(resolve(parent, {}, {}, {})).resolves.toBeNull();
      expect(calls).toBe(0);
    });

    it.each([[null], [undefined]])('returns null without loading when the key is %s', async (key) => {
      let calls = 0;
      const resolve = graphqlLoader<any, any, string>({
        key: () => key,
        loader: async () => {
          calls += 1;
          return 'x';
        },
      });

      await expect(resolve({ id: 1 }, {}, {}, {})).resolves.toBeNull();
      expect(calls).toBe(0);
    });

    it.each([[0], [''], [false]])('still loads the falsy-but-present key %p', async (key) => {
      const seen: unknown[] = [];
      const resolve = graphqlLoader<any, any, string>({
        key: () => key,
        loader: async (k) => {
          seen.push(k);
          return 'loaded';
        },
      });

      await expect(resolve({}, {}, {}, {})).resolves.toBe('loaded');
      expect(seen).toEqual([key]);
    });

    it('returns [] for an empty key array without loading', async () => {
      let calls = 0;
      const resolve = graphqlLoader<any, number, string>({
        key: () => [],
        loader: async () => {
          calls += 1;
          return 'x';
        },
      });

      await expect(resolve({}, {}, {}, {})).resolves.toEqual([]);
      expect(calls).toBe(0);
    });
  });

  describe('key shapes', () => {
    it('loads each key of an array and keeps the key order in the result', async () => {
      const resolve = graphqlLoader<{ ids: number[] }, number, string>({
        key: (p) => p.ids,
        loader: async (k) => {
          await new Promise((r) => setTimeout(r, k === 1 ? 20 : 0));
          return `user-${k}`;
        },
      });

      await expect(resolve({ ids: [1, 2, 3] }, {}, {}, {})).resolves.toEqual([
        'user-1',
        'user-2',
        'user-3',
      ]);
    });

    it('rejects the whole array when one key fails to load', async () => {
      const resolve = graphqlLoader<{ ids: number[] }, number, string>({
        key: (p) => p.ids,
        loader: async (k) => {
          if (k === 2) throw new Error('user 2 unavailable');
          return `user-${k}`;
        },
      });

      await expect(resolve({ ids: [1, 2] }, {}, {}, {})).rejects.toThrow('user 2 unavailable');
    });

    it('isList wraps a single result and passes an array result through', async () => {
      const single = graphqlLoader<any, number, any>({
        key: () => 1,
        isList: true,
        loader: async () => 'only',
      });
      const many = graphqlLoader<any, number, any>({
        key: () => 1,
        isList: true,
        loader: async () => ['a', 'b'],
      });

      await expect(single({}, {}, {}, {})).resolves.toEqual(['only']);
      await expect(many({}, {}, {}, {})).resolves.toEqual(['a', 'b']);
    });

    it('without isList a scalar key returns the bare loader result', async () => {
      const resolve = graphqlLoader<any, number, any>({ key: () => 1, loader: async () => 'only' });

      await expect(resolve({}, {}, {}, {})).resolves.toBe('only');
    });
  });

  describe('service resolution', () => {
    it('calls the named method bound to a pre-built instance', async () => {
      class UserService {
        prefix = 'u';
        async load(id: number) {
          return `${this.prefix}-${id}`;
        }
      }
      const resolve = graphqlLoader({ key: (p: any) => p.id, service: new UserService(), method: 'load' });

      await expect(resolve({ id: 5 }, {}, {}, {})).resolves.toBe('u-5');
    });

    it('throws at decoration time when a pre-built instance lacks the method', () => {
      class UserService {}

      expect(() =>
        graphqlLoader({ key: (p: any) => p.id, service: new UserService(), method: 'load' })
      ).toThrow("Method 'load' not found on service UserService");
    });

    it('prefers an explicit loader, so a missing service method is not an error', async () => {
      const resolve = graphqlLoader({
        key: (p: any) => p.id,
        service: {},
        method: 'load',
        loader: async (k: number) => k * 2,
      });

      await expect(resolve({ id: 4 }, {}, {}, {})).resolves.toBe(8);
    });

    it('uses a class with a static method as-is, without instantiating it', async () => {
      let constructed = 0;
      class StaticService {
        constructor() {
          constructed += 1;
        }
        static async load(id: number) {
          return `static-${id}`;
        }
      }
      const resolve = graphqlLoader({ key: (p: any) => p.id, service: StaticService, method: 'load' });

      await expect(resolve({ id: 1 }, {}, {}, {})).resolves.toBe('static-1');
      expect(constructed).toBe(0);
    });

    it('instantiates a class once per request registry and again for the next request', async () => {
      let constructed = 0;
      class UserService {
        readonly instanceNo = ++constructed;
        async load(id: number) {
          return `${this.instanceNo}:${id}`;
        }
      }
      const resolve = graphqlLoader({ key: (p: any) => p.id, service: UserService, method: 'load' });
      const requestA = createGraphQLLoaderContext();
      const requestB = createGraphQLLoaderContext();

      await expect(resolve({ id: 1 }, {}, requestA, {})).resolves.toBe('1:1');
      await expect(resolve({ id: 2 }, {}, requestA, {})).resolves.toBe('1:2');
      await expect(resolve({ id: 3 }, {}, requestB, {})).resolves.toBe('2:3');
      expect(constructed).toBe(2);
    });

    it('builds a fresh instance per call when there is no registry at all', async () => {
      let constructed = 0;
      class UserService {
        readonly instanceNo = ++constructed;
        async load(id: number) {
          return `${this.instanceNo}:${id}`;
        }
      }
      const resolve = graphqlLoader({ key: (p: any) => p.id, service: UserService, method: 'load' });

      await expect(resolve({ id: 1 }, {}, undefined, {})).resolves.toBe('1:1');
      await expect(resolve({ id: 1 }, {}, {}, {})).resolves.toBe('2:1');
    });

    it('calls a plain function as a factory', async () => {
      let factoryCalls = 0;
      const factory = () => {
        factoryCalls += 1;
        return { load: async (id: number) => `made-${id}` };
      };
      const resolve = graphqlLoader({ key: (p: any) => p.id, service: factory, method: 'load' });
      const request = createGraphQLLoaderContext();

      await expect(resolve({ id: 1 }, {}, request, {})).resolves.toBe('made-1');
      await expect(resolve({ id: 2 }, {}, request, {})).resolves.toBe('made-2');
      expect(factoryCalls).toBe(1);
    });

    it('rejects at resolve time when a factory product lacks the method', async () => {
      class Product {}
      const resolve = graphqlLoader({
        key: (p: any) => p.id,
        service: () => new Product(),
        method: 'load',
      });

      await expect(resolve({ id: 1 }, {}, {}, {})).rejects.toThrow(
        "Method 'load' not found on service Product"
      );
    });

    it('rejects at resolve time when a factory returns nothing', async () => {
      const resolve = graphqlLoader({ key: (p: any) => p.id, service: () => undefined, method: 'load' });

      await expect(resolve({ id: 1 }, {}, {}, {})).rejects.toThrow(
        "Method 'load' not found on service undefined"
      );
    });

    it.each([
      ['neither loader nor service', {}],
      ['a service without a method', { service: { load: async () => 1 } }],
      ['a method without a service', { method: 'load' }],
    ])('rejects with a configuration error given %s', async (_label, extra) => {
      const resolve = graphqlLoader({ key: (p: any) => p.id, ...extra });

      await expect(resolve({ id: 1 }, {}, {}, {})).rejects.toThrow(
        'graphqlLoader requires either `loader` function or `service` and `method`'
      );
    });
  });

  describe('registry and batching scope', () => {
    it('runs the loader inside the request registry taken from context.loaders', async () => {
      const request = createGraphQLLoaderContext();
      let scope: unknown;
      const resolve = graphqlLoader({
        key: (p: any) => p.id,
        loader: async (k: number) => {
          scope = batchLoadScopeStorage.getStore();
          return k;
        },
      });

      await resolve({ id: 1 }, {}, request, {});

      expect(scope).toBe(request.loaders);
    });

    it('falls back to the AsyncLocalStorage registry when context carries none', async () => {
      const ambient = new GraphQLLoaderRegistry();
      let constructed = 0;
      let scope: unknown;
      class UserService {
        constructor() {
          constructed += 1;
        }
        async load(id: number) {
          scope = batchLoadScopeStorage.getStore();
          return id;
        }
      }
      const resolve = graphqlLoader({ key: (p: any) => p.id, service: UserService, method: 'load' });

      await graphQLLoaderStorage.run(ambient, async () => {
        await resolve({ id: 1 }, {}, null, {});
        // A look-alike that is not a GraphQLLoaderRegistry must be ignored too.
        await resolve({ id: 2 }, {}, { loaders: { serviceFor: () => ({}) } }, {});
      });

      expect(scope).toBe(ambient);
      expect(constructed).toBe(1);
    });

    it('context.loaders wins over the ambient registry', async () => {
      const ambient = new GraphQLLoaderRegistry();
      const request = createGraphQLLoaderContext();
      let scope: unknown;
      const resolve = graphqlLoader({
        key: (p: any) => p.id,
        loader: async (k: number) => {
          scope = batchLoadScopeStorage.getStore();
          return k;
        },
      });

      await graphQLLoaderStorage.run(ambient, () => resolve({ id: 1 }, {}, request, {}));

      expect(scope).toBe(request.loaders);
    });

    it('uses a throwaway scope per call when no registry exists, never a shared one', async () => {
      const scopes: unknown[] = [];
      const resolve = graphqlLoader({
        key: (p: any) => p.id,
        loader: async (k: number) => {
          scopes.push(batchLoadScopeStorage.getStore());
          return k;
        },
      });

      await resolve({ id: 1 }, {}, {}, {});
      await resolve({ id: 2 }, {}, {}, {});

      expect(scopes[0]).toBeInstanceOf(GraphQLLoaderRegistry);
      expect(scopes[1]).toBeInstanceOf(GraphQLLoaderRegistry);
      expect(scopes[0]).not.toBe(scopes[1]);
      expect(batchLoadScopeStorage.getStore()).toBeUndefined();
    });
  });
});
