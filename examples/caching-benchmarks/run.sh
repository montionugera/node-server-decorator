#!/usr/bin/env bash
# examples/caching-benchmarks/run.sh
# Interactive & CLI runner for polyglot caching and prefetching benchmarks

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

run_go() {
  echo ""
  echo "========================================================"
  echo " 🚀 Running Go Multi-Tier Caching Benchmark"
  echo "========================================================"
  (cd "$REPO_ROOT" && go run ./examples/caching-benchmarks/go/main.go)
}

run_node() {
  echo ""
  echo "========================================================"
  echo " 🚀 Running Node/TypeScript Multi-Tier Caching Benchmark"
  echo "========================================================"
  # Ensure core package is built
  if [ ! -f "$REPO_ROOT/node/packages/core/dist/decorators/batch-load.js" ]; then
    echo "Building Node core package first..."
    (cd "$REPO_ROOT/node" && pnpm --filter @montionugera/server-decorator build)
  fi
  (cd "$REPO_ROOT" && node ./examples/caching-benchmarks/node/main.js)
}

run_python() {
  echo ""
  echo "========================================================"
  echo " 🚀 Running Python Multi-Tier Caching Benchmark"
  echo "========================================================"
  (cd "$REPO_ROOT/python" && uv run --package server-decorator python ../examples/caching-benchmarks/python/main.py)
}

run_all() {
  run_go
  run_node
  run_python
  echo ""
  echo "========================================================"
  echo " ✅ All Polyglot Benchmark Suites Completed Successfully!"
  echo "========================================================"
}

show_menu() {
  echo ""
  echo "========================================================"
  echo "  Polyglot Caching & Pre-Fetching Benchmark Suite"
  echo "========================================================"
  echo "  1) Run Go Benchmarks"
  echo "  2) Run Node/TypeScript Benchmarks"
  echo "  3) Run Python Benchmarks"
  echo "  4) Run All Languages (Go + Node + Python)"
  echo "  q) Quit"
  echo "========================================================"
  read -r -p "Select an option [1-4, q]: " choice
  case "$choice" in
    1) run_go ;;
    2) run_node ;;
    3) run_python ;;
    4) run_all ;;
    q|Q) echo "Exiting."; exit 0 ;;
    *) echo "Invalid option."; exit 1 ;;
  esac
}

# CLI Argument parsing
if [ $# -eq 0 ]; then
  show_menu
else
  case "$1" in
    --go) run_go ;;
    --node) run_node ;;
    --python) run_python ;;
    --all) run_all ;;
    -h|--help)
      echo "Usage: ./run.sh [--go | --node | --python | --all]"
      exit 0
      ;;
    *)
      echo "Unknown flag: $1"
      echo "Usage: ./run.sh [--go | --node | --python | --all]"
      exit 1
      ;;
  esac
fi
