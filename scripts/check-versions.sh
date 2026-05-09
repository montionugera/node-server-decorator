#!/usr/bin/env bash
# Assert node/package.json and python/pyproject.toml are at the same version (Decision #2).
set -euo pipefail

cd "$(dirname "$0")/.."

node_v=$(node -p "require('./node/package.json').version")
py_v=$(grep -oE '^version\s*=\s*"[^"]+"' python/pyproject.toml | grep -oE '"[^"]+"' | tr -d '"')

if [ "$node_v" != "$py_v" ]; then
  echo "FAIL: node/package.json version ($node_v) != python/pyproject.toml version ($py_v)" >&2
  echo "Run scripts/bump-version.sh to keep them in sync." >&2
  exit 1
fi
echo "OK: package version $node_v matches"
