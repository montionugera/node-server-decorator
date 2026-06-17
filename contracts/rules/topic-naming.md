# `topic-naming` (contract v1.0.0)

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
