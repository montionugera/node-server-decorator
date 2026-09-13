# Nim lane: fourth language — entity IR producer + OpenAPI emitter in Nim — research notes

Ecosystem survey done 2026-09-13 (web research; last-push dates and stars via GitHub API that day).
A recent push is not proof of a recent release. Nothing here is prototyped yet.

## Recommendation

Mirror F-005's scope: a Nim `entity` IR producer + OpenAPI emitter, byte-identical to
`contracts/fixtures/entity-spec.valid-user.json` / `openapi.valid-user.json`. Defer
cache / queue / tracking decorators — the Nim runtime ecosystem has hard gaps there.

## Schema / codegen side (viable)

| Area | Library | Last push | ★ | Fit |
|---|---|---|---|---|
| JSON | `std/json` (nim-lang/Nim) | 2026-09-12 | 18k | Best base. JsonNode objects keep insertion order (sort keys ourselves); floats shortest round-trip, whole floats render `1.0` (Python-style, not JS-style) |
| JSON | jsony (treeform/jsony) | 2026-05-24 | 297 | Fast; field-declaration key order; rename/skip/dump hooks |
| JSON | nim-json-serialization (status-im) | 2026-09-11 | 54 | RFC 8259 strict, JSONTestSuite; "flavors". Key-order/float docs unverified |
| JSON | canonicaljson.nim (jackhftang), RFC 8785 | 2021-01-27 | 0 | Abandoned; reference only |
| Entity markers | `std/macros` `hasCustomPragma` / `getCustomPragmaVal` | stdlib | — | Enough for readonly/writeonly field pragmas |
| Pragma prior art | norm (moigagoo/norm) | 2026-08-05 | 415 | `{.pk.}` etc. (`{.ro.}` unverified) |
| Pragma prior art | debby (treeform/debby), ormin (Araq/ormin) | 2026-03 / 2026-09 | 87 / 198 | ORM pragma patterns |
| Validation | schematic (cryo2010/nim-schematic) | 2026-08-28 | 3 | Zod-inspired (Infer, pick/omit/partial); very new |
| Validation | nimbit (kutruff/nimbit) | 2023 | — | Zod-style, stale |
| JSON Schema | jschema (Niminem/jschema) | 2026-07-10 | 4 | Draft 2020-12 validator + builder; no type→schema derivation |
| JSON Schema | NimJsonSchemaImporter (Nycto) | 2026-09-09 | 10 | Reverse direction (schema → Nim types) |
| OpenAPI | sarcophagus (elcritch/sarcophagus) | 2026-09-10 | 22 | Only code-first option: swagger.json from typed Mummy routes; OpenAPI version unverified |
| OpenAPI | openapi (disruptek), nimbase | 2026-04 / 2026-08 | 71 / 2 | Spec → client codegen; wrong direction |
| Web | Jester, Prologue, HappyX, Mummy | 2026 | 1.6k / 1.35k / 665 / 339 | Prologue serves a hand-written openapi.json only; no code-first 3.1 anywhere |

## Runtime side (large gaps)

| Area | Library | Last push | ★ | Async | Fit |
|---|---|---|---|---|---|
| Decorators | `std/macros` pragma macros (`{.cached.}`, `{.traced.}`, `{.emitOnSuccess.}`) | stdlib | — | either | Natural mapping; roll our own |
| Decorators | memo (andreaferretti/memo) | 2022-02-25 | 83 | sync | Proves the pattern; no adapter/TTL |
| In-mem cache | nim-minilru (status-im) | 2026-08-24 | 8 | — | Maintained LRU, no TTL |
| Redis | redis (nim-lang/redis) | 2026-08-13 | 131 | asyncdispatch | Official; typed commands only, **no Streams (XADD/XREADGROUP)** |
| Redis | redpool (zedeus), ready (guzba) | 2026-06 / 2024-01 | 14 / 47 | asyncdispatch / sync | ready has raw `command` → hand-roll streams, but sync + stale |
| RabbitMQ | asyncrabbitmq (Q-Master/rabbitmq.nim) | 2026-05-12 | 10 | asyncdispatch | Only maintained async client; single maintainer |
| Kafka | nimrdkafka (librdkafka bindings) | 2023-12-28 | 10 | — | Stale; nothing else alive |
| BullMQ | — | — | — | — | None |
| Event emitter | emitter (supranim), eventemitter (al-bimani) | 2026-08 / 2025-10 | 7 / 12 | sync | Trivial to own |
| Metrics | nim-metrics (status-im) | 2026-08-24 | 46 | chronos | Maintained Prometheus client |
| Logging | nim-chronicles (status-im) | 2026-09-11 | — | — | Solid |
| OpenTelemetry | — | — | — | — | No SDK; would need our own OTLP exporter |

## Risks / open questions

- **Byte-identical output is ours to own.** No maintained canonical-JSON lib: explicit key sort +
  float formatting, verified against the golden fixtures (same discipline as F-005).
- **Async split:** stdlib `asyncdispatch` (redis, rabbitmq) vs `chronos` (status-im libs) —
  incompatible event loops. Irrelevant for an IR/OpenAPI-only lane; decisive if runtime decorators follow.
- **Interop scenarios run over Redis Streams** — a Nim runtime port would need an in-house Streams layer first.
- **Low bus factor:** most fits are <50★, single maintainer. Pin or vendor; prefer stdlib-only for the IR lane (as Go did).
- Open: generation mechanism — compile-time macro over object pragmas vs builder API (Go chose builder after a struct-tag prototype, see I-006/F-005).
- Open: CI toolchain pin (Nim version), nimble vs atlas, and lockstep versioning for a Nim package.
