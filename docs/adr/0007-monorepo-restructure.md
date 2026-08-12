# ADR 0007 — Monorepo workspaces for the entity-spec layer

Status: Accepted (Mont, 2026-08-04) · Supersedes: Decision #11 (2026-05-05, "two folders, no monorepo tool")

## Context
I-004 adds an entity/IR layer with generators and framework adapters — 4+ new Node
packages and 3+ new Python packages. Publishing them inside the single core package
would force every consumer to install adapters they don't use and would couple core's
semver to adapter churn.

## Decision
- `node/` becomes a pnpm workspace (`packages/*`); the existing package moves to
  `node/packages/core` keeping its published name `@montionugera/server-decorator`.
- `python/` becomes a uv workspace (virtual root, `packages/*`); the existing package
  moves to `python/packages/core` keeping PyPI name `server-decorator`.
- Lockstep semver (Decision #2) now spans ALL published packages in both languages.
- Layering (one direction): entity → depends on nothing; gen-* → entity only;
  adapters (P2+) → entity + gen-* + core.

## Consequences
- `scripts/bump-version.sh` / `check-versions.sh` walk all packages.
- CI installs at the workspace root and fans out with `pnpm -r` / per-package uv runs.
- Consumer install path for core is unchanged (same name, same dist shape).
