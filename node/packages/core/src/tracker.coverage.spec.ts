import * as trackerModule from './tracker'
import { setGlobalTracker, Tracker } from './tracker'

describe('tracker module', () => {
  const original = trackerModule.globalTracker

  afterEach(() => {
    setGlobalTracker(original)
    jest.restoreAllMocks()
  })

  it('default tracker logs key, latency and error flag to console.log', () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {})

    trackerModule.globalTracker.track('Svc.method', 42, false)
    trackerModule.globalTracker.track('Svc.failing', 0, true)

    expect(log).toHaveBeenCalledTimes(2)
    expect(log).toHaveBeenNthCalledWith(
      1,
      '[Global Tracker] Svc.method - Latency: 42ms, Error: false',
    )
    expect(log).toHaveBeenNthCalledWith(
      2,
      '[Global Tracker] Svc.failing - Latency: 0ms, Error: true',
    )
  })

  it('default tracker returns nothing and does not throw on NaN / negative latency', () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {})

    expect(trackerModule.globalTracker.track('k', NaN, false)).toBeUndefined()
    expect(trackerModule.globalTracker.track('k', -5, true)).toBeUndefined()

    expect(log).toHaveBeenNthCalledWith(1, '[Global Tracker] k - Latency: NaNms, Error: false')
    expect(log).toHaveBeenNthCalledWith(2, '[Global Tracker] k - Latency: -5ms, Error: true')
  })

  it('setGlobalTracker swaps the exported live binding and stops using the default', () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {})
    const seen: Array<[string, number, boolean]> = []
    const custom: Tracker = { track: (key, latency, isError) => void seen.push([key, latency, isError]) }

    setGlobalTracker(custom)

    expect(trackerModule.globalTracker).toBe(custom)
    trackerModule.globalTracker.track('A.b', 7, true)
    expect(seen).toEqual([['A.b', 7, true]])
    expect(log).not.toHaveBeenCalled()
  })

  it('the last tracker set wins and the original can be restored', () => {
    const first: Tracker = { track: () => {} }
    const second: Tracker = { track: () => {} }

    setGlobalTracker(first)
    setGlobalTracker(second)
    expect(trackerModule.globalTracker).toBe(second)

    setGlobalTracker(original)
    expect(trackerModule.globalTracker).toBe(original)
  })
})
