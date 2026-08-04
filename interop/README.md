# `interop/` — cross-language end-to-end tests

Two scenarios:

- `scenarios/node-producer-python-consumer/` — Node `@EmitOnSuccess` publishes to Redis stream → Python reads + validates against `contracts/schemas/queue-message.schema.json`.
- `scenarios/python-producer-node-consumer/` — reverse direction.
- `scenarios/node-emit-python-consume/` — Node writes to a Redis stream; Python consumes via `@on_event` + `RedisStreamConsumer` (consumer groups + XACK).
- `scenarios/python-emit-node-consume/` — reverse direction, Node consumes via `@OnEvent` + `RedisStreamConsumer`.
- `scenarios/kafka-node-emit-python-consume/` — Node produces envelopes to a Kafka topic via `kafkajs`; Python consumes via `@on_event` + `KafkaConsumer` (aiokafka consumer group, manual commit). Brings up the single-broker KRaft `kafka` service from `docker-compose.yml`.
- `scenarios/bullmq-node-emit-python-consume/` — **(Plan-2 headline)** Node enqueues jobs via the `bullmq` `Queue`; Python consumes them via `@on_event` + `BullMQConsumer`, which runs the official `bullmq` package's `Worker`. Proves a Node BullMQ producer is consumed cross-language by Python over the same Redis-backed queue.

Both use the matched `RedisStreamAdapter` (Node) ↔ `RedisStreamAdapter` (Python) so the wire format is the clean `QueueMessage` JSON. BullMQ's framing-specific interop is out of scope for v2.0.0.

## Run locally

```bash
cd interop
docker compose up -d redis
bash scenarios/node-producer-python-consumer/run.sh
bash scenarios/python-producer-node-consumer/run.sh
docker compose down -v

# Plan-2 cross-language consume scenarios (each run.sh manages its own services):
bash scenarios/bullmq-node-emit-python-consume/run.sh   # Redis-backed, fast
bash scenarios/kafka-node-emit-python-consume/run.sh     # Kafka startup is slow
```

> Each `run.sh` traps `docker compose down -v` on exit, so it tears the services down
> when it finishes. The Kafka scenario brings up its own `kafka` service.

## Services in `docker-compose.yml`

- `redis` — Redis 7, host `6379`.
- `kafka` — single-broker Confluent KRaft, host `9092`. Env mirrors the proven
  testcontainers setup in `node/packages/core/src/integration/kafka-consumer.e2e.spec.ts`
  (RF=1 on internal topics, valid base64 `CLUSTER_ID`, advertised listener `localhost:9092`).
- `rabbitmq` — RabbitMQ 3 management, mapped to host **5673** (not the usual 5672) to
  avoid colliding with another RabbitMQ already on 5672. No interop scenario uses it yet
  (the RabbitMQ consumer classes are covered by their testcontainers integration tests);
  it is kept for parity and local experimentation.

## Adding a backend

To add RabbitMQ or Kafka interop:

1. Add the service to `docker-compose.yml`.
2. Copy a scenario folder, swap the producer/consumer adapters.
3. Pin the image tag in [`../contracts/INFRA.md`](../contracts/INFRA.md).

The contract round-trip is only proven between matched adapters. Kafka and BullMQ cross-language consume scenarios are added in Plan 2 (above). The RabbitMQ consumer classes are proven by their testcontainers integration tests; a dedicated RabbitMQ interop scenario is not built yet (the `rabbitmq` service is present in `docker-compose.yml` for when it is).
