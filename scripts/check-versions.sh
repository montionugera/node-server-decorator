#!/usr/bin/env bash
# Assert every published package (Node + Python) is at the same version (Decision #2, ADR 0006).
set -euo pipefail
shopt -s nullglob
cd "$(dirname "$0")/.."

versions=""
for pkg in node/packages/*/package.json; do
  v=$(node -p "require('./$pkg').version")
  versions+="$pkg=$v\n"
done
for pkg in python/packages/*/pyproject.toml; do
  v=$(grep -oE '^version\s*=\s*"[^"]+"' "$pkg" | grep -oE '"[^"]+"' | tr -d '"')
  versions+="$pkg=$v\n"
done
# _version.py is the runtime `__version__` export consumers actually read (see I1) — check
# it stays in lockstep with pyproject.toml, not just Node/Python across packages.
for v in python/packages/*/src/*/_version.py; do
  ver=$(grep -oE '^__version__\s*=\s*"[^"]+"' "$v" | grep -oE '"[^"]+"' | tr -d '"')
  versions+="$v=$ver\n"
done

count=$(printf "%b" "$versions" | cut -d= -f2 | sort -u | wc -l | tr -d ' ')
if [ "$count" != "1" ]; then
  echo "FAIL: package versions diverge:" >&2
  printf "%b" "$versions" >&2
  echo "Run scripts/bump-version.sh to re-sync." >&2
  exit 1
fi
echo "OK: all packages at $(printf "%b" "$versions" | head -1 | cut -d= -f2)"
