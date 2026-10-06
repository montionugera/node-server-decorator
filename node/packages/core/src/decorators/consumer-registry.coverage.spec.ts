import { ConsumerAdapter, ConsumerRegistry, Dispatch, InMemoryConsumer } from './consumer-registry'
import { Logger, globalLogger, setGlobalLogger } from '../logger'
import { getActiveTraceContext } from './trace'

const TRACE_ID = '0af7651916cd43dd8448eb211c80319c'
const PARENT_SPAN_ID = 'b7ad6b7169203331'
const TRACEPARENT = `00-${TRACE_ID}-${PARENT_SPAN_ID}-01`

function env(eventName: string, payload: unknown, metadata: unknown = { service: 'svc' }) {
  return { eventName, payload, timestamp: 1, metadata }
}

// An adapter that never consumes; only its lifecycle is observed.
function idleAdapter(): ConsumerAdapter & { stops: number } {
  return {
    stops: 0,
    async run() {},
    async stop() {
      this.stops += 1
    },
  }
}

function captureLogger() {
  const lines: Record<keyof Logger, string[]> = { debug: [], info: [], warn: [], error: [] }
  const logger: Logger = {
    debug: (m) => lines.debug.push(m),
    info: (m) => lines.info.push(m),
    warn: (m) => lines.warn.push(m),
    error: (m) => lines.error.push(m),
  }
  return { logger, lines }
}

describe('ConsumerRegistry coverage', () => {
  const originalLogger = globalLogger
  let lines: ReturnType<typeof captureLogger>['lines']

  beforeEach(() => {
    const captured = captureLogger()
    lines = captured.lines
    setGlobalLogger(captured.logger)
  })

  afterEach(() => {
    setGlobalLogger(originalLogger)
  })

  describe('envelope validation', () => {
    const cases: Array<[string, unknown, string]> = [
      ['a string', 'not-an-object', 'envelope must be an object'],
      ['null', null, 'envelope must be an object'],
      ['a number', 42, 'envelope must be an object'],
      ['missing eventName', { payload: 1, timestamp: 1 }, "envelope missing non-empty string 'eventName'"],
      ['empty eventName', { eventName: '', payload: 1, timestamp: 1 }, "envelope missing non-empty string 'eventName'"],
      ['non-string eventName', { eventName: 7, payload: 1, timestamp: 1 }, "envelope missing non-empty string 'eventName'"],
      ['missing payload', { eventName: 'A.x', timestamp: 1 }, "envelope missing 'payload'"],
      ['missing timestamp', { eventName: 'A.x', payload: 1 }, "envelope missing integer 'timestamp'"],
      ['fractional timestamp', { eventName: 'A.x', payload: 1, timestamp: 1.5 }, "envelope missing integer 'timestamp'"],
      ['NaN timestamp', { eventName: 'A.x', payload: 1, timestamp: NaN }, "envelope missing integer 'timestamp'"],
      ['string timestamp', { eventName: 'A.x', payload: 1, timestamp: '1' }, "envelope missing integer 'timestamp'"],
    ]

    it.each(cases)('rejects %s via onInvalid and never calls the handler', async (_label, raw, message) => {
      const invalid: Array<[unknown, Error]> = []
      const handled: unknown[] = []
      const reg = new ConsumerRegistry()
      reg.register('c', idleAdapter(), { onInvalid: (r, e) => invalid.push([r, e]) })
      reg.on('A.x', (p) => { handled.push(p) })

      await expect(reg.dispatchFor('c')(raw)).resolves.toBeUndefined()

      expect(handled).toEqual([])
      expect(invalid).toHaveLength(1)
      expect(invalid[0][0]).toBe(raw)
      expect(invalid[0][1]).toBeInstanceOf(Error)
      expect(invalid[0][1].message).toBe(message)
      expect(lines.warn).toEqual([])
    })

    it('warns through the global logger when no onInvalid hook is registered', async () => {
      const reg = new ConsumerRegistry()
      reg.register('c', idleAdapter())

      await reg.dispatchFor('c')({ eventName: 'A.x', timestamp: 1 })

      expect(lines.warn).toEqual(["invalid envelope dropped: envelope missing 'payload'"])
    })

    it('accepts an explicit null/undefined payload key and timestamp 0', async () => {
      const got: unknown[] = []
      const reg = new ConsumerRegistry()
      reg.register('c', idleAdapter(), {
        onInvalid: (_r, e) => { throw e },
      })
      reg.on('A.x', (p) => { got.push(p) })

      await reg.dispatchFor('c')({ eventName: 'A.x', payload: null, timestamp: 0 })
      await reg.dispatchFor('c')({ eventName: 'A.x', payload: undefined, timestamp: -5 })

      expect(got).toEqual([null, undefined])
    })

    it.each([
      ['absent', undefined],
      ['null', null],
      ['a string', 'meta'],
      ['a number', 3],
    ])('hands the handler an empty metadata object when metadata is %s', async (_label, metadata) => {
      const seen: unknown[] = []
      const reg = new ConsumerRegistry()
      reg.register('c', idleAdapter())
      reg.on('A.x', (_p, m) => { seen.push(m) })

      await reg.dispatchFor('c')({ eventName: 'A.x', payload: 1, timestamp: 1, metadata })

      expect(seen).toEqual([{}])
    })
  })

  describe('unhandled events', () => {
    it('calls onUnhandled with the event name and raw envelope', async () => {
      const unhandled: Array<[string, unknown]> = []
      const reg = new ConsumerRegistry()
      reg.register('c', idleAdapter(), { onUnhandled: (n, r) => unhandled.push([n, r]) })
      const raw = env('Nobody.listens', { n: 1 })

      await expect(reg.dispatchFor('c')(raw)).resolves.toBeUndefined()

      expect(unhandled).toEqual([['Nobody.listens', raw]])
      expect(lines.debug).toEqual([])
    })

    it('logs at debug level and resolves (ack + skip) without a hook', async () => {
      const reg = new ConsumerRegistry()
      reg.register('c', idleAdapter())

      await expect(reg.dispatchFor('c')(env('Nobody.listens', 1))).resolves.toBeUndefined()

      expect(lines.debug).toEqual(['no handler for event Nobody.listens; acked + skipped'])
    })
  })

  describe('handler dispatch', () => {
    it('propagates a handler rejection so the caller does not ack', async () => {
      const reg = new ConsumerRegistry()
      reg.register('c', idleAdapter())
      reg.on('A.x', async () => { throw new Error('handler failed') })

      await expect(reg.dispatchFor('c')(env('A.x', 1))).rejects.toThrow('handler failed')
    })

    it('runs the handler without a trace context when there is no traceparent', async () => {
      let active: unknown = 'unset'
      const reg = new ConsumerRegistry()
      reg.register('c', idleAdapter())
      reg.on('A.x', () => { active = getActiveTraceContext() })

      await reg.dispatchFor('c')(env('A.x', 1))

      expect(active).toBeNull()
    })

    it('still runs the handler, untraced, when the traceparent is malformed', async () => {
      let active: unknown = 'unset'
      let calls = 0
      const reg = new ConsumerRegistry()
      reg.register('c', idleAdapter())
      reg.on('A.x', () => { calls += 1; active = getActiveTraceContext() })

      await reg.dispatchFor('c')(env('A.x', 1, { traceparent: 'garbage' }))

      expect(calls).toBe(1)
      expect(active).toBeNull()
    })

    it('runs the handler inside a child CONSUMER span of the producer trace', async () => {
      let active = getActiveTraceContext()
      let received: unknown[] = []
      const reg = new ConsumerRegistry()
      reg.register('c', idleAdapter())
      reg.on('A.x', (p, m) => { active = getActiveTraceContext(); received = [p, m] })
      const metadata = { traceparent: TRACEPARENT, tracestate: 'vendor=1' }

      await reg.dispatchFor('c')(env('A.x', { n: 1 }, metadata))

      expect(received).toEqual([{ n: 1 }, metadata])
      expect(active).not.toBeNull()
      expect(active!.traceId).toBe(TRACE_ID)
      expect(active!.parentSpanId).toBe(PARENT_SPAN_ID)
      expect(active!.spanId).not.toBe(PARENT_SPAN_ID)
      expect(active!.tracestate).toBe('vendor=1')
      expect(active!.activeSpan!.name).toBe('consume A.x')
      expect(active!.activeSpan!.attributes['span.kind']).toBe('CONSUMER')
      // The span context does not leak out of the dispatch.
      expect(getActiveTraceContext()).toBeNull()
    })

    it('marks the span ERROR and still propagates when a traced handler throws', async () => {
      let span: any
      const reg = new ConsumerRegistry()
      reg.register('c', idleAdapter())
      reg.on('A.x', () => {
        span = getActiveTraceContext()!.activeSpan
        throw new Error('traced failure')
      })

      await expect(
        reg.dispatchFor('c')(env('A.x', 1, { traceparent: TRACEPARENT })),
      ).rejects.toThrow('traced failure')

      expect(span.status).toBe('ERROR')
    })
  })

  describe('registration and defaults', () => {
    it('throws when on() is called with no consumer registered at all', () => {
      const reg = new ConsumerRegistry()

      expect(() => reg.on('A.x', () => {})).toThrow('no consumer specified and no default registered')
    })

    it('throws when on() names a consumer that is not registered', () => {
      const reg = new ConsumerRegistry()
      reg.register('c', idleAdapter())

      expect(() => reg.on('A.x', () => {}, { consumer: 'ghost' })).toThrow("consumer 'ghost' not registered")
    })

    it('setDefault rejects an unregistered name and leaves the default untouched', async () => {
      const got: string[] = []
      const reg = new ConsumerRegistry()
      reg.register('first', idleAdapter())

      expect(() => reg.setDefault('ghost')).toThrow("consumer 'ghost' not registered")

      reg.on('A.x', () => { got.push('first') })
      await reg.dispatchFor('first')(env('A.x', 1))
      expect(got).toEqual(['first'])
    })

    it('the first registered consumer is the default until setDefault moves it', async () => {
      const got: string[] = []
      const unhandledOnFirst: string[] = []
      const reg = new ConsumerRegistry()
      reg.register('first', idleAdapter(), { onUnhandled: (n) => unhandledOnFirst.push(n) })
      reg.register('second', idleAdapter())

      reg.setDefault('second')
      reg.on('A.x', () => { got.push('second') })

      await reg.dispatchFor('first')(env('A.x', 1))
      await reg.dispatchFor('second')(env('A.x', 1))

      expect(unhandledOnFirst).toEqual(['A.x'])
      expect(got).toEqual(['second'])
    })

    it('a later on() for the same event replaces the earlier handler', async () => {
      const got: string[] = []
      const reg = new ConsumerRegistry()
      reg.register('c', idleAdapter())
      reg.on('A.x', () => { got.push('old') })
      reg.on('A.x', () => { got.push('new') })

      await reg.dispatchFor('c')(env('A.x', 1))

      expect(got).toEqual(['new'])
    })

    it('clear() forgets consumers and the default', () => {
      const reg = new ConsumerRegistry()
      reg.register('c', idleAdapter())

      reg.clear()

      expect(() => reg.on('A.x', () => {})).toThrow('no consumer specified and no default registered')
      expect(() => reg.setDefault('c')).toThrow("consumer 'c' not registered")
    })
  })

  describe('lifecycle', () => {
    it('logs, rather than leaking an unhandled rejection, when run() rejects', async () => {
      const failing: ConsumerAdapter = {
        async run() { throw new Error('broker gone') },
        async stop() {},
      }
      const reg = new ConsumerRegistry()
      reg.register('flaky', failing)

      await reg.start()
      await reg.stop()

      expect(lines.error).toEqual(["consumer 'flaky' run() terminated with error: Error: broker gone"])
    })

    it('also contains a run() that throws synchronously', async () => {
      const failing: ConsumerAdapter = {
        run() { throw new Error('sync boom') },
        async stop() {},
      }
      const reg = new ConsumerRegistry()
      reg.register('sync', failing)

      await expect(reg.start()).resolves.toBeUndefined()
      await reg.stop()

      expect(lines.error).toEqual(["consumer 'sync' run() terminated with error: Error: sync boom"])
    })

    it('a failing consumer does not stop a healthy one from receiving the dispatch', async () => {
      const dispatches: Dispatch[] = []
      const healthy: ConsumerAdapter = {
        async run(dispatch) { dispatches.push(dispatch) },
        async stop() {},
      }
      const got: unknown[] = []
      const reg = new ConsumerRegistry()
      reg.register('bad', { async run() { throw new Error('nope') }, async stop() {} })
      reg.register('good', healthy)
      reg.on('A.x', (p) => { got.push(p) }, { consumer: 'good' })

      await reg.start()
      await reg.stop()
      await dispatches[0](env('A.x', 'hello'))

      expect(dispatches).toHaveLength(1)
      expect(got).toEqual(['hello'])
    })

    it('stop() stops every adapter exactly once and can be called again safely', async () => {
      const a = idleAdapter()
      const b = idleAdapter()
      const reg = new ConsumerRegistry()
      reg.register('a', a)
      reg.register('b', b)

      await reg.start()
      await reg.stop()
      expect([a.stops, b.stops]).toEqual([1, 1])

      await reg.stop()
      expect([a.stops, b.stops]).toEqual([2, 2])
      expect(lines.error).toEqual([])
    })

    it('stop() rejects when an adapter fails to stop', async () => {
      const reg = new ConsumerRegistry()
      reg.register('c', { async run() {}, async stop() { throw new Error('stop failed') } })

      await reg.start()

      await expect(reg.stop()).rejects.toThrow('stop failed')
    })
  })
})

// Bounded wait on a condition instead of a fixed sleep: fast when it holds, loud when it never does.
async function waitUntil(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitUntil: condition not met in time')
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('InMemoryConsumer coverage', () => {
  it('dispatches messages fed after run() started, in order, until stopped', async () => {
    const seen: unknown[] = []
    const consumer = new InMemoryConsumer()
    const running = consumer.run(async (raw) => { seen.push(raw) })

    consumer.feed('one')
    consumer.feed('two')
    await waitUntil(() => seen.length === 2)
    await consumer.stop()
    await running

    expect(seen).toEqual(['one', 'two'])
  })

  it('copies the seed array instead of draining the caller\'s', async () => {
    const seed = ['a', 'b']
    const seen: unknown[] = []
    const consumer = new InMemoryConsumer(seed)
    const running = consumer.run(async (raw) => { seen.push(raw) })

    await waitUntil(() => seen.length === 2)
    await consumer.stop()
    await running

    expect(seen).toEqual(['a', 'b'])
    expect(seed).toEqual(['a', 'b'])
  })

  it('does not dispatch anything once stopped before run()', async () => {
    const seen: unknown[] = []
    const consumer = new InMemoryConsumer(['never'])

    await consumer.stop()
    await consumer.run(async (raw) => { seen.push(raw) })

    expect(seen).toEqual([])
  })

  it('surfaces a dispatch rejection from run()', async () => {
    const consumer = new InMemoryConsumer(['x'])

    await expect(consumer.run(async () => { throw new Error('nack') })).rejects.toThrow('nack')
  })
})
