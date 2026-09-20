# GraphQL DataLoader Contract & Multi-Tenant Request Isolation Rules

## 1. Overview
The GraphQL DataLoader adapter bridges `@batchLoad` (Node.js), `@batch_load` (Python), and `coalesce.MultiTierLoader` / `coalesce.Loader` (Go) into GraphQL field resolvers to eliminate the N+1 query problem.

## 2. Request-Scoped Registry & Context Isolation
To prevent cross-tenant and cross-user data leakage, each GraphQL execution must receive an isolated loader context:
1. In Node.js: `createGraphQLLoaderContext()` returns a `{ loaders: GraphQLLoaderRegistry }` object to be merged into Apollo / Mercurius / Yoga context. Alternatively, request-scoped context can be stored in an `AsyncLocalStorage`.
2. In Python: `create_graphql_loader_context()` returns a context object or dictionary containing an isolated `GraphQLLoaderRegistry`.
3. In Go: `gqlloader.WithContext(ctx, registry)` or `gqlloader.ForContext(ctx)` attaches and retrieves an isolated loader registry from `context.Context`.

## 3. Resolver Signature & Key Extraction
GraphQL resolvers typically have the signature:
- Node: `(parent: TParent, args: TArgs, context: TContext, info: GraphQLResolveInfo) => Promise<TResult>`
- Python: `def resolve_field(self, info: Info, **kwargs) -> TResult` or `def resolve_field(parent, info, **kwargs) -> TResult`
- Go: `func(ctx context.Context, parent *Parent, args Args) (Result, error)`

The adapter MUST accept:
1. `key`: A function or property extractor that retrieves the batch key from `parent` (e.g. `parent => parent.authorId`).
2. `service` & `method` OR `loader`: The batchLoad function or service method to delegate to.
3. Multiple keys handling: Support scalar lookups (1-to-1: `book.authorId -> Author`) and list lookups (1-to-many: `author.bookIds -> Book[]`).

## 4. Query Coalescing Parity
Across all implementations:
- Given $N$ items resolved in the same query depth level (e.g. 50 authors requesting their books), the downstream batch method MUST be called exactly ONCE with all 50 keys batched together.
- Total database round trips for an author + book list query MUST equal 2 (1 for root authors + 1 for batched books) instead of $N + 1$.
