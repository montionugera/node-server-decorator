#!/usr/bin/env bash
# Run: bash scripts/tests/gates.test.sh   (stage runner behind scripts/precheck.sh and scripts/integration.sh; stub stages only)
set -uo pipefail
R="$(cd "$(dirname "$0")/../.." && pwd)"; fail=0
check(){ if [ "$2" = "$3" ]; then echo "ok - $1"; else echo "FAIL - $1: got '$2', want '$3'"; fail=1; fi; }
for f in precheck integration; do
  check "$f.sh exists and is executable" "$([ -x "$R/scripts/$f.sh" ] && echo yes)" "yes"
done
check "integration.sh runs precheck.sh" "$(grep -c 'precheck.sh' "$R/scripts/integration.sh")" "1"
run(){ bash -c 'set -u; source "$1"; shift; eval "$*"; finish gate' _ "$R/scripts/lib-stages.sh" "$@"; }
out=$(run 'stage a true; stage b true'); rc=$?
check "all stages pass -> exit 0 and one-line summary" "$rc:$(echo "$out" | tail -1 | sed 's/ in [0-9]*s$//')" "0:gate: 2 passed, 0 failed, 0 skipped"
out=$(run 'stage a true; stage b false; stage c true'); rc=$?
check "a failing stage -> non-zero, later stages still run, failure named" "$rc:$(echo "$out" | tail -1 | sed 's/ in [0-9]*s//')" "1:gate: 2 passed, 1 failed (b), 0 skipped"
out=$(run 'stage a true; skip docs "no docker"'); rc=$?
check "a skipped stage is reported, not counted as passed" "$rc:$(echo "$out" | tail -1 | sed 's/ in [0-9]*s//')" "0:gate: 1 passed, 0 failed, 1 skipped (docs: no docker)"
out=$(run 'stage noisy bash -c "seq 1 200; exit 3"'); rc=$?
check "failure output is bounded to the tail" "$rc:$(echo "$out" | grep -c '^[0-9]')" "1:25"
out=$(run 'stage w bash -c "echo WARN: flaky"'); rc=$?
check "a WARN line on a passing stage is shown and counted" "$rc:$(echo "$out" | grep -c '^WARN: flaky'):$(echo "$out" | tail -1 | sed 's/ in [0-9]*s//')" "0:1:gate: 1 passed, 0 failed, 0 skipped, 1 warned"
out=$(run 'stage a true; skip x y; stage b false'); check "summary is the last line and a single line" "$(echo "$out" | tail -1 | grep -c '^gate: ')" "1"
exit "$fail"
