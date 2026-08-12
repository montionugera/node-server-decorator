---
title: "Cross-language consumption Plan 2: Kafka + BullMQ + RabbitMQ consumers"
id: I-003
status: idea
canonical_spec: docs/superpowers/specs/2026-06-17-cross-language-consumption-design.md
canonical_plan: docs/superpowers/plans/2026-06-19-cross-language-consumption-plan2-backends.md
---

# Cross-language consumption Plan 2 (stub)

The **approved design spec** (shared with F-001) is:
`docs/superpowers/specs/2026-06-17-cross-language-consumption-design.md`
— §3 per-backend ack table, §5 delivery model, §8 scope all cover the Plan-2 backends.

The **implementation plan** is:
`docs/superpowers/plans/2026-06-19-cross-language-consumption-plan2-backends.md`

## Problem

F-001 (Plan 1) shipped the consume side for **Redis only**. The realistic Node
production queue (BullMQ) and the other matched-adapter backends (Kafka,
RabbitMQ) still can't be consumed cross-language.

## Sketch

Add `KafkaConsumer`, `RabbitMQConsumer`, `BullMQConsumer` in both languages on
the existing `ConsumerAdapter` contract (no registry/decorator/contract change),
at-least-once with backend-native acks. BullMQ via the official `bullmq`
packages (Node Worker + Python `bullmq` extra, per Decision U3). Interop: Kafka
matched-pair + **BullMQ Node→Python** (the headline realistic-production proof).
See the canonical plan for full task breakdown.
