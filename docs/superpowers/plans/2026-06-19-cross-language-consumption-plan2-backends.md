# Cross-Language Consumption — Plan 2: Kafka + RabbitMQ + BullMQ consumers

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the consume side (shipped for Redis in Plan 1/F-001) with three more backends — Kafka, RabbitMQ, and BullMQ — in both Node and Python, at-least-once with backend-native acks, plus cross-language interop scenarios.

**Architecture:** Each new consumer implements the existing `ConsumerAdapter` contract (`run(dispatch)` / `stop()`) from Plan 1 and plugs into the existing `ConsumerRegistry` + `@on_event`/`@OnEvent`. No registry/decorator changes. Each adapter wraps its backend's native consumer (kafkajs/aiokafka, amqplib/aio-pika, bullmq Worker for both languages) and honours the Plan-1 delivery contract: dispatch returns → ack; dispatch raises → do NOT ack (backend redelivery); unparseable frames → ack+skip (where the backend exposes raw frames). Handlers stay idempotent (at-least-once).

**Tech Stack:** TypeScript (Jest e2e + `testcontainers`), Python 3.10+ (pytest `integration` marker + `testcontainers[kafka,rabbitmq]`), kafkajs / aiokafka, amqplib / aio-pika, bullmq (Node + the official `bullmq` PyPI package).

**Spec:** `docs/superpowers/specs/2026-06-17-cross-language-consumption-design.md` (the approved design; §3 per-backend ack table, §5 delivery model, §8 scope — this plan implements the Plan-2 row).

**Prereq:** Plan 1 (F-001) is shipped to release/1.1 — `ConsumerAdapter`, `ConsumerRegistry`, `@on_event`/`@OnEvent`, `RedisStreamConsumer`, `InMemoryConsumer` exist in both languages and are the patterns these tasks mirror.

---

## Per-backend ack mapping (the contract each adapter must honour)

| Backend | Read | Ack on dispatch success | On dispatch raise (handler failure) | Unparseable frame |
|---|---|---|---|---|
| Kafka | consumer group, manual offset commit | commit offset | do NOT commit → redelivered on restart/rebalance | ack+skip (commit) + log |
| RabbitMQ | `basic.consume` | `ack` | `nack(requeue=true)` | `ack` + log (drop; never parseable) |
| BullMQ | official Worker | return from processor (job completed) | throw from processor (BullMQ retries per `attempts`) | n/a — `job.data` is already a parsed object; invalid envelopes reach dispatch's `on_invalid` and the job completes |

> **Why BullMQ has no parse phase:** the producer's `BullMQAdapter` stores the `QueueMessage` as the job's `data` (a structured object), so the consumer receives `job.data` already-parsed. A malformed envelope is handled by the registry's `validate_envelope` → `on_invalid` path (dispatch resolves normally → job completes). Only a genuine handler raise causes a BullMQ retry.

---

## File Structure

**Node (`node/src/decorators/consumer-adapters.ts` — extend the existing file):**
- add `KafkaConsumer`, `RabbitMQConsumer`, `BullMQConsumer` classes alongside `RedisStreamConsumer`
- `node/src/index.ts` — export the three new classes
- e2e tests: `node/src/integration/kafka-consumer.e2e.spec.ts`, `rabbitmq-consumer.e2e.spec.ts`, `bullmq-consumer.e2e.spec.ts`

**Python (new files under `consumer/adapters/`):**
- `python/src/server_decorator/consumer/adapters/kafka_consumer.py` — `KafkaConsumer`
- `python/src/server_decorator/consumer/adapters/rabbitmq_consumer.py` — `RabbitMQConsumer`
- `python/src/server_decorator/consumer/adapters/bullmq_consumer.py` — `BullMQConsumer`
- `python/src/server_decorator/__init__.py` — export the three
- `python/pyproject.toml` — add `bullmq` optional extra (and add to `all`/`dev`)
- integration tests: `python/tests/integration/test_kafka_consumer.py`, `test_rabbitmq_consumer.py`, `test_bullmq_consumer.py`

**Interop (`interop/`):**
- `interop/docker-compose.yml` — add `kafka` and `rabbitmq` services (keep `redis`)
- `interop/scenarios/kafka-roundtrip/` (node-emit→python-consume over Kafka) + run.sh
- `interop/scenarios/bullmq-node-emit-python-consume/` (the realistic Node-production proof) + run.sh

**Contract:** unchanged (no `contracts/VERSION` bump — these are matched-adapter round-trips on the existing 1.1.0 wire format; cross-adapter framing remains the explicit non-goal).

---

## Task 1: Python `bullmq` optional extra

**Files:** Modify `python/pyproject.toml`; Test `python/tests/unit/test_bullmq_extra_declared.py`

- [ ] **Step 1: Write the failing test**

Create `python/tests/unit/test_bullmq_extra_declared.py`:

```python
import tomllib
from pathlib import Path


def test_bullmq_extra_present() -> None:
    pyproject = tomllib.loads(
        (Path(__file__).resolve().parents[2] / "pyproject.toml").read_text()
    )
    extras = pyproject["project"]["optional-dependencies"]
    assert "bullmq" in extras, "missing [project.optional-dependencies] bullmq extra"
    assert any("bullmq" in dep for dep in extras["bullmq"])
    # bullmq must also be in the aggregate extras
    assert any("bullmq" in dep for dep in extras["all"])
```

- [ ] **Step 2: Run — expect FAIL**

Run: `cd python && uv run pytest tests/unit/test_bullmq_extra_declared.py -q`
Expected: FAIL — `KeyError: 'bullmq'`.

- [ ] **Step 3: Add the extra**

In `python/pyproject.toml`, in `[project.optional-dependencies]`, add a `bullmq` line and include it in `all` and `dev`:

```toml
redis    = ["redis>=5.0"]
rabbitmq = ["aio-pika>=9.4"]
kafka    = ["aiokafka>=0.11"]
bullmq   = ["bullmq>=2.0"]
all      = ["redis>=5.0", "aio-pika>=9.4", "aiokafka>=0.11", "bullmq>=2.0"]
```

And append `"bullmq>=2.0",` to the `dev = [ ... ]` list (after the existing `aiokafka` line, before `testcontainers`).

- [ ] **Step 4: Sync + run — expect PASS**

Run: `cd python && uv sync --extra dev && uv run pytest tests/unit/test_bullmq_extra_declared.py -q`
Expected: `bullmq` resolves and installs; 1 passed.

- [ ] **Step 5: Full unit + lint + types**

Run: `cd python && uv run ruff check src tests && uv run mypy src && uv run pytest tests/unit -q`
Expected: clean; full unit suite still green.

- [ ] **Step 6: Commit**

```bash
git add python/pyproject.toml python/tests/unit/test_bullmq_extra_declared.py
git commit -m "feat(python): add bullmq optional extra"
```

---

## Task 2: Node KafkaConsumer

**Files:** Modify `node/src/decorators/consumer-adapters.ts`, `node/src/index.ts`; Test `node/src/integration/kafka-consumer.e2e.spec.ts`

- [ ] **Step 1: Write the failing e2e test**

Create `node/src/integration/kafka-consumer.e2e.spec.ts`:

```typescript
import { Kafka, logLevel } from 'kafkajs'
import { KafkaContainer, StartedKafkaContainer } from '@testcontainers/kafka'
import { ConsumerRegistry } from '../decorators/consumer-registry'
import { KafkaConsumer } from '../decorators/consumer-adapters'

describe('KafkaConsumer (e2e)', () => {
  let container: StartedKafkaContainer
  let broker: string

  beforeAll(async () => {
    container = await new KafkaContainer().withExposedPorts(9093).start()
    broker = `${container.getHost()}:${container.getMappedPort(9093)}`
  }, 120000)

  afterAll(async () => {
    await container?.stop()
  })

  it('consumes messages and commits offsets', async () => {
    const topic = 'A.x'
    const kafka = new Kafka({ brokers: [broker], logLevel: logLevel.NOTHING })
    const admin = kafka.admin()
    await admin.connect()
    await admin.createTopics({ topics: [{ topic, numPartitions: 1 }] })
    await admin.disconnect()

    const producer = kafka.producer()
    await producer.connect()
    for (const n of [1, 2]) {
      const msg = { eventName: 'A.x', payload: { n }, timestamp: 1, metadata: {} }
      await producer.send({ topic, messages: [{ value: JSON.stringify(msg) }] })
    }
    await producer.disconnect()

    const got: unknown[] = []
    const reg = new ConsumerRegistry()
    reg.register('c', new KafkaConsumer(kafka, { topics: [topic], groupId: 'g1' }))
    reg.on('A.x', (p) => { got.push(p) }, { consumer: 'c' })

    await reg.start()
    const deadline = Date.now() + 15000
    while (got.length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100))
    }
    await reg.stop()

    expect(got).toEqual([{ n: 1 }, { n: 2 }])
  }, 60000)
})
```

> NOTE: `@testcontainers/kafka` may need adding to devDependencies. If the repo already uses the umbrella `testcontainers` package with a `KafkaContainer` export, import from there instead (`import { KafkaContainer } from 'testcontainers'`). Check `node/package.json` and the existing redis e2e for the convention; adapt the import accordingly and add the dep if missing (`pnpm add -D @testcontainers/kafka`).

- [ ] **Step 2: Run — expect FAIL**

Run (Docker required): `cd node && pnpm test:e2e --testPathPattern=kafka-consumer`
Expected: FAIL — `KafkaConsumer` not exported.

- [ ] **Step 3: Implement**

In `node/src/decorators/consumer-adapters.ts`, add (keeping the existing `RedisStreamConsumer`):

```typescript
import type { Kafka, Consumer } from 'kafkajs'

// KafkaConsumer — at-least-once consume via a kafkajs consumer group with manual offset
// commit. Each message's `value` is the JSON envelope (matching the producer's KafkaAdapter).
// dispatch success → commit offset; dispatch raise → do not commit (redelivered on restart);
// unparseable value → commit + skip (log). One consumer instance covers one group.
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
          globalLogger.error(`dispatch failed for kafka offset ${message.offset}; not committing: ${err}`)
          return // not committed → redelivered on restart/rebalance
        }
        await this.commit(consumer, topic, partition, message.offset)
      },
    })
    // consumer.run returns immediately; keep run() alive until stop().
    while (!this.stopped) {
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  private async commit(consumer: Consumer, topic: string, partition: number, offset: string): Promise<void> {
    await consumer.commitOffsets([{ topic, partition, offset: (Number(offset) + 1).toString() }])
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.consumer) await this.consumer.disconnect()
  }
}
```

In `node/src/index.ts`, add to the consumer exports:

```typescript
export { RedisStreamConsumer, KafkaConsumer } from './decorators/consumer-adapters';
```
(merge with the existing `RedisStreamConsumer` export line.)

- [ ] **Step 4: Run — expect PASS**

Run: `cd node && pnpm test:e2e --testPathPattern=kafka-consumer`
Expected: 1 passed (Testcontainers spins up Kafka; first run pulls the image).

- [ ] **Step 5: Build + unit regression**

Run: `cd node && pnpm run build` (exit 0) and `pnpm test:unit` (unchanged count).

- [ ] **Step 6: Commit**

```bash
git add node/src/decorators/consumer-adapters.ts node/src/index.ts node/src/integration/kafka-consumer.e2e.spec.ts node/package.json
git commit -m "feat(node): KafkaConsumer (consumer group, manual offset commit), e2e"
```

---

## Task 3: Python KafkaConsumer

**Files:** Create `python/src/server_decorator/consumer/adapters/kafka_consumer.py`; Test `python/tests/integration/test_kafka_consumer.py`

- [ ] **Step 1: Write the failing integration test**

Create `python/tests/integration/test_kafka_consumer.py`:

```python
import asyncio
import json

import pytest

aiokafka = pytest.importorskip("aiokafka")
from testcontainers.kafka import KafkaContainer  # noqa: E402

from server_decorator import ConsumerRegistry, on_event  # noqa: E402
from server_decorator.consumer.adapters.kafka_consumer import KafkaConsumer  # noqa: E402

pytestmark = pytest.mark.integration


async def test_consumes_and_commits() -> None:
    with KafkaContainer() as kafka:
        bootstrap = kafka.get_bootstrap_server()

        producer = aiokafka.AIOKafkaProducer(bootstrap_servers=bootstrap)
        await producer.start()
        for n in (1, 2):
            msg = {"eventName": "A.x", "payload": {"n": n}, "timestamp": 1, "metadata": {}}
            await producer.send_and_wait("A.x", json.dumps(msg).encode())
        await producer.stop()

        got: list = []
        reg = ConsumerRegistry()
        reg.register("c", KafkaConsumer(bootstrap, topics=["A.x"], group_id="g1"))

        @on_event("A.x", consumer="c", registry=reg)
        async def handle(payload, meta):
            got.append(payload)

        await reg.start()
        deadline = asyncio.get_event_loop().time() + 20
        while len(got) < 2 and asyncio.get_event_loop().time() < deadline:
            await asyncio.sleep(0.2)
        await reg.stop()

        assert got == [{"n": 1}, {"n": 2}]
```

- [ ] **Step 2: Run — expect FAIL**

Run (Docker required): `cd python && uv run pytest -m integration tests/integration/test_kafka_consumer.py -q`
Expected: FAIL — `ModuleNotFoundError: ... kafka_consumer`.

- [ ] **Step 3: Implement**

Create `python/src/server_decorator/consumer/adapters/kafka_consumer.py`:

```python
"""KafkaConsumer — at-least-once consume via an aiokafka consumer group with manual
offset commit. Each record's value is the JSON envelope (matching the producer's
KafkaAdapter). dispatch success -> commit; dispatch raise -> do NOT commit (redelivered
on restart/rebalance); unparseable value -> commit + skip (log)."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from ..adapter import Dispatch

_log = logging.getLogger("server_decorator.consumer")


class KafkaConsumer:
    def __init__(
        self,
        bootstrap_servers: str,
        *,
        topics: list[str],
        group_id: str = "server-decorator",
        auto_offset_reset: str = "earliest",
    ) -> None:
        self._bootstrap = bootstrap_servers
        self._topics = topics
        self._group_id = group_id
        self._auto_offset_reset = auto_offset_reset
        self._stop = asyncio.Event()

    async def run(self, dispatch: Dispatch) -> None:
        from aiokafka import AIOKafkaConsumer

        consumer = AIOKafkaConsumer(
            *self._topics,
            bootstrap_servers=self._bootstrap,
            group_id=self._group_id,
            enable_auto_commit=False,
            auto_offset_reset=self._auto_offset_reset,
        )
        await consumer.start()
        try:
            while not self._stop.is_set():
                batch = await consumer.getmany(timeout_ms=1000, max_records=10)
                for _tp, records in batch.items():
                    for record in records:
                        # Phase 1: parse. Unparseable -> commit + skip.
                        try:
                            raw = json.loads(record.value)
                        except Exception:
                            _log.exception("unparseable kafka record; committing + skipping")
                            await consumer.commit()
                            continue
                        # Phase 2: dispatch. Handler failure -> do NOT commit (redelivered).
                        try:
                            await dispatch(raw)
                        except Exception:
                            _log.exception("dispatch failed for kafka record; not committing")
                            continue
                        await consumer.commit()
        finally:
            await consumer.stop()

    async def stop(self) -> None:
        self._stop.set()
```

Add `aiokafka.*` is already in the mypy `ignore_missing_imports` overrides (confirm in pyproject).

- [ ] **Step 4: Run — expect PASS**

Run: `cd python && uv run pytest -m integration tests/integration/test_kafka_consumer.py -q`
Expected: 1 passed.

- [ ] **Step 5: Lint + types + unit**

Run: `cd python && uv run ruff check src tests && uv run ruff format --check src tests && uv run mypy src && uv run pytest tests/unit -q`
Expected: clean; unit suite green.

- [ ] **Step 6: Commit**

```bash
git add python/src/server_decorator/consumer/adapters/kafka_consumer.py python/tests/integration/test_kafka_consumer.py
git commit -m "feat(python): KafkaConsumer (aiokafka group, manual commit), integration"
```

---

## Task 4: Node RabbitMQConsumer

**Files:** Modify `node/src/decorators/consumer-adapters.ts`, `node/src/index.ts`; Test `node/src/integration/rabbitmq-consumer.e2e.spec.ts`

- [ ] **Step 1: Write the failing e2e test**

Create `node/src/integration/rabbitmq-consumer.e2e.spec.ts`:

```typescript
import * as amqp from 'amqplib'
import { RabbitMQContainer, StartedRabbitMQContainer } from '@testcontainers/rabbitmq'
import { ConsumerRegistry } from '../decorators/consumer-registry'
import { RabbitMQConsumer } from '../decorators/consumer-adapters'

describe('RabbitMQConsumer (e2e)', () => {
  let container: StartedRabbitMQContainer
  let url: string

  beforeAll(async () => {
    container = await new RabbitMQContainer().start()
    url = container.getAmqpUrl()
  }, 120000)

  afterAll(async () => {
    await container?.stop()
  })

  it('consumes messages and acks them', async () => {
    const queue = 'A.x.queue'
    const conn = await amqp.connect(url)
    const ch = await conn.createChannel()
    await ch.assertQueue(queue, { durable: true })
    for (const n of [1, 2]) {
      const msg = { eventName: 'A.x', payload: { n }, timestamp: 1, metadata: {} }
      ch.sendToQueue(queue, Buffer.from(JSON.stringify(msg)), { persistent: true })
    }
    await ch.close()
    await conn.close()

    const consumerConn = await amqp.connect(url)
    const consumerCh = await consumerConn.createChannel()

    const got: unknown[] = []
    const reg = new ConsumerRegistry()
    reg.register('c', new RabbitMQConsumer(consumerCh, { queue }))
    reg.on('A.x', (p) => { got.push(p) }, { consumer: 'c' })

    await reg.start()
    const deadline = Date.now() + 15000
    while (got.length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100))
    }
    await reg.stop()
    await consumerConn.close()

    expect(got).toEqual([{ n: 1 }, { n: 2 }])
  }, 60000)
})
```

> NOTE: add `@testcontainers/rabbitmq` to devDependencies if not present (`pnpm add -D @testcontainers/rabbitmq`); or use `RabbitMQContainer` from the umbrella `testcontainers` if that's the repo convention.

- [ ] **Step 2: Run — expect FAIL**

Run: `cd node && pnpm test:e2e --testPathPattern=rabbitmq-consumer`
Expected: FAIL — `RabbitMQConsumer` not exported.

- [ ] **Step 3: Implement**

In `node/src/decorators/consumer-adapters.ts`, add:

```typescript
import type { Channel, ConsumeMessage } from 'amqplib'

// RabbitMQConsumer — at-least-once consume via basic.consume. The message body is the
// JSON envelope (matching the producer's RabbitMQAdapter). dispatch success -> ack;
// dispatch raise -> nack(requeue=true); unparseable body -> ack + skip (drop; never
// parseable). Consumes a single queue.
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
    // basic.consume returns immediately; the channel drives callbacks. run() resolves
    // when stop() cancels the consumer (cancellation rejects nothing; we just return).
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
```

In `node/src/index.ts`, extend the consumer export to include `RabbitMQConsumer`.

- [ ] **Step 4: Run — expect PASS**

Run: `cd node && pnpm test:e2e --testPathPattern=rabbitmq-consumer`
Expected: 1 passed.

- [ ] **Step 5: Build + unit regression**

Run: `cd node && pnpm run build` (exit 0); `pnpm test:unit`.

- [ ] **Step 6: Commit**

```bash
git add node/src/decorators/consumer-adapters.ts node/src/index.ts node/src/integration/rabbitmq-consumer.e2e.spec.ts node/package.json
git commit -m "feat(node): RabbitMQConsumer (ack/nack), e2e"
```

---

## Task 5: Python RabbitMQConsumer

**Files:** Create `python/src/server_decorator/consumer/adapters/rabbitmq_consumer.py`; Test `python/tests/integration/test_rabbitmq_consumer.py`

- [ ] **Step 1: Write the failing integration test**

Create `python/tests/integration/test_rabbitmq_consumer.py`:

```python
import asyncio
import json

import pytest

aio_pika = pytest.importorskip("aio_pika")
from testcontainers.rabbitmq import RabbitMqContainer  # noqa: E402

from server_decorator import ConsumerRegistry, on_event  # noqa: E402
from server_decorator.consumer.adapters.rabbitmq_consumer import RabbitMQConsumer  # noqa: E402

pytestmark = pytest.mark.integration


async def test_consumes_and_acks() -> None:
    with RabbitMqContainer() as rabbit:
        params = rabbit.get_connection_params()
        url = f"amqp://guest:guest@{params.host}:{params.port}/"
        queue_name = "A.x.queue"

        conn = await aio_pika.connect_robust(url)
        channel = await conn.channel()
        await channel.declare_queue(queue_name, durable=True)
        for n in (1, 2):
            msg = {"eventName": "A.x", "payload": {"n": n}, "timestamp": 1, "metadata": {}}
            await channel.default_exchange.publish(
                aio_pika.Message(body=json.dumps(msg).encode()), routing_key=queue_name
            )

        got: list = []
        reg = ConsumerRegistry()
        reg.register("c", RabbitMQConsumer(channel, queue=queue_name))

        @on_event("A.x", consumer="c", registry=reg)
        async def handle(payload, meta):
            got.append(payload)

        await reg.start()
        deadline = asyncio.get_event_loop().time() + 20
        while len(got) < 2 and asyncio.get_event_loop().time() < deadline:
            await asyncio.sleep(0.2)
        await reg.stop()
        await conn.close()

        assert got == [{"n": 1}, {"n": 2}]
```

- [ ] **Step 2: Run — expect FAIL**

Run: `cd python && uv run pytest -m integration tests/integration/test_rabbitmq_consumer.py -q`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `python/src/server_decorator/consumer/adapters/rabbitmq_consumer.py`:

```python
"""RabbitMQConsumer — at-least-once consume via aio-pika. The message body is the JSON
envelope (matching the producer's RabbitMQAdapter). dispatch success -> ack; dispatch
raise -> nack(requeue=True); unparseable body -> ack + drop (log). Consumes one queue."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from ..adapter import Dispatch

_log = logging.getLogger("server_decorator.consumer")


class RabbitMQConsumer:
    def __init__(self, channel: Any, *, queue: str, prefetch: int = 10) -> None:
        self._channel = channel
        self._queue_name = queue
        self._prefetch = prefetch
        self._stop = asyncio.Event()

    async def run(self, dispatch: Dispatch) -> None:
        await self._channel.set_qos(prefetch_count=self._prefetch)
        queue = await self._channel.declare_queue(self._queue_name, durable=True)
        async with queue.iterator() as it:
            async for message in it:
                if self._stop.is_set():
                    break
                # Phase 1: parse. Unparseable -> ack + drop.
                try:
                    raw = json.loads(message.body)
                except Exception:
                    _log.exception("unparseable rabbitmq message; acking + dropping")
                    await message.ack()
                    continue
                # Phase 2: dispatch. Handler failure -> nack(requeue).
                try:
                    await dispatch(raw)
                except Exception:
                    _log.exception("dispatch failed for rabbitmq message; requeueing")
                    await message.nack(requeue=True)
                    continue
                await message.ack()

    async def stop(self) -> None:
        self._stop.set()
```

`aio_pika.*` is already in the mypy ignore_missing_imports overrides (confirm in pyproject).

- [ ] **Step 4: Run — expect PASS**

Run: `cd python && uv run pytest -m integration tests/integration/test_rabbitmq_consumer.py -q`
Expected: 1 passed.

- [ ] **Step 5: Lint + types + unit**

Run: `cd python && uv run ruff check src tests && uv run ruff format --check src tests && uv run mypy src && uv run pytest tests/unit -q`

- [ ] **Step 6: Commit**

```bash
git add python/src/server_decorator/consumer/adapters/rabbitmq_consumer.py python/tests/integration/test_rabbitmq_consumer.py
git commit -m "feat(python): RabbitMQConsumer (aio-pika ack/nack), integration"
```

---

## Task 6: Node BullMQConsumer

**Files:** Modify `node/src/decorators/consumer-adapters.ts`, `node/src/index.ts`; Test `node/src/integration/bullmq-consumer.e2e.spec.ts`

- [ ] **Step 1: Write the failing e2e test**

Create `node/src/integration/bullmq-consumer.e2e.spec.ts`:

```typescript
import Redis from 'ioredis'
import { Queue } from 'bullmq'
import { ConsumerRegistry } from '../decorators/consumer-registry'
import { BullMQConsumer } from '../decorators/consumer-adapters'

describe('BullMQConsumer (e2e)', () => {
  const url = process.env.REDIS_URL ?? 'redis://localhost:6379'

  it('consumes BullMQ jobs (job.data is the envelope)', async () => {
    const queueName = 'A.x.bullmq'
    const connection = new Redis(url, { maxRetriesPerRequest: null })
    const queue = new Queue(queueName, { connection })
    await queue.obliterate({ force: true }).catch(() => {})

    // Producer-side framing: the BullMQAdapter stores the QueueMessage as job data.
    for (const n of [1, 2]) {
      const msg = { eventName: 'A.x', payload: { n }, timestamp: 1, metadata: {} }
      await queue.add('A.x', msg)
    }

    const got: unknown[] = []
    const reg = new ConsumerRegistry()
    reg.register('c', new BullMQConsumer({ queueName, connection: url }))
    reg.on('A.x', (p) => { got.push(p) }, { consumer: 'c' })

    await reg.start()
    const deadline = Date.now() + 15000
    while (got.length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100))
    }
    await reg.stop()
    await queue.close()
    connection.disconnect()

    expect(got).toEqual([{ n: 1 }, { n: 2 }])
  }, 30000)
})
```

> Uses the local Redis (BullMQ is Redis-backed). Ensure Redis is up (`docker compose -f interop/docker-compose.yml up -d redis`).

- [ ] **Step 2: Run — expect FAIL**

Run: `cd node && pnpm test:e2e --testPathPattern=bullmq-consumer`
Expected: FAIL — `BullMQConsumer` not exported.

- [ ] **Step 3: Implement**

In `node/src/decorators/consumer-adapters.ts`, add:

```typescript
import { Worker } from 'bullmq'
import type { Job } from 'bullmq'

// BullMQConsumer — consume BullMQ jobs via a Worker. The producer's BullMQAdapter stores
// the QueueMessage as the job's data, so job.data IS the envelope. dispatch success ->
// processor returns (job completed); dispatch raise -> processor throws (BullMQ retries
// per the job's `attempts`). No parse phase: job.data is already structured; an invalid
// envelope reaches dispatch's onInvalid path and the job completes.
export class BullMQConsumer implements ConsumerAdapter {
  private worker?: Worker

  constructor(
    private options: { queueName: string; connection: string | object; concurrency?: number },
  ) {}

  async run(dispatch: Dispatch): Promise<void> {
    this.worker = new Worker(
      this.options.queueName,
      async (job: Job) => {
        await dispatch(job.data) // throw → BullMQ marks failed + retries
      },
      { connection: this.options.connection as any, concurrency: this.options.concurrency ?? 1 },
    )
    await this.worker.waitUntilReady()
    // Worker drives its own loop; run() resolves when stop() closes it.
  }

  async stop(): Promise<void> {
    if (this.worker) await this.worker.close()
  }
}
```

In `node/src/index.ts`, extend the consumer export to include `BullMQConsumer`.

- [ ] **Step 4: Run — expect PASS**

Run: `cd node && pnpm test:e2e --testPathPattern=bullmq-consumer`
Expected: 1 passed.

- [ ] **Step 5: Build + unit regression**

Run: `cd node && pnpm run build` (exit 0); `pnpm test:unit`.

- [ ] **Step 6: Commit**

```bash
git add node/src/decorators/consumer-adapters.ts node/src/index.ts node/src/integration/bullmq-consumer.e2e.spec.ts
git commit -m "feat(node): BullMQConsumer (Worker), e2e"
```

---

## Task 7: Python BullMQConsumer (official `bullmq` package — the realistic Node-production proof)

**Files:** Create `python/src/server_decorator/consumer/adapters/bullmq_consumer.py`; Test `python/tests/integration/test_bullmq_consumer.py`

- [ ] **Step 1: Write the failing integration test**

Create `python/tests/integration/test_bullmq_consumer.py`:

```python
import asyncio

import pytest

bullmq = pytest.importorskip("bullmq")

from server_decorator import ConsumerRegistry, on_event  # noqa: E402
from server_decorator.consumer.adapters.bullmq_consumer import BullMQConsumer  # noqa: E402

pytestmark = pytest.mark.integration


async def test_consumes_bullmq_jobs(redis_url: str) -> None:
    from bullmq import Queue

    queue_name = "A.x.bullmq.py"
    queue = Queue(queue_name, {"connection": redis_url})
    # Producer framing: BullMQ stores the QueueMessage as job data.
    for n in (1, 2):
        msg = {"eventName": "A.x", "payload": {"n": n}, "timestamp": 1, "metadata": {}}
        await queue.add("A.x", msg)

    got: list = []
    reg = ConsumerRegistry()
    reg.register("c", BullMQConsumer(queue_name=queue_name, connection=redis_url))

    @on_event("A.x", consumer="c", registry=reg)
    async def handle(payload, meta):
        got.append(payload)

    await reg.start()
    deadline = asyncio.get_event_loop().time() + 15
    while len(got) < 2 and asyncio.get_event_loop().time() < deadline:
        await asyncio.sleep(0.2)
    await reg.stop()
    await queue.close()

    assert got == [{"n": 1}, {"n": 2}]
```

(The `redis_url` fixture from `tests/integration/conftest.py` already exists from Plan 1.)

- [ ] **Step 2: Run — expect FAIL**

Run (Redis up): `cd python && uv run pytest -m integration tests/integration/test_bullmq_consumer.py -q`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `python/src/server_decorator/consumer/adapters/bullmq_consumer.py`:

```python
"""BullMQConsumer — consume BullMQ jobs via the official `bullmq` package's Worker. The
Node producer's BullMQAdapter stores the QueueMessage as the job's data, so ``job.data``
IS the envelope. dispatch success -> processor returns (job completed); dispatch raise ->
processor raises (BullMQ retries per the job's attempts). No parse phase: job.data is
already structured; an invalid envelope reaches dispatch's on_invalid path and the job
completes. Requires the `bullmq` extra (pip install server-decorator[bullmq])."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from ..adapter import Dispatch

_log = logging.getLogger("server_decorator.consumer")


class BullMQConsumer:
    def __init__(
        self,
        *,
        queue_name: str,
        connection: str,
        concurrency: int = 1,
    ) -> None:
        self._queue_name = queue_name
        self._connection = connection
        self._concurrency = concurrency
        self._worker: Any = None
        self._stop = asyncio.Event()

    async def run(self, dispatch: Dispatch) -> None:
        from bullmq import Worker

        async def process(job: Any, job_token: str) -> None:
            await dispatch(job.data)  # raise -> BullMQ marks failed + retries

        self._worker = Worker(
            self._queue_name,
            process,
            {"connection": self._connection, "concurrency": self._concurrency},
        )
        await self._stop.wait()

    async def stop(self) -> None:
        self._stop.set()
        if self._worker is not None:
            await self._worker.close()
```

Add `bullmq.*` to the mypy `ignore_missing_imports` overrides in `pyproject.toml` (alongside the existing aiokafka/aio_pika/redis entries).

- [ ] **Step 4: Run — expect PASS**

Run: `cd python && uv run pytest -m integration tests/integration/test_bullmq_consumer.py -q`
Expected: 1 passed.

- [ ] **Step 5: Lint + types + unit**

Run: `cd python && uv run ruff check src tests && uv run ruff format --check src tests && uv run mypy src && uv run pytest tests/unit -q`

- [ ] **Step 6: Commit**

```bash
git add python/src/server_decorator/consumer/adapters/bullmq_consumer.py python/tests/integration/test_bullmq_consumer.py python/pyproject.toml
git commit -m "feat(python): BullMQConsumer via official bullmq package, integration"
```

---

## Task 8: Barrel exports + unit-level construction tests

**Files:** Modify `python/src/server_decorator/__init__.py`; Test `python/tests/unit/test_consumer_exports.py`, `node/src/decorators/consumer-exports.spec.ts`

> Node exports were added incrementally in Tasks 2/4/6; this task adds the Python barrel exports for the three new consumers and a unit test in each language that imports all consumer classes from the top level (no Docker — pure import/symbol check).

- [ ] **Step 1: Write the failing Python test**

Create `python/tests/unit/test_consumer_exports.py`:

```python
def test_all_consumers_importable_from_top_level() -> None:
    from server_decorator import (  # noqa: F401
        BullMQConsumer,
        KafkaConsumer,
        RabbitMQConsumer,
        RedisStreamConsumer,
    )
    assert KafkaConsumer is not None
    assert RabbitMQConsumer is not None
    assert BullMQConsumer is not None
    assert RedisStreamConsumer is not None
```

- [ ] **Step 2: Run — expect FAIL**

Run: `cd python && uv run pytest tests/unit/test_consumer_exports.py -q`
Expected: FAIL — ImportError (the three new ones aren't exported).

- [ ] **Step 3: Implement (Python barrel)**

In `python/src/server_decorator/__init__.py`, add imports (matching the existing absolute-import style; `RedisStreamConsumer` is already exported from Plan 1's final parity fix):

```python
from server_decorator.consumer.adapters.kafka_consumer import KafkaConsumer
from server_decorator.consumer.adapters.rabbitmq_consumer import RabbitMQConsumer
from server_decorator.consumer.adapters.bullmq_consumer import BullMQConsumer
```

and add `"KafkaConsumer"`, `"RabbitMQConsumer"`, `"BullMQConsumer"` to `__all__`.

> CRITICAL: verify none of `kafka_consumer.py` / `rabbitmq_consumer.py` / `bullmq_consumer.py` has a MODULE-LEVEL import of its optional client lib (`aiokafka`/`aio_pika`/`bullmq`). All three import their client lib INSIDE `run()` (lazy), so importing them in the barrel must NOT make `import server_decorator` require the optional extras. If any has a top-level client import, move it into `run()` before adding the barrel export. Confirm by reading each file.

- [ ] **Step 4: Run — expect PASS**

Run: `cd python && uv run pytest tests/unit/test_consumer_exports.py -q`
Expected: 1 passed (works even without kafka/rabbitmq/bullmq extras installed, because the client imports are lazy).

- [ ] **Step 5: Write + run the Node export test**

Create `node/src/decorators/consumer-exports.spec.ts`:

```typescript
import {
  RedisStreamConsumer,
  KafkaConsumer,
  RabbitMQConsumer,
  BullMQConsumer,
} from '../index'

describe('consumer exports', () => {
  it('all consumer classes are exported from the package root', () => {
    expect(typeof RedisStreamConsumer).toBe('function')
    expect(typeof KafkaConsumer).toBe('function')
    expect(typeof RabbitMQConsumer).toBe('function')
    expect(typeof BullMQConsumer).toBe('function')
  })
})
```

Run: `cd node && pnpm test -- --testPathPattern=consumer-exports` → 1 pass. Then `pnpm test:unit` (count +1) and `pnpm run build` (exit 0).

> If importing `BullMQConsumer`/`KafkaConsumer` at unit-test time pulls `bullmq`/`kafkajs` eagerly (because `consumer-adapters.ts` has top-level `import { Worker } from 'bullmq'` etc.), that's acceptable in Node since `bullmq` is a devDependency and `kafkajs` is an optional peer present in devDependencies — the unit test runs with devDeps installed. But confirm `pnpm run build` (which excludes specs) and the published `dist` don't force consumers to install `kafkajs`/`bullmq`: they're `import type` where possible, and runtime `import { Worker } from 'bullmq'`/`new Worker(...)` only executes when a consumer actually constructs a `BullMQConsumer`. If a top-level runtime `import` would break consumers who don't install the optional dep, switch to a lazy `await import('bullmq')` inside `run()` (mirroring the Python lazy import). Report which approach you used.

- [ ] **Step 6: Commit**

```bash
git add python/src/server_decorator/__init__.py python/tests/unit/test_consumer_exports.py node/src/decorators/consumer-exports.spec.ts
git commit -m "feat: export Kafka/RabbitMQ/BullMQ consumers from both package roots"
```

---

## Task 9: Interop scenarios — Kafka round-trip + BullMQ Node→Python

**Files:** Modify `interop/docker-compose.yml`; create `interop/scenarios/kafka-node-emit-python-consume/{producer.ts,consumer.py,run.sh}` and `interop/scenarios/bullmq-node-emit-python-consume/{producer.ts,consumer.py,run.sh}`; modify `interop/README.md`.

> Mirror the Plan-1 scenario structure (`interop/scenarios/node-emit-python-consume/`). Both new scenarios prove the realistic cross-language path: Node produces, Python consumes via `@on_event` + the new adapters.

- [ ] **Step 1: Add Kafka + RabbitMQ services to docker-compose**

In `interop/docker-compose.yml`, add (keep `redis`):

```yaml
  kafka:
    image: apache/kafka:3.7.0
    ports:
      - "9092:9092"
    environment:
      KAFKA_NODE_ID: 1
      KAFKA_PROCESS_ROLES: broker,controller
      KAFKA_LISTENERS: PLAINTEXT://:9092,CONTROLLER://:9093
      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://localhost:9092
      KAFKA_CONTROLLER_LISTENER_NAMES: CONTROLLER
      KAFKA_CONTROLLER_QUORUM_VOTERS: 1@localhost:9093
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1
    healthcheck:
      test: ["CMD-SHELL", "/opt/kafka/bin/kafka-broker-api-versions.sh --bootstrap-server localhost:9092 || exit 1"]
      interval: 5s
      timeout: 5s
      retries: 20
  rabbitmq:
    image: rabbitmq:3-management-alpine
    ports:
      - "5673:5672"
    healthcheck:
      test: ["CMD", "rabbitmq-diagnostics", "-q", "ping"]
      interval: 5s
      timeout: 5s
      retries: 20
```

> NOTE: RabbitMQ is mapped to host **5673** (not 5672) to avoid colliding with the developer's existing `quant_api_rabbitmq` container that holds 5672 (a known conflict from Plan 1). The interop scripts set the AMQP URL accordingly.

- [ ] **Step 2: Kafka scenario**

Create `interop/scenarios/kafka-node-emit-python-consume/producer.ts` — Node produces the shared fixtures to a Kafka topic `OrderService.createOrder`:

```typescript
import { readFileSync } from 'fs'
import { join } from 'path'
import { Kafka, logLevel } from 'kafkajs'

const fixturePath = join(__dirname, '..', '..', 'shared', 'expected-payloads.json')
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
  messages: { eventName: string; payload: Record<string, unknown> }[]
}
const TOPIC = process.env.INTEROP_TOPIC ?? 'OrderService.createOrder'
const BROKER = process.env.KAFKA_BROKER ?? 'localhost:9092'

async function main(): Promise<void> {
  const kafka = new Kafka({ brokers: [BROKER], logLevel: logLevel.NOTHING })
  const admin = kafka.admin()
  await admin.connect()
  await admin.createTopics({ topics: [{ topic: TOPIC, numPartitions: 1 }] })
  await admin.disconnect()
  const producer = kafka.producer()
  await producer.connect()
  for (const m of fixture.messages) {
    const msg = { eventName: m.eventName, payload: m.payload, timestamp: Date.now(), metadata: { topic: TOPIC } }
    await producer.send({ topic: TOPIC, messages: [{ value: JSON.stringify(msg) }] })
  }
  await producer.disconnect()
  console.log(`producer: wrote ${fixture.messages.length} messages to kafka topic ${TOPIC}`)
}

main().catch((err) => { console.error('producer failed:', err); process.exit(1) })
```

Create `interop/scenarios/kafka-node-emit-python-consume/consumer.py` — Python consumes via `@on_event` + `KafkaConsumer`:

```python
"""Python consumer over Kafka via @on_event + KafkaConsumer, asserting payload equality
with the shared fixture."""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "python" / "src"))

from server_decorator import ConsumerRegistry, on_event  # noqa: E402
from server_decorator.consumer.adapters.kafka_consumer import KafkaConsumer  # noqa: E402

EXPECTED = json.loads((ROOT / "interop" / "shared" / "expected-payloads.json").read_text())[
    "messages"
]
TOPIC = os.environ.get("INTEROP_TOPIC", "OrderService.createOrder")
BROKER = os.environ.get("KAFKA_BROKER", "localhost:9092")


async def main() -> int:
    received: list[dict] = []
    reg = ConsumerRegistry()
    reg.register("c", KafkaConsumer(BROKER, topics=[TOPIC], group_id="interop"))

    @on_event("OrderService.createOrder", consumer="c", registry=reg)
    async def handle(payload: dict, meta: dict) -> None:
        received.append(payload)

    await reg.start()
    deadline = asyncio.get_event_loop().time() + 30
    while len(received) < len(EXPECTED) and asyncio.get_event_loop().time() < deadline:
        await asyncio.sleep(0.2)
    await reg.stop()

    assert len(received) == len(EXPECTED), f"expected {len(EXPECTED)}, got {len(received)}"
    for got, expected in zip(received, EXPECTED):
        assert got == expected["payload"], f"payload mismatch: {got!r} vs {expected['payload']!r}"
    print(f"consumer: received + matched {len(received)} messages via @on_event (kafka).")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
```

Create `interop/scenarios/kafka-node-emit-python-consume/run.sh` (mirror the Plan-1 run.sh, but wait for the `kafka` service health and export `KAFKA_BROKER=localhost:9092`; producer = this producer.ts with `NODE_PATH`, consumer = this consumer.py; final echo `interop: kafka node-emit / python-consume PASSED`). chmod +x.

- [ ] **Step 3: Run the Kafka scenario — expect PASS**

Run: `bash interop/scenarios/kafka-node-emit-python-consume/run.sh`
Expected: ends `interop: kafka node-emit / python-consume PASSED`.

- [ ] **Step 4: BullMQ scenario (the realistic Node-production proof)**

Create `interop/scenarios/bullmq-node-emit-python-consume/producer.ts` — Node enqueues the shared fixtures via the BullMQ `Queue` (this is exactly what `@EmitOnSuccess` + `BullMQAdapter` does on the wire):

```typescript
import { readFileSync } from 'fs'
import { join } from 'path'
import Redis from 'ioredis'
import { Queue } from 'bullmq'

const fixturePath = join(__dirname, '..', '..', 'shared', 'expected-payloads.json')
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
  messages: { eventName: string; payload: Record<string, unknown> }[]
}
const QUEUE = process.env.INTEROP_QUEUE ?? 'OrderService.createOrder'

async function main(): Promise<void> {
  const connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null })
  const queue = new Queue(QUEUE, { connection })
  for (const m of fixture.messages) {
    const msg = { eventName: m.eventName, payload: m.payload, timestamp: Date.now(), metadata: { topic: QUEUE } }
    await queue.add(m.eventName, msg)
  }
  console.log(`producer: enqueued ${fixture.messages.length} BullMQ jobs to ${QUEUE}`)
  await queue.close()
  connection.disconnect()
}

main().catch((err) => { console.error('producer failed:', err); process.exit(1) })
```

Create `interop/scenarios/bullmq-node-emit-python-consume/consumer.py` — Python consumes via `@on_event` + `BullMQConsumer` (official `bullmq` pkg):

```python
"""Python consumer over BullMQ via @on_event + BullMQConsumer (official bullmq package),
proving a Node BullMQ producer can be consumed by Python."""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "python" / "src"))

from server_decorator import ConsumerRegistry, on_event  # noqa: E402
from server_decorator.consumer.adapters.bullmq_consumer import BullMQConsumer  # noqa: E402

EXPECTED = json.loads((ROOT / "interop" / "shared" / "expected-payloads.json").read_text())[
    "messages"
]
QUEUE = os.environ.get("INTEROP_QUEUE", "OrderService.createOrder")
REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379")


async def main() -> int:
    received: list[dict] = []
    reg = ConsumerRegistry()
    reg.register("c", BullMQConsumer(queue_name=QUEUE, connection=REDIS_URL))

    @on_event("OrderService.createOrder", consumer="c", registry=reg)
    async def handle(payload: dict, meta: dict) -> None:
        received.append(payload)

    await reg.start()
    deadline = asyncio.get_event_loop().time() + 20
    while len(received) < len(EXPECTED) and asyncio.get_event_loop().time() < deadline:
        await asyncio.sleep(0.2)
    await reg.stop()

    assert len(received) == len(EXPECTED), f"expected {len(EXPECTED)}, got {len(received)}"
    for got, expected in zip(received, EXPECTED):
        assert got == expected["payload"], f"payload mismatch: {got!r} vs {expected['payload']!r}"
    print(f"consumer: received + matched {len(received)} messages via @on_event (bullmq).")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
```

Create `interop/scenarios/bullmq-node-emit-python-consume/run.sh` — mirror Plan-1 run.sh (needs only `redis`); producer = producer.ts (NODE_PATH), consumer = consumer.py with `uv sync --extra dev` (the dev extra now includes `bullmq`); final echo `interop: bullmq node-emit / python-consume PASSED`. chmod +x.

- [ ] **Step 5: Run the BullMQ scenario — expect PASS**

Run: `bash interop/scenarios/bullmq-node-emit-python-consume/run.sh`
Expected: ends `interop: bullmq node-emit / python-consume PASSED`. This is the headline cross-language proof — quote the output.

- [ ] **Step 6: Update README + commit**

In `interop/README.md`, add bullets for the two new scenarios and note the RabbitMQ host-port 5673 choice. Then:

```bash
git add interop/
git commit -m "test(interop): Kafka + BullMQ cross-language consume scenarios"
```

---

## Task 10: Docs + ADR note + full green sweep

**Files:** Modify `node/README.md`, `python/README.md`, `docs/adr/0006-cross-language-consumption.md` (add a Plan-2 note), `interop/README.md`.

- [ ] **Step 1: README consume-backend matrix**

In both `node/README.md` and `python/README.md`, under the existing "Consuming events" section, add a short list of available consumers and their extras:
- Node: `RedisStreamConsumer`, `KafkaConsumer` (needs `kafkajs`), `RabbitMQConsumer` (needs `amqplib`), `BullMQConsumer` (needs `bullmq`).
- Python: `RedisStreamConsumer` (`[redis]`), `KafkaConsumer` (`[kafka]`), `RabbitMQConsumer` (`[rabbitmq]`), `BullMQConsumer` (`[bullmq]`).
Include a one-line note that delivery is at-least-once on every backend and handlers must be idempotent.

- [ ] **Step 2: ADR Plan-2 note**

In `docs/adr/0006-cross-language-consumption.md`, append a `## Plan 2 (shipped)` note: Kafka/RabbitMQ/BullMQ consumers added in both languages on the same `ConsumerAdapter` contract; BullMQ consumed via the official `bullmq` packages; no contract change (matched-adapter round-trips only; cross-adapter framing remains the non-goal). XAUTOCLAIM reclaim for Redis still deferred.

- [ ] **Step 3: FULL GREEN SWEEP**

- `cd python && bash scripts/check.sh` → ruff + mypy + unit all green.
- `cd node && pnpm test:unit && pnpm run build` → all pass, exit 0.
- `bash contracts/scripts/validate.sh` → all validate (contract unchanged at 1.1.0).
- Integration (Docker): `cd python && uv run pytest -m integration -q` (Redis/Kafka/RabbitMQ/BullMQ — note: the RabbitMQ produce-side test may still fail on the external `quant_api_rabbitmq` 5672 conflict; the consume-side RabbitMQ test uses Testcontainers' own mapped port so it should pass). `cd node && pnpm test:e2e` → all consumer e2e pass.
- Interop: re-run both new scenarios + the Plan-1 Redis scenarios.

Report any failure loudly with output; fix real regressions before committing.

- [ ] **Step 4: Commit**

```bash
git add node/README.md python/README.md docs/adr/0006-cross-language-consumption.md interop/README.md
git commit -m "docs: backend consumer matrix + Plan-2 ADR note"
```

---

## Self-Review (completed by plan author)

**Spec coverage (design spec §3/§5/§8 Plan-2 row):**
- Kafka consumer (both langs, consumer group + manual commit) → Tasks 2, 3 ✓
- RabbitMQ consumer (both langs, ack/nack) → Tasks 4, 5 ✓
- BullMQ consumer (Node Worker; Python official `bullmq` pkg per U3) → Tasks 6, 7 ✓
- Optional-dep hygiene (Python `bullmq` extra; lazy client imports so `import server_decorator` never requires extras) → Tasks 1, 8 ✓
- Interop: Kafka matched-pair + BullMQ Node→Python (the realistic Node-production proof) → Task 9 ✓
- Delivery model (at-least-once, ack-on-success / no-ack-on-raise, unparseable→ack+skip) honoured per-backend → every adapter task; mapping table at top ✓
- Contract unchanged (no VERSION bump; cross-adapter framing stays non-goal) → stated; Task 10 validates 1.1.0 ✓
- Docs/ADR → Task 10 ✓

**Cut-order (if scope presses, drop bottom-up, log what's dropped):** RabbitMQ interop scenario first (consumer class + integration still ship) → then Kafka interop scenario → never cut: BullMQ Node→Python interop (the headline) + the six consumer classes.

**Placeholder scan:** No TBD/TODO. Each task has full code. The only "verify against installed version" notes are deliberate (external client APIs: kafkajs `eachMessage`/`commitOffsets`, aiokafka `getmany`/`commit`, amqplib `consume`/`ack`/`nack`, aio-pika `queue.iterator()`, bullmq `Worker`) — implementers confirm via red-green TDD, which is the correct gate for third-party API drift.

**Type/name consistency:** `ConsumerAdapter`/`Dispatch` reused from Plan 1 unchanged; constructor option names consistent within each language (Node: `{topics, groupId}`, `{queue}`, `{queueName, connection}`; Python: `topics=/group_id=`, `queue=`, `queue_name=/connection=`); barrel export names match the class names.

**Known environmental caveat carried from Plan 1:** the developer's `quant_api_rabbitmq` holds host 5672 — interop RabbitMQ uses host 5673; integration RabbitMQ uses Testcontainers' own mapped port, so neither collides.
