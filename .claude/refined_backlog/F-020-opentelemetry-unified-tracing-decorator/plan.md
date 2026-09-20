# OpenTelemetry Unified Tracing Decorator Implementation Plan

> **Goal**: Implement polyglot OpenTelemetry tracing decorator (`@trace` / `@traced` / Go `tracing.StartSpan`) with automatic span lifecycle management, attribute mapping, and W3C trace context propagation across HTTP, message queues, and SSE.
> **Architecture Spec**: [`docs/superpowers/specs/2026-09-21-opentelemetry-tracing-design.md`](file:///Users/pasitnusso/workspace/repos/node-server-decorator/.claude/worktrees/_release/docs/superpowers/specs/2026-09-21-opentelemetry-tracing-design.md)

---

## Proposed Changes

### Phase 1: W3C Context Carrier & Header Utilities
- Implement standard W3C `traceparent` and `tracestate` carrier inject/extract functions across Go, TS, and Python.
- Integrate trace header propagation into `QueueMessage` headers.
- Quality Gate: Roundtrip test verifying W3C carrier serializing/parsing across all three runtimes.

### Phase 2: Node/TypeScript Implementation (`node/packages/core`)
- Implement `@trace` method decorator in `node/packages/core/src/decorators/trace.ts`.
- Automatically extract active context, start span, record latency/errors, and close span on promise resolve/reject.
- Integrate carrier propagation into `EmitOnSuccess` and `ConsumerRegistry`.
- Quality Gate: Unit tests (`trace.spec.ts`) validating span attributes, error status, and queue message header injection.

### Phase 3: Python Implementation (`python/packages/core`)
- Implement `@traced` decorator in `python/packages/core/src/server_decorator/decorators/trace.py`.
- Integrate with OpenTelemetry Python SDK if available, with graceful fallback to in-memory trace context.
- Quality Gate: Pytest unit tests (`test_trace.py`).

### Phase 4: Go Implementation (`go/core/tracing`)
- Implement `tracing.StartSpan`, `tracing.WithAttributes`, and context propagation middleware in Go.
- Quality Gate: `go test ./go/core/tracing/...`.

### Phase 5: Verification & Promotion
- Run `bash scripts/contributor-check.sh` (7/7 gates).
- Ship via `psrw ship`.
