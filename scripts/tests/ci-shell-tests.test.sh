#!/usr/bin/env bash
# Run: bash scripts/tests/ci-shell-tests.test.sh   (structural: the PR workflow runs every scripts/tests/*.test.sh)
set -uo pipefail
R="$(cd "$(dirname "$0")/../.." && pwd)"; WF="$R/.github/workflows/ci-scripts.yml"; fail=0
check(){ if [ "$2" = "$3" ]; then echo "ok - $1"; else echo "FAIL - $1: got '$2', want '$3'"; fail=1; fi; }
[ -f "$WF" ] || { echo "FAIL - $WF is missing"; exit 1; }
y(){ ruby -ryaml -e "w=YAML.load_file(ARGV[0]); $1" "$WF"; }
check "triggers on pull_request" "$(y 'puts w[true].key?("pull_request")')" "true"
check "triggers on scripts/**" "$(y 'puts w[true]["pull_request"]["paths"].include?("scripts/**")')" "true"
check "pull_request paths cover every workflow file" "$(y 'puts w[true]["pull_request"]["paths"].include?(".github/workflows/**")')" "true"
check "push paths cover every workflow file" "$(y 'puts w[true]["push"]["paths"].include?(".github/workflows/**")')" "true"
check "push paths still cover scripts/**" "$(y 'puts w[true]["push"]["paths"].include?("scripts/**")')" "true"
check "top-level permissions are read-only" "$(y 'puts w["permissions"].inspect')" '{"contents"=>"read"}'
check "main runs are not cancelled" "$(y 'puts w["concurrency"]["cancel-in-progress"]')" "\${{ github.ref != 'refs/heads/main' }}"
body="$(y 'puts w["jobs"]["shell-tests"]["steps"].map{|s| s["run"]}.compact.join("\n")')"
check "a step loops over scripts/tests/*.test.sh" "$(echo "$body" | grep -c 'scripts/tests/\*\.test\.sh')" "1"
check "the loop fails the job when any test fails" "$(echo "$body" | grep -c 'exit "\$fail"\|exit 1')" "1"
check "SETUP.md no longer says not run in CI" "$(grep -c 'not run in CI' "$R/.github/SETUP.md")" "0"
exit "$fail"
