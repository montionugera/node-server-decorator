# GraphQL DataLoader Adapter Implementation Plan

> **Goal**: Implement GraphQL DataLoader adapter (`@graphqlLoader` / `createGraphQLLoaderContext`) bridging existing `@batchLoad` and `coalesce.MultiTierLoader` transparently into GraphQL field resolvers to eliminate N+1 queries.
> **Architecture Spec**: [`docs/superpowers/specs/2026-09-21-graphql-dataloader-adapter-design.md`](file:///Users/pasitnusso/workspace/repos/node-server-decorator/.claude/worktrees/_release/docs/superpowers/specs/2026-09-21-graphql-dataloader-adapter-design.md)

---

## Proposed Changes

### Phase 1: Request-Scoped GraphQL Loader Registry
- Implement `GraphQLLoaderRegistry` managing ephemeral batch queues per GraphQL operation.
- Provide cleanup hook on request completion to avoid memory leaks.
- Quality Gate: Unit tests verifying multiple concurrent operations have independent batch queues and isolated caches.

### Phase 2: Node/TypeScript GraphQL Adapter (`node/packages/graphql` or `node/packages/core/src/adapters/graphql`)
- Implement `graphqlLoader` resolver wrapper function.
- Support scalar (1-to-1) and array (1-to-many) foreign key extractions.
- Quality Gate: Unit tests with mock GraphQL resolver execution context.

### Phase 3: Python GraphQL Adapter (Strawberry / Ariadne)
- Implement `@graphql_loader` field decorator in `python/packages/core/src/server_decorator/adapters/graphql.py`.
- Quality Gate: Pytest unit tests.

### Phase 4: Go Adapter (`go/adapter/graphql`)
- Implement `gqlloader.ForContext(ctx)` helper for GraphQL-Go / gqlgen.
- Quality Gate: `go test ./go/adapter/graphql/...`.

### Phase 5: Verification & Promotion
- Run `bash scripts/contributor-check.sh` (7/7 gates).
- Ship via `psrw ship`.
