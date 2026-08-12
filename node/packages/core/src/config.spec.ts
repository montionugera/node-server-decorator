import { configure, getService } from './config'

describe('config', () => {
  afterEach(() => configure({ service: null }))

  it('defaults to null when unset', () => {
    configure({ service: null })
    expect(getService()).toBeNull()
  })

  it('configure() sets the service', () => {
    configure({ service: 'user-svc' })
    expect(getService()).toBe('user-svc')
  })
})
