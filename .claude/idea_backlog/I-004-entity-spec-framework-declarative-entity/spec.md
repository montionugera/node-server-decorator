---
title: "Entity-spec framework: declarative entity → REST/RPC/SSE/WS (polyglot IR compiler)"
id: I-004
status: idea
---

# Entity-spec framework: declarative entity → REST/RPC/SSE/WS (polyglot IR compiler)

**Canonical spec (approved 2026-08-04):** [docs/superpowers/specs/2026-08-04-entity-spec-framework-design.md](../../../docs/superpowers/specs/2026-08-04-entity-spec-framework-design.md)

## Problem

Every service hand-writes the same per-entity stack (DTOs, controllers, validation, swagger, observability). Survey 2026-08-03: ~3,500–4,000 generatable lines across ~10 entities; ~1,800 lines of per-service infra copy-pasted and drifting; 7 duplicate state-trigger routes in fact-board.

## Why now

server-decorator v2 shipped the polyglot base (contracts/, parity fixtures, interop CI) this layer needs; the estate's boilerplate is actively decaying via copy-paste drift.

## Sketch

Decorators record entity metadata into a language-neutral EntitySpec IR (contracted in `contracts/`). Generators compile the IR to zod/pydantic validation, OpenAPI, and transports via NestJS / SvelteKit / FastAPI adapters. Repository port for persistence. Monorepo restructure (ADR 0006 supersedes Decision #11). Pilot: content-svc. Full details in the canonical spec.
