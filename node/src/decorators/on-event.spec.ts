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

  it('does not leak handlers across a class hierarchy', async () => {
    const reg = new ConsumerRegistry()
    reg.register(
      'c',
      new InMemoryConsumer([
        env('base.evt', 1),
        env('sub.evt', 2),
      ]),
    )
    const baseGot: unknown[] = []
    const subGot: unknown[] = []

    class Base {
      @OnEvent('base.evt', { consumer: 'c', registry: reg })
      onBase(payload: any) {
        baseGot.push(payload)
      }
    }

    class Sub extends Base {
      @OnEvent('sub.evt', { consumer: 'c', registry: reg })
      onSub(payload: any) {
        subGot.push(payload)
      }
    }

    registerHandlers(new Sub())

    await reg.start()
    await new Promise((r) => setTimeout(r, 100))
    await reg.stop()

    // Each handler fires exactly once — no duplication from prototype leakage.
    expect(baseGot).toEqual([1])
    expect(subGot).toEqual([2])
  })
})
