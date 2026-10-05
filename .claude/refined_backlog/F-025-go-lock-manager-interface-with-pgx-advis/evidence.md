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

Re-run on 2026-10-05 at commit `db3331a` (code identical to `f839b5b`, the last code
change: the deferred release in `closeAndRelease`), against PostgreSQL 16.15 in the
container above.

Unit tests, no database:

```bash
cd go/adapter/pgxlock
go vet ./...                 # exit 0, no output
go test -race -cover ./...   # exit 0
```

```
ok  	github.com/montionugera/node-server-decorator/v2/go/adapter/pgxlock	1.907s	coverage: 86.2% of statements
```

`go test -race -count=1 -v ./...` (same suite, verbose): exit 0, 17 `--- PASS`, 0 FAIL.

Integration, real PostgreSQL:

```bash
go vet -tags integration ./...                    # exit 0, no output
go test -tags integration -race -count=1 -v ./... # exit 0
```

Output, `--- `/`PASS`/`ok` lines only (24 `--- PASS`: 7 integration + 17 unit; 0 FAIL, 0 SKIP):

```
--- PASS: TestIntegrationHeldLockKeepsOneConnection (0.05s)
--- PASS: TestIntegrationKeyMatchesServiceSQL (0.04s)
--- PASS: TestIntegrationServiceHolderExcludesLibrary (0.04s)
--- PASS: TestIntegrationAnotherPoolCanLockAfterRelease (0.04s)
--- PASS: TestIntegrationCancelDoesNotFreeButReleaseDoes (0.04s)
--- PASS: TestIntegrationCustomPrefixIsADifferentLock (0.04s)
--- PASS: TestIntegrationFailedUnlockDropsTheConnection (0.07s)
--- PASS: TestNilPoolReturnsErrNilPool (0.00s)
--- PASS: TestNewWiresTheRealPool (0.00s)
--- PASS: TestDefaultsAndOptions (0.00s)
--- PASS: TestNonPositiveTimeoutsKeepTheDefault (0.00s)
--- PASS: TestAcquireSendsExactSQLWithPrefixedKey (0.00s)
--- PASS: TestAcquireTimeoutCoversLeaseAndQuery (0.00s)
--- PASS: TestCallerDeadlineAndCancelStillWin (0.00s)
--- PASS: TestLeaseFailureIsWrapped (0.00s)
--- PASS: TestExhaustedPoolReportsDeadlineExceeded (0.02s)
--- PASS: TestNotAcquiredReturnsConnectionAtOnce (0.00s)
--- PASS: TestLockQueryErrorClosesConnection (0.00s)
--- PASS: TestReleaseIgnoresCallerContext (0.00s)
--- PASS: TestReleaseTwiceReturnsConnectionOnce (0.00s)
--- PASS: TestUnlockErrorClosesConnectionBeforeRelease (0.00s)
--- PASS: TestPanicInLockQueryStillDropsTheConnection (0.00s)
--- PASS: TestPanicInUnlockStillDropsTheConnection (0.00s)
--- PASS: TestPanicInCloseStillReleasesTheConnectionOnce (0.00s)
PASS
ok  	github.com/montionugera/node-server-decorator/v2/go/adapter/pgxlock	2.571s
```

No combined unit-plus-integration coverage figure was taken in this re-run; the
98.0 percent figure quoted in an earlier version of this file predates the review fixes
and is withdrawn.

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

**Status: run on 2026-10-05 against the code at commit `9b493c0`, exit 0.** It was run in a
scratch copy of the module outside the repository; the committed `go.mod` stays on v5.7.4.
Database: a throwaway `postgres:16` container on 127.0.0.1:55433, removed afterwards.

```bash
cp -R go/adapter/pgxlock <scratch>/pgxlock-v511
go -C <scratch>/pgxlock-v511 get github.com/jackc/pgx/v5@v5.11.0
go -C <scratch>/pgxlock-v511 version      # go version go1.25.0 darwin/amd64
PGXLOCK_TEST_DATABASE_URL='postgres://postgres:...@127.0.0.1:55433/postgres?sslmode=disable' \
  go -C <scratch>/pgxlock-v511 test -race -tags integration -count=1 -v ./...
```

pgx v5.11.0 raised the scratch `go.mod` to `go 1.25.0` and `require github.com/jackc/pgx/v5
v5.11.0`, so it needs the Go 1.25 toolchain (the committed module builds with Go 1.22).

Output (exit code 0; 25 `--- PASS` lines including subtests, 0 `--- FAIL`, 0 `--- SKIP`):

```text
--- PASS: TestIntegrationHeldLockKeepsOneConnection (0.06s)
--- PASS: TestIntegrationKeyMatchesServiceSQL (0.06s)
--- PASS: TestIntegrationServiceHolderExcludesLibrary (0.05s)
--- PASS: TestIntegrationAnotherPoolCanLockAfterRelease (0.05s)
--- PASS: TestIntegrationCancelDoesNotFreeButReleaseDoes (0.05s)
--- PASS: TestIntegrationCustomPrefixIsADifferentLock (0.04s)
--- PASS: TestIntegrationFailedUnlockDropsTheConnection (0.07s)
PASS
ok  	github.com/montionugera/node-server-decorator/v2/go/adapter/pgxlock	2.736s
```

This run includes the panic guards, the ignored non-positive timeouts and the deferred
release in `closeAndRelease`. An earlier v5.11.0 run predated those changes and is
superseded by this one.

## Unit-only coverage (no Postgres)

Command and raw result (commit `db3331a`):

```bash
cd go/adapter/pgxlock
go test -race -cover -coverprofile=<tmp> ./...
# ok  ...  coverage: 86.2% of statements
go tool cover -func=<tmp>
```

```
pgxlock.go:45:	Acquire			0.0%
pgxlock.go:55:	QueryRow		0.0%
pgxlock.go:59:	Exec			0.0%
pgxlock.go:63:	Release			0.0%
pgxlock.go:65:	Close			0.0%
pgxlock.go:79:	New			100.0%
pgxlock.go:95:	WithKeyPrefix		100.0%
pgxlock.go:101:	WithAcquireTimeout	100.0%
pgxlock.go:115:	WithUnlockTimeout	100.0%
pgxlock.go:123:	noopRelease		0.0%
pgxlock.go:131:	AcquireLock		100.0%
pgxlock.go:175:	unlock			100.0%
pgxlock.go:195:	closeAndRelease		100.0%
total:			(statements)		86.2%
```

(`noopRelease` has an empty body, zero statements; the tool prints 0.0% for it.)

The raw figure, **86.2 percent (50 of 58 statements), is below 90**. The acceptance
line "reports at least 90 percent" is therefore NOT met by the raw command output.

Counted from the coverprofile blocks: the 8 uncovered statements are all in
`pgxlock.go` lines 45 to 65, the `pgxpool` wrapper methods the spec names
(`poolAdapter.Acquire` 4 statements; `connAdapter.QueryRow`, `Exec`, `Release`, `Close`
1 each). Excluding exactly those, **50 of 50 remaining statements are covered (100
percent)**. The 90 percent target is met only through the exclusion clause in spec
sections 2b and 5, not by the number the command prints. Note that `poolAdapter.Acquire`
is a 4-statement delegation with an error branch, not a single line. Run 1 shows all
seven integration tests passing against a real pool, which exercises those wrappers,
but no coverage figure was taken for that run.
