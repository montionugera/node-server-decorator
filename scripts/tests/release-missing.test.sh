#!/usr/bin/env bash
# Run: bash scripts/tests/release-missing.test.sh
# "Re-run all jobs" after publish tagged vX but the release job failed: decide says none (HEAD is inside vX).
# Uses the REAL workflow step/job conditions; gh is a stub that only logs, nothing touches GitHub.
set -uo pipefail
R="$(cd "$(dirname "$0")/../.." && pwd)"; WF="$R/.github/workflows/ci-node.yml"; T=$(mktemp -d); trap 'rm -rf "$T"' EXIT; fail=0
check(){ if [ "$2" = "$3" ]; then echo "ok - $1"; else echo "FAIL - $1: got '$2', want '$3'"; fail=1; fi; }
command -v ruby >/dev/null || { echo "FAIL - this test needs ruby"; exit 1; }
wf(){ ruby -ryaml -e 'w=YAML.load_file(ARGV[0]); eval(ARGV[1])' "$WF" "$1"; }
step(){ ruby -ryaml -e 's=YAML.load_file(ARGV[0])["jobs"]["publish"]["steps"].find{|x|x["name"]==ARGV[1]} or abort "no step: #{ARGV[1]}"; puts s["run"]' "$WF" "$1"; }
mkdir "$T/bin"
# gh stub: `release view` prints $GH_ASSETS (one name per line) and exits $GH_RC; stderr text from $GH_ERR.
printf '#!/bin/sh\necho "gh $*" >> "$LOG"\nif [ "$1 $2" = "release view" ]; then [ -n "$GH_ERR" ] && echo "$GH_ERR" >&2; [ "$GH_RC" = 0 ] && printf "%%s\\n" $GH_ASSETS; exit "${GH_RC:-1}"; fi\nexit 0\n' > "$T/bin/gh"; chmod +x "$T/bin/gh"
export PATH="$T/bin:$PATH" LOG="$T/log" GITHUB_OUTPUT="$T/out"
git init -q "$T/w"; cd "$T/w" || exit 1; git config user.email t@t; git config user.name t; git config commit.gpgsign false
cp -R "$R/scripts" .; git add -A; git commit -qm 'feat: x (#1)'; git commit -q --allow-empty -m 'chore: bump patch version [skip ci]'; git tag v1.0.1
body="$(step 'Check the contained tag has its GitHub Release')"
run(){ : > "$GITHUB_OUTPUT"; : > "$LOG"; out=$(bash -e -c "$body" 2>&1); rc=$?; }

GH_RC=1 GH_ERR="release not found" run
check "tag exists, no Release: step succeeds, outputs the tag, warns" "$rc:$(cat "$GITHUB_OUTPUT"):$(echo "$out" | grep -c '::warning::')" "0:tag=v1.0.1:1"
GH_RC=0 GH_ASSETS="notes.txt" run
check "Release without docs-site.tgz: still repaired" "$rc:$(cat "$GITHUB_OUTPUT")" "0:tag=v1.0.1"
GH_RC=0 GH_ASSETS="docs-site.tgz" run
check "normal none (Release has the archive): green, no output" "$rc:$(cat "$GITHUB_OUTPUT")" "0:"
check "normal none: only read the release, changed nothing" "$(grep -vc '^gh release view' "$LOG")" "0"
GH_RC=1 GH_ERR="HTTP 502: bad gateway" run
check "other gh failure: fails loudly with ::error::" "$([ "$rc" -ne 0 ] && echo nonzero):$(echo "$out" | grep -c '::error::'):$(cat "$GITHUB_OUTPUT")" "nonzero:1:"
git checkout -q --detach HEAD; git commit -q --allow-empty -m 'feat: newer (#2)'; GH_RC=1 GH_ERR="release not found" run
check "HEAD in no tag: nothing to check, no gh call" "$rc:$(cat "$GITHUB_OUTPUT"):$(wc -l < "$LOG" | tr -d ' ')" "0::0"

# Workflow wiring (real conditions, not copies).
check "step runs only when the decision is none" "$(wf 'puts w["jobs"]["publish"]["steps"].find{|x|x["name"]=="Check the contained tag has its GitHub Release"}["if"]')" "steps.decide.outputs.action == 'none'"
check "publish tag output falls back to the repaired tag" "$(wf 'puts w["jobs"]["publish"]["outputs"]["tag"]')" "\${{ steps.tag.outputs.tag || steps.missing.outputs.tag }}"
check "release job runs for a release/repair OR a tag that lacks its Release" "$(wf 'puts w["jobs"]["release"]["if"]')" "needs.publish.outputs.action != 'none' || needs.publish.outputs.tag != ''"
check "smoke job is still skipped on none" "$(wf 'puts w["jobs"]["smoke"]["if"]')" "needs.publish.outputs.action != 'none'"
# Every publishing/bumping/tagging step in publish keeps a skip gate against none.
check "no publish-job step except the none-only ones runs on none" "$(wf 'puts w["jobs"]["publish"]["steps"].select{|s| s["run"].to_s=~/publish|bump|git push|git tag|npm|cargo/ || s["uses"].to_s=~/pypi|crates|setup-uv/}.reject{|s| s["if"].to_s=~/action [!=]= .(none|release|repair)./ || s["if"].to_s=~/needs/}.map{|s|s["name"]||s["uses"]}.inspect')" "[]"
exit "$fail"
