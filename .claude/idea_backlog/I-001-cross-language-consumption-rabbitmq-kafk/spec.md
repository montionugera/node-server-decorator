---
title: "Cross-language consumption: RabbitMQ/Kafka interop scenarios, BullMQ-aware Python consumer, @on_event consumer decorator"
id: I-001
status: idea
canonical_spec: docs/superpowers/specs/2026-06-17-cross-language-consumption-design.md
---

# Cross-language consumption (stub)

This is a backlog stub. The **canonical, approved spec** lives at:

`docs/superpowers/specs/2026-06-17-cross-language-consumption-design.md`

Status: approved (brainstorm complete 2026-06-17), targeting release 1.1.

## Summary

A first-class consume side — `@on_event` (Python) / `@OnEvent` (Node) +
`ConsumerRegistry` + per-backend `ConsumerAdapter`s — in both languages, behind
the shared wire contract. At-least-once delivery with backend-native acks;
BullMQ consumption via the official `bullmq` package; opt-in
`${service}.${ClassName}.${methodName}` topic prefix (minor contract bump).
See the canonical spec for full detail.
