---
title: "OpenTelemetry unified tracing decorator: W3C baggage propagation across HTTP, queues, and SSE"
id: F-020
status: refined
from_idea: I-023
---

# OpenTelemetry Unified Tracing Decorator: Distributed Tracing & Context Propagation

## 1. Problem & Context

In polyglot event-driven microservice architectures, requests traverse multiple boundaries:
- HTTP REST / GraphQL requests (Express, FastAPI, Gin)
- Message Brokers & Event Streams (Kafka, RabbitMQ, BullMQ, Redis Streams)
- Server-Sent Events (SSE) streaming connections
- Batch loaders and database queries

Currently, while `@tracking` provides basic latency logging, it does not integrate with standard OpenTelemetry (OTel) distributed tracing. Spans break across queue boundaries (e.g. `EmitOnSuccess` publishing to Kafka/RabbitMQ and downstream `@on_event` consumers executing in another process). Correlating root traces with child operations requires manual, boilerplate-heavy trace carrier extraction and baggage injection.

---

## 2. Architecture & Design

`F-020` introduces `@trace` (TypeScript), `@traced` (Python), and `tracing.Tracer` (Go) to establish seamless end-to-end W3C trace context propagation across all existing components:

```
[Client HTTP Request]
        │ (traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01)
        ▼
┌──────────────────────────────────────┐
│ Express / FastAPI / Gin Route Handler│ ──▶ Creates Server Span
└──────────────────────────────────────┘
        │
        ▼
┌──────────────────────────────────────┐
│ Service Method: @trace()             │ ──▶ Creates Child Span & records attributes
└──────────────────────────────────────┘
        │
        ▼
┌──────────────────────────────────────┐
│ @EmitOnSuccess / Queue Publisher     │ ──▶ Injects traceparent into Message Headers
└──────────────────────────────────────┘
        │
        ▼ (Async Message Broker: Kafka / RabbitMQ / Redis Streams)
┌──────────────────────────────────────┐
│ Consumer: @on_event()                │ ──▶ Extracts traceparent & continues trace
└──────────────────────────────────────┘
```

---

## 3. Polyglot API Contracts

### A. TypeScript / Node.js
```typescript
export interface TraceOptions {
  /**
   * Name of the span. Defaults to `${ClassName}.${MethodName}`.
   */
  name?: string;
  /**
   * Span kind: 'INTERNAL' | 'SERVER' | 'CLIENT' | 'PRODUCER' | 'CONSUMER'. Default: 'INTERNAL'.
   */
  kind?: 'INTERNAL' | 'SERVER' | 'CLIENT' | 'PRODUCER' | 'CONSUMER';
  /**
   * Static or dynamic attributes extracted from method arguments or execution context.
   */
  attributes?: Record<string, any> | ((...args: any[]) => Record<string, any>);
  /**
   * Record errors as exceptions on the span with StatusCode.ERROR. Default: true.
   */
  recordError?: boolean;
}

export function trace(options?: TraceOptions): MethodDecorator;
```

### B. Python
```python
@traced(
    name="order_service.create_order",
    kind="INTERNAL",
    attributes=lambda order_data: {"order.id": order_data.id, "order.amount": order_data.total},
    record_error=True,
)
async def create_order(order_data: OrderInput) -> OrderResult:
    ...
```

### C. Go
```go
// Traced method wrapper in Go
func (s *OrderService) CreateOrder(ctx context.Context, input OrderInput) (*OrderResult, error) {
    ctx, span := tracing.StartSpan(ctx, "OrderService.CreateOrder",
        tracing.WithAttributes(map[string]any{
            "order.id": input.ID,
            "order.amount": input.Total,
        }),
    )
    defer span.End()

    res, err := s.doCreate(ctx, input)
    if err != nil {
        span.RecordError(err)
        return nil, err
    }
    return res, nil
}
```

---

## 4. W3C Context Propagation Engine
1. **HTTP Layer**: Extracts `traceparent` and `tracestate` from incoming headers; injects into outgoing requests.
2. **Queue Layer**: Injects W3C trace headers into `QueueMessage.headers['traceparent']` and `QueueMessage.headers['tracestate']`.
3. **Consumer Layer**: `@on_event` and consumer registry automatically extract incoming trace context and create `CONSUMER` spans linked to the producer.
4. **SSE Broadcaster**: Injects active `traceparent` into SSE event headers / metadata.

---

## 5. Verification Strategy
- Unit tests validating span creation, attribute extraction, and error status setting.
- End-to-end trace propagation tests: HTTP request $\rightarrow$ `@trace` service $\rightarrow$ `EmitOnSuccess` $\rightarrow$ Queue Broker $\rightarrow$ `@on_event` consumer; assert that trace ID remains invariant across the entire lifecycle.
