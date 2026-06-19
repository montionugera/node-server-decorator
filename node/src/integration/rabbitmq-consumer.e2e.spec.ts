// e2e: RabbitMQConsumer consumes envelopes from a real RabbitMQ broker (testcontainers)
// and acks them. Requires Docker. amqplib is in node/devDependencies for tests.
//
// NOTE on the container: the dedicated `@testcontainers/rabbitmq@12` module pulls in
// `testcontainers@12` (undici@8), which crashes on this Node/undici combo with
// `webidl.util.markAsUncloneable is not a function`. We instead use the umbrella
// `testcontainers@11` `GenericContainer` with the rabbitmq:3-management-alpine image —
// the same proven setup as the Kafka e2e (kafka-consumer.e2e.spec.ts).

import * as amqp from 'amqplib'
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers'
import { ConsumerRegistry } from '../decorators/consumer-registry'
import { RabbitMQConsumer } from '../decorators/consumer-adapters'

describe('RabbitMQConsumer (e2e)', () => {
  let container: StartedTestContainer
  let url: string

  beforeAll(async () => {
    container = await new GenericContainer('rabbitmq:3-management-alpine')
      .withExposedPorts(5672)
      .withWaitStrategy(Wait.forLogMessage(/Server startup complete/))
      .start()
    url = `amqp://guest:guest@${container.getHost()}:${container.getMappedPort(5672)}`
  }, 180000)

  afterAll(async () => {
    await container?.stop()
  }, 60000)

  it('consumes messages and acks them', async () => {
    const queue = 'A.x.queue'

    // Producer side: publish two envelopes, then close.
    const prodConn = await amqp.connect(url)
    const prodCh = await prodConn.createChannel()
    await prodCh.assertQueue(queue, { durable: true })
    for (const n of [1, 2]) {
      const msg = { eventName: 'A.x', payload: { n }, timestamp: 1, metadata: {} }
      prodCh.sendToQueue(queue, Buffer.from(JSON.stringify(msg)), { persistent: true })
    }
    await prodCh.close()
    await prodConn.close()

    // Consumer side: a fresh connection + channel.
    const consConn = await amqp.connect(url)
    const consumerCh = await consConn.createChannel()

    const got: unknown[] = []
    const reg = new ConsumerRegistry()
    reg.register('c', new RabbitMQConsumer(consumerCh, { queue }))
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
    await consConn.close()

    expect(got).toEqual([{ n: 1 }, { n: 2 }])
  }, 90000)
})
