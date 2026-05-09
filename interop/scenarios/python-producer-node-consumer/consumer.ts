// Node consumer: reads N messages from Redis stream, validates against schema, and
// asserts payload equality with the shared expected-payloads fixture.

import { readFileSync } from 'fs'
import { join } from 'path'
import Ajv2020 from 'ajv/dist/2020'
import Redis from 'ioredis'

const ROOT = join(__dirname, '..', '..', '..')
const SCHEMA = JSON.parse(
  readFileSync(join(ROOT, 'contracts', 'schemas', 'queue-message.schema.json'), 'utf8'),
)
const EXPECTED = (
  JSON.parse(readFileSync(join(ROOT, 'interop', 'shared', 'expected-payloads.json'), 'utf8')) as {
    messages: { eventName: string; payload: Record<string, unknown> }[]
  }
).messages

const STREAM = process.env.INTEROP_STREAM ?? 'interop'

async function main(): Promise<void> {
  const client = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379')
  const ajv = new Ajv2020({ strict: false })
  const validate = ajv.compile(SCHEMA)

  // Wait briefly for producer-written messages to appear.
  const deadline = Date.now() + 10_000
  let received: { eventName: string; payload: Record<string, unknown> }[] = []
  while (Date.now() < deadline && received.length < EXPECTED.length) {
    const entries = (await client.xrange(STREAM, '-', '+', 'COUNT', EXPECTED.length * 2)) as [
      string,
      string[],
    ][]
    received = entries.map(([, fields]) => {
      const idx = fields.indexOf('data')
      return JSON.parse(fields[idx + 1])
    })
    if (received.length < EXPECTED.length) await new Promise((r) => setTimeout(r, 100))
  }

  if (received.length !== EXPECTED.length) {
    throw new Error(`expected ${EXPECTED.length} messages, got ${received.length}`)
  }

  for (let i = 0; i < received.length; i++) {
    if (!validate(received[i])) {
      throw new Error(`schema validation failed for message ${i}: ${ajv.errorsText(validate.errors)}`)
    }
    const got = received[i]
    const want = EXPECTED[i]
    if (got.eventName !== want.eventName) {
      throw new Error(`eventName mismatch: ${got.eventName} vs ${want.eventName}`)
    }
    if (JSON.stringify(got.payload) !== JSON.stringify(want.payload)) {
      throw new Error(
        `payload mismatch: ${JSON.stringify(got.payload)} vs ${JSON.stringify(want.payload)}`,
      )
    }
  }

  console.log(`consumer: validated ${received.length} messages against the schema, all match.`)
  await client.quit()
}

main().catch((err) => {
  console.error('consumer failed:', err)
  process.exit(1)
})
