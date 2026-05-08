# ADR 0002 — Lockstep semver across both packages

**Status:** Accepted (2026-05-05). Locked as Decision #2.

## Context

We ship two packages from one repo (`server-decorator` on npm and PyPI). They could version independently or together. A choice now influences release cadence, PR shape, and what "v2.0.0" means.

## Options

1. **Lockstep semver.** One tag (`v1.2.3`), both packages publish at the same version regardless of which one actually changed.
2. **Per-language tags.** `node@1.2.3` and `python@1.0.0` decoupled; each release bumps only the language that changed.
3. **Lockstep MAJOR, per-language MINOR/PATCH.** Hybrid — both at v2.x but `node@2.5.1` can ship while Python stays at `python@2.0.3`.

## Decision

Option 1 — strict lockstep.

## Why

- **Mental model is simple.** "We are at v2.0.0" answers without qualification.
- **Tag pushes are atomic.** One CI workflow per language, both gated on the same tag. A successful publish means both packages are live.
- **Cross-language breaking changes don't have a version-coordination problem.** When the contract bumps, both languages bump.
- **The "patch in one language only" cost is low** — a patch bump in the other language is free; npm and PyPI don't charge for unchanged version numbers.

## Consequences

- A Node-only patch ships as a no-op patch on the Python side and vice versa. This is acceptable.
- The first release after the polyglot migration is v2.0.0 — Node consumers get the breaking changes (cache key, eventemitter3 swap), Python consumers get a fresh package at the same version for symmetry.
- `scripts/check-versions.sh` is enforced in CI to prevent the two `package.json` / `pyproject.toml` files from drifting.
- Revisit only via a new ADR. Trigger: 3+ language-specific patches in a 30-day window indicates the lockstep cost is now exceeding the simplicity benefit.
