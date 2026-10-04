# Contract Changelog

All notable changes to the wire-format contracts will be documented here. The format is loosely [Keep a Changelog](https://keepachangelog.com/), and the contract version follows [Semantic Versioning](https://semver.org/).

## [1.3.0] — 2026-10-04 / lock, trace, coalescing and resilience rules; cross-lane parity fixes

This entry also records the three rule files and one fixture that release 2.6 added without a
`VERSION` bump.

### Added

- `rules/lock-adapter.md` (release 2.6) — Redis lock adapter protocol, the token-guarded release and renewal Lua scripts and the behaviour invariants. New section 5 "Lease Loss, Renewal Errors & Release": auto-renew is on by default in every lane; a renewal returning `0` is a definite loss; a renewal that errors is *unknown* and retried on the next tick, failing closed only once a full TTL has passed with no confirmed renewal; a lost lease is always reported (`LockLostError` in Node/Python with the method's own error kept as `cause` / `__context__`; `Lock.Lost()`, a context cancelled with cause `ErrLockLost` and an `ErrLockLost` return from `Release` / `Do` in Go); the token-guarded release is always attempted; Go `Release` is retryable; Python cancellation is never absorbed or replaced; Python `distributed_lock_class` wraps coroutine functions only.
- `rules/trace-context.md` (release 2.6) — W3C `traceparent` format and queue-metadata propagation. Tightened here: the version must be exactly `00`, all-zero trace/span ids are rejected under any version, hex is lower-case only and is never normalised, and every lane returns the same verdict for the same carrier. The consumer span is a real exported span named `consume <eventName>` with `span.kind = "CONSUMER"`, its own span id and the producer span as parent; a handler failure marks it `ERROR` and still propagates; the caller's previous trace context is restored after dispatch. New section 5 "Span Lifecycle Invariants": instrumentation never fails the call, every failure (non-`Error` throws, cancellation and other `BaseException`s, Go panics) is exported as `ERROR` and re-raised unchanged, detached emits keep the caller's trace, and Python generator / async-generator spans cover the whole iteration.
- `rules/graphql-dataloader.md` (release 2.6) — request-scoped loader registry, resolver key extraction and coalescing parity. New section 2.1 "What the registry owns": batch queue, in-flight map and L1 cache are per registry; no registry means no sharing (fail closed to N+1); context registry wins over an ambient one; services are resolved by identity; Go batch-context value and deadline rules. New section 5 "Coalescing Safety Rules": a caller that gives up never fails another caller, invalidation beats an in-flight load, per-scope state dies with its scope, the key is bound by position/name, and Node plain-object batch results are string-keyed.
- `rules/resilience.md` — new. Shared behaviour for retry, circuit breaker and rate limit: `maxAttempts` is an integer >= 1 validated when the decorator is applied (default 3); bounded half-open probes with stale-result rejection; monotonic clocks; registry naming and idle-bucket eviction (Node, Python).
- `rules/cache-adapter.md` — "Adapter failures": a failing `set` fails open (the result is returned, the write error is logged), a failing `get` fails closed (the error propagates and the wrapped function is not called), and a cache-key error is raised before the adapter or the wrapped function is touched.
- `rules/topic-naming.md` — four sections: an event-name override does not change the auto topic; queue resolution (default queue, else the first registered queue; an unknown *named* queue fails closed); emission never changes the method's outcome (a throwing `transform`, emit or publish is logged and skipped); consumer delivery guarantees (at-least-once; a Kafka consumer rewinds to a failed offset after a retry backoff, default 1000 ms; a failed consumer run loop is logged, not restarted, and does not crash the process).
- `rules/entity-spec-validation.md` — the shared RFC 3339 `date-time` shape every validator applies before its own parser (`DATETIME_PATTERN` / `DateTimePattern`); JSON booleans are rejected for `int`/`float` and numbers for `bool`; a `null` list element follows the item's own `nullable` flag; `min`/`max` on `str`/`ref` count Unicode code points; `\d \w \b` (and negations) in a `pattern` are ASCII in every validator; a validation case may carry an inline `spec`.
- `rules/rest-conventions.md` — body validation counts string length in code points and applies the recursive include rule to nested members; a declared security requirement fails closed with `401`, including when no scope extractor was supplied; SSE `Last-Event-ID` replay is positional and replays the whole buffer for an unknown id; list `parameters` are sorted by name in code-point order.
- `fixtures/trace-context.cases.json` (release 2.6) — shared `traceparent` verdicts, plus five cases here: a non-`00` version, a non-`00` version with all-zero ids, and upper-case hex in the trace id, span id and flags.
- `fixtures/topic-naming.cases.json` — new. Four cases, run by Node and Python, pinning `eventName` and `metadata.topic` for auto topics and event-name overrides.
- `fixtures/cache-key.examples.json` — `unicode-arg-stays-utf8`, `html-chars-not-escaped`, `control-and-separator-chars`.
- `fixtures/entity-spec.cases.json` — cases for boolean/number coercion, the strict `date-time` shape, code-point string length (Thai and astral characters), ASCII `pattern` classes, nullable list items, the shared `uri` pattern and code-point parameter ordering.

### Changed

- `rules/cache-key.md` — string escaping is now specified as exactly JavaScript `JSON.stringify` (only `"`, `\` and C0 controls are escaped; non-ASCII, `<`, `>`, `&`, U+2028 and U+2029 are literal). The receiver (`self`/`cls`) is never part of `args`. NaN / Infinity MUST raise before the adapter or the wrapped function is touched (previously "should"). Node's mapping of `Date`, `Map`, `Set` and `toJSON()` objects is written down.

### Compatibility

No schema changed and the `QueueMessage` wire format is untouched, so this is a minor bump.
Four behaviour changes need attention when upgrading:

- **Cache keys (Python and Go only).** Node's output is unchanged and is the reference. Python keys whose arguments contain non-ASCII text were previously `\uXXXX`-escaped and are now UTF-8; Go keys whose arguments contain `<`, `>`, `&`, U+2028 or U+2029 were previously escaped and are now literal. Entries cached under the old spelling are simply missed and re-computed; keys built from other arguments are byte-identical to before.
- **Python auto topic.** A Python producer that sets `event_name` without an explicit `topic` now publishes to `ClassName.methodName` (it used the event name before, e.g. `order.created` → `OrderService.create`). Consumers and broker bindings on the old topic must be updated, or the producer must pin `topic=`.
- **`traceparent`.** Carriers that Node used to accept after lower-casing, and non-`00` versions that Python and Go used to accept, are now invalid and start a new trace.
- **Kafka consumers.** A permanently failing record now blocks its partition (redelivered after the backoff) instead of being skipped.

## [1.2.0] — 2026-08-16 / entity-spec descriptions, tags and security (F-004)

### Added

- `schemas/entity-spec.schema.json`: `specVersion` const moves to `1.2.0` and the `$id` to `.../entity-spec/1.2.0.json`. New optional members — `description` (on the entity, on every field, and on every action), `tags` (entity-level, unique strings) and `security` (entity-level). `$defs/security` requires a non-empty `schemes` array and carries optional `ops`/`actions` maps of op/action name → scope-string list; `$defs/securityScheme` closes `type` to `http | apiKey` with `scheme`, `bearerFormat`, `in` and `paramName`.
- `rules/rest-conventions.md` — normative route mapping (`update` is PATCH, never PUT), component naming (`{Entity}Create` / `Update` / `Read` / `{Action}Input` / `ListResponse`, shared `Problem` and `ValidationProblem`), field-to-JSON-Schema mapping, offset and cursor pagination envelopes, filtering, RFC 9457 error placement, security requirement emission and document assembly. Binds every generator and every future HTTP adapter.
- `fixtures/entity-spec.valid-user.json` regenerated: the golden `User` gains an entity `description` and `tags`, a `security` block (one `http`/`bearer` scheme plus `ops` and `actions` scope maps), a field-level `description` on `email` and an action-level `description` on `activate` — so the new members are exercised by the parity gate rather than only by the schema.

### Changed

- `fixtures/entity-spec.invalid-missing-entity.json` moves to `specVersion: "1.2.0"`. It is a negative fixture; leaving it at `1.1.0` would have made it fail on the `specVersion` const as well, so it would no longer isolate the missing-`entity` rejection it exists to prove.

### Compatibility

Additive for readers: every new member is optional, absent keys stay absent, and every
1.1.0-era declaration emits byte-identical canonical JSON. The cache-key algorithm is
untouched, so **no cache flush is required**. The one breaking edge is the `specVersion`
const itself — IR emitted by a 1.2.0 package reads `"1.2.0"`, so a consumer pinned to the
1.1.0 schema will reject it until it upgrades. Scope strings are opaque permission strings
(`user:write`); they are not roles and carry no hierarchy, wildcards or implied containment.

## [1.1.0] — 2026-06-17 / entity-spec schema, canonical rule, fixtures (I-004 P1)

### Added

- `schemas/entity-spec.schema.json` — the EntitySpec IR wire shape (draft 2020-12): `specVersion`, `entity`, `path`, `transports`, `ops`, `pagination`, `fields`, optional `actions`. Uses `"const": true`/`"const": false` tricks so canonical-form omit-when-default flags are schema-enforced.
- `rules/entity-spec-canonical.md` — canonical JSON serialization rule (sorted keys, no whitespace, omit-when-default, snake_case→camelCase) both languages must match byte-for-byte.
- `fixtures/entity-spec.valid-user.json` — canonical-form golden User entity fixture; parity test target for Tasks 7–9.
- `fixtures/entity-spec.invalid-missing-entity.json` — golden invalid fixture (missing required `entity`).
- `fixtures/entity-spec.cases.json` — cross-language DTO validation-behavior contract for Tasks 11/12 (create/update/action payloads with expected valid/errorFields verdicts). **Note:** the originating brief named this file `entity-spec.validation-cases.json`; it was renamed to `entity-spec.cases.json` because `validation-cases.json` collides with `contracts/scripts/validate.sh`'s `*.valid*.json` glob (the substring `.valid` inside `.validation`) without satisfying its sed strip pattern, which would make the script look for a nonexistent `entity-spec.validation-cases.json.schema.json` and fail. This file is not schema-validated by `validate.sh` in either case — it holds DTO payloads, not EntitySpec objects — so the rename only affects the filename, not intended behavior.
  - **Datetime parity added post-review (still 1.1.0, unreleased on this branch):** three `datetime` cases appended — `update-datetime-with-offset-ok`, `update-datetime-naive-rejected`, `update-datetime-null-ok` — locking the ruling that `datetime` REQUIRES an explicit UTC offset in both languages (naive timestamps are ambiguous across a multi-replica deployment, E8). Node's `gen-zod` already enforces this via `z.string().datetime({ offset: true })`; Python's generator must match.
  - **Email parity added post-review (still 1.1.0, unreleased on this branch):** `rules/entity-spec-validation.md` added — defines `format: "email"` as the WHATWG HTML5 email regex (verbatim in that doc) and `type: "datetime"` as ISO 8601 with a required UTC offset, both generators MUST match byte-for-byte. Two `format: "email"` cases appended to `fixtures/entity-spec.cases.json` — `create-email-single-char-tld-ok` (`a@b.c` valid) and `create-email-no-domain-rejected` (`a@` invalid) — locking the ruling after reviewer found pydantic's `EmailStr` and zod's `.email()` diverge on `a@b.c` (pydantic accepted it, zod rejected it). Neither ecosystem's built-in email validator is used anymore; both generators now validate against the shared regex directly.
  - **P1 phase-gate fix wave (still 1.1.0, unreleased on this branch):** an independent adversarial gate review (`.superpowers/sdd/2026-08-04-entity-spec-framework-p0-p1/p1-gate-review.md`) fuzzed both generators outside the original 16-case/1-fixture envelope and found 13 confirmed divergences. All Critical/Important findings closed:
    - `rules/entity-spec-validation.md` extended with: shared `uuid`/`uri` regexes (both generators now use `.regex(...)`/`Field(pattern=...)`, never `zod.uuid()`/`.url()`/`pydantic.AnyUrl`); JSON-type strictness for `int`/`float`/`bool`/`datetime` (a JSON string is rejected for a numeric/boolean field even if numeric-looking; `datetime` rejects a non-string epoch integer; `int` keeps lax integral-float coercion, `5.0` ok / `5.5` rejected); `ref` carries the same constraints as `str`; `format`+`pattern` are now mutually exclusive (decoration-time error, both languages); list-item constraints must be threaded through, not dropped; non-integer `min`/`max` and empty `enum`/`ops`/`transports` now raise at decoration time (both languages); a hardcoded `RESERVED_WIRE_NAMES` set (pydantic `BaseModel` public attributes) is enforced at decoration time in both entity packages; `pattern` must be RE2/rust-regex compatible (no lookaround/backreferences) — gen-pydantic wraps model-build failures into a clear `ValueError` naming the field/pattern.
    - `schemas/entity-spec.schema.json`: `ops` gains `minItems: 1` (previously only `transports`/`fields`/`enum` did — an entity could declare zero operations and still validate).
    - `fixtures/entity-spec.valid-user.json` regenerated: the golden `User` fixture gained three writable fields — `score` (float, min 0, optional), `active` (bool, optional), `secretNote` (str, `writeonly`, max 100, optional) — closing the gap where the contract exercised zero `read` DTO cases and no `writeonly` field (spec §4's "read = non-writeonly" rule was previously untested by the shared contract).
    - `fixtures/entity-spec.cases.json`: 16 → 22 cases. Added `create-with-new-writable-fields-ok`, `create-score-string-rejected`, `create-active-string-rejected`, `update-birthday-epoch-rejected`, `read-valid`, `read-excludes-writeonly`.
    - Byte-parity fixes in the entity IR layer itself (not the generators): TS `??` previously passed an explicit `transports: []`/`ops: []` through unchanged while Python's `or` silently replaced it with the default — both now raise instead; TS list-item name injection now recurses at every nesting level of a list-of-list, matching Python's `FieldMarker.to_ir` (previously only the outer level was named, leaving an inner item with schema-invalid `name: ""`).

### Added (cross-language consumption, F-001/F-002)

- `metadata.service` (optional string) on `schemas/queue-message.schema.json`. Stamped by producers when a service name is configured via `SERVER_DECORATOR_SERVICE` / `configure(service=...)`. Backward compatible: absent when no service is configured; consumers that ignore it are unaffected.
- `rules/topic-naming.md` — optional 3-segment auto-topic form `service.ClassName.methodName`, used only when a service is configured. The 2-segment form remains the default.
- `fixtures/queue-message.valid-with-service.json` — golden example of a service-prefixed envelope.

This part of the bump is additive and opt-in: no existing message changes shape unless a service name is configured. The cache-key algorithm is untouched (no cache flush required).

## [1.0.0] — 2026-05-08

Initial contract release, locked alongside Phase 2 of the polyglot migration.

### Added

- `schemas/queue-message.schema.json` — wire format for messages published via `@EmitOnSuccess(useQueue=true)` / `@emit_on_success(use_queue=True)`.
- `schemas/tracking-event.schema.json` — shape of the events emitted by `@tracking` / `tracking_class`.
- `schemas/cache-entry.schema.json` — minimal schema for cache adapter entries (informational; adapters serialize as they please).
- `rules/cache-key.md` — deterministic cache-key algorithm (Decision #6). Both Node and Python implement this from the same spec.
- `rules/cache-adapter.md` — `CACHE_MISS` sentinel rule (D-B). Adapters MUST return `CACHE_MISS` for absent keys.
- `rules/topic-naming.md` — auto-topic format and override regex.
- `rules/tracking-key.md` — `Owner.method` format for tracking event keys.
- `fixtures/queue-message.*.json` — golden valid/invalid payloads.
- `fixtures/cache-key.examples.json` — input → expected key fixtures.
- `fixtures/tracking-event.examples.json` — input → expected tracking event fixtures.
- `scripts/validate.sh` — `ajv`-driven contract self-test.
