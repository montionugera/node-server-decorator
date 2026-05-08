# `INFRA.md` — pinned container images for integration tests

Both Node and Python integration tests should use the same container image tags so behavior matches across language CI jobs. Update both sides in lock-step when bumping versions.

| Backend | Image | Tag | Used by |
|---------|-------|-----|---------|
| Redis | `redis` | `7-alpine` | Node Redis e2e + Python `test_emit_redis.py` |
| RabbitMQ | `rabbitmq` | `3-management-alpine` | Node Rabbit e2e + Python `test_emit_rabbitmq.py` |
| Kafka | `confluentinc/cp-kafka` | `7.6.0` | Node Kafka e2e + Python `test_emit_kafka.py` |

`testcontainers` (Node and Python) handles the lifecycle. CI caches Docker layers so cold pulls only happen on image-version bumps.

## Resource notes

- Kafka container is heavy (~1 GB RAM). If CI minutes get tight, consider swapping to `redpanda` — speaks the Kafka protocol on a smaller footprint. Confirmed working with `kafkajs` and `aiokafka`.
- Redis and RabbitMQ are <100 MB and start in <2s.
