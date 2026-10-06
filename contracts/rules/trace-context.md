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
5. **Case**: Hexadecimal is lower-case only (`0-9a-f`), as W3C requires. A carrier with any upper-case hex digit is invalid and ignored; parsers do not normalise it.
6. **Fail closed**: The all-zero checks apply regardless of version, and any version other than `00` is invalid. Every lane must return the same verdict for the same carrier (`contracts/fixtures/trace-context.cases.json`); an invalid carrier starts a new trace rather than continuing one.
7. **No trimming**: Parsers do not trim or otherwise normalise the header. The carrier must be exactly the 55-character form above; any leading or trailing character (space, tab, CR, LF, U+FEFF, U+0085 or any other) makes it invalid and it is ignored. Language whitespace sets differ (`String.trim`, `str.strip`, `strings.TrimSpace`), so trimming would give the same carrier a different verdict per lane. Transports that pad header values must strip the padding before handing the value to the parser.

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
   - The `CONSUMER` span is a real span: it has its own new span id, its parent is the extracted producer span id, and it is ended and exported like any other span, so every span started by the handler has a parent that an exporter receives. It is named `consume <eventName>` and carries the attribute `span.kind = "CONSUMER"`.
   - A handler failure marks the `CONSUMER` span `ERROR` and still propagates (the message is not acked).
   - Whatever trace context the caller of dispatch had is restored afterwards. An absent or invalid `traceparent` runs the handler with no consumer span.

---

## 5. Span Lifecycle Invariants

1. **Instrumentation never fails the call**: a throwing `attributes` extractor or span exporter is logged and skipped; the wrapped call still runs and its span is still exported.
2. **Every failure is recorded**: a span whose wrapped call does not complete normally is exported with status `ERROR` — including non-`Error` thrown values (Node), cancellation and other `BaseException`s (Python), and panics (Go, exported before the panic continues). The original error is always re-raised unchanged.
3. **Detached emits keep the trace**: when a producer hands the emit to another thread or task, it runs in a copy of the caller's context so the injected `traceparent` is the caller's active span.
4. **Streaming bodies (Python generators / async generators)**: the span starts at the first resume and ends on exhaustion, error, or close (an early close is `OK`). The span's context is active only while the generator body runs, not in the code consuming it.
