#!/usr/bin/env bash
# Assert TS and Python emit a byte-identical OpenAPI document, equal to the contract fixture.
set -euo pipefail
cd "$(dirname "$0")/.."

fixture=contracts/fixtures/openapi.valid-user.json
ts_out=$(cd node/packages/gen-openapi && pnpm exec tsx scripts/emit-openapi.ts)
py_out=$(cd python && uv run --package server-decorator-gen-openapi \
  python packages/gen_openapi/scripts/emit_openapi.py)
expected=$(cat "$fixture")

[ "$ts_out" = "$expected" ] || { echo "FAIL: TS OpenAPI != $fixture" >&2; diff <(echo "$ts_out") <(echo "$expected") >&2 || true; exit 1; }
[ "$py_out" = "$expected" ] || { echo "FAIL: PY OpenAPI != $fixture" >&2; diff <(echo "$py_out") <(echo "$expected") >&2 || true; exit 1; }
echo "OK: openapi parity (TS == PY == contract fixture)"
