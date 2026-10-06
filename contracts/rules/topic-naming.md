# `topic-naming` (contract v1.1.0)

## Auto-generated topic format

When `@EmitOnSuccess` / `@emit_on_success` is used without an explicit `topic` option, the topic is auto-derived.

Without a configured service (default):

```
ClassName.methodName
```

With a service configured via `SERVER_DECORATOR_SERVICE` (env) or `configure(service=...)`:

```
service.ClassName.methodName
```

Both names taken verbatim from runtime introspection (Node: `target.constructor.name` + `propertyKey`; Python: `__qualname__` last two segments). The service segment is taken verbatim from configuration and may contain hyphens (e.g. `user-svc`).

## Validation regex (auto form only)

Two-segment form (no service configured):

```
^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$
```

Three-segment form (service configured); the service segment additionally allows hyphens:

```
^[A-Za-z_][A-Za-z0-9-]*\.[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$
```

Matches (2-seg): `OrderService.createOrder`, `UserService.login`, `_PrivateService.helper`
Matches (3-seg): `user-svc.UserService.create`, `quant.OhlcService.createCandle`

Does **not** match either form: `123Service.method` (must start with letter/underscore), `Service.create-order` (Class/method segments forbid hyphens).

## Manual override

If the user passes an explicit `topic: "..."` option, the auto-format regex does not apply. The only constraint is **no whitespace**. Anything else is allowed (`urgent`, `events.high-priority`, `analytics:user_action`).

## Routing precedence

When `@EmitOnSuccess({useQueue: true})` decides where to publish:

1. Explicit `topic` option (manual override) — highest priority.
2. Auto-generated `ClassName.methodName` — used when neither manual `topic` nor queue `defaultTopic` applies.
3. Queue `defaultTopic` from registry config — fallback.
4. Literal `"default"` — last resort if nothing else is set.

The chosen value lands in `QueueMessage.metadata.topic`.

## Event-name override does not change the auto topic

The `eventName` / `event_name` option renames only `QueueMessage.eventName` (and the in-process event). The auto-generated topic is always built from `ClassName.methodName`, so a consumer binding set up for one language lane receives the other lane's messages. Pinned by `contracts/fixtures/topic-naming.cases.json`, which both lanes run.

## Queue resolution

When no queue name is given, the registry publishes to the default queue, or — if no default was ever set — to the first registered queue. An unknown *named* queue never falls back to another queue: the message is not published and the failure is logged (fail closed, so a message cannot land on a broker it was not addressed to).

## Emission never changes the method's outcome

Everything that runs after the decorated method succeeded (the `transform`, the event emit, the queue publish) is a side effect. If any of it throws, the error is logged, nothing further is emitted for that call, and the caller still receives the method's original result. Go follows the same rule: a panicking transform is recovered and nothing is published.

## Consumer delivery guarantees

Consumers are at-least-once. A Kafka consumer whose handler fails must not commit that offset and must rewind the partition to it (after a retry backoff, default 1000 ms) before dispatching anything later, so no commit can ever pass over a failed or undispatched offset. A consumer adapter whose run loop fails is logged by the registry; it is not restarted and must not crash the process.

A failure to acknowledge is not a reason to crash either. If the broker call that acks or rejects a message throws (for example a RabbitMQ channel that closed while the handler ran), the adapter logs it and leaves the message unacknowledged, so the broker redelivers it; the adapter never rejects a message whose handler succeeded. Stopping the registry always drains every consumer: a consumer whose run loop already died was logged when it died and does not make `stop()` fail or skip the others.
