#!/usr/bin/env bash
# Assert TS and Python entity declarations emit byte-identical IR, equal to the contract fixture.
set -euo pipefail
cd "$(dirname "$0")/.."

fixture=contracts/fixtures/entity-spec.valid-user.json
ts_out=$(cd node/packages/entity && pnpm exec tsx scripts/emit-fixture.ts)
py_out=$(cd python && uv run --package server-decorator-entity python packages/entity/scripts/emit_fixture.py)
expected=$(cat "$fixture")

[ "$ts_out" = "$expected" ] || { echo "FAIL: TS IR != $fixture" >&2; diff <(echo "$ts_out") <(echo "$expected") >&2 || true; exit 1; }
[ "$py_out" = "$expected" ] || { echo "FAIL: PY IR != $fixture" >&2; diff <(echo "$py_out") <(echo "$expected") >&2 || true; exit 1; }
echo "OK: entity-spec parity (TS == PY == contract fixture)"
