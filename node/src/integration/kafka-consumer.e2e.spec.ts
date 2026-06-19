// e2e: KafkaConsumer consumes envelopes from a real Kafka broker (testcontainers)
// and commits offsets. Requires Docker. Per Decision #9, kafkajs is an optional peer
// dep but stays in node/devDependencies for tests.
//
// NOTE on the container: the dedicated `@testcontainers/kafka@12` module pulls in
// `testcontainers@12` (undici@8), which crashes on this Node/undici combo with
// `webidl.util.markAsUncloneable is not a function`. We instead use the umbrella
// `testcontainers@11` `GenericContainer` with the confluentinc/cp-kafka image in
// KRaft mode — the same proven setup as emit-on-success-kafka-testcontainers.e2e.spec.ts.

import { Kafka, logLevel } from 'kafkajs'
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers'
import { ConsumerRegistry } from '../decorators/consumer-registry'
import { KafkaConsumer } from '../decorators/consumer-adapters'

describe('KafkaConsumer (e2e)', () => {
  let container: StartedTestContainer
  let broker: string

  beforeAll(async () => {
    // Fixed host port (9092 -> 9092) so the broker can advertise localhost:9092 and
    // the kafkajs client reconnects to the same address it dialed. A random mapped port
    // would break the advertised-listener handshake (broker replies "reconnect to
    // localhost:9092", which wouldn't be the mapped port).
    container = await new GenericContainer('confluentinc/cp-kafka:7.6.0')
      .withExposedPorts({ container: 9092, host: 9092 })
      .withEnvironment({
        KAFKA_NODE_ID: '1',
        KAFKA_PROCESS_ROLES: 'broker,controller',
        KAFKA_LISTENERS: 'PLAINTEXT://0.0.0.0:9092,CONTROLLER://0.0.0.0:9093',
        KAFKA_INTER_BROKER_LISTENER_NAME: 'PLAINTEXT',
        KAFKA_CONTROLLER_LISTENER_NAMES: 'CONTROLLER',
        KAFKA_CONTROLLER_QUORUM_VOTERS: '1@localhost:9093',
        KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: 'CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT',
        KAFKA_ADVERTISED_LISTENERS: 'PLAINTEXT://localhost:9092',
        // Single-broker: the internal __consumer_offsets topic defaults to RF=3 and
        // would never be creatable, so the consumer group coordinator can't function
        // and eachMessage never fires. Force RF=1 for all internal topics.
        KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: '1',
        KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: '1',
        KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: '1',
        KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS: '0',
        // cp-kafka 7.6.0 validates this as a base64-encoded UUID (22 chars);
        // a free-form string like 'test-cluster-1234' makes the broker exit 1.
        CLUSTER_ID: 'ncBJzxKpQqOF0fZX3nDm8w',
      })
      .withWaitStrategy(Wait.forLogMessage('Kafka Server started', 1))
      .start()
    broker = `localhost:${container.getMappedPort(9092)}`
  }, 300000)

  afterAll(async () => { await container?.stop() }, 60000)

  it('consumes messages and commits offsets', async () => {
    const topic = 'A.x'
    const kafka = new Kafka({ brokers: [broker], logLevel: logLevel.NOTHING })
    const admin = kafka.admin()
    await admin.connect()
    await admin.createTopics({ topics: [{ topic, numPartitions: 1 }] })
    await admin.disconnect()

    const producer = kafka.producer()
    await producer.connect()
    for (const n of [1, 2]) {
      const msg = { eventName: 'A.x', payload: { n }, timestamp: 1, metadata: {} }
      await producer.send({ topic, messages: [{ value: JSON.stringify(msg) }] })
    }
    await producer.disconnect()

    const got: unknown[] = []
    const reg = new ConsumerRegistry()
    reg.register('c', new KafkaConsumer(kafka, { topics: [topic], groupId: 'g1' }))
    reg.on('A.x', (p) => { got.push(p) }, { consumer: 'c' })

    await reg.start()
    const deadline = Date.now() + 40000
    while (got.length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100))
    }
    await reg.stop()

    expect(got).toEqual([{ n: 1 }, { n: 2 }])
  }, 120000)
})
