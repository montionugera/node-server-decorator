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
git tag v1.0.1
H=('fix: say "hi" (#1)' "fix: it's (#2)" 'fix: `touch PWNED` (#3)' 'fix: $(touch PWNED) (#4)' 'fix: $HOME and ${HOME} (#5)')
for m in "${H[@]}"; do c "$m"; done
want=$(printf -- '- %s\n' "${H[@]}"); want=${want%$'\n'}
check "hostile titles are output byte-for-byte" "$(bash "$S" v1.0.1)" "$want"
check "hostile titles are never executed (no PWNED file)" "$(find "$T" -name 'PWNED*' | wc -l | tr -d ' ')" "0"
exit "$fail"
