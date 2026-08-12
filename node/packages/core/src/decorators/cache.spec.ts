import { cache, CACHE_MISS } from './cache'

describe('cache decorator', () => {
  it('returns cached result if available', async () => {
    const cacheAdapter = {
      get: jest.fn().mockResolvedValue('cached result'),
      set: jest.fn().mockResolvedValue(undefined),
    }

    class TestClass {
      callCount = 0
      @cache(cacheAdapter, 60)
      async getData(param: string) {
        this.callCount++
        return `result for ${param}`
      }
    }

    const instance = new TestClass()
    const result = await instance.getData('test')
    expect(result).toBe('cached result')
    expect(cacheAdapter.get).toHaveBeenCalled()
    expect(instance.callCount).toBe(0)
  })

  it('calls original method and caches result when not cached', async () => {
    const cacheStore = new Map<string, unknown>()
    const cacheAdapter = {
      get: jest.fn().mockImplementation((key: string) => (cacheStore.has(key) ? cacheStore.get(key) : CACHE_MISS)),
      set: jest.fn().mockImplementation((key: string, value: unknown) => cacheStore.set(key, value)),
    }

    class TestClass {
      callCount = 0
      @cache(cacheAdapter, 60)
      async getData(param: string) {
        this.callCount++
        return `result for ${param}`
      }
      @cache(cacheAdapter, 60)
      getDataV2(param: string) {
        this.callCount++
        return `result for ${param}`
      }
    }

    const instance = new TestClass()
    let result: unknown = await instance.getData('test')
    expect(result).toBe('result for test')
    // Decision #6: arg is JSON-stringified.
    expect(cacheAdapter.get).toBeCalledWith('TestClass.getData("test")')
    expect(cacheAdapter.set).toHaveBeenCalled()
    result = await instance.getData('test')
    expect(result).toBe('result for test')
    expect(instance.callCount).toBe(1)
    result = instance.getDataV2('testV2')
    expect(result).toBe('result for testV2')
    expect(instance.callCount).toBe(2)
    result = instance.getDataV2('testV2')
    expect(instance.callCount).toBe(2)
    expect(result).toBe('result for testV2')
  })

  it('caches falsy values via CACHE_MISS sentinel (D-B)', async () => {
    const store = new Map<string, unknown>()
    const adapter = {
      get: (key: string) => (store.has(key) ? store.get(key) : CACHE_MISS),
      set: (key: string, value: unknown) => {
        store.set(key, value)
      },
    }

    class Svc {
      nullCalls = 0
      zeroCalls = 0
      emptyCalls = 0

      @cache(adapter, 60)
      returnsNull() {
        this.nullCalls++
        return null
      }

      @cache(adapter, 60)
      returnsZero() {
        this.zeroCalls++
        return 0
      }

      @cache(adapter, 60)
      returnsEmpty() {
        this.emptyCalls++
        return ''
      }
    }

    const s = new Svc()
    for (let i = 0; i < 2; i++) {
      expect(s.returnsNull()).toBeNull()
      expect(s.returnsZero()).toBe(0)
      expect(s.returnsEmpty()).toBe('')
    }
    // Each method ran exactly once — the second call hit the cache despite the value being falsy.
    expect(s.nullCalls).toBe(1)
    expect(s.zeroCalls).toBe(1)
    expect(s.emptyCalls).toBe(1)
  })
})
