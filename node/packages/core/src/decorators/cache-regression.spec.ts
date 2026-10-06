// Regression tests for confirmed @cache / cache-key defects.
// Spec: contracts/rules/cache-key.md and contracts/rules/cache-adapter.md.

import { readFileSync } from 'fs'
import { join } from 'path'
import { runInNewContext } from 'vm'
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

describe('buildCacheKey: keyless objects with only a generic "[object X]" string form', () => {
  const opaque = /no enumerable keys and no meaningful string form.*toJSON\(\)/

  it('rejects a class instance whose state is only #private fields', () => {
    class Account {
      #id: number
      constructor(id: number) {
        this.#id = id
      }
      get id() {
        return this.#id
      }
    }
    expect(() => buildCacheKey('F.b', [new Account(1)])).toThrow(TypeError)
    expect(() => buildCacheKey('F.b', [new Account(1)])).toThrow(opaque)
  })

  it('rejects a class instance that only has getters', () => {
    class Lazy {
      get value() {
        return 1
      }
    }
    expect(() => buildCacheKey('F.b', [new Lazy()])).toThrow(opaque)
  })

  it.each([
    ['WeakMap', () => new WeakMap()],
    ['WeakSet', () => new WeakSet()],
    ['Promise', () => Promise.resolve(1)],
  ])('rejects a %s', (name, make) => {
    expect(() => buildCacheKey('F.b', [make()])).toThrow(TypeError)
    expect(() => buildCacheKey('F.b', [make()])).toThrow(`[object ${name}]`)
  })

  it('rejects a class instance with no enumerable fields at all, also behind a Proxy', () => {
    class Empty {}
    expect(() => buildCacheKey('F.b', [new Empty()])).toThrow(opaque)
    expect(() => buildCacheKey('F.b', [new Proxy(new Empty(), {})])).toThrow(opaque)
  })

  it.each([
    ['ArrayBuffer', () => new ArrayBuffer(8)],
    ['DataView', () => new DataView(new ArrayBuffer(8))],
    ['Custom', () => Object.create({ [Symbol.toStringTag]: 'Custom' })],
    ['Tagged', () => new (class { get [Symbol.toStringTag]() { return 'Tagged' } })()],
  ])('rejects a keyless %s', (name, make) => {
    expect(() => buildCacheKey('F.b', [make()])).toThrow(TypeError)
    expect(() => buildCacheKey('F.b', [make()])).toThrow(`[object ${name}]`)
  })

  it('throws synchronously from an async method, before the adapter is touched', () => {
    const adapter = new MemAdapter()
    const get = jest.spyOn(adapter, 'get')
    class Repo {
      @cache(adapter, 60)
      async load(_handle: unknown) {
        return 1
      }
    }
    expect(() => new Repo().load(new ArrayBuffer(8))).toThrow(TypeError)
    expect(get).not.toHaveBeenCalled()
  })

  it('treats a plain object from another realm like a same-realm one', () => {
    expect(buildCacheKey('F.b', [runInNewContext('({})')])).toBe('F.b({})')
    expect(buildCacheKey('F.b', [runInNewContext('({ b: 1, a: { c: [] } })')])).toBe(
      'F.b({"a":{"c":[]},"b":1})',
    )
  })

  it('rejects one nested inside a plain object, array, Map or Set', () => {
    expect(() => buildCacheKey('F.b', [{ a: new WeakMap() }])).toThrow(opaque)
    expect(() => buildCacheKey('F.b', [[new WeakMap()]])).toThrow(opaque)
    expect(() =>
      buildCacheKey('F.b', [new Map([['a', new WeakMap()]])]),
    ).toThrow(opaque)
    expect(() => buildCacheKey('F.b', [new Set([new WeakMap()])])).toThrow(
      opaque,
    )
  })

  it('surfaces the error through @cache before the adapter or the method is touched', () => {
    const adapter = new MemAdapter()
    const get = jest.spyOn(adapter, 'get')
    let calls = 0
    class Repo {
      @cache(adapter, 60)
      load(_handle: unknown) {
        calls += 1
        return calls
      }
    }
    expect(() => new Repo().load(new WeakMap())).toThrow(TypeError)
    expect(get).not.toHaveBeenCalled()
    expect(calls).toBe(0)
  })

  it('keeps RegExp, Error and any object with a meaningful String(x)', () => {
    class Sku {
      #code: string
      constructor(code: string) {
        this.#code = code
      }
      toString() {
        return `sku:${this.#code}`
      }
    }
    expect(buildCacheKey('F.b', [/a+/g])).toBe('F.b("/a+/g")')
    expect(buildCacheKey('F.b', [new Error('boom')])).toBe('F.b("Error: boom")')
    expect(buildCacheKey('F.b', [new Sku('a')])).toBe('F.b("sku:a")')
    expect(buildCacheKey('F.b', [new Sku('a')])).not.toBe(
      buildCacheKey('F.b', [new Sku('b')]),
    )
  })

  it('keeps a #private-only instance that implements toJSON', () => {
    class Account {
      #id: number
      constructor(id: number) {
        this.#id = id
      }
      toJSON() {
        return { id: this.#id }
      }
    }
    expect(buildCacheKey('F.b', [new Account(7)])).toBe('F.b({"id":7})')
  })

  it('keeps Date, Map and Set, including empty ones', () => {
    expect(buildCacheKey('F.b', [new Date(0)])).toBe(
      'F.b("1970-01-01T00:00:00.000Z")',
    )
    expect(buildCacheKey('F.b', [new Map()])).toBe('F.b({})')
    expect(buildCacheKey('F.b', [new Set()])).toBe('F.b([])')
  })

  it('keeps plain objects, including {} and Object.create(null), and instances with fields', () => {
    class Dto {
      constructor(public a: number) {}
    }
    expect(buildCacheKey('F.b', [{}])).toBe('F.b({})')
    expect(buildCacheKey('F.b', [Object.create(null)])).toBe('F.b({})')
    expect(buildCacheKey('F.b', [{ a: 1 }])).toBe('F.b({"a":1})')
    expect(buildCacheKey('F.b', [new Dto(1)])).toBe('F.b({"a":1})')
  })

  it('leaves a plain object with only symbol keys as {} (symbol keys are never part of the key)', () => {
    expect(buildCacheKey('F.b', [{ [Symbol('s')]: 1 }])).toBe('F.b({})')
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

describe('buildCacheKey: key ordering by code point', () => {
  it("plain object with keys '😀', '～', 'z' orders by code point", () => {
    expect(buildCacheKey('F.b', [{ '😀': 2, '～': 1, z: 0 }])).toBe(
      'F.b({"z":0,"～":1,"😀":2})',
    )
  })

  it('kwargs orders by code point', () => {
    expect(buildCacheKey('F.b', [], { '😀': 2, '～': 1 })).toBe(
      'F.b(～=1,😀=2)',
    )
  })

  it('Map with the same three keys gives exactly the same key as the plain object', () => {
    const map = new Map<string, number>([
      ['😀', 2],
      ['～', 1],
      ['z', 0],
    ])
    expect(buildCacheKey('F.b', [map])).toBe(
      buildCacheKey('F.b', [{ '😀': 2, '～': 1, z: 0 }]),
    )
  })

  it('new Map([[\'a\', 1], [\'a!\', 2]]) -> F.b({"a":1,"a!":2})', () => {
    expect(
      buildCacheKey('F.b', [
        new Map([
          ['a', 1],
          ['a!', 2],
        ]),
      ]),
    ).toBe('F.b({"a":1,"a!":2})')
  })

  it('Set: new Set([\'😀\', \'～\']) -> F.b(["～","😀"])', () => {
    expect(buildCacheKey('F.b', [new Set(['😀', '～'])])).toBe(
      'F.b(["～","😀"])',
    )
  })
})

describe('buildCacheKey: non-finite numbers in boxed and Map-key form', () => {
  it.each([
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
  ])('new Number(%s) throws TypeError in various positions', (_name, v) => {
    expect(() => buildCacheKey('F.b', [new Number(v)])).toThrow(TypeError)
    expect(() => buildCacheKey('F.b', [{ nested: [new Number(v)] }])).toThrow(
      TypeError,
    )
    expect(() =>
      buildCacheKey('F.b', [new Map([['k', new Number(v)]])]),
    ).toThrow(TypeError)
    expect(() => buildCacheKey('F.b', [new Set([new Number(v)])])).toThrow(
      TypeError,
    )
    expect(() => buildCacheKey('F.b', [], { k: new Number(v) })).toThrow(
      TypeError,
    )
  })

  it.each([
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
  ])('Map key with non-finite %s throws TypeError', (_name, v) => {
    expect(() => buildCacheKey('F.b', [new Map([[v, 1]])])).toThrow(TypeError)
    expect(() => buildCacheKey('F.b', [new Map([[new Number(v), 1]])])).toThrow(
      TypeError,
    )
  })

  it('finite inputs are unchanged', () => {
    expect(buildCacheKey('F.b', [new Number(5)])).toBe('F.b("5")')
    expect(buildCacheKey('F.b', [new Map([[1, 'a']])])).toBe('F.b({"1":"a"})')
  })
})

interface ErrorFixtureExample {
  name: string
  qualname: string
  args: unknown[]
  kwargs: Record<string, unknown>
}

const errorFixturePath = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  'contracts',
  'fixtures',
  'cache-key.errors.examples.json',
)
const errorFixture = JSON.parse(readFileSync(errorFixturePath, 'utf8')) as {
  examples: ErrorFixtureExample[]
}

function revive(val: unknown): unknown {
  if (val === null || typeof val !== 'object') {
    return val
  }
  if (Array.isArray(val)) {
    return val.map(revive)
  }
  const obj = val as Record<string, unknown>
  if (obj.$nonfinite === 'NaN') return NaN
  if (obj.$nonfinite === 'Infinity') return Infinity
  if (obj.$nonfinite === '-Infinity') return -Infinity

  const result: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    result[k] = revive(v)
  }
  return result
}

describe('buildCacheKey: shared rejection fixture (cache-key.errors.examples.json)', () => {
  it('has at least 8 examples', () => {
    expect(errorFixture.examples.length).toBeGreaterThanOrEqual(8)
  })

  it.each(errorFixture.examples)('$name', (ex) => {
    expect(() =>
      buildCacheKey(
        ex.qualname,
        revive(ex.args) as unknown[],
        revive(ex.kwargs) as Record<string, unknown>,
      ),
    ).toThrow(TypeError)
  })
})
