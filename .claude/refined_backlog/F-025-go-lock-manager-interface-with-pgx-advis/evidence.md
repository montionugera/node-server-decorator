# F-025 local evidence: pgxlock against a real PostgreSQL

Recorded 2026-10-05 on the maintainer Mac (darwin/amd64). The integration test is
local-only by owner decision (spec, design notes); no CI job runs it.

## Database

A throwaway container, removed afterwards. No existing database or cluster was used.

```bash
docker run --rm -d --name f025-pgxlock-it -p 127.0.0.1:55432:5432 \
  -e POSTGRES_PASSWORD=f025test postgres:16
export PGXLOCK_TEST_DATABASE_URL='postgres://postgres:f025test@127.0.0.1:55432/postgres?sslmode=disable'
export GOFLAGS=-ldflags=-linkmode=external   # this Mac only
```

## Run 1: committed module (pgx v5.7.4, go1.22.4)

```bash
cd go/adapter/pgxlock
go test -tags integration -race -count=3 -v -coverprofile=<tmp> ./...
```

Result: exit 0, `ok ... coverage: 98.0% of statements`. 20 top-level tests per pass
(13 unit, 7 integration), all passed in each of the 3 passes (60 PASS lines, 21 of them
`TestIntegration*`). With the integration tests included, every function is at 100
percent except `poolAdapter.Acquire` (75 percent: its error return needs a failing
pool) — so all five adapter delegations run against the real pool.

Integration tests and the spec statements they prove:

| Test | Statements |
|---|---|
| `TestIntegrationHeldLockKeepsOneConnection` | 13, 21, 24 (`AcquiredConns` 1 while held, 1 after a not-acquired attempt on top, 0 after release) |
| `TestIntegrationKeyMatchesServiceSQL` | 17, 27 (service literal SQL gets `false` while held, `true` after release) |
| `TestIntegrationServiceHolderExcludesLibrary` | 17 in the other direction, 19 |
| `TestIntegrationAnotherPoolCanLockAfterRelease` | 27 |
| `TestIntegrationCancelDoesNotFreeButReleaseDoes` | 4, 23 |
| `TestIntegrationCustomPrefixIsADifferentLock` | 16 (prefix is part of the identity) |
| `TestIntegrationFailedUnlockDropsTheConnection` | 25 (session killed with `pg_terminate_backend`; pool ends at 0 connections and the lock is free) |

Without the variable the tagged tests fail with:
`PGXLOCK_TEST_DATABASE_URL is empty: set it to a throwaway PostgreSQL URL to run the integration tests`.

## Run 2: pgx v5.11.0 compatibility (the version joy-data-platform uses)

Done in a scratch copy of the module outside the repository; the committed `go.mod`
stays on v5.7.4.

```bash
go get github.com/jackc/pgx/v5@v5.11.0 && go mod tidy   # GOTOOLCHAIN unset (auto)
go version                                               # go1.25.0 darwin/amd64
go test -tags integration -race -count=1 -v ./...
```

pgx v5.11.0 raised the scratch `go.mod` to `go 1.25.0`. Result: exit 0, 20 tests passed
(7 integration), same container.

## Unit-only coverage (no Postgres)

`go test -race -coverprofile=<tmp> ./...` reports 83.7 percent raw. Every function is at
100 percent except the five adapter delegations (`poolAdapter.Acquire`,
`connAdapter.QueryRow`, `Exec`, `Release`, `Close`), which is the exclusion the spec
allows. The raw figure is below 90 because those delegations are 8 of 49 statements.
