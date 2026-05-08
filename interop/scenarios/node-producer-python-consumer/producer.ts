// Node producer: builds a QueueMessage exactly as @EmitOnSuccess would, encodes as
// JSON, and XADDs to a Redis stream. The Python consumer reads + validates.

import { readFileSync } from 'fs'
import { join } from 'path'
import Redis from 'ioredis'

interface ExpectedPayload {
  eventName: string
  payload: Record<string, unknown>
}

const fixturePath = join(__dirname, '..', '..', 'shared', 'expected-payloads.json')
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as { messages: ExpectedPayload[] }

const STREAM = process.env.INTEROP_STREAM ?? 'interop'

async function main(): Promise<void> {
  const client = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379')
  for (const expected of fixture.messages) {
    const msg = {
      eventName: expected.eventName,
      payload: expected.payload,
      timestamp: Date.now(),
      metadata: { className: 'OrderService', methodName: 'createOrder', topic: 'orders' },
    }
    await client.xadd(STREAM, '*', 'data', JSON.stringify(msg))
  }
  console.log(`producer: wrote ${fixture.messages.length} messages to stream ${STREAM}`)
  await client.quit()
}

main().catch((err) => {
  console.error('producer failed:', err)
  process.exit(1)
})
