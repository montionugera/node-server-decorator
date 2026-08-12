import { readFileSync } from 'fs'
import { join } from 'path'
import { Queue } from 'bullmq'
import IORedis from 'ioredis'

interface ExpectedPayload {
  eventName: string
  payload: Record<string, unknown>
}

const fixturePath = join(__dirname, '..', '..', 'shared', 'expected-payloads.json')
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as { messages: ExpectedPayload[] }
const QUEUE = process.env.INTEROP_QUEUE ?? 'OrderService.createOrder'

async function main(): Promise<void> {
  const connection = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
  })
  const queue = new Queue(QUEUE, { connection })

  for (const expected of fixture.messages) {
    const m = {
      eventName: expected.eventName,
      payload: expected.payload,
      timestamp: Date.now(),
      metadata: { topic: QUEUE },
    }
    await queue.add(m.eventName, m)
  }

  console.log(`producer: enqueued ${fixture.messages.length} jobs to bullmq queue ${QUEUE}`)
  await queue.close()
  await connection.quit()
}

main().catch((err) => {
  console.error('producer failed:', err)
  process.exit(1)
})
