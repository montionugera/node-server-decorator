#!/usr/bin/env bash
# Gate 1 (psrw ship): fast local checks, a few minutes at most. Run from anywhere; exits non-zero on any failure.
set -u
cd "$(dirname "$0")/.."
export PATH="$HOME/.nimble/bin:$HOME/.cargo/bin:$PATH"
source scripts/lib-stages.sh
shell_tests(){ local t rc=0; for t in scripts/tests/*.test.sh; do bash "$t" >/dev/null 2>&1 || { echo "failed: $t"; rc=1; }; done; return "$rc"; }
# core's rate-limit and distributed-lock specs are timing-based and fail on a loaded machine (seen: 3 failures in a
# full run, 23/23 green when re-run alone, load average 238 on a shared dev machine), so a red unit run is
# retried up to twice; a real failure fails every attempt.
node_unit(){
  cd node && { [ -d node_modules ] || pnpm install --frozen-lockfile; } && pnpm -r run build || return 1
  local attempt
  for attempt in 1 2 3; do
    pnpm -r test:unit && return 0
    echo "node unit tests failed on attempt $attempt of 3 (timing-sensitive specs are retried)"
  done
  return 1
}
stage "shell tests (scripts/tests)" shell_tests
if command -v actionlint >/dev/null; then stage "actionlint" actionlint .github/workflows/*.yml; else skip actionlint "not installed"; fi
stage "version lockstep" bash scripts/check-versions.sh
if command -v pnpm >/dev/null; then stage "node build + unit tests" node_unit; else skip "node build + unit tests" "pnpm not installed"; fi
finish precheck
