import type { Redis } from 'ioredis'
import { ConsumerAdapter, Dispatch } from './consumer-registry'
import { globalLogger } from '../logger'

// RedisStreamConsumer — at-least-once consume over a Redis stream via a consumer group.
// Reads with XREADGROUP, dispatches the JSON in the `data` field (matching the
// producer's RedisStreamAdapter), and XACKs only on successful dispatch. A handler that
// throws leaves the entry pending (reclaimable) and the loop continues — one poison
// message cannot halt the pipe. (Automatic reclaim via XAUTOCLAIM is a future enhancement.)
export class RedisStreamConsumer implements ConsumerAdapter {
  private stopped = false

  constructor(
    private client: Redis,
    private options: {
      stream?: string
      group?: string
      consumerName?: string
      blockMs?: number
      batch?: number
    } = {},
  ) {}

  private get stream(): string {
    return this.options.stream ?? 'default'
  }
  private get group(): string {
    return this.options.group ?? 'server-decorator'
  }

  private async ensureGroup(): Promise<void> {
    try {
      await this.client.xgroup('CREATE', this.stream, this.group, '0', 'MKSTREAM')
    } catch (err) {
      if (!String(err).includes('BUSYGROUP')) throw err
    }
  }

  async run(dispatch: Dispatch): Promise<void> {
    await this.ensureGroup()
    const consumerName = this.options.consumerName ?? 'consumer-1'
    const blockMs = this.options.blockMs ?? 1000
    const batch = this.options.batch ?? 10
    while (!this.stopped) {
      const resp = (await this.client.xreadgroup(
        'GROUP',
        this.group,
        consumerName,
        'COUNT',
        batch,
        'BLOCK',
        blockMs,
        'STREAMS',
        this.stream,
        '>',
      )) as [string, [string, string[]][]][] | null
      if (!resp) continue
      for (const [, entries] of resp) {
        for (const [entryId, fields] of entries) {
          const idx = fields.indexOf('data')
          try {
            const raw = JSON.parse(fields[idx + 1])
            await dispatch(raw)
          } catch (err) {
            // Dispatch/parse failed: do NOT xack — entry stays pending for reclaim
            // (at-least-once). Keep consuming so one poison message can't halt the pipe.
            globalLogger.error(`dispatch failed for entry ${entryId}; left pending: ${err}`)
            continue
          }
          await this.client.xack(this.stream, this.group, entryId)
        }
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
  }
}
