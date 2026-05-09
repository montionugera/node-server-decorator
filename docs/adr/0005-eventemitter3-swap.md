# ADR 0005 — Replace `@nestjs/event-emitter` with `eventemitter3`

**Status:** Accepted (2026-05-05). Locked as Decision #8.

## Context

The pre-v2.0.0 Node implementation used `EventEmitter2` from `@nestjs/event-emitter` for `globalEmitter`. This dragged in `@nestjs/common`, `@nestjs/core`, and `rxjs` as peer/transitive dependencies — a significant footprint for one feature (a small in-process pub/sub).

## Decision

Drop `@nestjs/event-emitter` and replace with [`eventemitter3`](https://github.com/primus/eventemitter3) (~3 KB minified, no transitive deps).

## Why

- **Footprint.** NestJS pulled in ~30 MB of node_modules; eventemitter3 is ~10 KB on disk.
- **Consumers don't need NestJS.** The `globalEmitter` API used by `@EmitOnSuccess` is `.emit(name, payload)` and `.on(name, handler)`. Both are present on eventemitter3.
- **Removing framework coupling makes the package framework-agnostic.** The Node consumers we know of (`atlas-world-svc`, others) don't use NestJS — they were carrying its dependencies for no reason.

## Consequences

- The exported `globalEmitter` changes type from `EventEmitter2` to `eventemitter3`'s default export. Runtime API is unchanged.
- Consumers who imported the type explicitly need to update one line. Documented in MIGRATION.md.
- This is the one intentional Node breaking change in v2.0.0 (along with the cache-key change in ADR 0003).
- The dead `custom-logger.ts` file (NestJS-coupled, never re-exported from `index.ts`) is removed in the same release.
