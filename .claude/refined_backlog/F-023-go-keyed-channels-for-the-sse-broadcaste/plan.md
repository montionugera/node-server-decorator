# Go keyed channels for the SSE broadcaster Implementation Plan

**Goal:** Add `SubscribeKey`, `BroadcastTo` and `MarkAllDropped` to the Go `sse.Broadcaster[T]` so the `asset-studio` private copy of the broadcaster can be deleted.

**Architecture:** Three new methods in a new file `go/sse/keyed.go`. `go/sse/broadcaster.go` changes only for the shared struct fields (`subscriber.dropped`, `Broadcaster.byKey`), `SubscriberCount` and `Close`. Keyed subscribers live in `byKey map[string]map[uint64]*subscriber[T]`, disjoint from the unkeyed `subscribers` map, and reuse the library cancel pattern (map membership checked under `b.mu`).

**Tech Stack:** Go 1.22, standard library only (`sync/atomic`).

**Spec:** `.claude/refined_backlog/F-023-go-keyed-channels-for-the-sse-broadcaste/spec.md` (behaviour statements 1 to 27 are referenced below as S1..S27).

## Global Constraints

- Additive only: no existing signature changes; no `contracts/` change; no `go.mod` change; no version bump.
- `go/sse` stays at 100 percent statement coverage (`scripts/check-go-coverage.sh`).
- Tests live in `go/sse/keyed_test.go`, `package sse`. Nothing is exported for tests.
- Always `export GOFLAGS=-ldflags=-linkmode=external` before running Go commands.
- New commits only on `feat/F-023`; never push, ship, promote or amend.

## Statement to test map

| Test (in `go/sse/keyed_test.go`) | Statements |
|---|---|
| `TestBroadcastTo_ReachesOnlyItsKey` | S1, S2, S4, S7, S10 (other key not flagged) |
| `TestBroadcastTo_NoHistory` | S3 (`History()` and the `Last-Event-ID` replay snapshot) |
| `TestBroadcastTo_EmptyKeyIsOrdinary` | S5 |
| `TestBroadcastTo_Timestamp` | S6 |
| `TestSubscribeKey_FlagsAnOverflowOnce` | S8, S9 (contents `0, 1, 2, 3`), S10 (same key, roomy buffer), S11, S12 |
| `TestMarkAllDropped` | S13, S14, S15 |
| `TestSubscribeKey_Cancel` | S16, S17, S18, S22 |
| `TestSubscribeKey_ContextCancel` | S19 |
| `TestSubscribeKey_NilContext` | S20 |
| `TestSubscribeKey_WatcherGoroutineExits` | S21 (ctx done, cancel, Close) |
| `TestSubscriberCount_IncludesKeyed` | S23 |
| `TestClose_WithLiveKeyedAndUnkeyedSubscribers` | S24 |
| `TestKeyed_AfterClose` | S25, S15, S17 |
| `TestKeyed_ConcurrentAccess` (under `-race`) | S26, S27 |

## Tasks

### Task 1: Keyed subscribe, broadcast and flag

- [x] 1.1 Write `go/sse/keyed_test.go` with every test in the table above.
- [x] 1.2 Run `go test ./go/sse/...` and see it fail to compile (`b.SubscribeKey undefined`).
- [x] 1.3 `go/sse/broadcaster.go`: add `dropped atomic.Bool` to `subscriber[T]`, `byKey` to `Broadcaster[T]` (created in `NewBroadcaster`); `SubscriberCount` adds keyed subscribers; `Close` closes and removes them.
- [x] 1.4 Create `go/sse/keyed.go` with `SubscribeKey`, `BroadcastTo` (read lock for the whole send loop, no history), `MarkAllDropped`.
- [x] 1.5 Verify: `go test ./go/sse/...`, `go test -race -count=3 ./go/sse/...`, `go vet ./go/...`, `gofmt -l go` empty, `bash scripts/check-go-coverage.sh` (sse at 100).
- [x] 1.6 Commit code and tests.

### Task 2: Documentation

- [x] 2.1 `go/README.md`: package table row says "with history, `Last-Event-ID` replay and keyed channels"; add `## 6. Server-Sent Events (`go/sse`)` before `## Testing & Coverage Gate` with `### Keyed channels` (shows `SubscribeKey` with a `dropped()` poll, `BroadcastTo`, `MarkAllDropped`; one line each for S2, S3, S11, S14).
- [x] 2.2 Repo `CLAUDE.md`, Go lane sentence: mention keyed channels for `go/sse`.
- [x] 2.3 Verify: `grep -n 'Keyed channels' go/README.md`; `go doc ./go/sse Broadcaster` lists the three new methods.
- [x] 2.4 Commit docs.

### Task 3: Review and fix

- [x] 3.1 Independent review of the diff (`golang-reviewer`); fix every valid finding.
- [x] 3.2 Re-run the full verification list and every acceptance-criteria command from the spec, recording exit codes.
- [x] 3.3 Commit fixes and this plan; leave the tree clean.
