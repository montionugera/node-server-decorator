#!/usr/bin/env bash
# Run: bash scripts/tests/release-notes.test.sh   (throwaway repo; never touches a remote)
set -uo pipefail
R="$(cd "$(dirname "$0")/../.." && pwd)"; S="$R/scripts/release-notes.sh"; T=$(mktemp -d); trap 'rm -rf "$T"' EXIT; fail=0
check(){ if [ "$2" = "$3" ]; then echo "ok - $1"; else echo "FAIL - $1: got '$2', want '$3'"; fail=1; fi; }
check "real history v2.0.20..v2.0.21" "$(cd "$R" && bash "$S" v2.0.20 v2.0.21)" "- fix(ci): publish to npmjs.com via trusted publishing instead of NPM_TOKEN (#17)"
git init -q "$T/w"; cd "$T/w" || exit 1; git config user.email t@t; git config user.name t; git config commit.gpgsign false
c(){ git commit -q --allow-empty -m "$1"; }
c 'feat: base'; git tag v1.0.0
check "empty range -> maintenance line" "$(bash "$S" v1.0.0)" "- Maintenance release"
c 'feat: one (#1)'; c 'chore: bump patch version [skip ci]'; c 'fix: two (#2)'
check "oldest first, bump commits dropped" "$(bash "$S" v1.0.0)" $'- feat: one (#1)\n- fix: two (#2)'
check "explicit end ref" "$(bash "$S" v1.0.0 HEAD~2)" "- feat: one (#1)"
bash "$S" >/dev/null 2>&1; check "missing argument -> non-zero" "$([ $? -ne 0 ] && echo nonzero)" "nonzero"
bash "$S" v0.0.0-nope >/dev/null 2>&1; check "unknown tag -> non-zero" "$([ $? -ne 0 ] && echo nonzero)" "nonzero"
exit "$fail"
