# I-001 — Cross-Language Consumption — Design Spec

**Status:** approved (brainstorm complete 2026-06-17)
**Release:** 1.1
**Backlog id:** I-001 (idea; not yet refined to F-NNN)
**Canonical spec:** this file. The backlog `I-001-*/spec.md` is a stub pointing here.

---

## 1. Problem

`node-server-decorator` v2.0.2 makes the **producing** side polyglot: both Node
(`@EmitOnSuccess`) and Python (`@emit_on_success`) emit byte-compatible
`QueueMessage` envelopes to Redis Streams, RabbitMQ, Kafka, or BullMQ, validated
against a shared contract.

The **consuming** side does not exist. There is no consumer decorator or
consume-side machinery in either language; the interop tests read messages back
with raw clients (`redis.asyncio`, `ioredis`). Every real consumer would
hand-roll the same boilerplate, and a Python service cannot read a Node
service's BullMQ job envelope at all.

I-001 closes the loop: a first-class consume side, in both languages, behind the
existing shared contract.

## 2. Locked decisions (from brainstorm)

- **U1 — Generality.** No concrete service pairing exists yet; design for
  generality. Redis Streams is the proven pipe and the flagship.
- **U2 — Both languages, lockstep.** `@on_event` (Python) and `@OnEvent` (Node)
  ship together, parity-tested — matching the repo's core philosophy.
- **U3 — BullMQ via official package.** Python BullMQ consumption builds on the
  official `bullmq` PyPI package (optional extra), not a hand-rolled envelope
  parser. Node uses the existing `bullmq` (optional peer).
- **U4 — At-least-once, backend-native acks.** Redelivery uses each backend's
  own mechanism (Redis consumer groups + XACK, RabbitMQ ack/nack, Kafka offset
  commit, BullMQ retries). Handlers MUST be idempotent.
- **U5 — Opt-in service prefix.** When a service name is configured (env var
  `SERVER_DECORATOR_SERVICE`, overridable by `configure(service=...)`),
  auto-topic becomes `${service}.${ClassName}.${methodName}` and
  `metadata.service` is stamped on every emitted envelope. Unset → today's
  2-segment format, byte-identical. Minor `contracts/VERSION` bump.
- **Unmatched messages** → ack + skip, debug-level log; `on_unhandled=` hook
  overrides.

These derive from the binding decisions in `DECISIONS.md` (esp. #2 lockstep
versioning, #3 stage-2 TS decorators, #7 JSON-serializable payloads, #8
eventemitter3, #9 optional Kafka peer dep, #10 asyncio-only). Nothing here
revisits a locked decision.

## 3. Architecture — mirror the producer (Approach A)

Each language gains three consume-side units, exact duals of the produce side:

| Produce side (exists) | Consume side (new) |
|---|---|
| `QueueAdapter.publish(msg)` | `ConsumerAdapter` — `subscribe(topics)`, `run()`, `stop()` |
| `QueueRegistry` / `global_queue_registry` | `ConsumerRegistry` / `global_consumer_registry` |
| `@emit_on_success` / `@EmitOnSuccess` | `@on_event` / `@OnEvent` |

**Why A over alternatives:** symmetry is the repo's proven pattern — adapter +
registry + decorator already works across both languages with a shared
parity-test template. A degrades gracefully into "classes only" (cut the
decorator + registry last) if scope presses. Rejected: a decorator that
auto-starts consumers at import time (hidden lifecycle, untestable, contrary to
the explicit-wiring idiom).

**Message flow:** adapter receives raw frame → unwraps framing (e.g. BullMQ
`job.data`) → validates against `queue-message.schema.json` → dispatches by
`eventName` (optionally filtered by `metadata.service`) → handler receives
`(payload, metadata)` → ack on return, backend-native redelivery on raise.

**Lifecycle is explicit:** nothing connects or consumes until
`registry.start()`; `registry.stop()` drains and closes. No import-time magic.

### Consumer adapters (4 per language, all at-least-once)

| Backend | Read | Ack on success | On handler raise | Dependency |
|---|---|---|---|---|
| Redis Streams | `XREADGROUP` (consumer group) | `XACK` | reclaimed via `XAUTOCLAIM` after idle | `redis` / `ioredis` |
| Kafka | poll within group | commit offset after handler | no commit → redelivered on rebalance | `aiokafka` / `kafkajs` (optional) |
| RabbitMQ | `basic.consume` | `basic.ack` | `basic.nack(requeue=true)` | `aio-pika` / `amqplib` |
| BullMQ | official Worker | job completes | Worker throws → BullMQ retry/backoff | `bullmq` (new Python extra; Node optional peer) |

Plus an `InMemoryConsumer` (dual of `InMemoryQueueAdapter`) for fast unit tests.

## 4. API

### Python (asyncio only — Decision #10)

```python
from server_decorator import on_event, ConsumerRegistry, RedisStreamConsumer

registry = ConsumerRegistry()
registry.register("orders", RedisStreamConsumer(client, stream="orders", group="email-svc"))

@on_event("OrderService.createOrder", consumer="orders")
async def send_email(payload: dict, meta: dict) -> None:
    ...   # return → ack; raise → backend redelivers

await registry.start()
# ...
await registry.stop()
```

### Node (stage-2 decorators — Decision #3; eventemitter3 — Decision #8)

```typescript
import { OnEvent, ConsumerRegistry, RedisStreamConsumer } from '@montionugera/server-decorator';

class OrderHandlers {
  @OnEvent('OrderService.createOrder', { consumer: 'orders' })
  async sendEmail(payload: OrderPayload, meta: EventMetadata): Promise<void> { ... }
}

await registry.start();
```

### Shared semantics

- **Handler signature `(payload, metadata)`** — never the raw envelope. The
  envelope is validated and unwrapped first; `eventName`/`timestamp` are
  available in `metadata`.
- **Matching** — exact string against the envelope's `eventName`. With U5's
  prefix on, subscribe to the full `user-svc.UserService.create`. A `service=`
  filter option matches by service without naming every event.
- **`consumer=`** ties a handler to a registered pipe; omitted → the default
  consumer (mirrors `registry.setDefault`).
- **Node class-form** — `@OnEvent` decorates methods; registering an instance
  wires its decorated methods in. No auto-class-walk (handlers are opt-in by
  decoration), unlike Python's `tracking_class`.

## 5. Delivery & error handling

Uniform contract: **handler returns → ack; handler raises → no ack, backend
redelivers.** Per-backend mechanics in §3's table.

- **Strict ack ordering** — ack only after the handler resolves successfully. A
  crash between handler-success and ack yields a duplicate (the at-least-once
  tax), never a silent drop. Hence **handlers must be idempotent** (documented
  prominently in both READMEs).
- **Poison messages** — a forever-raising handler would redeliver forever. Each
  adapter exposes the backend's native cap (`max_attempts` → Redis idle reclaim
  limit / Kafka local retry count / Rabbit requeue limit / BullMQ `attempts`);
  on exhaustion the message goes to the backend's dead-letter facility, or an
  `on_failure=` hook. No cross-backend DLQ abstraction this cycle.
- **Validation failures** — a message failing `queue-message.schema.json`
  (corrupt / foreign producer) is acked + routed to `on_invalid=` (default:
  warn-log + skip), so one bad message cannot wedge the pipe.
- **Unmatched** — acked + skipped, debug log; `on_unhandled=` overrides.
- **Ordering is NOT guaranteed** under at-least-once with retries (a redelivered
  message arrives after later ones). Consumers needing order handle it
  themselves. Stated explicitly.

## 6. Contract changes (U5 — minor `contracts/VERSION` bump)

The only piece touching the shared wire contract; follows the strict rule —
`VERSION` + `CHANGELOG.md` + both `_contract.ts`/`_contract.py` + fixtures in one
PR.

- **`rules/topic-naming.md`** — auto-topic gains an optional 3-segment form.
  Accept both:
  ```
  2-segment (today):  ^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$
  3-segment (new):    ^[A-Za-z_][A-Za-z0-9-]*\.<ClassName>\.<methodName>$   (service segment allows hyphens)
  ```
  Precedence ladder unchanged; only the auto-derived value gains an optional
  prefix.
- **`schemas/queue-message.schema.json`** — `metadata` gains optional
  `service: string`. Stays `additionalProperties: true` → old consumers ignore
  it. Backward compatible.
- **`VERSION`** — minor bump (`1.0.0 → 1.1.0`). Opt-in → no existing message
  changes shape unless a service name is set.
- **Fixtures** — add a 3-segment example (`user-svc.UserService.create`)
  alongside existing 2-segment ones.

**Producer-side wiring:** read `SERVER_DECORATOR_SERVICE` at module init;
`configure(service=...)` overrides. When set: auto-topic gains the prefix AND
`metadata.service` is stamped. When unset: byte-identical to today.

**Blast radius:** does NOT touch the cache-key contract (`cache-key.md`) — no
cache flush, so not a major bump. Reversible by unsetting the env var.
`ci-contracts.yml` stays green because all three `_contract` values bump
together.

> Note vs the original idea framing: I-001 originally implied "no contract
> VERSION bump." That non-goal was about *cross-adapter framing*. This is a
> different, additive, metadata-only **minor** bump — explicitly in scope now.

## 7. Testing

- **Unit (fast lane, every PR)** — dispatch by `eventName`; `(payload,
  metadata)` shape; ack-on-return / no-ack-on-raise; unmatched → ack+skip;
  validation-fail → `on_invalid`; service-prefix on/off. Uses
  `InMemoryConsumer`, no Docker.
- **Parity** — new fixtures: a 3-segment service-prefixed envelope round-trips
  identically Node↔Python; both consumers unwrap the same bytes to the same
  `(payload, metadata)`.
- **Integration (Docker, opt-in label)** — one consume test per backend: real
  producer → broker → consumer → assert handler fired + acked. Redis, Kafka,
  BullMQ, RabbitMQ.
- **Interop (`ci-interop.yml`, push:main / weekly)** — new
  `interop/scenarios/`:
  - `node-emit-python-consume` (Redis Streams) — flagship
  - `python-emit-node-consume` (Redis Streams)
  - Kafka matched-pair
  - **BullMQ: Node `@EmitOnSuccess` → Python `@on_event`** (official `bullmq`
    pkg) — the realistic Node-production proof

## 8. Scope & cut-lines

```
SHIPS ── @on_event / @OnEvent + ConsumerRegistry + lifecycle ... both languages
      ── RedisStreamConsumer / KafkaConsumer / BullMQConsumer + interop scenario each
      ── RabbitMQConsumer ........... class + unit + integration ships
      ── service prefix (U5) ........ minor contracts VERSION bump

CUT ORDER (if scope presses, drop bottom-up — log what was dropped):
   1. RabbitMQ interop scenario (class still ships)
   2. Kafka interop scenario (integration still ships)
   3. — never cut: Redis flagship interop + @on_event core

NON-GOALS (explicit):
   ── cross-adapter framing (BullMQ→RabbitMQ etc.) → major bump, not this cycle
   ── retry / circuit-breaker decorators → I-002
   ── ordering guarantees → at-least-once only, documented
```

## 9. Affected paths (orientation, not exhaustive)

- `contracts/`: `VERSION`, `CHANGELOG.md`, `rules/topic-naming.md`,
  `schemas/queue-message.schema.json`, `fixtures/*`
- `node/src/`: `_contract.ts`, new `decorators/on-event.ts`,
  `decorators/consumer-registry.ts`, `decorators/consumer-adapters.ts`,
  `configure` for service name; barrel exports
- `python/src/server_decorator/`: `_contract.py`, new `decorators/on_event.py`,
  new `consumer/` package (registry + adapters), `configure`; `pyproject.toml`
  `bullmq` extra; barrel exports
- `interop/scenarios/`: new consume scenarios + `run.sh`
- READMEs (root/node/python): consume usage, idempotency caveat, service prefix
- `MIGRATION.md` / `docs/adr/`: ADR for the consume side + service prefix
```
