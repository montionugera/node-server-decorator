import * as queueModule from './global-queue'
import { NoOpQueueAdapter, QueueAdapter, QueueMessage, hasGlobalQueue, setGlobalQueue } from './global-queue'

const message: QueueMessage = { eventName: 'Svc.method', payload: { id: 1 }, timestamp: 0 }

describe('global-queue module', () => {
  const original = queueModule.globalQueue

  afterEach(() => {
    setGlobalQueue(original)
  })

  it('has no global queue configured by default', () => {
    setGlobalQueue(null)

    expect(queueModule.globalQueue).toBeNull()
    expect(hasGlobalQueue()).toBe(false)
  })

  it('setGlobalQueue installs the adapter on the live binding and hasGlobalQueue reports it', async () => {
    const published: QueueMessage[] = []
    const adapter: QueueAdapter = {
      publish: async (m) => {
        published.push(m)
      },
    }

    setGlobalQueue(adapter)

    expect(hasGlobalQueue()).toBe(true)
    expect(queueModule.globalQueue).toBe(adapter)
    await queueModule.globalQueue!.publish(message)
    expect(published).toEqual([message])
  })

  it('setGlobalQueue(null) clears a previously installed adapter', () => {
    setGlobalQueue(new NoOpQueueAdapter())
    expect(hasGlobalQueue()).toBe(true)

    setGlobalQueue(null)

    expect(hasGlobalQueue()).toBe(false)
    expect(queueModule.globalQueue).toBeNull()
  })

  it('NoOpQueueAdapter.publish resolves to undefined and leaves the message untouched', async () => {
    const adapter = new NoOpQueueAdapter()
    const input: QueueMessage = { ...message, metadata: { trace: 't' } }
    const snapshot = JSON.parse(JSON.stringify(input))

    await expect(adapter.publish(input)).resolves.toBeUndefined()

    expect(input).toEqual(snapshot)
    expect((adapter as QueueAdapter).close).toBeUndefined()
  })
})
