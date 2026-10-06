---
title: "Library hardening: coverage gates, 54 bug fixes, cache-key contract 1.3.0"
id: I-025
status: idea
---

# Library hardening: coverage gates, 54 bug fixes, cache-key contract 1.3.0

> Retrospective spec. The work was done first, on branch `feature/quality-coverage-gate`
> (cut from `release/2.6` before it merged), on the owner's instruction: "perfect lib first,
> add code cov gate + fill the missing test + ensure quality then move". This spec records
> what that branch contains so it can enter release 2.7 through the normal workflow.

## Problem

Before any service adopts the library, an audit found 54 confirmed defects across the Node,
Python and Go lanes (cache keys, queue adapters, tracing, circuit breaker, batch load,
server-sent events), and no lane had a coverage gate, so regressions could land unseen.
Examples:

- Node cache keys: `Date`, `Map`, `Set` arguments all serialised as `{}` and shared one entry.
- Python `@cache`: the instance's memory address leaked into the key for some methods.
- NaN / Infinity arguments produced a key (or collided with `null`) in every lane.
- Node, Python and Go disagreed on key order and escaping for some inputs, breaking the
  byte-for-byte cross-language promise in `contracts/rules/cache-key.md`.

Full bug-by-bug table: `~/workspace/wip/server-decorator-bug-audit-2026-10-04.md`.

## Why now

Adoption pilots (message-svc, joy-data-platform) consume this branch locally. They cannot
merge until a release contains it, and Go consumers need a tag that includes the Go
cache, retry, circuit breaker and server-sent-events code.

## Sketch

Merge `feature/quality-coverage-gate` into the feature worktree for this item, on top of
release 2.7. No new code beyond resolving the merge against `main`'s version bumps.

Contents of the branch:

- Regression tests for each of the 54 defects plus fixes; 40 follow-up gaps closed.
- Coverage gates: Node (jest thresholds), Python (`--cov-fail-under` per package),
  Go (`scripts/check-go-coverage.sh`).
- Contract version 1.3.0 (`contracts/VERSION`, `_contract.ts`, `_contract.py`, CHANGELOG).
- ADR 0009: cache keys are ordered by Unicode code point (defect correction, minor bump).
- Python `@cache` receiver detection by binding, shared with `batch_load`.
- Node `stableStringify` throws for non-plain objects with no enumerable keys.

## Behaviour changes consumers must know (from `contracts/CHANGELOG.md` 1.3.0)

- Some cache keys change per language (one-time cache miss, never wrong data).
- Node: field-less non-plain objects passed to a cached method now throw a `TypeError`.
- Python auto topic, `traceparent` validation and Kafka poison-record handling changed.

## Out of scope

- New features (Go get-or-load helper, injectable clock, consumer test kit).
- Fixing the npmjs.com and PyPI publisher accounts.

## Acceptance criteria

- [ ] `cd node && pnpm -r test:unit` exits 0 with the coverage thresholds enforced.
- [ ] `cd python && bash scripts/check.sh` exits 0 with the coverage gates enforced.
- [ ] `go test ./go/...` and `bash scripts/check-go-coverage.sh` exit 0.
- [ ] `cd nim && nimble test` exits 0.
- [ ] `bash contracts/scripts/validate.sh`, `bash scripts/check-versions.sh`,
      `bash scripts/check-entity-parity.sh` and `bash scripts/check-openapi-parity.sh` exit 0.
- [ ] `contracts/VERSION` is 1.3.0 and matches `_contract.ts` and `_contract.py`.
- [ ] Package versions stay in lockstep with `main` after the merge (no downgrade).
- [ ] `docs/adr/0009-cache-key-code-point-ordering.md` exists and is linked from `DECISIONS.md`.
