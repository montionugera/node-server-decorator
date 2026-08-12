#!/usr/bin/env bash
# python/packages/gen_pydantic/scripts/check.sh — lint + type-check + unit tests.
# Assumes `uv` is installed; `pip install uv` if not.
set -euo pipefail

cd "$(dirname "$0")/.."

if command -v uv >/dev/null 2>&1; then
  uv sync --extra dev >/dev/null
  RUN="uv run"
else
  echo "warning: uv not found; falling back to plain python+pytest. Install uv for the full dev experience." >&2
  RUN=""
fi

$RUN ruff check src tests
$RUN ruff format --check src tests
$RUN mypy src
$RUN pytest -q tests/unit
