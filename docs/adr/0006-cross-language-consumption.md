# 0006. Cross-language consumption (consume side)

Status: Accepted (release 1.1)

## Context

v2.0 made the produce side polyglot (`@EmitOnSuccess` / `@emit_on_success`) but
shipped no consume side. Python could not consume Node's events; both relied on
raw clients in tests. We need a first-class consume API in both languages.

## Decision

- Mirror the produce side: `ConsumerAdapter` (per backend) -> `ConsumerRegistry`
  (named consumers, explicit `start()`/`stop()`) -> `@on_event` / `@OnEvent`
  (dispatch by `eventName`, handler receives `(payload, metadata)`).
- Delivery is **at-least-once** using each backend's native ack/redelivery; a
  handler that raises is not acked. Handlers MUST be idempotent. Ordering is not
  guaranteed.
- Unmatched events are acked + skipped (debug log); `on_unhandled` overrides.
  Unparseable/invalid envelopes are acked + skipped (warn log) / routed to
  `on_invalid`; only handler failures stay pending for retry.
- Opt-in service prefix: `SERVER_DECORATOR_SERVICE` / `configure(service=...)`
  makes the auto-topic `service.ClassName.methodName` and stamps
  `metadata.service`. Additive minor contract bump (1.1.0); the cache-key
  contract is untouched.

## Consequences

- Lockstep symmetry: anyone who knows the produce side knows the consume side.
- BullMQ-as-BullMQ consumption (Plan 2) needs no contract change; cross-adapter
  framing remains an explicit non-goal (would force a major bump).
- Plan 1 ships Redis; Kafka/BullMQ/RabbitMQ consumers land in Plan 2.
- Node `@OnEvent` relies on stage-2 `experimentalDecorators` (Decision #3); it is
  not compatible with TC39 stage-3 transpilers (e.g. esbuild/tsx) — consumers
  compile with tsc (as the package does) or register handlers imperatively via
  `ConsumerRegistry.on()`.

## Plan 2 (shipped)

- Kafka, RabbitMQ, and BullMQ consumers added in **both** languages on the same
  `ConsumerAdapter` contract introduced in Plan 1.
- BullMQ is consumed via the official `bullmq` packages — a Node `Worker` and the
  Python `bullmq` package (Decision U3) — rather than re-framing BullMQ jobs onto
  another transport.
- **No contract change**: matched-adapter round-trips ride wire format `1.1.0`;
  cross-adapter framing remains the explicit non-goal.
- Optional client libraries (`kafkajs`/`amqplib`/`bullmq`; `aiokafka`/`aio-pika`/
  `bullmq`) are **lazy-imported**, so `import server_decorator` /
  `import '@montionugera/server-decorator'` never requires an unused extra.
- Automatic Redis reclaim (XAUTOCLAIM) is still deferred.
