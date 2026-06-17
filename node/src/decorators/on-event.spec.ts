import { ConsumerRegistry, InMemoryConsumer } from './consumer-registry'
import { OnEvent, registerHandlers } from './on-event'

function env(eventName: string, payload: unknown) {
  return { eventName, payload, timestamp: 1, metadata: {} }
}

describe('@OnEvent', () => {
  it('wires a decorated method into the registry', async () => {
    const reg = new ConsumerRegistry()
    reg.register('c', new InMemoryConsumer([env('A.x', { n: 1 })]))
    const got: unknown[] = []

    class Handlers {
      @OnEvent('A.x', { consumer: 'c', registry: reg })
      async onCreate(payload: any) {
        got.push(payload)
      }
    }
    registerHandlers(new Handlers())

    await reg.start()
    await new Promise((r) => setTimeout(r, 100))
    await reg.stop()

    expect(got).toEqual([{ n: 1 }])
  })
})
