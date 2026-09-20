---
title: "OpenTelemetry unified tracing decorator: W3C baggage propagation across HTTP, queues, and SSE"
id: F-020
status: refined
from_idea: I-023
---

# OpenTelemetry Unified Tracing Decorator: Distributed Tracing & W3C Propagation

## 1. Problem & Context

In polyglot event-driven microservice architectures, requests traverse multiple boundaries:
- HTTP REST / GraphQL requests (Express, FastAPI, Gin)
- Message Brokers & Event Streams (Kafka, RabbitMQ, BullMQ, Redis Streams)
- Server-Sent Events (SSE) streaming connections
- Batch loaders and database queries

Currently, while `@tracking` provides basic latency logging, it does not integrate with standard OpenTelemetry (OTel) distributed tracing. Spans break across queue boundaries (e.g. `EmitOnSuccess` publishing to Kafka/RabbitMQ and downstream `@on_event` consumers executing in another process). Correlating root traces with child operations requires manual, boilerplate-heavy trace carrier extraction and baggage injection.

---

## 2. Architecture & Design

`F-020` introduces `@trace` (TypeScript), `@traced` & `@traced_class` (Python), and `tracing.Tracer` (Go) to establish seamless end-to-end W3C trace context propagation across all existing components:

```
[Client HTTP Request]
        │ (traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01)
        ▼
┌────────────────────────────────────────┐
│ Express / FastAPI / Gin Route Handler  │ ──▶ Creates Server Span
└────────────────────────────────────────┘
        │
        ▼
┌────────────────────────────────────────┐
│ Service Method: @trace() / @traced     │ ──▶ Creates Child Span & records attributes
└────────────────────────────────────────┘
        │
        ▼
┌────────────────────────────────────────┐
│ @EmitOnSuccess / Queue Publisher       │ ──▶ Injects traceparent into QueueMessage.metadata
└────────────────────────────────────────┘
        │
        ▼ (Async Message Broker: Kafka / RabbitMQ / Redis Streams)
┌────────────────────────────────────────┐
│ ConsumerRegistry: dispatchFor()        │ ──▶ Extracts traceparent & starts Consumer Span
└────────────────────────────────────────┘
```

---

## 3. Polyglot API Contracts

### A. W3C Carrier Format & Canonical Rules
Conforms strictly to W3C Trace Context recommendation:
- `traceparent`: `00-${traceId}-${spanId}-${traceFlags}` (version 00, 32-hex trace ID, 16-hex span ID, 2-hex flags)
- `tracestate`: comma-separated vendor key-value pairs (e.g. `rojo=1,congo=2`)
- Preserved inside `QueueMessage.metadata.traceparent` and `QueueMessage.metadata.tracestate` to ensure 100% compliance with `queue-message.schema.json`.

### B. TypeScript / Node.js (`node/packages/core`)
Zero mandatory dependencies; built-in lightweight W3C context management with optional bridge to `@opentelemetry/api`:

```typescript
export interface TraceSpan {
  traceId: string;
  spanId: string;
  name: string;
  setAttributes(attrs: Record<string, any>): void;
  recordException(error: Error): void;
  end(): void;
}

export interface TraceOptions {
  name?: string;
  attributes?: Record<string, any> | ((...args: any[]) => Record<string, any>);
  recordError?: boolean;
}

export function trace(options?: TraceOptions): MethodDecorator;
export function getActiveTraceContext(): { traceparent?: string; tracestate?: string } | null;
```

### C. Python (`python/packages/core`)
Complies with Decision #4 & N4 (method and class forms using `_class_apply`):

```python
# Method form
@traced(
    name="order_service.create_order",
    attributes=lambda order_data: {"order.id": order_data.id, "order.amount": order_data.total},
    record_error=True,
)
async def create_order(order_data: OrderInput) -> OrderResult:
    ...

# Class form: auto-wrap all qualifying public async methods (Decision #4)
@traced_class(prefix="service.order")
class OrderService:
    ...
```

### D. Go (`go/core/tracing`)
Maintains Go stdlib-only invariant (zero external dependencies in `go.mod`):

```go
package tracing

type Span interface {
    TraceID() string
    SpanID() string
    SetAttributes(attrs map[string]any)
    RecordError(err error)
    End()
}

func StartSpan(ctx context.Context, name string, opts ...SpanOption) (context.Context, Span)
func InjectW3C(ctx context.Context) (traceparent string, tracestate string)
func ExtractW3C(ctx context.Context, traceparent string, tracestate string) context.Context
```

---

## 4. Cross-Boundary Propagation Engine

1. **HTTP Layer (Express, FastAPI, Gin)**:
   Extracts `traceparent` and `tracestate` from HTTP incoming request headers; sets as active async context.
2. **Queue Publisher (`@EmitOnSuccess`)**:
   Reads active trace from async context (`AsyncLocalStorage` in TS, `contextvars` in Python, `context.Context` in Go) and injects into `QueueMessage.metadata.traceparent`.
3. **Queue Consumer (`ConsumerRegistry.dispatchFor`)**:
   Reads `message.metadata.traceparent`, creates a child span representing consumer processing, and activates context while handlers execute.
4. **SSE Handshake**:
   Injects `traceparent` response header into HTTP handshake and attaches trace context to client subscription metadata.

---

## 5. Verification Strategy
- **Carrier Unit Tests**: Roundtrip validation of `traceparent` format parsing, rejection of invalid versions (`ff`), rejection of all-zero trace IDs.
- **Queue Metadata Parity**: Verify `QueueMessage` serialization passes `queue-message.schema.json` validation with traceparent in `metadata`.
- **E2E Trace Continuity**: Emitting a queue message from a traced method into Kafka/RabbitMQ/Redis consumer preserves the `traceId` end-to-end.
