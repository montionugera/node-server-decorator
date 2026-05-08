# Contract Changelog

All notable changes to the wire-format contracts will be documented here. The format is loosely [Keep a Changelog](https://keepachangelog.com/), and the contract version follows [Semantic Versioning](https://semver.org/).

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
