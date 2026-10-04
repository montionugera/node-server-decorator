// Regression tests for confirmed @cache / cache-key defects.
// Spec: contracts/rules/cache-key.md and contracts/rules/cache-adapter.md.

import { cache, CACHE_MISS, type CacheAdapter } from './cache'
import { buildCacheKey } from './_cache_key'
import { globalLogger, setGlobalLogger, type Logger } from '../logger'

class MemAdapter implements CacheAdapter {
  store = new Map<string, unknown>()
  get(key: string): unknown {
    return this.store.has(key) ? this.store.get(key) : CACHE_MISS
  }
  set(key: string, value: unknown): void {
    this.store.set(key, value)
  }
}

describe('@cache on static methods', () => {
  it('uses the class name, so same-named statics on different classes do not share entries', () => {
    const adapter = new MemAdapter()

    class UserRepo {
      @cache(adapter, 60)
      static find(id: number) {
        return `user${id}`
      }
    }
    class OrderRepo {
      @cache(adapter, 60)
      static find(id: number) {
        return `order${id}`
      }
    }

    expect(UserRepo.find(1)).toBe('user1')
    expect(OrderRepo.find(1)).toBe('order1')
    expect([...adapter.store.keys()].sort()).toEqual(['OrderRepo.find(1)', 'UserRepo.find(1)'])
  })

  it('keeps ClassName.method for instance methods', () => {
    const adapter = new MemAdapter()
    class Svc {
      @cache(adapter, 60)
      go(n: number) {
        return n
      }
    }
    new Svc().go(3)
    expect([...adapter.store.keys()]).toEqual(['Svc.go(3)'])
  })
})

describe('buildCacheKey: non-plain objects', () => {
  it('serialises a Date as its ISO-8601 string', () => {
    expect(buildCacheKey('F.b', [new Date(0)])).toBe('F.b("1970-01-01T00:00:00.000Z")')
  })

  it('gives different Dates different keys, including nested ones', () => {
    expect(buildCacheKey('F.b', [new Date(0)])).not.toBe(buildCacheKey('F.b', [new Date(1e12)]))
    expect(buildCacheKey('F.b', [{ day: new Date(0) }])).toBe('F.b({"day":"1970-01-01T00:00:00.000Z"})')
  })

  it('surfaces an error for an invalid Date instead of colliding with null', () => {
    expect(() => buildCacheKey('F.b', [new Date(NaN)])).toThrow(RangeError)
  })

  it('serialises a Map by its entries, order-independently', () => {
    const a = new Map<unknown, unknown>([
      ['b', 2],
      ['a', 1],
    ])
    const b = new Map<unknown, unknown>([
      ['a', 1],
      ['b', 2],
    ])
    expect(buildCacheKey('F.b', [a])).toBe('F.b({"a":1,"b":2})')
    expect(buildCacheKey('F.b', [b])).toBe(buildCacheKey('F.b', [a]))
    expect(buildCacheKey('F.b', [new Map([[1, 2]])])).not.toBe(buildCacheKey('F.b', [new Map([[1, 3]])]))
  })

  it('serialises a Set by its members, order-independently', () => {
    expect(buildCacheKey('F.b', [new Set([2, 1])])).toBe('F.b([1,2])')
    expect(buildCacheKey('F.b', [new Set([1, 2])])).toBe('F.b([1,2])')
    expect(buildCacheKey('F.b', [new Set([1])])).not.toBe(buildCacheKey('F.b', [new Set([2])]))
  })

  it('honours toJSON', () => {
    const money = { toJSON: () => ({ c: 'THB', a: 5 }) }
    expect(buildCacheKey('F.b', [money])).toBe('F.b({"a":5,"c":"THB"})')
  })

  it('falls back to String(x) for keyless non-plain objects', () => {
    expect(buildCacheKey('F.b', [/a+/g])).toBe('F.b("/a+/g")')
    expect(buildCacheKey('F.b', [/a+/g])).not.toBe(buildCacheKey('F.b', [/b+/g]))
  })

  it('still serialises plain objects and class instances by their own keys', () => {
    class Dto {
      constructor(
        public b: number,
        public a: number,
      ) {}
    }
    expect(buildCacheKey('F.b', [new Dto(2, 1)])).toBe('F.b({"a":1,"b":2})')
    expect(buildCacheKey('F.b', [{}])).toBe('F.b({})')
    expect(buildCacheKey('F.b', [Object.create(null)])).toBe('F.b({})')
  })
})

describe('buildCacheKey: non-finite numbers', () => {
  it.each([
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
  ])('throws a TypeError for %s', (_name, value) => {
    expect(() => buildCacheKey('F.b', [value])).toThrow(TypeError)
    expect(() => buildCacheKey('F.b', [{ nested: [value] }])).toThrow(TypeError)
    expect(() => buildCacheKey('F.b', [], { k: value })).toThrow(TypeError)
  })

  it('does not call the wrapped method or the adapter when the key cannot be built', () => {
    const adapter = new MemAdapter()
    let calls = 0
    class Svc {
      @cache(adapter, 60)
      price(n: number) {
        calls++
        return n
      }
    }
    expect(() => new Svc().price(NaN)).toThrow(TypeError)
    expect(calls).toBe(0)
    expect(adapter.store.size).toBe(0)
  })
})

describe('@cache when the adapter fails', () => {
  let saved: Logger
  let warnings: string[]

  beforeEach(() => {
    saved = globalLogger
    warnings = []
    setGlobalLogger({
      debug: () => undefined,
      info: () => undefined,
      warn: (m: string) => {
        warnings.push(m)
      },
      error: () => undefined,
    })
  })
  afterEach(() => setGlobalLogger(saved))

  it('sync method + sync adapter: a throwing set returns the computed result (fail open)', () => {
    const adapter: CacheAdapter = {
      get: () => CACHE_MISS,
      set: () => {
        throw new Error('redis down')
      },
    }
    let calls = 0
    class Svc {
      @cache(adapter, 60)
      pay() {
        calls++
        return 'paid'
      }
    }
    expect(new Svc().pay()).toBe('paid')
    expect(calls).toBe(1)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('Svc.pay()')
    expect(warnings[0]).toContain('redis down')
  })

  it('async method + sync adapter: a throwing set resolves with the computed result', async () => {
    const adapter: CacheAdapter = {
      get: () => CACHE_MISS,
      set: () => {
        throw new Error('redis down')
      },
    }
    let calls = 0
    class Svc {
      @cache(adapter, 60)
      async pay() {
        calls++
        return 'paid'
      }
    }
    await expect(new Svc().pay()).resolves.toBe('paid')
    expect(calls).toBe(1)
    expect(warnings).toHaveLength(1)
  })

  it('async adapter: a rejecting set resolves with the computed result', async () => {
    const adapter: CacheAdapter = {
      get: async () => CACHE_MISS,
      set: async () => {
        throw new Error('redis down')
      },
    }
    let calls = 0
    class Svc {
      @cache(adapter, 60)
      async pay() {
        calls++
        return 'paid'
      }
    }
    await expect(new Svc().pay()).resolves.toBe('paid')
    expect(calls).toBe(1)
    expect(warnings).toHaveLength(1)
  })

  it('sync method + sync get + async set: a rejecting set does not leak an unhandled rejection', async () => {
    const adapter: CacheAdapter = {
      get: () => CACHE_MISS,
      set: () => Promise.reject(new Error('redis down')),
    }
    class Svc {
      @cache(adapter, 60)
      pay() {
        return 'paid'
      }
    }
    expect(new Svc().pay()).toBe('paid')
    await new Promise((resolve) => setImmediate(resolve))
    expect(warnings).toHaveLength(1)
  })

  it('a throwing get fails closed: the error propagates and the method is not called', () => {
    const adapter: CacheAdapter = {
      get: () => {
        throw new Error('redis down')
      },
      set: () => undefined,
    }
    let calls = 0
    class Svc {
      @cache(adapter, 60)
      pay() {
        calls++
        return 'paid'
      }
    }
    expect(() => new Svc().pay()).toThrow('redis down')
    expect(calls).toBe(0)
  })

  it('a rejecting get fails closed: the rejection propagates and the method is not called', async () => {
    const adapter: CacheAdapter = {
      get: () => Promise.reject(new Error('redis down')),
      set: () => undefined,
    }
    let calls = 0
    class Svc {
      @cache(adapter, 60)
      async pay() {
        calls++
        return 'paid'
      }
    }
    await expect(new Svc().pay()).rejects.toThrow('redis down')
    expect(calls).toBe(0)
  })
})
