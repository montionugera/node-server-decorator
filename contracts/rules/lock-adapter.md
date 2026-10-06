# Contract Rule: Redis Lock Adapter & Distributed Mutual Exclusion

## 1. Scope

This contract governs distributed lock adapters and `@distributedLock` / `@distributed_lock` decorators across all languages (TypeScript, Python, Go).

---

## 2. Adapter Protocol

Any Redis lock adapter must implement the minimal, dependency-free interface:

| Operation | Arguments | Return | Behavior |
| :--- | :--- | :--- | :--- |
| `setNxPx` | `key: string`, `value: string`, `ttlMs: number` | `boolean` | Atomic acquire: Returns `true` if key was set with PX ttl, `false` if key already existed. |
| `evalLua` | `script: string`, `keys: string[]`, `args: (string\|number)[]` | `any` | Evaluates an atomic Lua script on the Redis server. |

---

## 3. Standard Atomic Lua Scripts

### Safe Release Script
Ensures a lock is released **only** if the held token matches the caller's unique ownership token:
```lua
if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
else
    return 0
end
```

### Safe Renewal Script
Extends the TTL **only** if the held token matches the caller's unique ownership token:
```lua
if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("pexpire", KEYS[1], ARGV[2])
else
    return 0
end
```

---

## 4. Behavior Invariants

1. **Mutual Exclusion**: At most one execution of the protected critical section occurs concurrently across all cluster instances.
2. **Safe Release**: A client whose lock lease expired must never release another client's newly acquired lock on the same resource.
3. **Heartbeat Watchdog**: When `autoRenew: true`, a background heartbeat extends the TTL every `ttl / 3`. If renewal returns `0` (lock lost), the watchdog immediately fails closed and aborts/signals.
4. **Contention Handling**: When `waitTimeout > 0`, the client retries acquisition with randomized jittered backoff until acquired or timeout expires.

---

## 5. Lease Loss, Renewal Errors & Release

These rules make invariant 3 concrete. Every lane must follow them.

- **`autoRenew` defaults to on in every lane.** Node `autoRenew` and Python `auto_renew` default to `true`; Go renews unless `Config.DisableAutoRenew` or `WithAutoRenew(false)` is set (the old `Config.AutoRenew` field is ignored).
- **Definite loss.** A renewal that returns `0` means the lease is lost. The watchdog stops renewing.
- **Unknown is not lost.** A renewal that throws / returns an error (timeout, connection reset) says nothing about ownership. The watchdog keeps running and retries on the next tick. It fails closed only once a full TTL has passed since the last confirmed acquisition or renewal, at which point the lease has certainly expired and is treated as lost.
- **Loss is always reported to the caller.** A lost lease must never yield a normal result:
  - Node / Python: after the protected method settles, the wrapper raises `LockLostError` instead of returning the result. If the method itself failed, that error is attached as the cause (`cause` in Node, `__context__` in Python). In Python a cancellation in flight is never replaced by `LockLostError`.
  - Go: `Lock.Lost()` is closed; `Do` cancels the context it passes to `fn` with cause `ErrLockLost`; `Release` and `Do` return `ErrLockLost`.
- **The release result is a loss signal too.** The watchdog is not the only observer: with auto-renew off, a stalled process, or renewals that only errored, no renewal ever sees the loss. A release script that returns the integer `0` (the key no longer holds our token) therefore means the lease was lost and is reported exactly like a loss seen by a renewal. A release that errors is *unknown*: it is reported as lost only when a full TTL has already passed since the last confirmed acquisition or renewal; otherwise Node / Python swallow it and return the method's outcome, and Go returns the release error. A missing or non-integer release result is not a loss.
- **Release is always attempted.** The release script is token-guarded, so the wrapper runs it whether or not the lease is believed lost: it is a no-op for a lease that is no longer ours and frees a still-owned key immediately instead of leaving it for a full TTL.
- **Go `Release` is retryable.** A lock is marked released only when the release script actually ran; if it failed (for example a cancelled context) a later `Release` retries the delete. `Do` releases with a context bounded by the lock TTL and returns the release error joined with `fn`'s error.
- **Python cancellation.** Stopping the watchdog must not absorb a cancellation aimed at the caller; the lock is still released before the cancellation propagates.
- **Python class form.** `distributed_lock_class` wraps only coroutine functions; sync methods, sync static/class methods and property accessors are left untouched.
