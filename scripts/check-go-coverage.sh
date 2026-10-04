#!/usr/bin/env bash
# Go coverage gate: runs the ./go/... unit tests with a coverprofile and fails
# if any package's statement coverage is below its threshold.
#
# Usage (repo root or anywhere): bash scripts/check-go-coverage.sh
#
# Thresholds are a ratchet: each is the achieved coverage rounded DOWN to a
# whole percent. Raise them as tests are added; never lower one to make a PR
# pass. The target for every package is 90. Four `package main` entries do NOT
# meet it yet; they are listed above the table with the reason for each.
#
# Go measures statements, not lines; the numbers are covered/total statements
# computed from the coverprofile. Packages with no statements do not appear in
# the profile and need no entry. A package that appears in the profile without
# an entry here fails the gate, so new packages must declare a threshold.
#
# The go/adapter/gin submodule is a separate module (its own go.mod), so
# ./go/... does not reach it and it has NO coverage threshold. Its tests still
# run, without a coverage gate, in ci-go.yml and scripts/contributor-check.sh
# (`cd go/adapter/gin && go test ./...`).
#
# Env:
#   GO_COVERAGE_TEST_FLAGS  extra `go test` flags. Unset, it defaults to nothing,
#                           except on macOS with a Go toolchain older than
#                           1.22.9 / 1.23.3, where it defaults to
#                           -ldflags=-linkmode=external (see below). Set it,
#                           even to an empty string, to override that default.
#   GO_COVERAGE_DIR        where to write the coverprofile (default: a temp dir)
set -euo pipefail

# Four entries are below the 90 target. All four are thin `package main`
# wrappers whose logic lives in, and is tested by, the library packages
# (go/entity, go/dto, go/openapi); three of them feed the cross-language
# byte-parity checks, where the emitted bytes are what is verified:
#   go/cmd/gen-dto                   86  a test runs main for the stdout, file
#     and directory outputs; the uncovered statements are the two log.Fatalf
#     error branches, which exit the process.
#   go/cmd/gen-entity-spec           0   untested main: flag parse + one
#     entity.WriteFiles call. Its output is checked by the go:generate drift
#     test instead. The entry exists only so the package is declared; raise it
#     if a test of main is ever added.
#   go/internal/example/emitfixture  60  and
#   go/internal/example/emitopenapi  72  fixture emitters for the parity
#     scripts. A test runs main and checks the bytes, covering 3 of 5
#     statements (emitfixture) and 8 of 11 (emitopenapi, which also reads
#     contracts/VERSION); the rest are log.Fatal error branches that exit the
#     process, so these are the ceilings without restructuring, not ratchet
#     steps.
#
# package (relative to the module root)   minimum statement coverage, whole %
THRESHOLDS='
go/adapter/gqlloader                  100
go/cmd/gen-dto                        86
go/cmd/gen-entity-spec                0
go/core                               100
go/core/coalesce                      98
go/core/distlock                      100
go/core/tracing                       92
go/dto                                97
go/entity                             98
go/http                               100
go/internal/example/emitfixture       60
go/internal/example/emitopenapi       72
go/openapi                            99
go/sse                                100
'

cd "$(dirname "$0")/.."

if [ -n "${GO_COVERAGE_DIR:-}" ]; then
  out_dir="$GO_COVERAGE_DIR"
  mkdir -p "$out_dir"
else
  out_dir="$(mktemp -d)"
  trap 'rm -rf "$out_dir"' EXIT
fi
profile="$out_dir/go-coverage.out"

module="$(go list -m)"

# Go's internal linker did not emit an LC_UUID load command before 1.22.9 /
# 1.23.3, and the dyld in macOS 15+ aborts such a binary at launch ("missing
# LC_UUID load command", signal: abort trap) when it links cgo (here: the
# net-using go/http and go/sse tests). The system linker does emit it, so on
# an affected toolchain link externally. Coverage numbers are unaffected. CI
# (Linux) never takes this branch.
if [ -z "${GO_COVERAGE_TEST_FLAGS+set}" ] && [ "$(uname -s)" = Darwin ]; then
  case "$(go env GOVERSION)" in
    go1.?|go1.?.*|go1.1[0-9]|go1.1[0-9].*|go1.2[01]|go1.2[01].*|go1.22|go1.22.[0-8]|go1.23|go1.23.[0-2]|go1.22rc*|go1.23rc*)
      GO_COVERAGE_TEST_FLAGS=-ldflags=-linkmode=external
      echo "note: $(go env GOVERSION) on macOS: linking test binaries externally (missing LC_UUID workaround)" >&2
      ;;
  esac
fi

# shellcheck disable=SC2086  # flags are intentionally word-split
go test ${GO_COVERAGE_TEST_FLAGS:-} -covermode=set -coverprofile="$profile" ./go/...

echo
echo "Go statement coverage per package (threshold is the minimum):"

printf '%s\n' "$THRESHOLDS" > "$out_dir/thresholds.txt"

awk -v module="$module" '
# first file: the threshold table
FNR == NR {
  if (NF == 2) min[$1] = $2
  next
}
/^mode:/ { next }
{
  # <import path>/<file>.go:<start>,<end> <statements> <count>
  block = $1
  pkg = block
  sub(/:[^:]*$/, "", pkg)
  sub(/\/[^\/]*$/, "", pkg)
  pkg = substr(pkg, length(module) + 2)
  if (!(block in seen)) {
    seen[block] = 1
    total[pkg] += $2
  }
  if ($3 > 0 && !(block in hit)) {
    hit[block] = 1
    covered[pkg] += $2
  }
}
END {
  failed = 0
  for (pkg in total) {
    pct = 100 * covered[pkg] / total[pkg]
    if (!(pkg in min)) {
      printf "FAIL  %-34s %6.1f%%  no threshold declared in scripts/check-go-coverage.sh\n", pkg, pct | "sort"
      failed = 1
    } else if (covered[pkg] * 100 < min[pkg] * total[pkg]) {
      # integer comparison: no float rounding at the boundary
      printf "FAIL  %-34s %6.1f%%  below threshold %d%%\n", pkg, pct, min[pkg] | "sort"
      failed = 1
    } else {
      printf "ok    %-34s %6.1f%%  threshold %d%%\n", pkg, pct, min[pkg] | "sort"
    }
  }
  for (pkg in min) {
    if (!(pkg in total)) {
      printf "FAIL  %-34s    n/a   has a threshold but no coverage data (package removed or renamed?)\n", pkg | "sort"
      failed = 1
    }
  }
  close("sort")
  if (failed) {
    print "\nGo coverage gate FAILED."
    exit 1
  }
  print "\nGo coverage gate passed."
}
' "$out_dir/thresholds.txt" "$profile"
