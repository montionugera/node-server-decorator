export interface Tracker {
  track(key: string, latency: number, isError: boolean): void
}

export let globalTracker: Tracker = {
  track: (key: string, latency: number, isError: boolean) => {
    // Default implementation; replace with your own tracking logic
    console.log(
      `[Global Tracker] ${key} - Latency: ${latency}ms, Error: ${isError}`
    )
  },
}

export function setGlobalTracker(tracker: Tracker) {
  globalTracker = tracker
}
