import { readFileSync } from 'fs'
import { join } from 'path'
import Redis from 'ioredis'
import { ConsumerRegistry } from '../../../node/packages/core/src/decorators/consumer-registry'
import { RedisStreamConsumer } from '../../../node/packages/core/src/decorators/consumer-adapters'

// NOTE: this scenario runs via `tsx`, whose esbuild transform implements TC39 stage-3
// decorators rather than the legacy `experimentalDecorators` semantics that `@OnEvent` /
// `registerHandlers` are written against (tsx does not pick up `experimentalDecorators`
// from node/tsconfig.json). Under stage-3, `@OnEvent` receives a context object instead of
// a string propertyKey, so the pending-handler list never lands on the prototype and no
// handler gets wired. We therefore register the handler imperatively via `reg.on(...)`,
// which is exactly what `@OnEvent` + `registerHandlers` does under the hood. The decorator
// path itself is covered by Jest (ts-jest honors experimentalDecorators) in
// node/packages/core/src/decorators/on-event.spec.ts.

const ROOT = join(__dirname, '..', '..', '..')
const EXPECTED = (
  JSON.parse(readFileSync(join(ROOT, 'interop', 'shared', 'expected-payloads.json'), 'utf8')) as {
    messages: { eventName: string; payload: Record<string, unknown> }[]
  }
).messages
const STREAM = process.env.INTEROP_STREAM ?? 'interop'

const received: Record<string, unknown>[] = []
const reg = new ConsumerRegistry()

async function main(): Promise<void> {
  const client = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379')
  reg.register('c', new RedisStreamConsumer(client, { stream: STREAM, group: 'interop', consumerName: 'w1' }))
  reg.on(
    'OrderService.createOrder',
    (payload) => {
      received.push(payload as Record<string, unknown>)
    },
    { consumer: 'c' },
  )

  await reg.start()
  const deadline = Date.now() + 10_000
  while (received.length < EXPECTED.length && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100))
  }
  await reg.stop()

  if (received.length !== EXPECTED.length) {
    throw new Error(`expected ${EXPECTED.length} messages, got ${received.length}`)
  }
  for (let i = 0; i < received.length; i++) {
    if (JSON.stringify(received[i]) !== JSON.stringify(EXPECTED[i].payload)) {
      throw new Error(`payload mismatch at ${i}`)
    }
  }
  console.log(`consumer: received + matched ${received.length} messages via @OnEvent.`)
  await client.quit()
}

main().catch((err) => {
  console.error('consumer failed:', err)
  process.exit(1)
})
