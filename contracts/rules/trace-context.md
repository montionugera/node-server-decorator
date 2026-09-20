# Contract Rule: W3C Trace Context & Queue Propagation

## 1. Scope

This contract defines the format and parsing invariants for W3C Trace Context propagation across HTTP, message brokers, and SSE in `server-decorator`.

---

## 2. W3C Traceparent Specification

A valid `traceparent` header conforms to:
```
version-trace_id-parent_id-trace_flags
```
Example: `00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01`

### Validation Invariants
1. **Version**: Exactly `00` (hex). If version is `ff` or unparseable, carrier is considered invalid and ignored.
2. **Trace ID**: Exactly 32 hexadecimal characters (16 bytes). Cannot be all zeroes (`00000000000000000000000000000000`).
3. **Span ID**: Exactly 16 hexadecimal characters (8 bytes). Cannot be all zeroes (`0000000000000000`).
4. **Trace Flags**: Exactly 2 hexadecimal characters (`01` = recorded/sampled, `00` = not sampled).

---

## 3. Queue Message Metadata Conformance

To comply with `contracts/schemas/queue-message.schema.json` without modifying the strict top-level schema (`additionalProperties: false`), trace context fields MUST be injected into the open `metadata` object:

```json
{
  "eventName": "order.created",
  "payload": { "orderId": "123" },
  "timestamp": 1774141200000,
  "metadata": {
    "service": "order-service",
    "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    "tracestate": "congo=t61rcWkgMzE"
  }
}
```

---

## 4. Propagation Behavior

1. **Producer Side (`EmitOnSuccess` / publishers)**: If an active trace span exists in the execution context, inject its `traceparent` and `tracestate` into `QueueMessage.metadata`.
2. **Consumer Side (`ConsumerRegistry.dispatchFor`)**: If incoming `QueueMessage.metadata.traceparent` is present, extract it, start a child span with kind `CONSUMER`, and activate the span for the duration of the registered handler execution.
