# `contracts/` — language-neutral wire format

This directory is **the source of truth** for the wire format and shared rules that both `node/` and `python/` implementations validate against. If a behavior is documented here, both implementations MUST match.

If you change anything in this directory, you almost certainly need to bump `VERSION`, update `CHANGELOG.md`, and adjust both implementations in the same PR. CI's `ci-contracts` workflow asserts that `contracts/VERSION`, `node/src/_contract.ts`, and `python/src/server_decorator/_contract.py` all agree.

## Layout

- `VERSION` — current contract semver (currently `1.0.0`).
- `CHANGELOG.md` — append-only history of contract versions.
- `schemas/*.schema.json` — JSON Schema 2020-12 definitions of wire payloads.
- `rules/*.md` — text specs of algorithms (cache key, topic naming, etc.) with examples and edge cases.
- `fixtures/*.json` — golden inputs/outputs both implementations test against.
- `scripts/validate.sh` — runs `ajv` against all schemas + fixtures.

## What's in scope

- Anything that crosses a process boundary (queue messages, event payloads — when serialized).
- Anything where two implementations must agree on a deterministic transformation (cache keys, topic naming, tracking event shape).

## What's out of scope

- Adapter-specific framing (BullMQ's job envelope, RabbitMQ exchange routing, Kafka headers). The contract proves that *one* clean payload round-trips between matched adapters. Adapter-to-adapter interop (e.g. BullMQ producer → raw Redis consumer) is a separate v2.1+ concern.
- In-process emitter calls. `globalEmitter.emit(...)` may pass rich language-native objects (Decision #7); only queue publishes must be JSON-serializable.

## Versioning

Contract version is decoupled from package version. The contract uses additive-only changes within a major version: new optional fields are fine, removing or renaming a required field is a breaking contract change requiring a major bump.

Rationale: a published `server-decorator@2.5.0` package may still target `contract@1.0.0`. If we ever need to break the wire format, the contract bumps to `2.0.0` and any package that targets it must declare so explicitly.
