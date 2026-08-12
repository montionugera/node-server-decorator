#!/usr/bin/env bash
# Run every package's own gate. Each package keeps a standalone scripts/check.sh.
set -euo pipefail
cd "$(dirname "$0")/.."
for pkg in packages/*/; do
  echo "=== check: $pkg ==="
  ( cd "$pkg" && bash scripts/check.sh )
done
