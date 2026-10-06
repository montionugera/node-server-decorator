---
title: "Verified adoptions: keyed broadcaster, single-flight and limiter, Postgres lock manager, emit-on-success"
id: E-001
status: epic
---

# Verified adoptions: keyed broadcaster, single-flight and limiter, Postgres lock manager, emit-on-success

Source analysis: `~/workspace/wip/2026-10-04-server-decorator-opportunities-epic.md`
(12 candidates, each challenged by a sceptic that re-read the code; 6 survived; the owner
approved ranks 1 to 4 on 2026-10-05).

## Outcome

Release 2.7 of the library ships three additive pieces that real services already
hand-write, and five services adopt them on local, unpushed feature branches with their
own tests passing:

- a keyed-channel API on the Go server-sent-events broadcaster;
- a plain keyed single-flight helper for Python, and a concurrency limiter plus a keyed
  serializer for Node;
- a Go lock-manager interface with in-memory and no-op implementations, plus a
  Postgres advisory-lock adapter in its own nested Go module.

Expected service-side saving (from reading, to be confirmed by the adoption diffs): about
648 production lines and 377 test lines across asset-studio, fact-board, quant,
joy-data-platform and message-svc.

## Constraints

- Additive only. No contract (`contracts/`) change and no version bump inside a slice.
- The zero-dependency Go core module stays zero-dependency: the pgx adapter lives in a
  nested module with its own `go.mod`.
- Test code must not reach production. Nothing in this epic ships a test helper; any
  fake used by the library's own tests stays in `_test.go` / `*.spec.ts` / `tests/`.
- Every slice ends with the per-phase gate: verify, independent review, fix, re-verify.
- No push, no promote. Adoption branches in other repositories stay unpushed until a
  release tag exists (blocked on PyPI and npmjs.com account fixes) and the owner approves.

## Slices

- Go keyed channels for the SSE broadcaster: SubscribeKey, BroadcastTo, MarkAllDropped, per-subscriber dropped flag
- Python single_flight helper and Node createLimiter plus keyedSerializer helpers
- Go lock manager interface with in-memory and no-op implementations and a pgx advisory-lock adapter in a nested module

## Adoption (other repositories, not fanned out here)

Each on a `feature/` branch in a sibling git worktree, consuming release 2.7 locally:

| Service | Change | Local check |
|---|---|---|
| asset-studio | delete `go/internal/api/sse/broadcaster.go`, `event.go`, `broadcaster_test.go`; repoint references | `go build ./... && go vet ./... && go test ./internal/api/...` |
| fact-board | delete `src/lib/server/drafter/limiter.ts` and `serializeComfy`; delete the limiter unit test | `pnpm check && pnpm lint && pnpm test:unit` |
| quant | replace `fetch_or_wait` / `_INFLIGHT` in `quant-api/src/workers/ohlc_quarter_cache.py` | `pytest` on the cache and bar-streamer tests |
| joy-data-platform | delete `internal/worker/advisory_lock.go` and its test; keep scheduler wiring | `go build ./... && go test ./internal/worker/...` |
| message-svc | delete the local `EmitOnSuccess.ts` and `global-emitter.ts`; use the 2.x package | `pnpm build && pnpm test` |

## Out of scope

Retry, circuit breaker, rate limiter, shared validation, injectable clock and metrics
wrappers (all refuted); the Go fake-clock test package and the Go cache adoption (optional
ranks 5 and 6); user-svc, atlas-world-svc and joy-coach-svc (no safe slice).
