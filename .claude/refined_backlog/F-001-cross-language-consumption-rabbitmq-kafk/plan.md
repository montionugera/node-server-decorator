# Cross-language consumption — F-001 Implementation Plan (stub)

The canonical implementation plan lives at:

`docs/superpowers/plans/2026-06-17-cross-language-consumption-plan1-foundation-redis.md`

That is **Plan 1 (Foundation + Redis)** — 13 TDD tasks: contract bump (1.1.0),
service config, ConsumerRegistry + @on_event/@OnEvent + InMemoryConsumer,
RedisStreamConsumer, Node↔Python Redis interop, parity, ADR + READMEs.

**Plan 2 (Kafka, BullMQ, RabbitMQ consumers + interop)** is deferred and will be
written before implementing those backends.
