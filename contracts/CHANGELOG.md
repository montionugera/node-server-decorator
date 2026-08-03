# Contract Changelog

All notable changes to the wire-format contracts will be documented here. The format is loosely [Keep a Changelog](https://keepachangelog.com/), and the contract version follows [Semantic Versioning](https://semver.org/).

## 1.1.0 — add entity-spec schema, canonical rule, fixtures (I-004 P1)

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
