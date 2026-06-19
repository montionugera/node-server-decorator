import { readFileSync } from 'fs'
import { join } from 'path'
import { Kafka, logLevel } from 'kafkajs'

interface ExpectedPayload {
  eventName: string
  payload: Record<string, unknown>
}

const fixturePath = join(__dirname, '..', '..', 'shared', 'expected-payloads.json')
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as { messages: ExpectedPayload[] }
const TOPIC = 'OrderService.createOrder'
const broker = process.env.KAFKA_BROKER ?? 'localhost:9092'

async function main(): Promise<void> {
  const kafka = new Kafka({ brokers: [broker], logLevel: logLevel.NOTHING })

  const admin = kafka.admin()
  await admin.connect()
  await admin.createTopics({ topics: [{ topic: TOPIC, numPartitions: 1 }] })
  await admin.disconnect()

  const producer = kafka.producer()
  await producer.connect()
  for (const expected of fixture.messages) {
    const msg = {
      eventName: expected.eventName,
      payload: expected.payload,
      timestamp: Date.now(),
      metadata: { topic: TOPIC },
    }
    await producer.send({ topic: TOPIC, messages: [{ value: JSON.stringify(msg) }] })
  }
  await producer.disconnect()
  console.log(`producer: wrote ${fixture.messages.length} messages to kafka topic ${TOPIC}`)
}

main().catch((err) => {
  console.error('producer failed:', err)
  process.exit(1)
})
