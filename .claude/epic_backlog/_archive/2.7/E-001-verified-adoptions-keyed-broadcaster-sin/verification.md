---
title: "Verified adoptions: keyed broadcaster, single-flight and limiter, Postgres lock manager, emit-on-success"
id: E-001
---

# How we will know E-001 works

Prose for humans. `scripts/epic-check.sh` implements these assertions; the
toolkit never parses this file.

## Assertions

1. On `release/2.7`, with all three slices shipped: `cd node && pnpm -r test:unit`,
   `cd python && bash scripts/check.sh`, `go test ./go/...`,
   `bash scripts/check-go-coverage.sh`, `cd nim && nimble test`,
   `bash contracts/scripts/validate.sh`, `bash scripts/check-versions.sh`,
   `bash scripts/check-entity-parity.sh` and `bash scripts/check-openapi-parity.sh`
   all exit 0, and every coverage gate still passes.
2. `go list -deps ./go/core/... ./go/sse/...` lists no module outside the standard library
   (the pgx adapter did not leak into the core module).
3. The nested pgx adapter module builds and its unit tests pass on its own
   (`cd go/adapter/pgxlock && go test ./...`).
4. `contracts/VERSION` is unchanged at 1.3.0.
5. Each of the five adoption worktrees builds and passes the local check named in the
   spec, with no test that was green on its baseline now red.
6. No adoption branch and no release branch has been pushed.
