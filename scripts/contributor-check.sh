#!/usr/bin/env bash
# scripts/contributor-check.sh
# Automated local verification script for contributors before opening a PR.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

export PATH="$HOME/.nimble/bin:$PATH"

echo "========================================================"
echo " Running server-decorator Contributor Quality Gate"
echo "========================================================"

echo ""
echo "▶ [1/5] Checking version lockstep across packages..."
bash scripts/check-versions.sh
echo "  ✓ Versions aligned"

echo ""
echo "▶ [2/5] Checking EntitySpec IR parity (TS == PY == GO == NIM)..."
bash scripts/check-entity-parity.sh
echo "  ✓ EntitySpec parity verified"

echo ""
echo "▶ [3/5] Checking OpenAPI 3.1 parity (TS == PY == GO == NIM)..."
bash scripts/check-openapi-parity.sh
echo "  ✓ OpenAPI parity verified"

echo ""
echo "▶ [4/5] Running Go tests..."
CGO_ENABLED=0 go test ./go/...
echo "  ✓ Go tests passed"

echo ""
echo "▶ [5/5] Testing documentation portal build..."
if [ -d "$ROOT_DIR/website" ]; then
  (cd "$ROOT_DIR/website" && pnpm build > /dev/null)
  echo "  ✓ Documentation build passed (HTML + Search Index generated)"
fi

echo ""
echo "========================================================"
echo " ✅ All Contributor Quality Gates Passed!"
echo "    Ready to submit Pull Request."
echo "========================================================"
