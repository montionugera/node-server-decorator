# `interop/` — cross-language end-to-end tests

Two scenarios:

- `scenarios/node-producer-python-consumer/` — Node `@EmitOnSuccess` publishes to Redis stream → Python reads + validates against `contracts/schemas/queue-message.schema.json`.
- `scenarios/python-producer-node-consumer/` — reverse direction.

Both use the matched `RedisStreamAdapter` (Node) ↔ `RedisStreamAdapter` (Python) so the wire format is the clean `QueueMessage` JSON. BullMQ's framing-specific interop is out of scope for v2.0.0.

## Run locally

```bash
cd interop
docker compose up -d redis
bash scenarios/node-producer-python-consumer/run.sh
bash scenarios/python-producer-node-consumer/run.sh
docker compose down -v
```

## Adding a backend

To add RabbitMQ or Kafka interop:

1. Add the service to `docker-compose.yml`.
2. Copy a scenario folder, swap the producer/consumer adapters.
3. Pin the image tag in [`../contracts/INFRA.md`](../contracts/INFRA.md).

The contract round-trip is only proven between matched adapters. A BullMQ-aware Python consumer is tracked as a v2.1+ candidate.
