# Architecture Decision Records

ADRs document the *why* behind architectural choices. Each one is short, dated, and immutable once accepted — supersede a prior ADR with a new one rather than editing it.

| # | Title | Status |
|---|-------|--------|
| [0001](./0001-polyglot-architecture.md) | Polyglot architecture: two folders, no monorepo tool | Accepted |
| [0002](./0002-lockstep-versioning.md) | Lockstep semver across both packages | Accepted |
| [0003](./0003-cache-key-format.md) | Cache key format | Accepted |
| [0004](./0004-cache-miss-sentinel.md) | `CACHE_MISS` sentinel for adapter contract | Accepted |
| [0005](./0005-eventemitter3-swap.md) | Replace `@nestjs/event-emitter` with `eventemitter3` | Accepted |
| [0007](./0007-monorepo-restructure.md) | Monorepo workspaces for the entity-spec layer | Accepted |

The decisions table in the root [`DECISIONS.md`](../../DECISIONS.md) is the at-a-glance reference; the ADRs here carry the rationale.
