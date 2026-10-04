import { globalLogger } from '../logger'
import { parseTraceparent, runInChildSpan } from './trace'

// dispatch(rawJsonValue) -> Promise; rejecting means "do not ack".
export type Dispatch = (raw: unknown) => Promise<void>

export interface ConsumerAdapter {
  // Begin consuming, calling dispatch per message, until stop() resolves.
  run(dispatch: Dispatch): Promise<void>
  stop(): Promise<void>
}

export type EventHandler = (payload: any, metadata: Record<string, any>) => void | Promise<void>
export type UnhandledHook = (eventName: string, raw: unknown) => void
export type InvalidHook = (raw: unknown, error: Error) => void

export interface RegisterOptions {
  onUnhandled?: UnhandledHook
  onInvalid?: InvalidHook
}

interface ConsumerEntry {
  adapter: ConsumerAdapter
  handlers: Map<string, EventHandler>
  onUnhandled?: UnhandledHook
  onInvalid?: InvalidHook
}

// Structural envelope validation (mirrors contracts/schemas/queue-message).
class InvalidEnvelope extends Error {}

function validateEnvelope(raw: unknown): {
  eventName: string
  payload: unknown
  metadata: Record<string, any>
} {
  if (typeof raw !== 'object' || raw === null) {
    throw new InvalidEnvelope('envelope must be an object')
  }
  const obj = raw as Record<string, unknown>
  if (typeof obj.eventName !== 'string' || obj.eventName.length === 0) {
    throw new InvalidEnvelope("envelope missing non-empty string 'eventName'")
  }
  if (!('payload' in obj)) {
    throw new InvalidEnvelope("envelope missing 'payload'")
  }
  if (typeof obj.timestamp !== 'number' || !Number.isInteger(obj.timestamp)) {
    throw new InvalidEnvelope("envelope missing integer 'timestamp'")
  }
  const metadata =
    obj.metadata && typeof obj.metadata === 'object'
      ? (obj.metadata as Record<string, any>)
      : {}
  return { eventName: obj.eventName, payload: obj.payload, metadata }
}

export class ConsumerRegistry {
  private consumers: Map<string, ConsumerEntry> = new Map()
  private defaultConsumer?: string
  private tasks: Promise<void>[] = []

  register(name: string, adapter: ConsumerAdapter, options: RegisterOptions = {}): void {
    this.consumers.set(name, {
      adapter,
      handlers: new Map(),
      onUnhandled: options.onUnhandled,
      onInvalid: options.onInvalid,
    })
    if (this.defaultConsumer === undefined) this.defaultConsumer = name
  }

  setDefault(name: string): void {
    if (!this.consumers.has(name)) throw new Error(`consumer '${name}' not registered`)
    this.defaultConsumer = name
  }

  on(eventName: string, handler: EventHandler, options: { consumer?: string } = {}): void {
    this.entry(options.consumer).handlers.set(eventName, handler)
  }

  // Call stop() first if started — clear() does not stop/await running consumer tasks.
  clear(): void {
    this.consumers.clear()
    this.defaultConsumer = undefined
    this.tasks = []
  }

  async start(): Promise<void> {
    for (const [name, entry] of this.consumers.entries()) {
      // A run() that fails while the service is live must not become an unhandled
      // rejection (which terminates the process by default) — log it, mirroring
      // Python's _on_task_done. The consumer is not restarted.
      const dispatch = this.dispatchFor(name)
      this.tasks.push(
        Promise.resolve()
          .then(() => entry.adapter.run(dispatch))
          .catch((err) => {
            globalLogger.error(`consumer '${name}' run() terminated with error: ${err}`)
          }),
      )
    }
  }

  async stop(): Promise<void> {
    for (const entry of this.consumers.values()) await entry.adapter.stop()
    const results = await Promise.allSettled(this.tasks)
    for (const r of results) {
      if (r.status === 'rejected') {
        globalLogger.error(`consumer run() terminated with error: ${r.reason}`)
      }
    }
    this.tasks = []
  }

  private entry(consumer?: string): ConsumerEntry {
    const name = consumer ?? this.defaultConsumer
    if (name === undefined || !this.consumers.has(name)) {
      throw new Error(
        name === undefined
          ? 'no consumer specified and no default registered'
          : `consumer '${name}' not registered`,
      )
    }
    return this.consumers.get(name)!
  }

  // Exposed for unit testing the dispatch contract directly.
  dispatchFor(name: string): Dispatch {
    const entry = this.consumers.get(name)!
    return async (raw: unknown): Promise<void> => {
      let parsed
      try {
        parsed = validateEnvelope(raw)
      } catch (err) {
        if (entry.onInvalid) entry.onInvalid(raw, err as Error)
        else globalLogger.warn(`invalid envelope dropped: ${(err as Error).message}`)
        return // acked + skipped
      }
      const handler = entry.handlers.get(parsed.eventName)
      if (!handler) {
        if (entry.onUnhandled) entry.onUnhandled(parsed.eventName, raw)
        else globalLogger.debug(`no handler for event ${parsed.eventName}; acked + skipped`)
        return // acked + skipped
      }
      
      const traceHeader = parsed.metadata?.traceparent
      const parsedTrace = traceHeader ? parseTraceparent(traceHeader) : null
      if (parsedTrace) {
        // trace-context.md §4.2: a real, exported CONSUMER span (child of the
        // producer span) is active for the handler; a handler throw marks it
        // ERROR and still propagates → caller does not ack.
        await runInChildSpan(
          `consume ${parsed.eventName}`,
          { ...parsedTrace, tracestate: parsed.metadata?.tracestate },
          { 'span.kind': 'CONSUMER' },
          () => handler(parsed.payload, parsed.metadata),
        )
      } else {
        await handler(parsed.payload, parsed.metadata) // throw → caller does not ack
      }
    }
  }
}

// In-memory consumer for unit tests — the dual of InMemoryQueueAdapter.
export class InMemoryConsumer implements ConsumerAdapter {
  private queue: unknown[]
  private stopped = false

  constructor(messages: unknown[] = []) {
    this.queue = [...messages]
  }

  feed(raw: unknown): void {
    this.queue.push(raw)
  }

  async run(dispatch: Dispatch): Promise<void> {
    while (!this.stopped) {
      const raw = this.queue.shift()
      if (raw === undefined) {
        await new Promise((r) => setTimeout(r, 20))
        continue
      }
      await dispatch(raw)
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
  }
}

export const globalConsumerRegistry = new ConsumerRegistry()
