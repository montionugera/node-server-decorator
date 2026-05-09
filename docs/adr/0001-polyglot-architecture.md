# ADR 0001 — Polyglot architecture: two folders, no monorepo tool

**Status:** Accepted (2026-05-05). Locked as Decision #11.

## Context

`server-decorator` originated as a Node-only library. Multiple internal services that consume its decorators (notably the `quant-api` Python service) need the same wire-format and decorator semantics in Python. We considered three structures.

## Options

1. **Two side-by-side folders (`node/`, `python/`) + a `contracts/` directory.** No monorepo tool.
2. **Monorepo tool** (Nx, Turborepo, pnpm workspace with Python plugin). Single root, language-aware orchestration.
3. **Two separate repos**, sharing the contract via a third repo or a versioned API spec.

## Decision

Option 1.

## Why

- **Decoupled CI.** Path-filtered workflows (`paths: ['node/**']`) cost effectively nothing for off-language PRs. Monorepo tools add their own CLI surface and yet-another build graph.
- **Independent dev loops.** A Node engineer running `pnpm test` doesn't need Python tooling on their machine, and vice versa. A monorepo tool would couple them.
- **Two-language scope is small.** Nx/Turborepo earn their weight at 5+ packages. With two packages, the orchestration overhead exceeds the benefit.
- **Contracts directory does the actual coordination work.** Schemas, rules, and fixtures are language-neutral. The languages need to agree on those, not on a shared task runner.
- **Two-repo split was rejected** because the contract would drift — the whole point of polyglot is that both implementations validate against the same fixtures in the same PR.

## Consequences

- Each language has its own CI workflow (`ci-node.yml`, `ci-python.yml`).
- A `contracts/` change triggers `ci-contracts.yml` and both language workflows. The interop workflow is heavier and runs on `push: main` + weekly schedule + `run-interop` PR label.
- Contributors touching `contracts/` understand they're affecting both languages.
- If the project grows to 5+ packages, revisit by re-opening this ADR.
