import { configure } from '../config'
import { EmitOnSuccess } from './emit-on-success'
import { InMemoryQueueAdapter } from './queue-adapters'
import { globalQueueRegistry } from './queue-registry'

describe('EmitOnSuccess service prefix', () => {
  afterEach(() => {
    configure({ service: null })
    globalQueueRegistry.clear()
  })

  it('prefixes the auto-topic and stamps metadata.service when configured', async () => {
    configure({ service: 'user-svc' })
    const adapter = new InMemoryQueueAdapter()
    globalQueueRegistry.register('q', { adapter })

    class UserService {
      @EmitOnSuccess({ useQueue: true, queue: 'q' })
      async create(x: number) {
        return x
      }
    }
    await new UserService().create(1)

    const msgs = adapter.getMessages('user-svc.UserService.create')
    expect(msgs).toHaveLength(1)
    expect(msgs[0].metadata!.topic).toBe('user-svc.UserService.create')
    expect(msgs[0].metadata!.service).toBe('user-svc')
  })
})
