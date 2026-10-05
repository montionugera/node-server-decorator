---
title: "Go keyed channels for the SSE broadcaster"
id: I-026
status: idea
---

# Go keyed channels for the SSE broadcaster

Slice of epic E-001 (verified adoptions). Go only. Target branch: `release/2.7`.

## 1. Problem

The service `asset-studio` keeps a private copy of this library's server-sent-events
broadcaster and adds keyed channels to it. The copy lives in
`asset-studio/go/internal/api/sse/`:

| File | Lines | What it is |
|---|---|---|
| `broadcaster.go` | 344 | Copy of `go/sse/broadcaster.go` plus about 110 lines of keyed-channel code |
| `event.go` | 48 | Copy of `go/sse/event.go`. Only one comment line differs |
| `broadcaster_test.go` | 187 | Six tests. Three test the keyed code, one tests `Close` with live subscribers |

The library file `go/sse/broadcaster.go` (320 lines) has no keyed API. The service needs
one because each build stream and each series stream must receive only its own events:

- `internal/api/handlers_builds.go:165` and `internal/api/handlers_series.go:96` call
  `SubscribeKey(ctx, id)` and poll the returned `dropped()` function.
- `internal/api/sse/multiplexer.go:216` and `:233` call `BroadcastTo(id, event)`.
- `internal/api/sse/multiplexer.go:299-304` calls `MarkAllDropped()` on three broadcasters
  after the Postgres LISTEN connection is re-established.
- `internal/api/handlers_builds_test.go:445` and `:604` rely on `SubscriberCount()`
  counting keyed subscribers.

This slice moves the keyed extensions into the library so the service copy can go.

## 2. Public API

Package `sse`, import path `github.com/montionugera/node-server-decorator/v2/go/sse`.

Put the three new methods in a new file `go/sse/keyed.go`. Edit `go/sse/broadcaster.go`
only for the shared struct fields, `SubscriberCount` and `Close`.

```go
// SubscribeKey registers a subscriber that receives only events sent with
// BroadcastTo(key, ...). It returns the receive channel, a dropped func and a
// cancel func.
func (b *Broadcaster[T]) SubscribeKey(ctx context.Context, key string) (events <-chan Event[T], dropped func() bool, cancel func())

// BroadcastTo sends event to the subscribers of key only. It keeps no history.
func (b *Broadcaster[T]) BroadcastTo(key string, event Event[T])

// MarkAllDropped flags every keyed subscriber as having missed events.
func (b *Broadcaster[T]) MarkAllDropped()
```

Internal changes (unexported, no API effect):

- `subscriber[T]` gains `dropped atomic.Bool` (`sync/atomic`, standard library).
- `Broadcaster[T]` gains `byKey map[string]map[uint64]*subscriber[T]`, created in
  `NewBroadcaster`.
- Keyed subscribers share `nextSubID` and `bufferSize` with unkeyed subscribers.

Existing methods keep their signatures: `NewBroadcaster`, `WithHeartbeat`,
`WithBufferSize`, `WithHistoryLimit`, `Broadcast`, `Publish`, `Subscribe`,
`SubscriberCount`, `History`, `Close`, `ServeHTTP`, `Event[T].Format`.

Two existing methods change behaviour, additively:

- `SubscriberCount()` returns unkeyed plus keyed subscribers.
- `Close()` also closes and removes every keyed subscriber.

## 3. Behaviour contract

Each statement is testable. "Differs" marks a place where the service does something an
obvious implementation would not.

**Routing**

1. `BroadcastTo(key, e)` delivers `e` to every subscriber registered with exactly that
   key, and to nobody else.
2. **Differs.** `BroadcastTo` does not reach unkeyed subscribers (`Subscribe`), and
   `Broadcast` / `Publish` do not reach keyed subscribers. The two sets are disjoint.
3. **Differs.** `BroadcastTo` never appends to the history. `History()` is unchanged by
   it, and a keyed event is never replayed by `ServeHTTP` for a `Last-Event-ID`.
4. `BroadcastTo` to a key with no subscribers is a no-op and creates no map entry.
5. The empty string is an ordinary key. It does not alias the unkeyed subscribers.
6. `BroadcastTo` sets `event.Timestamp` to the current Unix milliseconds when it is zero,
   and leaves a non-zero timestamp alone. Same rule as `Broadcast`.
7. Events sent to one key by one goroutine arrive in send order. Order between
   concurrent `BroadcastTo` callers is not defined.

**Buffer overflow and the dropped flag**

8. The channel returned by `SubscribeKey` has capacity `WithBufferSize` (default 64).
9. `BroadcastTo` never blocks. When a subscriber's buffer is full, the new event is
   discarded for that subscriber. The older buffered events stay. With buffer size 4 and
   ten sends of `0..9`, the channel holds four events: `0, 1, 2, 3`.
10. A discard sets the dropped flag of that subscriber only. A subscriber of another key,
    or another subscriber of the same key with room in its buffer, is not flagged.
11. **Differs.** `dropped()` returns the flag and resets it in one atomic step
    (`Swap(false)`). The first call after a drop returns true. The next call returns
    false, until a new drop.
12. The flag is sticky. Draining the channel does not clear it. Only `dropped()` clears it.
13. `MarkAllDropped()` sets the flag on every keyed subscriber of every key. It sends
    nothing and closes nothing.
14. **Differs.** A flag can be set while no event arrives (statement 13 on a quiet key).
    The consumer must poll `dropped()` on its own timer. The library does not wake it.
15. `dropped()` is safe to call after `cancel()` and after `Close()`. It does not panic.

**Cancel and cleanup**

16. `cancel()` removes the subscriber, then closes its channel. Events already buffered
    can still be read before the channel reports closed.
17. `cancel()` is idempotent. A second call, and a call after `Close()`, do nothing and do
    not panic.
18. When the last subscriber of a key cancels, the key's entry is deleted from `byKey`.
    After all subscribers cancel, `len(b.byKey) == 0`.
19. When `ctx` is done, the subscriber is cancelled automatically and its channel closes.
20. A nil `ctx` is allowed. No watcher goroutine starts. Only `cancel()` or `Close()`
    ends the subscription.
21. The watcher goroutine exits on any of: `ctx` done, `cancel()` called, `Close()` called.
    This is observable by comparing `runtime.NumGoroutine` before and after with a polling wait.
22. Use the library's existing cancel pattern (map membership checked under `b.mu`, as in
    `subscribe`). Do not copy the service's `sync.Once` field. The library pattern is what
    keeps `cancel` safe against `Close`.

**Count and close**

23. `SubscriberCount()` equals the number of live unkeyed subscribers plus live keyed
    subscribers. With two keyed and one unkeyed subscriber it returns 3.
24. `Close()` closes the channel of every keyed and unkeyed subscriber and empties both
    maps. It returns within one second when subscribers of both kinds are live. This is
    the deadlock the service test guards against.
25. After `Close()`: `SubscribeKey` returns an already closed channel, a `dropped` func
    that always returns false, and a no-op `cancel`. `BroadcastTo` and `MarkAllDropped`
    do nothing.

**Concurrency**

26. `BroadcastTo` holds `b.mu` (a read lock is enough) for the whole send loop. `cancel`
    and `Close` close channels under the write lock. So `BroadcastTo` can never send on a
    closed channel.
27. Concurrent `SubscribeKey`, `cancel`, `BroadcastTo`, `Broadcast`, `MarkAllDropped`,
    `SubscriberCount` and `Close` pass `go test -race`.

## 4. Non-goals

- No keyed API in Node, Python or Nim. No consumer needs it.
- No history or `Last-Event-ID` replay for keyed events.
- No keyed variant of `ServeHTTP`. The service writes its own stream loop.
- No `dropped()` accessor for unkeyed subscribers. `Subscribe` keeps its two return
  values. The service sets a flag on unkeyed subscribers but nothing can read it, so the
  library does not need to store one.
- No wildcard or prefix keys. No multi-key subscribe.
- No change to the heartbeat text. The library writes `: ping`. The service copy writes
  `: keepalive`. See the adoption check.
- No version bump and no change under `contracts/`.

## 5. Compatibility

- Additive only. Three new methods. No existing signature changes.
- `SubscriberCount` and `Close` change only for programs that use the new `SubscribeKey`.
- No `contracts/` change. No change to `go.mod`. The root module stays standard library
  only (`sync/atomic` is standard library).
- Go 1.22 language level, as declared in the root `go.mod`.
- Coverage gate: `scripts/check-go-coverage.sh` lists `go/sse` at **100** percent
  statement coverage. Every new statement must be covered. Do not lower the number.

## 6. Test code stays out of production

- Tests go in `go/sse/keyed_test.go`, `package sse` (the same internal test package the
  existing `go/sse/*_test.go` files use). Statement 18 needs access to `b.byKey`.
- Go never compiles `_test.go` files into an importing program.
- No exported test helper, fake, hook or build tag is added. No `export_test.go` that
  widens the public API. `go doc ./go/sse` must list only the three new methods as new.

## 7. Documentation to update

- `go/README.md`, package table row for `sse`: say "with history, `Last-Event-ID` replay
  and keyed channels".
- `go/README.md`: add a section `## 6. Server-Sent Events (`go/sse`)` before
  `## Testing & Coverage Gate`, with a subsection `### Keyed channels`. It must show
  `SubscribeKey` with a `dropped()` poll, `BroadcastTo`, and `MarkAllDropped`. It must
  state statements 2, 3, 11 and 14 in one line each.
- Repo `CLAUDE.md`, Go lane sentence: change "`go/sse` (broadcaster with `Last-Event-ID`
  replay)" to mention keyed channels.

## 8. Acceptance criteria

- [ ] `go test ./go/...` passes from the repo root.
- [ ] `go test -race ./go/sse/...` passes, including a test that runs `SubscribeKey`, `cancel`, `BroadcastTo`, `Broadcast`, `MarkAllDropped`, `SubscriberCount` and `Close` concurrently (statements 26, 27).
- [ ] `bash scripts/check-go-coverage.sh` passes with `go/sse` still at threshold 100.
- [ ] `bash scripts/check-versions.sh` passes (no version changed).
- [ ] `test -z "$(gofmt -l go)" && go vet ./go/...` passes.
- [ ] `git diff --stat release/2.7 -- go.mod contracts/` prints nothing.
- [ ] Routing: `go test ./go/sse -run 'TestBroadcastTo_ReachesOnlyItsKey|TestBroadcastTo_NoHistory|TestBroadcastTo_EmptyKeyIsOrdinary|TestBroadcastTo_Timestamp'` passes and covers statements 1 to 7.
- [ ] Overflow and flag: `go test ./go/sse -run 'TestSubscribeKey_FlagsAnOverflowOnce|TestMarkAllDropped'` passes and covers statements 8 to 15, including the exact buffered contents `0, 1, 2, 3`.
- [ ] Cancel and cleanup: `go test ./go/sse -run 'TestSubscribeKey_Cancel|TestSubscribeKey_ContextCancel|TestSubscribeKey_NilContext|TestSubscribeKey_WatcherGoroutineExits'` passes and covers statements 16 to 22, including `len(b.byKey) == 0` after the last cancel and a test comparing `runtime.NumGoroutine` before and after with a polling wait to verify watcher goroutines exit.
- [ ] Count and close: `go test ./go/sse -run 'TestSubscriberCount_IncludesKeyed|TestClose_WithLiveKeyedAndUnkeyedSubscribers|TestKeyed_AfterClose'` passes and covers statements 23 to 25.
- [ ] Real test names ported and passing: the three service tests (`TestSubscribeKey_FlagsAnOverflowOnce`, `TestBroadcastTo_ReachesOnlyItsKey`, and `TestClose_WithLiveKeyedAndUnkeyedSubscribers`, dropping the duplicate `TestBroadcaster_CloseWithLiveSubscribersDoesNotDeadlock` that overlaps it) plus one existing library test `TestSlowSubscriberDropsOverflowWithoutBlocking` all pass.
- [ ] `go doc ./go/sse Broadcaster` lists `SubscribeKey`, `BroadcastTo` and `MarkAllDropped`, and no other new exported name.
- [ ] `grep -n 'Keyed channels' go/README.md` finds the new subsection.

## 9. Adoption check

Once this ships, these `asset-studio` files should be deletable:

- `go/internal/api/sse/broadcaster.go` (344 lines)
- `go/internal/api/sse/event.go` (48 lines)
- `go/internal/api/sse/broadcaster_test.go` (187 lines)

Facts the adoption step must confirm:

- `Broadcaster.ServeHTTP` is not used by `asset-studio` production code. Only
  `broadcaster_test.go:55` (`TestBroadcaster_HeartbeatKeepsAlive`) uses it, and that file
  is deleted. So the `: ping` versus `: keepalive` difference, and the different body for
  a non-flusher writer, do not matter. `handlers_builds.go:221` writes its own
  `: keepalive` line.
- `handlers_jobs.go:201` uses plain `Subscribe`. The library signature is identical.
- `handlers_builds.go:103` and `handlers_jobs.go:287,315` use `sse.Event[...]{...}.Format()`.
  The library `Event` and `Format` are byte-for-byte the same code.
- The service default options (heartbeat 15 s, buffer 64, history 100) equal the library
  defaults.
- `asset-studio/go/go.mod` does not require the library today, so adoption adds the
  dependency and needs a root version tag that contains `keyed.go` (a local `replace` line
  until then).
- About 12 lines of generic aliases stay in `asset-studio` (such as
  `type Broadcaster[T any] = libsse.Broadcaster[T]` and thin wrappers for `NewBroadcaster`
  and the three options) so `multiplexer.go` and `build_routing_test.go` keep compiling.

## Design notes

- **Adoption is not a pure deletion.** `multiplexer.go` and `build_routing_test.go` are in
  the same Go package as the deleted files and use the unqualified names `Broadcaster`,
  `Event`, `NewBroadcaster`. To keep them unchanged, as the epic asks, the service
  package needs a small alias file (about 12 lines) with generic type aliases such as
  `type Broadcaster[T any] = libsse.Broadcaster[T]` and thin wrappers for
  `NewBroadcaster` and the three options. Generic type aliases need Go 1.24 or newer.
  `asset-studio/go/go.mod` declares Go 1.26, so this works. The library API needs no
  change for it.
- The service sets the dropped flag on unkeyed subscribers too. Nothing reads it. The
  library skips that write. If a consumer later needs it, add a separate accessor.
- The service `BroadcastTo` uses a read lock, so two goroutines can send to one key at
  the same time. Statement 7 keeps that freedom and makes no ordering promise across
  goroutines. The only caller today is the single multiplexer loop.
