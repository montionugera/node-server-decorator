// Regression coverage for the ES6-downlevel async-detection bug (see
// contracts/rules/cache-adapter.md and .superpowers/sdd/2026-08-04-entity-spec-framework-p0-p1/task-5-report.md,
// "## E2E drift diagnosis round 2").
//
// Root cause: cache.ts used `originalMethod.constructor.name.includes('AsyncFunction')` to
// pick the sync/async branch. Under this package's own tsconfig (`target: es6`), TypeScript
// downlevels `async` methods to plain functions wrapped by `__awaiter`, so that check is always
// false — genuine async methods got routed into the sync branch, which handed an unresolved
// Promise straight to `adapter.set`. A JSON-serializing adapter (matching the shape every real
// adapter — Redis, etc. — uses) then persists `JSON.stringify(Promise)`, which is `"{}"`.
//
// These adapters intentionally round-trip through JSON.stringify/JSON.parse (like the Redis
// integration test's RedisCacheAdapter) so the corruption reproduces exactly as it does against
// real Redis, instead of just holding object references in a Map.

import { cache, CACHE_MISS } from './cache'
import { buildCacheKey } from './_cache_key'

function jsonAdapter() {
  const raw = new Map<string, string>()
  return {
    get: async (key: string): Promise<unknown> => {
      const v = raw.get(key)
      return v === undefined ? CACHE_MISS : JSON.parse(v)
    },
    set: async (key: string, value: unknown): Promise<void> => {
      raw.set(key, JSON.stringify(value))
    },
  }
}

function syncAdapter() {
  const store = new Map<string, unknown>()
  return {
    get: (key: string): unknown => (store.has(key) ? store.get(key) : CACHE_MISS),
    set: (key: string, value: unknown): void => {
      store.set(key, value)
    },
  }
}

describe('cache decorator — runtime thenable detection (ES6-downlevel async)', () => {
  it('(a) async method + async adapter: second call hits cache and returns the real value, not {}', async () => {
    const adapter = jsonAdapter()

    class Svc {
      calls = 0
      @cache(adapter, 60)
      async expensive(id: string) {
        this.calls++
        return { id, ts: 42 }
      }
    }

    const s = new Svc()
    const r1 = await s.expensive('abc')
    const r2 = await s.expensive('abc')
    expect(r1).toEqual({ id: 'abc', ts: 42 })
    expect(r2).toEqual({ id: 'abc', ts: 42 })
    expect(s.calls).toBe(1)
  })

  it('(b) async method returning null: CACHE_MISS contract lets null round-trip, compute called once', async () => {
    const adapter = jsonAdapter()

    class Svc {
      calls = 0
      @cache(adapter, 60)
      async maybeNull() {
        this.calls++
        return null
      }
    }

    const s = new Svc()
    expect(await s.maybeNull()).toBeNull()
    expect(await s.maybeNull()).toBeNull()
    expect(s.calls).toBe(1)
  })

  it('(c) sync method + sync adapter: return value is not a Promise, and caching works', () => {
    const adapter = syncAdapter()

    class Svc {
      calls = 0
      @cache(adapter, 60)
      compute(x: number) {
        this.calls++
        return x * 2
      }
    }

    const s = new Svc()
    const r1 = s.compute(21)
    expect(r1).not.toBeInstanceOf(Promise)
    expect(r1).toBe(42)
    const r2 = s.compute(21)
    expect(r2).not.toBeInstanceOf(Promise)
    expect(r2).toBe(42)
    expect(s.calls).toBe(1)
  })

  it('(d) sync method + async adapter: works via the thenable fallback', async () => {
    const adapter = jsonAdapter()

    class Svc {
      calls = 0
      @cache(adapter, 60)
      compute(x: number) {
        this.calls++
        return x * 2
      }
    }

    const s = new Svc()
    const r1 = await s.compute(21)
    const r2 = await s.compute(21)
    expect(r1).toBe(42)
    expect(r2).toBe(42)
    expect(s.calls).toBe(1)
  })

  it('(e) async method + sync adapter, WARM cache: hit is a thenable resolving to the cached value (I3)', async () => {
    const adapter = syncAdapter()

    class Svc {
      calls = 0
      @cache(adapter, 60)
      async expensive(id: string) {
        this.calls++
        return { id, ts: 42 }
      }
    }

    // Pre-populate the adapter directly (bypassing the decorator) so the very first call
    // through the decorated method is a HIT — this exercises the decoration-time heuristic,
    // not the runtime-miss-path correction, because no miss has happened yet on this
    // decorator instance to teach it the method is async.
    const key = buildCacheKey('Svc.expensive', ['abc'])
    adapter.set(key, { id: 'abc', ts: 42 })

    const s = new Svc()
    const r1 = s.expensive('abc')
    expect(typeof (r1 as unknown as { then?: unknown }).then).toBe('function')
    await expect(r1).resolves.toEqual({ id: 'abc', ts: 42 })
    expect(s.calls).toBe(0) // never computed — served straight from the warm cache
  })

  it('(f) sync method + sync adapter still returns a non-Promise on hit', () => {
    const adapter = syncAdapter()

    class Svc {
      calls = 0
      @cache(adapter, 60)
      compute(x: number) {
        this.calls++
        return x * 2
      }
    }

    const s = new Svc()
    s.compute(21) // miss, populates cache
    const r2 = s.compute(21) // hit
    expect(r2).not.toBeInstanceOf(Promise)
    expect(r2).toBe(42)
    expect(s.calls).toBe(1)
  })
})
