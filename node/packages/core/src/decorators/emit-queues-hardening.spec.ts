import * as fs from 'fs'
import * as path from 'path'
import { configure } from '../config'
import { setGlobalLogger } from '../logger'
import { KafkaConsumer } from './consumer-adapters'
import { ConsumerAdapter, ConsumerRegistry } from './consumer-registry'
import { EmitOnSuccess } from './emit-on-success'
import { globalEmitter } from './global-emitter'
import { QueueMessage } from './global-queue'
import { InMemoryQueueAdapter } from './queue-adapters'
import { QueueRegistry, globalQueueRegistry } from './queue-registry'

function makeLogger() {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }
}

function allMessages(adapter: InMemoryQueueAdapter): QueueMessage[] {
  return Array.from(adapter.getAllMessages().values()).flat()
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))

describe('emit / queues / consumers hardening', () => {
  let logger: ReturnType<typeof makeLogger>

  beforeEach(() => {
    logger = makeLogger()
    setGlobalLogger(logger as any)
    globalQueueRegistry.clear()
    configure({ service: null })
  })

  afterEach(() => {
    globalQueueRegistry.clear()
    configure({ service: null })
  })

  describe('KafkaConsumer redelivery', () => {
    // Minimal kafkajs stand-in: one partition, honours seek() the way the kafkajs
    // runner does (a pending seek abandons the rest of the fetched batch).
    class FakeKafkaJsConsumer {
      position = 0
      commits: number[] = []
      private seekTo?: number
      private running = true
      done: Promise<void> = Promise.resolve()

      constructor(private log: string[]) {}

      async connect() {}
      async subscribe() {}
      async disconnect() {}
      async stop() {
        this.running = false
      }
      seek({ offset }: { topic: string; partition: number; offset: string }) {
        this.seekTo = Number(offset)
      }
      async commitOffsets(offsets: Array<{ offset: string }>) {
        this.commits.push(Number(offsets[0].offset))
      }
      async run({ eachMessage }: { eachMessage: (p: any) => Promise<void> }) {
        this.done = (async () => {
          while (this.running && this.position < this.log.length) {
            const offset = this.position
            this.position += 1
            await eachMessage({
              topic: 't',
              partition: 0,
              message: {
                offset: String(offset),
                value: Buffer.from(this.log[offset]),
              },
            })
            if (this.seekTo !== undefined) {
              this.position = this.seekTo
              this.seekTo = undefined
            }
          }
        })()
      }
    }

    it('redelivers a failed offset and never commits past it', async () => {
      const fake = new FakeKafkaJsConsumer(['0', '1', '2', '3'])
      const kafka = { consumer: () => fake } as any
      const adapter = new KafkaConsumer(kafka, {
        topics: ['t'],
        groupId: 'g',
        retryBackoffMs: 0,
      })

      const dispatched: number[] = []
      const commitsAtFailure: number[][] = []
      let failedOnce = false
      const running = adapter.run(async (raw) => {
        dispatched.push(raw as number)
        if (raw === 1 && !failedOnce) {
          failedOnce = true
          commitsAtFailure.push([...fake.commits])
          throw new Error('handler boom')
        }
      })

      await tick()
      await fake.done
      await adapter.stop()
      await running

      expect(dispatched).toEqual([0, 1, 1, 2, 3])
      expect(commitsAtFailure).toEqual([[1]])
      // Commits advance one record at a time: nothing ever jumped over offset 1.
      expect(fake.commits).toEqual([1, 2, 3, 4])
    })
  })

  describe('ConsumerRegistry.start()', () => {
    it('logs a rejected adapter run() instead of leaving it unhandled', async () => {
      const unhandled: unknown[] = []
      const onUnhandled = (reason: unknown) => unhandled.push(reason)
      process.on('unhandledRejection', onUnhandled)
      try {
        const failing: ConsumerAdapter = {
          run: async () => {
            throw new Error('redis down')
          },
          stop: async () => {},
        }
        const reg = new ConsumerRegistry()
        reg.register('c', failing)

        await reg.start()
        await tick(50)

        expect(unhandled).toEqual([])
        expect(logger.error).toHaveBeenCalledWith(
          expect.stringContaining('redis down'),
        )
        await expect(reg.stop()).resolves.toBeUndefined()
      } finally {
        process.off('unhandledRejection', onUnhandled)
      }
    })

    it('logs an adapter whose run() throws synchronously and still starts the others', async () => {
      const started: string[] = []
      const reg = new ConsumerRegistry()
      reg.register('bad', {
        run: () => {
          throw new Error('sync boom')
        },
        stop: async () => {},
      } as ConsumerAdapter)
      reg.register('good', {
        run: async () => {
          started.push('good')
        },
        stop: async () => {},
      })

      await expect(reg.start()).resolves.toBeUndefined()
      await tick()

      expect(started).toEqual(['good'])
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('sync boom'),
      )
      await reg.stop()
    })
  })

  describe('EmitOnSuccess with a throwing transform', () => {
    it('async method still resolves with its result and emits nothing', async () => {
      const adapter = new InMemoryQueueAdapter()
      globalQueueRegistry.register('q', adapter)
      const events: unknown[] = []
      const listener = (p: unknown) => events.push(p)
      globalEmitter.on('TransformSvc.save', listener)

      class TransformSvc {
        @EmitOnSuccess({
          useQueue: true,
          queue: 'q',
          transform: (r: any) => r.a.b,
        })
        async save() {
          return { id: 7 }
        }
      }

      try {
        await expect(new TransformSvc().save()).resolves.toEqual({ id: 7 })
      } finally {
        globalEmitter.off('TransformSvc.save', listener)
      }
      expect(events).toEqual([])
      expect(allMessages(adapter)).toEqual([])
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('transform'),
      )
    })

    it('sync method still returns its result and emits nothing', async () => {
      const adapter = new InMemoryQueueAdapter()
      globalQueueRegistry.register('q', adapter)

      class TransformSyncSvc {
        @EmitOnSuccess({
          useQueue: true,
          queue: 'q',
          transform: () => {
            throw new Error('bad transform')
          },
        })
        save() {
          return 5
        }
      }

      expect(new TransformSyncSvc().save()).toBe(5)
      await tick()
      expect(allMessages(adapter)).toEqual([])
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('transform'),
      )
    })
  })

  describe('QueueRegistry default resolution', () => {
    it('publishes to the first registered queue when no default was set', async () => {
      const registry = new QueueRegistry()
      const first = new InMemoryQueueAdapter()
      const second = new InMemoryQueueAdapter()
      registry.register('first', first)
      registry.register('second', second)

      const published = await registry.publish(
        { eventName: 'E', payload: 1, timestamp: 1 },
        undefined,
        'topic',
      )

      expect(published).toBe(true)
      expect(first.getMessages('topic')).toHaveLength(1)
      expect(allMessages(second)).toEqual([])
    })

    it('uses the fallback queue defaultTopic when no topic is given', async () => {
      const registry = new QueueRegistry()
      const adapter = new InMemoryQueueAdapter()
      registry.register('only', { adapter, defaultTopic: 'fallback-topic' })

      await registry.publish({ eventName: 'E', payload: 1, timestamp: 1 })

      expect(adapter.getMessages('fallback-topic')).toHaveLength(1)
    })

    it('fails closed for an unknown named queue (no fallback to another queue)', async () => {
      const registry = new QueueRegistry()
      const adapter = new InMemoryQueueAdapter()
      registry.register('only', adapter)

      const published = await registry.publish(
        { eventName: 'E', payload: 1, timestamp: 1 },
        'missing',
        'topic',
      )

      expect(published).toBe(false)
      expect(allMessages(adapter)).toEqual([])
    })

    it('reports false when nothing is registered or the adapter rejects', async () => {
      const registry = new QueueRegistry()
      expect(
        await registry.publish({ eventName: 'E', payload: 1, timestamp: 1 }),
      ).toBe(false)

      registry.register('bad', {
        publish: async () => {
          throw new Error('broker down')
        },
      })
      expect(
        await registry.publish({ eventName: 'E', payload: 1, timestamp: 1 }),
      ).toBe(false)
    })

    it('EmitOnSuccess delivers without setDefault and only logs "queued" on delivery', async () => {
      const adapter = new InMemoryQueueAdapter()
      globalQueueRegistry.register('only', adapter)

      class NoDefaultSvc {
        @EmitOnSuccess({ useQueue: true, useEvents: false, topic: 't' })
        async go() {
          return 1
        }
      }
      await new NoDefaultSvc().go()
      expect(adapter.getMessages('t')).toHaveLength(1)
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Message queued'),
      )

      logger.debug.mockClear()
      globalQueueRegistry.clear()
      await new NoDefaultSvc().go()
      expect(logger.debug).not.toHaveBeenCalledWith(
        expect.stringContaining('Message queued'),
      )
    })
  })

  describe('topic-naming contract cases', () => {
    const fixture = JSON.parse(
      fs.readFileSync(
        path.resolve(
          __dirname,
          '../../../../../contracts/fixtures/topic-naming.cases.json',
        ),
        'utf8',
      ),
    ) as {
      cases: Array<{
        name: string
        className: string
        methodName: string
        service: string | null
        eventName: string | null
        topic: string | null
        expectedEventName: string
        expectedTopic: string
      }>
    }

    it.each(fixture.cases.map((c) => [c.name, c] as const))(
      '%s',
      async (_name, c) => {
        configure({ service: c.service })
        const adapter = new InMemoryQueueAdapter()
        globalQueueRegistry.register('q', adapter)

        const cls = { [c.className]: class {} }[c.className] as any
        const descriptor: PropertyDescriptor = {
          value: async () => 'ok',
          writable: true,
          configurable: true,
        }
        EmitOnSuccess({
          useQueue: true,
          useEvents: false,
          queue: 'q',
          ...(c.eventName ? { eventName: c.eventName } : {}),
          ...(c.topic ? { topic: c.topic } : {}),
        })(cls.prototype, c.methodName, descriptor)
        Object.defineProperty(cls.prototype, c.methodName, descriptor)

        await new cls()[c.methodName]()

        const messages = allMessages(adapter)
        expect(messages).toHaveLength(1)
        expect(messages[0].eventName).toBe(c.expectedEventName)
        expect(messages[0].metadata?.topic).toBe(c.expectedTopic)
      },
    )
  })
})
