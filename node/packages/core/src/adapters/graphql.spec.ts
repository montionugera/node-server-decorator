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
