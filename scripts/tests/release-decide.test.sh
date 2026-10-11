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
check "bump commit that is already tagged (manual re-run) -> none" "$(bash "$S" 2>&1)" "action=none"
git remote set-url origin "$T/missing.git"
out=$(bash "$S" 2>/dev/null); rc=$?
check "unreachable origin -> fails and prints no action" "$rc:$out" "128:"
mkdir -p .claude/refined_backlog; echo x > .claude/refined_backlog/a.md; echo '{}' > .release.json
git add -A; git commit -qm 'chore(release): finalize 9.9 cleanup on main'
check "only .claude/ and .release.json changed since the last tag -> none" "$(bash "$S" 2>&1)" "action=none"
mkdir -p src/.claude; echo x > src/.claude/b.md; git add -A; git commit -qm 'fix: nested .claude is real code'
check "a nested .claude/ path is not exempt -> release" "$(bash "$S" 2>&1)" "action=release"
git reset -q --hard HEAD~1; echo y >> .claude/refined_backlog/a.md; echo node > node/x.ts
git add -A; git commit -qm 'fix: mixed (#2)'
check ".claude/ plus a real file since the last tag -> release" "$(bash "$S" 2>&1)" "action=release"
git reset -q --hard HEAD~1; git commit -q --allow-empty -m 'docs: empty commit'
check "empty commit since the last tag -> none" "$(bash "$S" 2>&1)" "action=none"
check "FORCE_RELEASE=true overrides none" "$(FORCE_RELEASE=true bash "$S" 2>&1)" "action=release"
git reset -q --hard HEAD~1; mkdir -p node; echo r > node/moved.ts; git add -A; git commit -qm 'fix: add file'; git tag v9.9.10
git mv node/moved.ts .claude/moved.ts; git commit -qm 'refactor: move a published file into .claude'
check "a real file renamed into .claude/ still counts -> release" "$(bash "$S" 2>&1)" "action=release"
git reset -q --hard v9.9.9; git commit -q --allow-empty -m 'x'; echo n > node/y.ts; git add -A; git commit -qm 'feat: y'
git tag v9.9.11; git reset -q --hard HEAD~1
check "HEAD contained in a newer tag (queued run behind a finished one) -> none" "$(bash "$S" 2>&1)" "action=none"
check "contained in a tag but forced -> release" "$(FORCE_RELEASE=true bash "$S" 2>&1)" "action=release"
exit "$fail"
