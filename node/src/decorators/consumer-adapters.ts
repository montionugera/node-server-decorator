import type { Redis } from 'ioredis'
import type { Kafka, Consumer } from 'kafkajs'
import type { Channel, ConsumeMessage } from 'amqplib'
import type { Worker, Job } from 'bullmq'
import { ConsumerAdapter, Dispatch } from './consumer-registry'
import { globalLogger } from '../logger'

// RedisStreamConsumer — at-least-once consume over a Redis stream via a consumer group.
// Reads with XREADGROUP, dispatches the JSON in the `data` field (matching the
// producer's RedisStreamAdapter). Per-entry handling splits into two phases:
//   1. Parse/validation — an entry with no `data` field, or whose `data` isn't valid
//      JSON, can never succeed on retry, so it's XACKed + skipped (logged). Leaving such
//      entries pending would grow the Redis PEL unboundedly (spec §5).
//   2. Dispatch — a valid envelope whose handler throws leaves the entry pending
//      (reclaimable) for at-least-once retry; the loop continues so one poison message
//      cannot halt the pipe. A parseable-but-schema-invalid envelope still reaches
//      dispatch, where the registry's onInvalid path handles it and dispatch resolves
//      normally, so the entry is XACKed.
// (Automatic reclaim via XAUTOCLAIM is a future enhancement.)
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
          // Phase 1: parse. A malformed/absent-data entry can never succeed → ack + skip.
          let raw: unknown
          try {
            const idx = fields.indexOf('data')
            if (idx === -1) throw new Error("entry missing 'data' field")
            raw = JSON.parse(fields[idx + 1])
          } catch (err) {
            globalLogger.error(`unparseable entry ${entryId}; acking + skipping: ${err}`)
            await this.client.xack(this.stream, this.group, entryId)
            continue
          }
          // Phase 2: dispatch. A handler failure → leave pending (no ack) for at-least-once retry.
          try {
            await dispatch(raw)
          } catch (err) {
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

// KafkaConsumer — at-least-once consume via a kafkajs consumer group with manual offset
// commit. Each message's `value` is the JSON envelope (matching the producer's KafkaAdapter).
// dispatch success → commit offset; dispatch raise → do not commit (redelivered on restart);
// unparseable value → commit + skip (log).
export class KafkaConsumer implements ConsumerAdapter {
  private consumer?: Consumer
  private stopped = false

  constructor(
    private kafka: Kafka,
    private options: { topics: string[]; groupId: string; fromBeginning?: boolean },
  ) {}

  async run(dispatch: Dispatch): Promise<void> {
    const consumer = this.kafka.consumer({ groupId: this.options.groupId })
    this.consumer = consumer
    await consumer.connect()
    for (const topic of this.options.topics) {
      await consumer.subscribe({ topic, fromBeginning: this.options.fromBeginning ?? true })
    }
    await consumer.run({
      autoCommit: false,
      eachMessage: async ({ topic, partition, message }) => {
        if (this.stopped) return
        const valueStr = message.value?.toString()
        let raw: unknown
        try {
          if (!valueStr) throw new Error('empty message value')
          raw = JSON.parse(valueStr)
        } catch (err) {
          globalLogger.error(`unparseable kafka message; committing + skipping: ${err}`)
          await this.commit(consumer, topic, partition, message.offset)
          return
        }
        try {
          await dispatch(raw)
        } catch (err) {
          globalLogger.error(
            `dispatch failed for kafka offset ${message.offset}; not committing: ${err}`,
          )
          return
        }
        await this.commit(consumer, topic, partition, message.offset)
      },
    })
    while (!this.stopped) {
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  private async commit(
    consumer: Consumer,
    topic: string,
    partition: number,
    offset: string,
  ): Promise<void> {
    await consumer.commitOffsets([
      { topic, partition, offset: (Number(offset) + 1).toString() },
    ])
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.consumer) await this.consumer.disconnect()
  }
}

// RabbitMQConsumer — at-least-once consume via basic.consume. The message body is the
// JSON envelope (matching the producer's RabbitMQAdapter). dispatch success -> ack;
// dispatch raise -> nack(requeue=true); unparseable body -> ack + drop (log). One queue.
export class RabbitMQConsumer implements ConsumerAdapter {
  private consumerTag?: string

  constructor(
    private channel: Channel,
    private options: { queue: string; prefetch?: number },
  ) {}

  async run(dispatch: Dispatch): Promise<void> {
    await this.channel.assertQueue(this.options.queue, { durable: true })
    if (this.options.prefetch) await this.channel.prefetch(this.options.prefetch)
    const { consumerTag } = await this.channel.consume(
      this.options.queue,
      (msg: ConsumeMessage | null) => {
        if (!msg) return
        void this.handle(dispatch, msg)
      },
      { noAck: false },
    )
    this.consumerTag = consumerTag
  }

  private async handle(dispatch: Dispatch, msg: ConsumeMessage): Promise<void> {
    let raw: unknown
    try {
      raw = JSON.parse(msg.content.toString())
    } catch (err) {
      globalLogger.error(`unparseable rabbitmq message; acking + dropping: ${err}`)
      this.channel.ack(msg)
      return
    }
    try {
      await dispatch(raw)
    } catch (err) {
      globalLogger.error(`dispatch failed for rabbitmq message; requeueing: ${err}`)
      this.channel.nack(msg, false, true)
      return
    }
    this.channel.ack(msg)
  }

  async stop(): Promise<void> {
    if (this.consumerTag) await this.channel.cancel(this.consumerTag)
  }
}

// BullMQConsumer — consume BullMQ jobs via a Worker. The producer's BullMQAdapter stores
// the QueueMessage as the job's data, so job.data IS the envelope. dispatch success ->
// processor returns (job completed); dispatch raise -> processor throws (BullMQ retries
// per the job's attempts). No parse phase: job.data is already structured; an invalid
// envelope reaches dispatch's onInvalid path and the job completes. bullmq is lazily
// imported so consumers who don't use it aren't forced to install it.
export class BullMQConsumer implements ConsumerAdapter {
  private worker?: Worker

  constructor(
    private options: { queueName: string; connection: string | object; concurrency?: number },
  ) {}

  async run(dispatch: Dispatch): Promise<void> {
    const { Worker } = await import('bullmq')
    this.worker = new Worker(
      this.options.queueName,
      async (job: Job) => {
        await dispatch(job.data)
      },
      { connection: this.options.connection as any, concurrency: this.options.concurrency ?? 1 },
    )
    await this.worker.waitUntilReady()
  }

  async stop(): Promise<void> {
    if (this.worker) await this.worker.close()
  }
}
