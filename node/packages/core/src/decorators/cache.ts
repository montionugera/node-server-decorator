// @cache decorator. Decisions #6 + D-B (v2.0.0):
//  * Cache key now built by `buildCacheKey` (matches Python; spec in contracts/rules/cache-key.md).
//  * Adapters return the `CACHE_MISS` sentinel for absent keys (D-B). Hit detection uses
//    identity comparison so users can cache null/undefined/0/""/false as legitimate values.

import { buildCacheKey } from './_cache_key'
import { globalLogger } from '../logger'

// Process-shared sentinel via Symbol.for so user adapters in separate modules produce the same value.
export const CACHE_MISS = Symbol.for('server-decorator.cache.miss')
export type CacheMiss = typeof CACHE_MISS

export interface CacheAdapter {
  get(key: string): unknown | Promise<unknown>
  set(key: string, value: unknown, ttl: number): void | Promise<void>
}

// Runtime thenable check, used in place of compile-time function-flavor detection
// (`fn.constructor.name.includes('AsyncFunction')`). That check silently always evaluates
// false under this package's own tsconfig (`target: es6`): TypeScript downlevels `async`
// methods to plain functions wrapped by `__awaiter`, so `constructor.name` is `'Function'`
// for both sync and (downleveled) async methods. Branching on the *actual runtime shape* of
// what `adapter.get`/the wrapped method return — thenable or not — works regardless of how
// the method was compiled, and preserves a synchronous return for genuinely-sync method +
// sync adapter pairs (no unconditional async wrapping).
const isThenable = (v: unknown): v is PromiseLike<unknown> =>
  v != null && typeof (v as { then?: unknown }).then === 'function'

// Cache writes fail open (contracts/rules/cache-adapter.md): the wrapped method has already
// run, so a failing `set` must not turn its result into an error (a retrying caller would
// repeat the side effect). Logs and swallows both a synchronous throw and a rejection; the
// returned promise (async `set` only) never rejects.
function safeSet(adapter: CacheAdapter, key: string, value: unknown, ttl: number): void | Promise<void> {
  const onError = (err: unknown) => {
    globalLogger.warn(`@cache: failed to write key ${key}: ${String(err)}`)
  }
  try {
    const pending = adapter.set(key, value, ttl)
    if (isThenable(pending)) return Promise.resolve(pending).then(() => undefined, onError)
  } catch (err) {
    onError(err)
  }
}

export function cache(cacheAdapter: CacheAdapter, TTL: number) {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value
    // For a static method `target` is the constructor itself, whose own `constructor` is
    // `Function` — use its name directly so statics on different classes get distinct keys.
    const className = typeof target === 'function' ? target.name : target.constructor.name
    const qualname = `${className}.${propertyKey}`

    // Decoration-time heuristic for "is the wrapped method async?", used only to pick the
    // SHAPE of a cache HIT with a sync adapter (see below) before any miss has happened to
    // tell us the truth at runtime. `constructor.name === 'AsyncFunction'` catches genuine
    // native async functions/methods. It does NOT catch async methods that TypeScript
    // downlevels to plain functions wrapped by the `__awaiter` helper (this package's own
    // tsconfig uses `target: es6`, where `constructor.name` is always `'Function'` even for
    // `async` methods — see the isThenable comment above) — so we also sniff the compiled
    // source text for `__awaiter`, the fingerprint every ES5/ES6-downleveled async function
    // emits. This is a heuristic, not proof: it can false-positive (a sync method whose body
    // happens to contain the literal string `__awaiter`, e.g. in a comment) or false-negative
    // (a bundler that renames/inlines the helper). `treatAsAsync` is corrected to the
    // ground-truth runtime shape (`isThenable(result)`) the first time this decorator
    // instance actually sees a miss, so the heuristic only matters for a hit on the very
    // first call against a pre-warmed cache.
    let treatAsAsync =
      originalMethod.constructor.name === 'AsyncFunction' ||
      originalMethod.toString().includes('__awaiter')

    descriptor.value = function (...args: unknown[]) {
      const key = buildCacheKey(qualname, args)
      const cached = cacheAdapter.get(key)

      if (isThenable(cached)) {
        // Async adapter (regardless of whether the wrapped method is sync or async).
        return (async () => {
          const awaited = await cached
          if (awaited !== CACHE_MISS) return awaited
          const result = originalMethod.apply(this, args)
          treatAsAsync = isThenable(result)
          const resolved = treatAsAsync ? await result : result
          await safeSet(cacheAdapter, key, resolved, TTL)
          return resolved
        })()
      }

      if (cached !== CACHE_MISS) {
        // Sync-adapter cache hit (I3): a hit must return the same shape a miss would have
        // for this method, so callers can `.then()`/`await` uniformly regardless of cache
        // state. `treatAsAsync` reflects either the decoration-time heuristic above (no miss
        // yet) or the real runtime shape learned from a prior miss on this decorator
        // instance — runtime truth always wins once observed.
        return treatAsAsync ? Promise.resolve(cached) : cached
      }

      const result = originalMethod.apply(this, args)
      treatAsAsync = isThenable(result)
      if (treatAsAsync) {
        // Async method + sync adapter: await the resolved value before caching it so the
        // adapter never receives a pending Promise (the ES6-downlevel bug this replaces).
        return result.then(async (resolved: unknown) => {
          await safeSet(cacheAdapter, key, resolved, TTL)
          return resolved
        })
      }

      // Genuinely sync method + sync adapter: stay fully synchronous.
      safeSet(cacheAdapter, key, result, TTL)
      return result
    }
    return descriptor
  }
}
