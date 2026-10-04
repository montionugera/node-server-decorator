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
