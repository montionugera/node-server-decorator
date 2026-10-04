import { AsyncLocalStorage } from 'async_hooks';
import { batchLoad } from '../decorators/batch-load';
import {
  graphqlLoader,
  createGraphQLLoaderContext,
  GraphQLLoaderRegistry,
  graphQLLoaderStorage,
} from './graphql';

describe('GraphQL DataLoader Adapter (Node/TypeScript)', () => {
  let dbQueries: string[] = [];

  class BookService {
    async batchFindAuthors(ids: string[]) {
      dbQueries.push(`SELECT * FROM authors WHERE id IN (${ids.join(',')})`);
      return ids.map((id) => ({ id, name: `Author ${id}` }));
    }

    async batchFindBooksByAuthor(authorIds: string[]) {
      dbQueries.push(`SELECT * FROM books WHERE author_id IN (${authorIds.join(',')})`);
      const map = new Map<string, any[]>();
      for (const aId of authorIds) {
        map.set(aId, [
          { id: `b-1-${aId}`, authorId: aId, title: `Book 1 by ${aId}` },
          { id: `b-2-${aId}`, authorId: aId, title: `Book 2 by ${aId}` },
        ]);
      }
      return map;
    }

    @batchLoad({ batchMethod: 'batchFindAuthors' })
    async getAuthorById(id: string): Promise<any> {
      return undefined;
    }

    @batchLoad({ batchMethod: 'batchFindBooksByAuthor' })
    async getBooksByAuthorId(authorId: string): Promise<any> {
      return undefined;
    }
  }

  beforeEach(() => {
    dbQueries = [];
  });

  it('coalesces 1-to-1 field lookups (Book.author) across 50 items into 1 batched query', async () => {
    const bookService = new BookService();

    const authorResolver = graphqlLoader({
      service: bookService,
      method: 'getAuthorById',
      key: (book: any) => book.authorId,
    });

    const context = createGraphQLLoaderContext();

    // Simulate 50 books being resolved at the same depth level in GraphQL query
    const books = Array.from({ length: 50 }, (_, i) => ({
      id: `book-${i}`,
      title: `Title ${i}`,
      authorId: `author-${i % 10}`, // 10 distinct authors across 50 books
    }));

    const results = await Promise.all(
      books.map((book) => authorResolver(book, {}, context, {}))
    );

    expect(results.length).toBe(50);
    expect(results[0]).toEqual({ id: 'author-0', name: 'Author author-0' });
    expect(results[49]).toEqual({ id: 'author-9', name: 'Author author-9' });

    // Verify all 10 distinct author lookups were coalesced into exactly 1 batch DB query
    expect(dbQueries.length).toBe(1);
    expect(dbQueries[0]).toContain('SELECT * FROM authors WHERE id IN');

    await context.cleanupLoaders();
  });

  it('coalesces 1-to-many field lookups (Author.books) into 1 batched query', async () => {
    const bookService = new BookService();

    const booksResolver = graphqlLoader({
      service: bookService,
      method: 'getBooksByAuthorId',
      key: (author: any) => author.id,
    });

    const context = createGraphQLLoaderContext();

    const authors = [
      { id: 'auth-1', name: 'Author 1' },
      { id: 'auth-2', name: 'Author 2' },
      { id: 'auth-3', name: 'Author 3' },
    ];

    const results = await Promise.all(
      authors.map((author) => booksResolver(author, {}, context, {}))
    );

    expect(results.length).toBe(3);
    expect(results[0].length).toBe(2);
    expect(results[0][0].title).toBe('Book 1 by auth-1');

    expect(dbQueries.length).toBe(1);
    expect(dbQueries[0]).toContain('SELECT * FROM books WHERE author_id IN (auth-1,auth-2,auth-3)');

    await context.cleanupLoaders();
  });

  it('maintains complete isolation between concurrent GraphQL requests', async () => {
    const bookService = new BookService();

    const authorResolver = graphqlLoader({
      service: bookService,
      method: 'getAuthorById',
      key: (book: any) => book.authorId,
    });

    const ctxA = createGraphQLLoaderContext();
    const ctxB = createGraphQLLoaderContext();

    // Run two concurrent GraphQL requests
    const [resA, resB] = await Promise.all([
      Promise.all([
        authorResolver({ id: 'b-1', authorId: 'auth-A1' }, {}, ctxA, {}),
        authorResolver({ id: 'b-2', authorId: 'auth-A2' }, {}, ctxA, {}),
      ]),
      Promise.all([
        authorResolver({ id: 'b-3', authorId: 'auth-B1' }, {}, ctxB, {}),
        authorResolver({ id: 'b-4', authorId: 'auth-B2' }, {}, ctxB, {}),
      ]),
    ]);

    expect(resA[0]).toEqual({ id: 'auth-A1', name: 'Author auth-A1' });
    expect(resB[0]).toEqual({ id: 'auth-B1', name: 'Author auth-B1' });

    // Clean up both requests independently
    await ctxA.cleanupLoaders();
    await ctxB.cleanupLoaders();
  });
});

describe('GraphQL DataLoader Adapter — request isolation regressions', () => {
  const userStore = new AsyncLocalStorage<string>();
  let queries: string[] = [];

  class DocService {
    async batchFind(ids: string[]) {
      const user = userStore.getStore();
      queries.push(`${user}:${ids.join(',')}`);
      return ids.map((id) => ({ id, owner: user }));
    }

    @batchLoad({ batchMethod: 'batchFind' })
    async findById(id: string): Promise<any> {
      return undefined;
    }
  }

  beforeEach(() => {
    queries = [];
  });

  it('does not serve one request’s cached row to the next request for the SAME key', async () => {
    const service = new DocService();
    const resolver = graphqlLoader({ service, method: 'findById', key: (p: any) => p.docId });

    const ctxA = createGraphQLLoaderContext();
    const a = await userStore.run('alice', () => resolver({ docId: 'doc1' }, {}, ctxA, {}));
    await ctxA.cleanupLoaders();

    const ctxB = createGraphQLLoaderContext();
    const b = await userStore.run('bob', () => resolver({ docId: 'doc1' }, {}, ctxB, {}));
    await ctxB.cleanupLoaders();

    expect(a).toEqual({ id: 'doc1', owner: 'alice' });
    expect(b).toEqual({ id: 'doc1', owner: 'bob' });
    expect(queries).toEqual(['alice:doc1', 'bob:doc1']);
  });

  it('does not merge two concurrent requests into one batch', async () => {
    const service = new DocService();
    const resolver = graphqlLoader({ service, method: 'findById', key: (p: any) => p.docId });

    const ctxA = createGraphQLLoaderContext();
    const ctxB = createGraphQLLoaderContext();
    const [a, b] = await Promise.all([
      userStore.run('alice', () => resolver({ docId: 'x' }, {}, ctxA, {})),
      userStore.run('bob', () => resolver({ docId: 'y' }, {}, ctxB, {})),
    ]);

    expect(a).toEqual({ id: 'x', owner: 'alice' });
    expect(b).toEqual({ id: 'y', owner: 'bob' });
    expect([...queries].sort()).toEqual(['alice:x', 'bob:y']);
  });

  it('isolates the registry held in graphQLLoaderStorage the same way', async () => {
    const service = new DocService();
    const resolver = graphqlLoader({ service, method: 'findById', key: (p: any) => p.docId });

    const run = (user: string) =>
      graphQLLoaderStorage.run(new GraphQLLoaderRegistry(), () =>
        userStore.run(user, () => resolver({ docId: 'doc1' }, {}, {}, {}))
      );

    expect(await run('alice')).toEqual({ id: 'doc1', owner: 'alice' });
    expect(await run('bob')).toEqual({ id: 'doc1', owner: 'bob' });
  });

  it('shares nothing between calls when no registry is available (fail closed, no cross-request cache)', async () => {
    const service = new DocService();
    const resolver = graphqlLoader({ service, method: 'findById', key: (p: any) => p.docId });

    const a = await userStore.run('alice', () => resolver({ docId: 'doc1' }, {}, {}, {}));
    const b = await userStore.run('bob', () => resolver({ docId: 'doc1' }, {}, undefined, {}));

    expect(a).toEqual({ id: 'doc1', owner: 'alice' });
    expect(b).toEqual({ id: 'doc1', owner: 'bob' });
  });

  it('still coalesces within one request after isolation (loader option form)', async () => {
    const service = new DocService();
    const resolver = graphqlLoader({
      loader: (id: string) => service.findById(id),
      key: (p: any) => p.docId,
    });

    const ctx = createGraphQLLoaderContext();
    await userStore.run('alice', () =>
      Promise.all(['a', 'b', 'c'].map((docId) => resolver({ docId }, {}, ctx, {})))
    );
    await ctx.cleanupLoaders();

    expect(queries).toEqual(['alice:a,b,c']);
  });
});

describe('GraphQL DataLoader Adapter — service resolution regressions', () => {
  it('routes two resolvers bound to two instances of one class to their own instance', async () => {
    class Repo {
      constructor(private tenant: string) {}
      async find(id: string) {
        return `${this.tenant}:${id}`;
      }
    }
    const resolverA = graphqlLoader({ service: new Repo('tenantA'), method: 'find', key: (p: any) => p.id });
    const resolverB = graphqlLoader({ service: new Repo('tenantB'), method: 'find', key: (p: any) => p.id });

    const ctx = createGraphQLLoaderContext();
    expect(await resolverA({ id: '1' }, {}, ctx, {})).toBe('tenantA:1');
    expect(await resolverB({ id: '1' }, {}, ctx, {})).toBe('tenantB:1');
    await ctx.cleanupLoaders();
  });

  it('keeps separate batch queues for two batchLoad instances of one class in one request', async () => {
    const seen: string[] = [];
    class Repo {
      constructor(private tenant: string) {}
      async batch(ids: string[]) {
        seen.push(`${this.tenant}:${ids.join(',')}`);
        return ids.map((id) => ({ id, tenant: this.tenant }));
      }
      @batchLoad({ batchMethod: 'batch' })
      async find(id: string): Promise<any> {
        return undefined;
      }
    }
    const resolverA = graphqlLoader({ service: new Repo('tenantA'), method: 'find', key: (p: any) => p.id });
    const resolverB = graphqlLoader({ service: new Repo('tenantB'), method: 'find', key: (p: any) => p.id });

    const ctx = createGraphQLLoaderContext();
    const [a, b] = await Promise.all([
      resolverA({ id: '1' }, {}, ctx, {}),
      resolverB({ id: '1' }, {}, ctx, {}),
    ]);
    await ctx.cleanupLoaders();

    expect(a).toEqual({ id: '1', tenant: 'tenantA' });
    expect(b).toEqual({ id: '1', tenant: 'tenantB' });
    expect([...seen].sort()).toEqual(['tenantA:1', 'tenantB:1']);
  });

  it('routes two object-literal services with the same method name to their own service', async () => {
    const users = { load: async (id: string) => `user:${id}` };
    const orders = { load: async (id: string) => `order:${id}` };
    const userResolver = graphqlLoader({ service: users, method: 'load', key: (p: any) => p.id });
    const orderResolver = graphqlLoader({ service: orders, method: 'load', key: (p: any) => p.id });

    const ctx = createGraphQLLoaderContext();
    expect(await userResolver({ id: '1' }, {}, ctx, {})).toBe('user:1');
    expect(await orderResolver({ id: '1' }, {}, ctx, {})).toBe('order:1');
    await ctx.cleanupLoaders();
  });

  it('accepts the service class itself and builds one instance per request', async () => {
    let instances = 0;
    const calls: string[] = [];
    class Svc {
      constructor() {
        instances++;
      }
      async batch(ids: string[]) {
        calls.push(ids.join(','));
        return ids.map((id) => ({ id }));
      }
      @batchLoad({ batchMethod: 'batch' })
      async get(id: string): Promise<any> {
        return undefined;
      }
    }
    const resolver = graphqlLoader({ service: Svc, method: 'get', key: (p: any) => p.id });

    const ctx = createGraphQLLoaderContext();
    const out = await Promise.all(['1', '2', '3'].map((id) => resolver({ id }, {}, ctx, {})));
    await ctx.cleanupLoaders();

    expect(out).toEqual([{ id: '1' }, { id: '2' }, { id: '3' }]);
    expect(instances).toBe(1);
    expect(calls).toEqual(['1,2,3']);
  });

  it('runs a service factory once per request, not once per resolver call', async () => {
    let built = 0;
    const calls: string[] = [];
    class Svc {
      async batch(ids: string[]) {
        calls.push(ids.join(','));
        return ids.map((id) => ({ id }));
      }
      @batchLoad({ batchMethod: 'batch' })
      async get(id: string): Promise<any> {
        return undefined;
      }
    }
    const factory = () => {
      built++;
      return new Svc();
    };
    const resolver = graphqlLoader({ service: factory, method: 'get', key: (p: any) => p.id });

    const ctx = createGraphQLLoaderContext();
    await Promise.all(['1', '2', '3'].map((id) => resolver({ id }, {}, ctx, {})));
    expect(built).toBe(1);
    expect(calls).toEqual(['1,2,3']);
    await ctx.cleanupLoaders();

    const ctx2 = createGraphQLLoaderContext();
    await resolver({ id: '1' }, {}, ctx2, {});
    expect(built).toBe(2);
    await ctx2.cleanupLoaders();
  });

  it('fails at definition time when the method does not exist on a service instance', () => {
    expect(() => graphqlLoader({ service: { other: async () => 1 }, method: 'get', key: (p: any) => p.id })).toThrow(
      /Method 'get' not found/
    );
  });

  it('fails clearly when a factory returns a service without the method', async () => {
    const resolver = graphqlLoader({ service: () => ({}), method: 'get', key: (p: any) => p.id });
    const ctx = createGraphQLLoaderContext();
    await expect(resolver({ id: '1' }, {}, ctx, {})).rejects.toThrow(/Method 'get' not found/);
  });

  it('fails at definition time when the method does not exist on a service class', () => {
    class Svc {
      async get(id: string) {
        return id;
      }
    }
    expect(() =>
      graphqlLoader({ key: (p: any) => p.id, service: Svc as any, method: 'gett' })
    ).toThrow("Method 'gett' not found on service Svc");
  });

  it('never calls a service class without new', async () => {
    let instances = 0;
    class Svc {
      constructor() {
        instances++;
      }
      async get(id: string) {
        return id;
      }
    }
    const resolver = graphqlLoader({ key: (p: any) => p.id, service: Svc as any, method: 'get' });
    const ctx = createGraphQLLoaderContext();
    const result = await resolver({ id: '1' }, {}, ctx, {});
    await ctx.cleanupLoaders();

    expect(result).toBe('1');
    expect(instances).toBe(1);
  });

  it('still treats a plain function without the method as a factory', async () => {
    class Svc {
      async get(id: string) {
        return id;
      }
    }
    const resolver = graphqlLoader({
      key: (p: any) => p.id,
      service: () => new Svc(),
      method: 'get',
    });
    const ctx = createGraphQLLoaderContext();
    const result = await resolver({ id: '1' }, {}, ctx, {});
    await ctx.cleanupLoaders();

    expect(result).toBe('1');
  });
});
