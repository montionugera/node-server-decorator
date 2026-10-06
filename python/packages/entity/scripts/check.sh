#!/usr/bin/env bash
# python/packages/entity/scripts/check.sh — lint + type-check + unit tests.
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

# Coverage gate (unit tests only; integration-marked tests are excluded).
# COV_MIN is a ratchet: achieved line+branch coverage (--cov-branch) rounded down,
# measured on Python 3.10, 3.12 and 3.14. Raise it, never lower it.
COV_MIN=${COV_MIN:-95}
export COVERAGE_FILE="${COVERAGE_FILE:-${TMPDIR:-/tmp}/server-decorator-entity.coverage}"
$RUN pytest -q tests/unit -m "not integration" \
  --cov=src --cov-branch --cov-report=term-missing:skip-covered --cov-fail-under="$COV_MIN"
