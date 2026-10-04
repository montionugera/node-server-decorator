# OpenTelemetry Unified Tracing Decorator Implementation Plan (F-020)

> **Goal**: Implement polyglot OpenTelemetry tracing decorator (`@trace` / `@traced` & `@traced_class` / Go `tracing.StartSpan`) with automatic span lifecycle management, attribute mapping, and W3C trace context propagation across HTTP, message queues, and SSE.
> **Architecture Spec**: [`docs/superpowers/specs/2026-09-21-opentelemetry-tracing-design.md`](file:///Users/pasitnusso/workspace/repos/node-server-decorator/.claude/worktrees/_release/docs/superpowers/specs/2026-09-21-opentelemetry-tracing-design.md)

---

## Proposed Changes

### Phase 1: Contract Rules & W3C Carrier Utilities
- Add `contracts/rules/trace-context.md` defining W3C traceparent formatting (`00-traceid-spanid-flags`), edge cases, and schema conformance inside `QueueMessage.metadata`.
- Add test vectors in `contracts/fixtures/trace-context.cases.json`.
- Quality Gate: Roundtrip test validating parsing, formatting, and edge-case rejection (version `ff`, all-zero traceId).

### Phase 2: Node/TypeScript Implementation (`node/packages/core`)
- Implement `TraceSpan` and `@trace` method decorator in `node/packages/core/src/decorators/trace.ts` using `AsyncLocalStorage`.
- Inject `traceparent` and `tracestate` into `QueueMessage.metadata` in `EmitOnSuccess`.
- Extract incoming trace context in `ConsumerRegistry.dispatchFor` to wrap consumer handlers in child spans.
- Export in `node/packages/core/src/index.ts`.
- Quality Gate: Unit tests (`trace.spec.ts`) validating span creation, attribute extraction, error capture, and queue message metadata propagation.

### Phase 3: Python Asyncio Implementation (`python/packages/core`)
- Implement `@traced` method decorator and `@traced_class` class decorator in `python/packages/core/src/server_decorator/decorators/trace.py` using `contextvars` and `_class_apply`.
- Inject trace context into `QueueMessage.metadata` in `emit_on_success.py`.
- Extract trace context in `ConsumerRegistry.dispatch_for`.
- Export in `python/packages/core/src/server_decorator/__init__.py`.
- Quality Gate: Pytest unit tests in `python/packages/core/tests/unit/test_trace.py`.

### Phase 4: Go Implementation (`go/core/tracing`)
- Implement stdlib-only `tracing.StartSpan`, `tracing.Span`, `InjectW3C`, and `ExtractW3C` in `go/core/tracing/trace.go` using `context.Context` and `crypto/rand`.
- Update `go/core/emit.go` `QueueMessageMetadata` to include `Traceparent` and `Tracestate` (`json:",omitempty"`).
- Quality Gate: Unit tests in `go/core/tracing/trace_test.go` and `go/core/emit_test.go`.

### Phase 5: Verification & Promotion
- Run `bash scripts/contributor-check.sh` (all 7 quality gates).
- Ship via `psrw ship`.
