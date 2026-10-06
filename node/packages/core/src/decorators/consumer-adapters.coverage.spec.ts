// Unit coverage for the four consumer adapters. No broker is started: each adapter is
// driven through a hand-written fake of its client library at the module boundary
// (ioredis client, kafkajs Kafka, amqplib Channel, bullmq Worker).
import * as loggerModule from '../logger'
import { setGlobalLogger } from '../logger'
import {
  BullMQConsumer,
  KafkaConsumer,
  RabbitMQConsumer,
  RedisStreamConsumer,
} from './consumer-adapters'

const mockWorkerInstances: any[] = []
let mockWaitUntilReadyError: Error | null = null

jest.mock('bullmq', () => ({
  Worker: class FakeWorker {
    closed = 0
    constructor(
      public queueName: string,
      public processor: (job: any) => Promise<void>,
      public opts: any,
    ) {
      mockWorkerInstances.push(this)
    }
    async waitUntilReady() {
      if (mockWaitUntilReadyError) throw mockWaitUntilReadyError
    }
    async close() {
      this.closed++
    }
  },
}))

const flush = () => new Promise((r) => setImmediate(r))

const originalLogger = loggerModule.globalLogger
let errors: string[]

beforeEach(() => {
  errors = []
  setGlobalLogger({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (m: string) => void errors.push(m),
  })
})

afterEach(() => {
  setGlobalLogger(originalLogger)
})

// ---------------------------------------------------------------------------
// RedisStreamConsumer
// ---------------------------------------------------------------------------

type StreamResp = [string, [string, string[]][]][] | null

function fakeRedis(script: StreamResp[], opts: { xgroupError?: Error } = {}) {
  const calls = { xgroup: [] as any[][], xreadgroup: [] as any[][], xack: [] as any[][] }
  let consumer: RedisStreamConsumer | undefined
  const client = {
    async xgroup(...args: any[]) {
      calls.xgroup.push(args)
      if (opts.xgroupError) throw opts.xgroupError
      return 'OK'
    },
    async xreadgroup(...args: any[]) {
      calls.xreadgroup.push(args)
      if (script.length === 0) {
        // Script exhausted: stop the loop the same way a caller would.
        await consumer!.stop()
        return null
      }
      return script.shift()
    },
    async xack(...args: any[]) {
      calls.xack.push(args)
      return 1
    },
  }
  return {
    client: client as any,
    calls,
    attach(c: RedisStreamConsumer) {
      consumer = c
      return c
    },
  }
}

const entry = (id: string, fields: string[]): StreamResp => [['s', [[id, fields]]]]

describe('RedisStreamConsumer', () => {
  it('creates the consumer group and reads with the documented defaults', async () => {
    const redis = fakeRedis([])
    const consumer = redis.attach(new RedisStreamConsumer(redis.client))

    await consumer.run(async () => {})

    expect(redis.calls.xgroup).toEqual([['CREATE', 'default', 'server-decorator', '0', 'MKSTREAM']])
    expect(redis.calls.xreadgroup).toEqual([
      ['GROUP', 'server-decorator', 'consumer-1', 'COUNT', 10, 'BLOCK', 1000, 'STREAMS', 'default', '>'],
    ])
  })

  it('honours custom stream, group, consumer name, block and batch options', async () => {
    const redis = fakeRedis([])
    const consumer = redis.attach(
      new RedisStreamConsumer(redis.client, {
        stream: 'orders',
        group: 'billing',
        consumerName: 'c-9',
        blockMs: 5,
        batch: 3,
      }),
    )

    await consumer.run(async () => {})

    expect(redis.calls.xgroup[0]).toEqual(['CREATE', 'orders', 'billing', '0', 'MKSTREAM'])
    expect(redis.calls.xreadgroup[0]).toEqual([
      'GROUP', 'billing', 'c-9', 'COUNT', 3, 'BLOCK', 5, 'STREAMS', 'orders', '>',
    ])
  })

  it('tolerates an already-existing group (BUSYGROUP) and keeps consuming', async () => {
    const redis = fakeRedis([entry('1-0', ['data', '{"n":1}'])], {
      xgroupError: new Error('BUSYGROUP Consumer Group name already exists'),
    })
    const consumer = redis.attach(new RedisStreamConsumer(redis.client))
    const dispatched: unknown[] = []

    await consumer.run(async (raw) => void dispatched.push(raw))

    expect(dispatched).toEqual([{ n: 1 }])
  })

  it('rethrows any other group-creation error without reading the stream', async () => {
    const boom = new Error('NOAUTH Authentication required')
    const redis = fakeRedis([], { xgroupError: boom })
    const consumer = redis.attach(new RedisStreamConsumer(redis.client))

    await expect(consumer.run(async () => {})).rejects.toBe(boom)
    expect(redis.calls.xreadgroup).toEqual([])
  })

  it('dispatches the parsed data field and acks the entry, even when data is not the first field', async () => {
    const redis = fakeRedis([entry('5-1', ['trace', 'abc', 'data', '{"eventName":"A.b","payload":[1,2]}'])])
    const consumer = redis.attach(new RedisStreamConsumer(redis.client, { stream: 's', group: 'g' }))
    const dispatched: unknown[] = []

    await consumer.run(async (raw) => void dispatched.push(raw))

    expect(dispatched).toEqual([{ eventName: 'A.b', payload: [1, 2] }])
    expect(redis.calls.xack).toEqual([['s', 'g', '5-1']])
    expect(errors).toEqual([])
  })

  it('acks and skips an entry with no data field without dispatching it', async () => {
    const redis = fakeRedis([entry('2-0', ['other', 'x'])])
    const consumer = redis.attach(new RedisStreamConsumer(redis.client))
    const dispatch = jest.fn(async () => {})

    await consumer.run(dispatch)

    expect(dispatch).not.toHaveBeenCalled()
    expect(redis.calls.xack).toEqual([['default', 'server-decorator', '2-0']])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('unparseable entry 2-0')
    expect(errors[0]).toContain("entry missing 'data' field")
  })

  it('acks and skips an entry whose data is not valid JSON (also an empty string)', async () => {
    const redis = fakeRedis([
      [['s', [['3-0', ['data', '{not json']], ['3-1', ['data', '']]]]],
    ])
    const consumer = redis.attach(new RedisStreamConsumer(redis.client))
    const dispatch = jest.fn(async () => {})

    await consumer.run(dispatch)

    expect(dispatch).not.toHaveBeenCalled()
    expect(redis.calls.xack.map((c) => c[2])).toEqual(['3-0', '3-1'])
    expect(errors).toHaveLength(2)
  })

  it('leaves a failed entry pending (no ack) and still processes the entries after it', async () => {
    const redis = fakeRedis([
      [['s', [
        ['4-0', ['data', '{"n":1}']],
        ['4-1', ['data', '{"n":2}']],
        ['4-2', ['data', '{"n":3}']],
      ]]],
    ])
    const consumer = redis.attach(new RedisStreamConsumer(redis.client))
    const seen: number[] = []

    await consumer.run(async (raw) => {
      const n = (raw as { n: number }).n
      seen.push(n)
      if (n === 2) throw new Error('handler exploded')
    })

    expect(seen).toEqual([1, 2, 3])
    expect(redis.calls.xack.map((c) => c[2])).toEqual(['4-0', '4-2'])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('dispatch failed for entry 4-1; left pending')
    expect(errors[0]).toContain('handler exploded')
  })

  it('keeps polling across empty (null) reads and handles multiple streams in one response', async () => {
    const redis = fakeRedis([
      null,
      [
        ['s1', [['1-0', ['data', '"a"']]]],
        ['s2', [['1-1', ['data', '0']]]],
      ],
      null,
    ])
    const consumer = redis.attach(new RedisStreamConsumer(redis.client))
    const dispatched: unknown[] = []

    await consumer.run(async (raw) => void dispatched.push(raw))

    // 3 scripted reads + the final read that stops the loop.
    expect(redis.calls.xreadgroup).toHaveLength(4)
    expect(dispatched).toEqual(['a', 0])
    expect(redis.calls.xack.map((c) => c[2])).toEqual(['1-0', '1-1'])
  })

  it('does not read at all when stopped before run, but still ensures the group', async () => {
    const redis = fakeRedis([entry('9-0', ['data', '{}'])])
    const consumer = redis.attach(new RedisStreamConsumer(redis.client))

    await consumer.stop()
    await consumer.run(async () => {})

    expect(redis.calls.xgroup).toHaveLength(1)
    expect(redis.calls.xreadgroup).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// KafkaConsumer
// ---------------------------------------------------------------------------

function fakeKafka(opts: { stopError?: Error } = {}) {
  const log: string[] = []
  const calls = {
    consumerConfig: [] as any[],
    subscribe: [] as any[],
    runConfig: [] as any[],
    commitOffsets: [] as any[],
    seek: [] as any[],
  }
  const consumer = {
    async connect() {
      log.push('connect')
    },
    async subscribe(arg: any) {
      log.push('subscribe')
      calls.subscribe.push(arg)
    },
    async run(cfg: any) {
      log.push('run')
      calls.runConfig.push(cfg)
    },
    async commitOffsets(arg: any) {
      calls.commitOffsets.push(arg)
    },
    seek(arg: any) {
      calls.seek.push(arg)
    },
    async stop() {
      log.push('stop')
      if (opts.stopError) throw opts.stopError
    },
    async disconnect() {
      log.push('disconnect')
    },
  }
  const kafka = {
    consumer(cfg: any) {
      calls.consumerConfig.push(cfg)
      return consumer
    },
  }
  return { kafka: kafka as any, calls, log }
}

const kafkaMsg = (offset: string, value: Buffer | null) => ({ offset, value })

async function startKafka(
  options: ConstructorParameters<typeof KafkaConsumer>[1],
  dispatch: (raw: unknown) => Promise<void>,
  fakeOpts: { stopError?: Error } = {},
) {
  const fake = fakeKafka(fakeOpts)
  const consumer = new KafkaConsumer(fake.kafka, options)
  const running = consumer.run(dispatch)
  while (fake.calls.runConfig.length === 0) await flush()
  const eachMessage = fake.calls.runConfig[0].eachMessage as (p: any) => Promise<void>
  return { ...fake, consumer, running, eachMessage }
}

describe('KafkaConsumer', () => {
  it('connects, subscribes every topic from the beginning by default and disables auto-commit', async () => {
    const k = await startKafka({ topics: ['a', 'b'], groupId: 'g1' }, async () => {})

    expect(k.calls.consumerConfig).toEqual([{ groupId: 'g1' }])
    expect(k.calls.subscribe).toEqual([
      { topic: 'a', fromBeginning: true },
      { topic: 'b', fromBeginning: true },
    ])
    expect(k.calls.runConfig[0].autoCommit).toBe(false)
    expect(k.log).toEqual(['connect', 'subscribe', 'subscribe', 'run'])

    await k.consumer.stop()
    await k.running
  })

  it('passes fromBeginning: false through and subscribes nothing for an empty topic list', async () => {
    const k = await startKafka({ topics: ['a'], groupId: 'g', fromBeginning: false }, async () => {})
    expect(k.calls.subscribe).toEqual([{ topic: 'a', fromBeginning: false }])
    await k.consumer.stop()
    await k.running

    const none = await startKafka({ topics: [], groupId: 'g' }, async () => {})
    expect(none.calls.subscribe).toEqual([])
    await none.consumer.stop()
    await none.running
  })

  it('dispatches the parsed value then commits offset + 1', async () => {
    const dispatched: unknown[] = []
    const k = await startKafka({ topics: ['t'], groupId: 'g' }, async (raw) => void dispatched.push(raw))

    await k.eachMessage({ topic: 't', partition: 2, message: kafkaMsg('7', Buffer.from('{"n":1}')) })

    expect(dispatched).toEqual([{ n: 1 }])
    expect(k.calls.commitOffsets).toEqual([[{ topic: 't', partition: 2, offset: '8' }]])
    expect(k.calls.seek).toEqual([])

    await k.consumer.stop()
    await k.running
  })

  it('commits and skips null, empty and non-JSON values without dispatching', async () => {
    const dispatch = jest.fn(async () => {})
    const k = await startKafka({ topics: ['t'], groupId: 'g' }, dispatch)

    await k.eachMessage({ topic: 't', partition: 0, message: kafkaMsg('0', null) })
    await k.eachMessage({ topic: 't', partition: 0, message: kafkaMsg('1', Buffer.from('')) })
    await k.eachMessage({ topic: 't', partition: 0, message: kafkaMsg('2', Buffer.from('<xml/>')) })

    expect(dispatch).not.toHaveBeenCalled()
    expect(k.calls.commitOffsets.map((c) => c[0].offset)).toEqual(['1', '2', '3'])
    expect(errors).toHaveLength(3)
    expect(errors[0]).toContain('empty message value')
    expect(errors[2]).toContain('unparseable kafka message; committing + skipping')

    await k.consumer.stop()
    await k.running
  })

  it('on a dispatch failure does not commit and seeks back to the failed offset', async () => {
    const k = await startKafka({ topics: ['t'], groupId: 'g', retryBackoffMs: 0 }, async () => {
      throw new Error('handler down')
    })

    await k.eachMessage({ topic: 't', partition: 1, message: kafkaMsg('41', Buffer.from('{}')) })

    expect(k.calls.commitOffsets).toEqual([])
    expect(k.calls.seek).toEqual([{ topic: 't', partition: 1, offset: '41' }])
    expect(errors[0]).toContain('dispatch failed for kafka offset 41')
    expect(errors[0]).toContain('handler down')

    await k.consumer.stop()
    await k.running
  })

  it('waits retryBackoffMs before seeking back', async () => {
    const k = await startKafka({ topics: ['t'], groupId: 'g', retryBackoffMs: 60 }, async () => {
      throw new Error('x')
    })

    const started = Date.now()
    const pending = k.eachMessage({ topic: 't', partition: 0, message: kafkaMsg('3', Buffer.from('1')) })
    await flush()
    expect(k.calls.seek).toEqual([])

    await pending
    expect(Date.now() - started).toBeGreaterThanOrEqual(55)
    expect(k.calls.seek).toEqual([{ topic: 't', partition: 0, offset: '3' }])

    await k.consumer.stop()
    await k.running
  })

  it('defaults the retry backoff to 1000ms', async () => {
    const k = await startKafka({ topics: ['t'], groupId: 'g' }, async () => {
      throw new Error('x')
    })
    await k.consumer.stop()
    await k.running

    // A second consumer under fake timers so the 1000ms default is observed exactly.
    jest.useFakeTimers()
    try {
      const fake = fakeKafka()
      const consumer = new KafkaConsumer(fake.kafka, { topics: ['t'], groupId: 'g' })
      const running = consumer.run(async () => {
        throw new Error('x')
      })
      await jest.advanceTimersByTimeAsync(0)
      const eachMessage = fake.calls.runConfig[0].eachMessage
      const pending = eachMessage({ topic: 't', partition: 0, message: kafkaMsg('5', Buffer.from('1')) })

      await jest.advanceTimersByTimeAsync(999)
      expect(fake.calls.seek).toEqual([])
      await jest.advanceTimersByTimeAsync(1)
      await pending
      expect(fake.calls.seek).toEqual([{ topic: 't', partition: 0, offset: '5' }])

      await consumer.stop()
      await jest.advanceTimersByTimeAsync(100)
      await running
    } finally {
      jest.useRealTimers()
    }
  })

  it('ignores messages delivered after stop (no dispatch, no commit)', async () => {
    const dispatch = jest.fn(async () => {})
    const k = await startKafka({ topics: ['t'], groupId: 'g' }, dispatch)

    await k.consumer.stop()
    await k.eachMessage({ topic: 't', partition: 0, message: kafkaMsg('1', Buffer.from('{}')) })

    expect(dispatch).not.toHaveBeenCalled()
    expect(k.calls.commitOffsets).toEqual([])
    await k.running
  })

  it('stop() stops then disconnects the consumer and lets run() resolve', async () => {
    // Fake timers: run() polls its stop flag every 100ms, so step past several polls exactly.
    jest.useFakeTimers()
    try {
      const fake = fakeKafka()
      const consumer = new KafkaConsumer(fake.kafka, { topics: ['t'], groupId: 'g' })
      let settled = false
      const running = consumer.run(async () => {}).then(() => (settled = true))

      await jest.advanceTimersByTimeAsync(350)
      expect(settled).toBe(false)
      expect(fake.log).not.toContain('stop')

      await consumer.stop()
      expect(settled).toBe(false) // resolves only on the next poll after stop()
      await jest.advanceTimersByTimeAsync(100)
      await running

      expect(settled).toBe(true)
      expect(fake.log.slice(-2)).toEqual(['stop', 'disconnect'])
    } finally {
      jest.useRealTimers()
    }
  })

  it('still disconnects when consumer.stop() throws', async () => {
    const k = await startKafka({ topics: ['t'], groupId: 'g' }, async () => {}, {
      stopError: new Error('already stopping'),
    })

    await expect(k.consumer.stop()).resolves.toBeUndefined()
    await k.running

    expect(k.log.slice(-2)).toEqual(['stop', 'disconnect'])
  })

  it('stop() before run() is a no-op on the client', async () => {
    const fake = fakeKafka()
    const consumer = new KafkaConsumer(fake.kafka, { topics: ['t'], groupId: 'g' })

    await expect(consumer.stop()).resolves.toBeUndefined()

    expect(fake.log).toEqual([])
    expect(fake.calls.consumerConfig).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// RabbitMQConsumer
// ---------------------------------------------------------------------------

function fakeChannel() {
  const calls = {
    assertQueue: [] as any[][],
    prefetch: [] as any[][],
    consume: [] as any[][],
    ack: [] as any[],
    nack: [] as any[][],
    cancel: [] as any[][],
  }
  let onMessage: ((msg: any) => void) | undefined
  const channel = {
    async assertQueue(...a: any[]) {
      calls.assertQueue.push(a)
    },
    async prefetch(...a: any[]) {
      calls.prefetch.push(a)
    },
    async consume(queue: string, cb: (msg: any) => void, o: any) {
      calls.consume.push([queue, o])
      onMessage = cb
      return { consumerTag: 'ctag-1' }
    },
    ack(msg: any) {
      calls.ack.push(msg)
    },
    nack(...a: any[]) {
      calls.nack.push(a)
    },
    async cancel(...a: any[]) {
      calls.cancel.push(a)
    },
  }
  return { channel: channel as any, calls, deliver: (msg: any) => onMessage!(msg) }
}

const amqpMsg = (body: string) => ({ content: Buffer.from(body), fields: {}, properties: {} })

describe('RabbitMQConsumer', () => {
  it('asserts a durable queue and consumes with manual acks; no prefetch unless configured', async () => {
    const ch = fakeChannel()
    await new RabbitMQConsumer(ch.channel, { queue: 'jobs' }).run(async () => {})

    expect(ch.calls.assertQueue).toEqual([['jobs', { durable: true }]])
    expect(ch.calls.consume).toEqual([['jobs', { noAck: false }]])
    expect(ch.calls.prefetch).toEqual([])
  })

  it('applies a positive prefetch and skips a zero prefetch', async () => {
    const withPrefetch = fakeChannel()
    await new RabbitMQConsumer(withPrefetch.channel, { queue: 'q', prefetch: 5 }).run(async () => {})
    expect(withPrefetch.calls.prefetch).toEqual([[5]])

    const zero = fakeChannel()
    await new RabbitMQConsumer(zero.channel, { queue: 'q', prefetch: 0 }).run(async () => {})
    expect(zero.calls.prefetch).toEqual([])
  })

  it('dispatches the parsed body and acks on success', async () => {
    const ch = fakeChannel()
    const dispatched: unknown[] = []
    await new RabbitMQConsumer(ch.channel, { queue: 'q' }).run(async (raw) => void dispatched.push(raw))
    const msg = amqpMsg('{"eventName":"X.y","payload":null}')

    ch.deliver(msg)
    await flush()

    expect(dispatched).toEqual([{ eventName: 'X.y', payload: null }])
    expect(ch.calls.ack).toEqual([msg])
    expect(ch.calls.nack).toEqual([])
  })

  it('acks and drops an unparseable body without dispatching', async () => {
    const ch = fakeChannel()
    const dispatch = jest.fn(async () => {})
    await new RabbitMQConsumer(ch.channel, { queue: 'q' }).run(dispatch)
    const bad = amqpMsg('not-json')
    const empty = amqpMsg('')

    ch.deliver(bad)
    ch.deliver(empty)
    await flush()

    expect(dispatch).not.toHaveBeenCalled()
    expect(ch.calls.ack).toEqual([bad, empty])
    expect(ch.calls.nack).toEqual([])
    expect(errors).toHaveLength(2)
    expect(errors[0]).toContain('unparseable rabbitmq message; acking + dropping')
  })

  it('nacks with requeue (and never acks) when dispatch throws', async () => {
    const ch = fakeChannel()
    await new RabbitMQConsumer(ch.channel, { queue: 'q' }).run(async () => {
      throw new Error('db down')
    })
    const msg = amqpMsg('{}')

    ch.deliver(msg)
    await flush()

    expect(ch.calls.nack).toEqual([[msg, false, true]])
    expect(ch.calls.ack).toEqual([])
    expect(errors[0]).toContain('dispatch failed for rabbitmq message; requeueing')
    expect(errors[0]).toContain('db down')
  })

  it('ignores the null delivery amqplib sends when the broker cancels the consumer', async () => {
    const ch = fakeChannel()
    const dispatch = jest.fn(async () => {})
    await new RabbitMQConsumer(ch.channel, { queue: 'q' }).run(dispatch)

    ch.deliver(null)
    await flush()

    expect(dispatch).not.toHaveBeenCalled()
    expect(ch.calls.ack).toEqual([])
    expect(ch.calls.nack).toEqual([])
  })

  it('stop() cancels the consumer tag returned by consume; before run() it cancels nothing', async () => {
    const ch = fakeChannel()
    const consumer = new RabbitMQConsumer(ch.channel, { queue: 'q' })

    await consumer.stop()
    expect(ch.calls.cancel).toEqual([])

    await consumer.run(async () => {})
    await consumer.stop()
    expect(ch.calls.cancel).toEqual([['ctag-1']])
  })
})

// ---------------------------------------------------------------------------
// BullMQConsumer
// ---------------------------------------------------------------------------

describe('BullMQConsumer', () => {
  beforeEach(() => {
    mockWorkerInstances.length = 0
    mockWaitUntilReadyError = null
  })

  it('creates a Worker with a normalized connection string and concurrency 1 by default', async () => {
    const consumer = new BullMQConsumer({ queueName: 'emails', connection: 'redis://10.0.0.5:6380' })

    await consumer.run(async () => {})

    expect(mockWorkerInstances).toHaveLength(1)
    expect(mockWorkerInstances[0].queueName).toBe('emails')
    expect(mockWorkerInstances[0].opts).toEqual({
      connection: { url: 'redis://10.0.0.5:6380' },
      concurrency: 1,
    })
  })

  it('passes an object connection through by reference and honours concurrency', async () => {
    const connection = { host: 'h', port: 1 }
    const consumer = new BullMQConsumer({ queueName: 'q', connection, concurrency: 8 })

    await consumer.run(async () => {})

    expect(mockWorkerInstances[0].opts.connection).toBe(connection)
    expect(mockWorkerInstances[0].opts.concurrency).toBe(8)
  })

  it('the processor dispatches job.data and resolves when dispatch succeeds', async () => {
    const dispatched: unknown[] = []
    const consumer = new BullMQConsumer({ queueName: 'q', connection: {} })
    await consumer.run(async (raw) => void dispatched.push(raw))
    const data = { eventName: 'A.b', payload: 1, timestamp: 5 }

    await expect(mockWorkerInstances[0].processor({ data })).resolves.toBeUndefined()

    expect(dispatched).toEqual([data])
  })

  it('the processor rethrows a dispatch failure so BullMQ can retry the job', async () => {
    const boom = new Error('handler failed')
    const consumer = new BullMQConsumer({ queueName: 'q', connection: {} })
    await consumer.run(async () => {
      throw boom
    })

    await expect(mockWorkerInstances[0].processor({ data: {} })).rejects.toBe(boom)
  })

  it('run() rejects when the worker never becomes ready', async () => {
    mockWaitUntilReadyError = new Error('ECONNREFUSED')
    const consumer = new BullMQConsumer({ queueName: 'q', connection: {} })

    await expect(consumer.run(async () => {})).rejects.toThrow('ECONNREFUSED')
  })

  it('stop() closes the worker once; before run() it is a no-op', async () => {
    const consumer = new BullMQConsumer({ queueName: 'q', connection: {} })

    await expect(consumer.stop()).resolves.toBeUndefined()
    expect(mockWorkerInstances).toHaveLength(0)

    await consumer.run(async () => {})
    await consumer.stop()
    expect(mockWorkerInstances[0].closed).toBe(1)
  })
})
