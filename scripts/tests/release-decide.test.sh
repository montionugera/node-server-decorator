#!/usr/bin/env bash
# Run: bash scripts/tests/release-decide.test.sh   ("origin" is a local bare repo; never touches GitHub)
set -uo pipefail
S="$(cd "$(dirname "$0")/.." && pwd)/release-decide.sh"; T=$(mktemp -d); trap 'rm -rf "$T"' EXIT; fail=0
check(){ if [ "$2" = "$3" ]; then echo "ok - $1"; else echo "FAIL - $1: got '$2', want '$3'"; fail=1; fi; }
git init -q --bare "$T/origin.git"; git clone -q "$T/origin.git" "$T/w" 2>/dev/null; cd "$T/w" || exit 1
git config user.email t@t; git config user.name t; git config commit.gpgsign false
mkdir -p node/packages/core; echo '{"version":"9.9.9"}' > node/packages/core/package.json
git add -A; git commit -qm 'feat: something (#1)'
check "normal commit -> release" "$(bash "$S" 2>&1)" "action=release"
git commit -q --allow-empty -m 'chore: bump patch version [skip ci]'
check "bump commit, no tag on origin -> repair" "$(bash "$S" 2>&1)" "action=repair"
git tag v9.9.9; git push -q origin v9.9.9
check "bump commit, tag on origin -> release" "$(bash "$S" 2>&1)" "action=release"
git remote set-url origin "$T/missing.git"
out=$(bash "$S" 2>/dev/null); rc=$?
check "unreachable origin -> fails and prints no action" "$rc:$out" "128:"
exit "$fail"
