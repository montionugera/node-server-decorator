import { cache } from "./cache"

describe("cache decorator", () => {
  it("returns cached result if available", async () => {
    const cacheAdapter = {
      get: jest.fn().mockResolvedValue("cached result"),
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
    const result = await instance.getData("test")
    expect(result).toBe("cached result")
    expect(cacheAdapter.get).toHaveBeenCalled()
    // When cache hit happens, the original method is not called.
    expect(instance.callCount).toBe(0)
  })

  it("calls original method and caches result when not cached", async () => {
    const cacheStore = new Map<string, string>()
    const cacheAdapter = {
      get: jest.fn().mockImplementation((key: string) => cacheStore.get(key)),
      set: jest.fn().mockImplementation((key: string, value: string) => cacheStore.set(key, value)),
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
    let result = await instance.getData("test")
    expect(result).toBe("result for test")
    expect(cacheAdapter.get).toBeCalledWith("TestClass.getData(test)")
    expect(cacheAdapter.set).toHaveBeenCalled()
    result = await instance.getData("test")
    expect(result).toBe("result for test")
    expect(instance.callCount).toBe(1)
    result = instance.getDataV2("testV2")
    expect(result).toBe("result for testV2")
    expect(instance.callCount).toBe(2)
    result = instance.getDataV2("testV2")
    expect(instance.callCount).toBe(2)
    expect(result).toBe("result for testV2")
  })
})
