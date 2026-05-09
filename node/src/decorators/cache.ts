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

export function cache(cacheAdapter: CacheAdapter, TTL: number) {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value
    const qualname = `${target.constructor.name}.${propertyKey}`

    descriptor.value = function (...args: unknown[]) {
      const key = buildCacheKey(qualname, args)
      const isAsync = originalMethod.constructor.name.includes('AsyncFunction')

      if (!isAsync) {
        const cached = cacheAdapter.get(key)
        if (cached instanceof Promise) {
          // User-supplied async adapter on a sync method — fall through to async path.
          return (async () => {
            const awaited = await cached
            if (awaited !== CACHE_MISS) return awaited
            const result = originalMethod.apply(this, args)
            const setResult = cacheAdapter.set(key, result, TTL)
            if (setResult instanceof Promise) await setResult
            return result
          })()
        }
        if (cached !== CACHE_MISS) {
          return cached
        }
        const result = originalMethod.apply(this, args)
        cacheAdapter.set(key, result, TTL)
        return result
      }

      return (async () => {
        const cached = await Promise.resolve(cacheAdapter.get(key))
        if (cached !== CACHE_MISS) {
          return cached
        }
        const result = await originalMethod.apply(this, args)
        await Promise.resolve(cacheAdapter.set(key, result, TTL))
        return result
      })()
    }
    return descriptor
  }
}
