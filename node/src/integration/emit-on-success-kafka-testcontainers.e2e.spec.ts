// Integration test: @EmitOnSuccess → real Kafka via testcontainers → consume back.
// Requires Docker. Per Decision #9, kafkajs is an optional peer dep but stays in
// node/devDependencies for tests.

import { Kafka, Producer } from 'kafkajs'
import { GenericContainer, StartedTestContainers, Wait } from 'testcontainers'
import { EmitOnSuccess, globalQueueRegistry, KafkaAdapter } from '../index'

jest.setTimeout(120_000)

describe('@EmitOnSuccess + Kafka (testcontainers)', () => {
  let containers: { kafka: any; bootstrap: string } | null = null
  let kafka: Kafka
  let producer: Producer

  beforeAll(async () => {
    // confluentinc/cp-kafka image (Kafka in KRaft mode); single-node
    const kafkaContainer = await new GenericContainer('confluentinc/cp-kafka:7.6.0')
      .withExposedPorts(9092)
      .withEnvironment({
        KAFKA_NODE_ID: '1',
        KAFKA_PROCESS_ROLES: 'broker,controller',
        KAFKA_LISTENERS: 'PLAINTEXT://0.0.0.0:9092,CONTROLLER://0.0.0.0:9093',
        KAFKA_INTER_BROKER_LISTENER_NAME: 'PLAINTEXT',
        KAFKA_CONTROLLER_LISTENER_NAMES: 'CONTROLLER',
        KAFKA_CONTROLLER_QUORUM_VOTERS: '1@localhost:9093',
        KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: 'CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT',
        KAFKA_ADVERTISED_LISTENERS: 'PLAINTEXT://localhost:9092',
        CLUSTER_ID: 'test-cluster-1234',
      })
      .withWaitStrategy(Wait.forLogMessage('Kafka Server started', 1))
      .start()

    const port = kafkaContainer.getMappedPort(9092)
    const host = kafkaContainer.getHost()
    const bootstrap = `${host}:${port}`
    containers = { kafka: kafkaContainer, bootstrap }

    kafka = new Kafka({ clientId: 'test', brokers: [bootstrap] })
    producer = kafka.producer()
    await producer.connect()

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
