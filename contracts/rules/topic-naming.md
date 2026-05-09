# `topic-naming` (contract v1.0.0)

## Auto-generated topic format

When `@EmitOnSuccess` / `@emit_on_success` is used without an explicit `topic` option, the topic is auto-derived as:

```
ClassName.methodName
```

Both names taken verbatim from the runtime introspection (Node: `target.constructor.name` + `propertyKey`; Python: `__qualname__` last two segments).

## Validation regex (auto form only)

```
^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$
```

Matches:
- `OrderService.createOrder`
- `UserService.login`
- `_PrivateService.helper` (allowed; auto-form is permissive about leading underscore)

Does **not** match:
- `Service.method.subname` (only one dot allowed in auto form)
- `123Service.method` (must start with letter or underscore)
- `Service.create-order` (no hyphens)

## Manual override

If the user passes an explicit `topic: "..."` option, the auto-format regex does not apply. The only constraint is **no whitespace**. Anything else is allowed (`urgent`, `events.high-priority`, `analytics:user_action`).

## Routing precedence

When `@EmitOnSuccess({useQueue: true})` decides where to publish:

1. Explicit `topic` option (manual override) — highest priority.
2. Auto-generated `ClassName.methodName` — used when neither manual `topic` nor queue `defaultTopic` applies.
3. Queue `defaultTopic` from registry config — fallback.
4. Literal `"default"` — last resort if nothing else is set.

The chosen value lands in `QueueMessage.metadata.topic`.
