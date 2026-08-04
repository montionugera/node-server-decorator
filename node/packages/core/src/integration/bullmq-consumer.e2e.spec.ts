import Redis from 'ioredis'
import { Queue } from 'bullmq'
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers'
import { ConsumerRegistry } from '../decorators/consumer-registry'
import { BullMQConsumer } from '../decorators/consumer-adapters'

jest.setTimeout(60_000)

describe('BullMQConsumer (e2e)', () => {
  let redisContainer: StartedTestContainer
  let url: string

  beforeAll(async () => {
    redisContainer = await new GenericContainer('redis:7-alpine')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
      .start()

    url = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`
  }, 60000)

  afterAll(async () => {
    if (redisContainer) {
      await redisContainer.stop()
    }
  })

  it('consumes BullMQ jobs (job.data is the envelope)', async () => {
    const queueName = 'A.x.bullmq'
    const connection = new Redis(url, { maxRetriesPerRequest: null })
    const queue = new Queue(queueName, { connection })
    await queue.obliterate({ force: true }).catch(() => {})

    for (const n of [1, 2]) {
      const msg = { eventName: 'A.x', payload: { n }, timestamp: 1, metadata: {} }
      await queue.add('A.x', msg)
    }

    const got: unknown[] = []
    const reg = new ConsumerRegistry()
    reg.register('c', new BullMQConsumer({ queueName, connection: url }))
    reg.on(
      'A.x',
      (p) => {
        got.push(p)
      },
      { consumer: 'c' },
    )

    await reg.start()
    const deadline = Date.now() + 15000
    while (got.length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100))
    }
    await reg.stop()
    await queue.close()
    connection.disconnect()

    expect(got.sort((a: any, b: any) => a.n - b.n)).toEqual([{ n: 1 }, { n: 2 }])
  }, 30000)
})
