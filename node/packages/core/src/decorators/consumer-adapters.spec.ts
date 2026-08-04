import { normalizeConnection } from './consumer-adapters'

// Regression test for a production bug: BullMQConsumer forwarded a bare
// `connection: string` straight to bullmq's `Worker`. bullmq's RedisConnection
// does `Object.assign({ port: 6379, host: '127.0.0.1', ... }, opts)` — when `opts`
// is a string, Object.assign spreads its char-indexed properties (numeric-index →
// single-char values) instead of merging any host/port/url, so the string content is
// silently discarded and the worker always dials 127.0.0.1:6379. bullmq's own types
// require `{ url: string }` to connect via a connection string. normalizeConnection()
// wraps a bare string as `{ url: string }` before it reaches the Worker; an
// already-structured connection (ioredis instance, RedisOptions, ...) passes through
// unchanged.
describe('normalizeConnection', () => {
  it('wraps a bare connection string as { url: string }', () => {
    const conn = 'redis://localhost:6379'
    expect(normalizeConnection(conn)).toEqual({ url: conn })
  })

  it('wraps a mapped-port testcontainers-style URL as { url: string }', () => {
    const conn = 'redis://127.0.0.1:54321'
    expect(normalizeConnection(conn)).toEqual({ url: conn })
  })

  it('passes an object connection through unchanged', () => {
    const conn = { host: '127.0.0.1', port: 6379 }
    expect(normalizeConnection(conn)).toBe(conn)
  })

  it('passes an ioredis-like instance through unchanged (not spread)', () => {
    class FakeRedis {
      host = '127.0.0.1'
      port = 6379
    }
    const conn = new FakeRedis()
    expect(normalizeConnection(conn)).toBe(conn)
  })
})
