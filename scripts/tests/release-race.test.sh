#!/usr/bin/env bash
# Run: bash scripts/tests/release-race.test.sh
# Two merges land back to back; run A (merge 1) releases while run B (merge 2) waits in the queue.
# Uses the REAL publish-job step bodies from ci-node.yml; "origin" is a local bare repo, nothing is published.
set -uo pipefail
R="$(cd "$(dirname "$0")/../.." && pwd)"; WF="$R/.github/workflows/ci-node.yml"; T=$(mktemp -d); trap 'rm -rf "$T"' EXIT; fail=0
check(){ if [ "$2" = "$3" ]; then echo "ok - $1"; else echo "FAIL - $1: got '$2', want '$3'"; fail=1; fi; }
command -v ruby >/dev/null || { echo "FAIL - this test needs ruby"; exit 1; }
run_of(){ ruby -ryaml -e 's=YAML.load_file(ARGV[0])["jobs"]["publish"]["steps"].find{|x|x["name"]==ARGV[1]} or abort "no step: #{ARGV[1]}"; puts s["run"]' "$WF" "$1"; }
step(){ bash -e -c "$(run_of "$1")"; }
export GITHUB_OUTPUT="$T/out"; : > "$GITHUB_OUTPUT"; mkdir "$T/bin"; printf '#!/bin/sh\nexit 0\n' > "$T/bin/sleep"; chmod +x "$T/bin/sleep"
cfg(){ git config user.email t@t; git config user.name t; git config commit.gpgsign false; }
git init -q --bare "$T/origin.git"; git clone -q "$T/origin.git" "$T/seed" 2>/dev/null; cd "$T/seed" || exit 1; cfg; git checkout -qb main
cp -R "$R/scripts" .; mkdir -p node/packages/core python/packages/p/src/p go/entity go/adapter/gin nim rust
echo '{"version":"1.0.0"}' > node/packages/core/package.json; : > node/pnpm-lock.yaml; : > python/packages/p/pyproject.toml; : > python/packages/p/src/p/_version.py
: > python/uv.lock; : > go/entity/version.go; : > go/adapter/gin/go.mod; : > nim/server_decorator.nimble; : > rust/Cargo.toml; : > rust/Cargo.lock; printf '# Changelog\n' > CHANGELOG.md
git add -A; git commit -qm 'feat: base'; git tag v1.0.0; git push -q origin main v1.0.0 2>/dev/null
echo 1 > one.txt; git add -A; git commit -qm 'feat: one (#1)'; git push -q origin main; m1=$(git rev-parse HEAD)
clone(){ git clone -q "$T/origin.git" "$1" 2>/dev/null; (cd "$1" && cfg && git checkout -q --detach "$2"); }
clone "$T/A" "$m1"                                                # run A starts at merge 1
echo 2 > two.txt; git add -A; git commit -qm 'feat: two (#2)'; git push -q origin main; m2=$(git rev-parse HEAD)
clone "$T/B0" "$m2"                                               # run B as it checks out today: before A has tagged
cd "$T/A" || exit 1
check "A: merge 1 alone is a release" "$(step 'Decide release or repair' 2>&1 | tail -1)" "action=release"
echo '{"version":"1.0.1"}' > node/packages/core/package.json     # stands in for bump-version.sh
step 'Write CHANGELOG entry' >/dev/null 2>&1; PATH="$T/bin:$PATH" step 'Commit version bump' >"$T/a.log" 2>&1; rc=$?; [ "$rc" = 0 ] || tail -5 "$T/a.log"
check "A: bump pushed after rebasing onto merge 2" "$rc:$(git -C "$T/origin.git" log main --format=%s | head -3 | tr '\n' '|')" "0:chore: bump patch version [skip ci]|feat: two (#2)|feat: one (#1)|"
step 'Tag release' >/dev/null 2>&1
check "A: tag v1.0.1 contains merge 2" "$(git -C "$T/origin.git" merge-base --is-ancestor "$m2" v1.0.1 && echo yes)" "yes"
# Reproduction of the old failure: B decided release from a checkout that predates A's tag.
cd "$T/B0" || exit 1
echo '{"version":"1.0.1"}' > node/packages/core/package.json; step 'Write CHANGELOG entry' >/dev/null 2>&1
PATH="$T/bin:$PATH" step 'Commit version bump' >/dev/null 2>&1; rc=$?
check "B without tags (old behaviour) fails at the rebase" "$([ "$rc" -ne 0 ] && echo red)" "red"
git rebase --abort 2>/dev/null
# The fix: B starts after A (queued run), so its checkout carries A's tag.
clone "$T/B" "$m2"; cd "$T/B" || exit 1; : > "$GITHUB_OUTPUT"
out=$(step 'Decide release or repair' 2>&1); rc=$?
check "B (queued, after A tagged): decide succeeds with action=none" "$rc:$(cat "$GITHUB_OUTPUT")" "0:action=none"
check "B: the notice step is selected for none" "$(ruby -ryaml -e 'puts YAML.load_file(ARGV[0])["jobs"]["publish"]["steps"].find{|x|x["name"]=="Nothing to release"}["if"]' "$WF")" "steps.decide.outputs.action == 'none'"
check "origin ends with exactly one new release tag" "$(git -C "$T/origin.git" tag --list 'v*' | tr '\n' ' ')" "v1.0.0 v1.0.1 "
exit "$fail"
