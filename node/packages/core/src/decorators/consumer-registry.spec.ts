import { ConsumerRegistry, InMemoryConsumer } from './consumer-registry'

function env(eventName: string, payload: unknown) {
  return { eventName, payload, timestamp: 1, metadata: { service: 'svc' } }
}

describe('ConsumerRegistry', () => {
  it('dispatches to the matching handler by eventName', async () => {
    const got: Array<[unknown, unknown]> = []
    const reg = new ConsumerRegistry()
    reg.register('c', new InMemoryConsumer([env('A.x', { n: 1 })]))
    reg.on('A.x', (p, m) => { got.push([p, m]) }, { consumer: 'c' })

    await reg.start()
    await new Promise((r) => setTimeout(r, 100))
    await reg.stop()

    expect(got).toEqual([[{ n: 1 }, { service: 'svc' }]])
  })

  it('acks + skips unmatched events via on_unhandled', async () => {
    const unhandled: string[] = []
    const reg = new ConsumerRegistry()
    reg.register('c', new InMemoryConsumer([env('B.y', 1)]), {
      onUnhandled: (ev) => { unhandled.push(ev) },
    })
    reg.on('A.x', () => {}, { consumer: 'c' })

    await reg.start()
    await new Promise((r) => setTimeout(r, 100))
    await reg.stop()

    expect(unhandled).toEqual(['B.y'])
  })

  it('routes invalid envelopes to onInvalid', async () => {
    const invalid: unknown[] = []
    const reg = new ConsumerRegistry()
    reg.register('c', new InMemoryConsumer(['not-an-object']), {
      onInvalid: (raw) => { invalid.push(raw) },
    })
    reg.on('A.x', () => {}, { consumer: 'c' })

    await reg.start()
    await new Promise((r) => setTimeout(r, 100))
    await reg.stop()

    expect(invalid).toEqual(['not-an-object'])
  })

  it('re-raises when a handler throws (so the adapter does not ack)', async () => {
    const reg = new ConsumerRegistry()
    reg.register('c', new InMemoryConsumer([]))
    reg.on('A.x', () => { throw new Error('boom') }, { consumer: 'c' })
    const dispatch = reg.dispatchFor('c')
    await expect(dispatch(env('A.x', 1))).rejects.toThrow('boom')
  })
})
