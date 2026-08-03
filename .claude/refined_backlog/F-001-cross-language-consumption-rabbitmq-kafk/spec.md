---
title: "Cross-language consumption: @on_event/@OnEvent consumer side"
id: F-001
from_idea: I-001
status: refined
canonical_spec: docs/superpowers/specs/2026-06-17-cross-language-consumption-design.md
canonical_plan: docs/superpowers/plans/2026-06-17-cross-language-consumption-plan1-foundation-redis.md
---

# Cross-language consumption — F-001 (stub)

The **canonical, approved spec** is:
`docs/superpowers/specs/2026-06-17-cross-language-consumption-design.md`

The **implementation plan (Plan 1: Foundation + Redis)** is:
`docs/superpowers/plans/2026-06-17-cross-language-consumption-plan1-foundation-redis.md`

## Goal

A first-class consume side — `@on_event` (Python) / `@OnEvent` (Node) +
`ConsumerRegistry` + per-backend `ConsumerAdapter`s — in both languages, behind
the shared wire contract.

## Architecture

Mirror the produce side: ConsumerAdapter (per backend) → ConsumerRegistry
(named consumers, explicit start()/stop()) → @on_event/@OnEvent (dispatch by
eventName, handler receives (payload, metadata)). At-least-once delivery with
backend-native acks; opt-in `${service}.ClassName.methodName` topic prefix
(minor contract bump 1.1.0).

## Scope

- **Plan 1 (this cycle):** contract bump, service config, registry + decorator +
  InMemoryConsumer, RedisStreamConsumer, Node↔Python Redis interop, parity, docs.
- **Plan 2 (deferred):** Kafka, BullMQ (official `bullmq` pkg), RabbitMQ
  consumers + their interop scenarios.

See the canonical spec for full detail (decisions, delivery/error model,
contract changes, testing, cut-lines).
