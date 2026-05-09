// Integration test: @cache backed by Redis (ioredis), using the new CACHE_MISS contract.

import Redis from 'ioredis'
import { GenericContainer, StartedTestContainer } from 'testcontainers'
import { cache, CACHE_MISS, type CacheAdapter } from '../index'

jest.setTimeout(60_000)

class RedisCacheAdapter implements CacheAdapter {
  constructor(
    private client: Redis,
    private prefix = 'sd:',
  ) {}

  async get(key: string): Promise<unknown> {
    const raw = await this.client.get(this.prefix + key)
    if (raw === null) return CACHE_MISS
    return JSON.parse(raw)
  }

  async set(key: string, value: unknown, ttl: number): Promise<void> {
    await this.client.set(this.prefix + key, JSON.stringify(value), 'EX', ttl)
  }
}

describe('@cache + Redis (testcontainers)', () => {
  let container: StartedTestContainer
  let client: Redis
  let adapter: RedisCacheAdapter

  beforeAll(async () => {
    container = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start()
    client = new Redis({ host: container.getHost(), port: container.getMappedPort(6379) })
    adapter = new RedisCacheAdapter(client)
  })

  afterAll(async () => {
    if (client) await client.quit()
    if (container) await container.stop()
  })

  it('round-trips a cached value', async () => {
    let computeCalls = 0

    class Svc {
      @cache(adapter, 60)
      async expensive(id: string): Promise<{ id: string; ts: number }> {
        computeCalls++
        return { id, ts: 42 }
      }
    }

    const s = new Svc()
    const r1 = await s.expensive('abc')
    const r2 = await s.expensive('abc')
    expect(r1).toEqual(r2)
    expect(computeCalls).toBe(1) // second call hit Redis
  })

  it('caches null values via CACHE_MISS contract', async () => {
    let computeCalls = 0

    class Svc {
      @cache(adapter, 60)
      async maybeNull(): Promise<null> {
        computeCalls++
        return null
      }
    }

    const s = new Svc()
    expect(await s.maybeNull()).toBeNull()
    expect(await s.maybeNull()).toBeNull()
    expect(computeCalls).toBe(1)
  })
})
