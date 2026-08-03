# Contract Changelog

All notable changes to the wire-format contracts will be documented here. The format is loosely [Keep a Changelog](https://keepachangelog.com/), and the contract version follows [Semantic Versioning](https://semver.org/).

## 1.1.0 — add entity-spec schema, canonical rule, fixtures (I-004 P1)

### Added

- `schemas/entity-spec.schema.json` — the EntitySpec IR wire shape (draft 2020-12): `specVersion`, `entity`, `path`, `transports`, `ops`, `pagination`, `fields`, optional `actions`. Uses `"const": true`/`"const": false` tricks so canonical-form omit-when-default flags are schema-enforced.
- `rules/entity-spec-canonical.md` — canonical JSON serialization rule (sorted keys, no whitespace, omit-when-default, snake_case→camelCase) both languages must match byte-for-byte.
- `fixtures/entity-spec.valid-user.json` — canonical-form golden User entity fixture; parity test target for Tasks 7–9.
- `fixtures/entity-spec.invalid-missing-entity.json` — golden invalid fixture (missing required `entity`).
- `fixtures/entity-spec.cases.json` — cross-language DTO validation-behavior contract for Tasks 11/12 (create/update/action payloads with expected valid/errorFields verdicts). **Note:** the originating brief named this file `entity-spec.validation-cases.json`; it was renamed to `entity-spec.cases.json` because `validation-cases.json` collides with `contracts/scripts/validate.sh`'s `*.valid*.json` glob (the substring `.valid` inside `.validation`) without satisfying its sed strip pattern, which would make the script look for a nonexistent `entity-spec.validation-cases.json.schema.json` and fail. This file is not schema-validated by `validate.sh` in either case — it holds DTO payloads, not EntitySpec objects — so the rename only affects the filename, not intended behavior.

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
