import Redis from 'ioredis'
import { ConsumerRegistry } from '../decorators/consumer-registry'
import { RedisStreamConsumer } from '../decorators/consumer-adapters'

describe('RedisStreamConsumer (e2e)', () => {
  const url = process.env.REDIS_URL ?? 'redis://localhost:6379'

  it('consumes messages and XACKs them', async () => {
    const client = new Redis(url)
    const stream = 'test-node-consume-stream'
    const group = 'test-group'
    await client.del(stream)

    const got: unknown[] = []
    const reg = new ConsumerRegistry()
    reg.register('c', new RedisStreamConsumer(client, { stream, group, consumerName: 'w1' }))
    reg.on('A.x', (p) => { got.push(p) }, { consumer: 'c' })

    for (const n of [1, 2]) {
      const msg = { eventName: 'A.x', payload: { n }, timestamp: 1, metadata: {} }
      await client.xadd(stream, '*', 'data', JSON.stringify(msg))
    }

    await reg.start()
    const deadline = Date.now() + 5000
    while (got.length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50))
    }
    await reg.stop()

    expect(got).toEqual([{ n: 1 }, { n: 2 }])
    const pending = (await client.xpending(stream, group)) as any[]
    expect(pending[0]).toBe(0) // 0 pending = all acked
    await client.quit()
  }, 30000)

  it('survives a poison message, leaving it pending', async () => {
    const client = new Redis(url)
    const stream = 'test-node-poison-stream'
    const group = 'test-poison-group'
    await client.del(stream)

    const ok: unknown[] = []
    const reg = new ConsumerRegistry()
    reg.register('c', new RedisStreamConsumer(client, { stream, group, consumerName: 'w1' }))
    reg.on('A.fail', () => { throw new Error('boom') }, { consumer: 'c' })
    reg.on('A.ok', (p) => { ok.push(p) }, { consumer: 'c' })

    await client.xadd(stream, '*', 'data', JSON.stringify({ eventName: 'A.fail', payload: 1, timestamp: 1, metadata: {} }))
    await client.xadd(stream, '*', 'data', JSON.stringify({ eventName: 'A.ok', payload: { n: 2 }, timestamp: 1, metadata: {} }))

    await reg.start()
    const deadline = Date.now() + 5000
    while (ok.length < 1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50))
    }
    await reg.stop()

    expect(ok).toEqual([{ n: 2 }]) // consumer survived the poison message
    const pending = (await client.xpending(stream, group)) as any[]
    expect(pending[0]).toBeGreaterThanOrEqual(1) // poison entry still pending (not acked)
    await client.quit()
  }, 30000)

  it('acks and skips an unparseable entry', async () => {
    const client = new Redis(url)
    const stream = 'test-node-malformed-stream'
    const group = 'test-malformed-group'
    await client.del(stream)

    const ok: unknown[] = []
    const reg = new ConsumerRegistry()
    reg.register('c', new RedisStreamConsumer(client, { stream, group, consumerName: 'w1' }))
    reg.on('A.ok', (p) => { ok.push(p) }, { consumer: 'c' })

    // Malformed entry: no `data` field. Can never succeed → ack + skip.
    await client.xadd(stream, '*', 'notdata', 'garbage')
    await client.xadd(stream, '*', 'data', JSON.stringify({ eventName: 'A.ok', payload: { n: 9 }, timestamp: 1, metadata: {} }))

    await reg.start()
    const deadline = Date.now() + 5000
    while (ok.length < 1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50))
    }
    await reg.stop()

    expect(ok).toEqual([{ n: 9 }]) // good entry dispatched
    const pending = (await client.xpending(stream, group)) as any[]
    expect(pending[0]).toBe(0) // malformed entry was acked, not left pending
    await client.quit()
  }, 30000)
})
