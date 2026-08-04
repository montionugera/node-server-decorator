import { tracking } from "./tracking"
import {globalTracker} from "../tracker";

describe("tracking decorator", () => {
  it("logs tracking info and returns correct result", async () => {
    const trackSpy = jest.spyOn(globalTracker, "track").mockImplementation(() => {})

    class TestClass {
      @tracking
      async doSomething(num: number) {
        return num * 2
      }
    }

    const instance = new TestClass()
    const result = await instance.doSomething(5)
    expect(result).toBe(10)
    expect(trackSpy).toHaveBeenCalled()
    const [key,latency,isError] = trackSpy.mock.calls[0]
    expect(key).toMatch(/TestClass.doSomething/)
    expect(latency.toString()).toMatch(/\d+/)
    expect(isError.toString()).toMatch(/false/)
    trackSpy.mockRestore()
  })

  it("logs tracking info with error flag on exception", async () => {
    const trackSpy = jest.spyOn(globalTracker, "track").mockImplementation(() => {})

    class TestClass {
      @tracking
      async doSomething() {
        throw new Error("Failure")
      }
    }

    const instance = new TestClass()
    await expect(instance.doSomething()).rejects.toThrow("Failure")
    expect(trackSpy).toHaveBeenCalled()
    expect(trackSpy.mock.calls[0][0]).toMatch('TestClass.doSomething')
    expect(trackSpy.mock.calls[0][2]).toBe(true)

    trackSpy.mockRestore()
  })
})
