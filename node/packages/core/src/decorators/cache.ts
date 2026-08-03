// @cache decorator. Decisions #6 + D-B (v2.0.0):
//  * Cache key now built by `buildCacheKey` (matches Python; spec in contracts/rules/cache-key.md).
//  * Adapters return the `CACHE_MISS` sentinel for absent keys (D-B). Hit detection uses
//    identity comparison so users can cache null/undefined/0/""/false as legitimate values.

import { buildCacheKey } from './_cache_key'

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

export function cache(cacheAdapter: CacheAdapter, TTL: number) {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value
    const qualname = `${target.constructor.name}.${propertyKey}`

    descriptor.value = function (...args: unknown[]) {
      const key = buildCacheKey(qualname, args)
      const cached = cacheAdapter.get(key)

      if (isThenable(cached)) {
        // Async adapter (regardless of whether the wrapped method is sync or async).
        return (async () => {
          const awaited = await cached
          if (awaited !== CACHE_MISS) return awaited
          const result = await originalMethod.apply(this, args)
          await cacheAdapter.set(key, result, TTL)
          return result
        })()
      }

      if (cached !== CACHE_MISS) {
        return cached
      }

      const result = originalMethod.apply(this, args)
      if (isThenable(result)) {
        // Async method + sync adapter: await the resolved value before caching it so the
        // adapter never receives a pending Promise (the ES6-downlevel bug this replaces).
        return result.then(async (resolved: unknown) => {
          await cacheAdapter.set(key, resolved, TTL)
          return resolved
        })
      }

      // Genuinely sync method + sync adapter: stay fully synchronous.
      cacheAdapter.set(key, result, TTL)
      return result
    }
    return descriptor
  }
}
