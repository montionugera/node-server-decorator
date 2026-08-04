// Integration test: @EmitOnSuccess → real Kafka via testcontainers → consume back.
// Requires Docker. Per Decision #9, kafkajs is an optional peer dep but stays in
// node/devDependencies for tests.

import { Kafka, Producer } from 'kafkajs'
import { GenericContainer, Wait } from 'testcontainers'
import * as net from 'net'
import { EmitOnSuccess, globalQueueRegistry, KafkaAdapter } from '../index'

jest.setTimeout(120_000)

// Reserve a free host port synchronously before starting the container. Kafka's
// KAFKA_ADVERTISED_LISTENERS must be a real, dialable host:port pair — every kafkajs
// operation past the very first metadata fetch (produce, consumer group coordination,
// etc.) reconnects directly to whatever address the broker advertises. If that address
// doesn't match the testcontainers-mapped host port, those reconnects fail against a
// port nothing is listening on, and the consumer sits in a "Restarting the consumer"
// retry loop until the test's 30s timeout. Binding a fixed host port up front and
// reusing it both for the container's port mapping AND the advertised listener closes
// that gap. Small TOCTOU race between closing this probe socket and Docker binding the
// same port is inherent to this pattern but negligible in practice.
async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, () => {
      const address = srv.address()
      const port = typeof address === 'object' && address ? address.port : 0
      srv.close(() => resolve(port))
    })
  })
}

// I6: getFreePort()'s reserve-then-hand-off is an inherent TOCTOU race — something else
// can grab the port between the probe socket closing and Docker actually binding it (or
// the broker binding it internally), which surfaces later as a live connection error
// against a port nothing is listening on (observed: "AggregateError at
// internalConnectMultiple" against the reserved host port on ~1 in a handful of runs).
// Retry the whole start-and-connect sequence with a *fresh* port each attempt rather than
// trying to close the TOCTOU window itself.
async function startKafka(
  maxAttempts = 3,
): Promise<{ container: any; bootstrap: string; kafka: Kafka; producer: Producer }> {
  let lastError: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const hostPort = await getFreePort()
    let container: any
    try {
      // confluentinc/cp-kafka image (Kafka in KRaft mode); single-node
      container = await new GenericContainer('confluentinc/cp-kafka:7.6.0')
        .withExposedPorts({ container: 9092, host: hostPort })
        .withEnvironment({
          KAFKA_NODE_ID: '1',
          KAFKA_PROCESS_ROLES: 'broker,controller',
          KAFKA_LISTENERS: 'PLAINTEXT://0.0.0.0:9092,CONTROLLER://0.0.0.0:9093',
          KAFKA_INTER_BROKER_LISTENER_NAME: 'PLAINTEXT',
          KAFKA_CONTROLLER_LISTENER_NAMES: 'CONTROLLER',
          KAFKA_CONTROLLER_QUORUM_VOTERS: '1@localhost:9093',
          KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: 'CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT',
          // Single-broker cluster: the internal __consumer_offsets topic defaults to
          // replication factor 3, which a 1-node cluster can never satisfy — consumer
          // group coordination then fails with KafkaJSGroupCoordinatorNotFound because
          // the coordinator's backing topic never gets created. Pin it to 1.
          KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: '1',
          // Advertise the actual reserved host port (not the container-internal 9092) so
          // every post-bootstrap kafkajs connection lands on a port testcontainers really
          // forwards. See getFreePort() above for why this must be known before start().
          KAFKA_ADVERTISED_LISTENERS: `PLAINTEXT://localhost:${hostPort}`,
          // KRaft requires a 16-byte UUID base64url-encoded to exactly 22 chars;
          // the previous placeholder ('test-cluster-1234') fails Kafka's cluster-id
          // validator and the broker exits immediately, so `Wait.forLogMessage`
          // below times out deterministically. Any valid UUID works here.
          CLUSTER_ID: '5EIN5krtSw2OeR6qt1uK1Q',
        })
        .withWaitStrategy(Wait.forLogMessage('Kafka Server started', 1))
        .start()

      const port = container.getMappedPort(9092)
      const host = container.getHost()
      const bootstrap = `${host}:${port}`

      const kafkaClient = new Kafka({ clientId: 'test', brokers: [bootstrap] })
      const producerClient = kafkaClient.producer()
      await producerClient.connect()

      return { container, bootstrap, kafka: kafkaClient, producer: producerClient }
    } catch (err) {
      lastError = err
      if (container) {
        await container.stop().catch(() => {})
      }
      if (attempt === maxAttempts) throw err
    }
  }
  // Unreachable (the loop above always returns or throws on the last attempt), but keeps
  // the function's control flow provably total for TypeScript.
  throw lastError
}

describe('@EmitOnSuccess + Kafka (testcontainers)', () => {
  let containers: { kafka: any; bootstrap: string } | null = null
  let kafka: Kafka
  let producer: Producer

  beforeAll(async () => {
    const started = await startKafka()
    containers = { kafka: started.container, bootstrap: started.bootstrap }
    kafka = started.kafka
    producer = started.producer

    globalQueueRegistry.clear?.() // optional clear if exposed
    globalQueueRegistry.register('kafka', new KafkaAdapter(producer))
    globalQueueRegistry.setDefault('kafka')
  })

  afterAll(async () => {
    if (producer) await producer.disconnect()
    if (containers) await containers.kafka.stop()
  })

  it('publishes a QueueMessage to Kafka and we can consume it back', async () => {
    class OrderService {
      @EmitOnSuccess({ queue: 'kafka', topic: 'orders', useQueue: true, useEvents: false })
      async createOrder(customerId: string): Promise<{ customerId: string }> {
        return { customerId }
      }
    }

    await new OrderService().createOrder('cust-1')

    const consumer = kafka.consumer({ groupId: 'test-group' })
    await consumer.connect()
    await consumer.subscribe({ topic: 'orders', fromBeginning: true })

    const received: string[] = []
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timeout')), 30_000)
      consumer
        .run({
          eachMessage: async ({ message }) => {
            received.push(message.value!.toString())
            clearTimeout(timeout)
            resolve()
          },
        })
        .catch(reject)
    })

    expect(received.length).toBe(1)
    const body = JSON.parse(received[0])
    expect(body.eventName).toBe('OrderService.createOrder')
    expect(body.payload.customerId).toBe('cust-1')

    await consumer.disconnect()
  })
})
