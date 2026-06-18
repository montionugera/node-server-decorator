import { readFileSync } from 'fs'
import { join } from 'path'
import { ConsumerRegistry, InMemoryConsumer } from './consumer-registry'

const fixturePath = join(
  __dirname,
  '..',
  '..',
  '..',
  'contracts',
  'fixtures',
  'queue-message.valid-with-service.json',
)

describe('queue-message parity (service-prefixed envelope)', () => {
  it('unwraps to the same (eventName, payload, metadata) as Python', async () => {
    const raw = JSON.parse(readFileSync(fixturePath, 'utf8'))
    const got: Array<{ p: unknown; m: any }> = []
    const reg = new ConsumerRegistry()
    reg.register('c', new InMemoryConsumer([raw]))
    reg.on('UserService.create', (p, m) => { got.push({ p, m }) }, { consumer: 'c' })

    await reg.start()
    await new Promise((r) => setTimeout(r, 100))
    await reg.stop()

    expect(got).toHaveLength(1)
    expect(got[0].p).toEqual({ userId: 'u-1', email: 'a@example.com' })
    expect(got[0].m.service).toBe('user-svc')
    expect(got[0].m.topic).toBe('user-svc.UserService.create')
  })
})
