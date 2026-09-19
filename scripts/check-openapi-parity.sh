#!/usr/bin/env bash
# Assert TS, Python and Nim emit a byte-identical OpenAPI document, equal to the contract fixture.
set -euo pipefail
cd "$(dirname "$0")/.."

fixture=contracts/fixtures/openapi.valid-user.json

# The emitter resolves @montionugera/entity-spec through dist/, which does not exist on a
# clean checkout — build it first, the same reason gen-*/package.json carries pretest:unit.
# (check-entity-parity.sh needs no equivalent: its emitter imports ../src directly.)
( cd node && pnpm --filter @montionugera/entity-spec run build >/dev/null )

ts_out=$(cd node/packages/gen-openapi && pnpm exec tsx scripts/emit-openapi.ts)
py_out=$(cd python && uv run --package server-decorator-gen-openapi \
  python packages/gen_openapi/scripts/emit_openapi.py)
command -v nim >/dev/null || { echo "nim not on PATH (export PATH=\$HOME/.nimble/bin:\$PATH)" >&2; exit 1; }
nim_out=$(nim r --hints:off nim/examples/emit_openapi.nim)
go_out=$(go run ./go/internal/example/emitopenapi)
expected=$(cat "$fixture")

[ "$ts_out" = "$expected" ] || { echo "FAIL: TS OpenAPI != $fixture" >&2; diff <(echo "$ts_out") <(echo "$expected") >&2 || true; exit 1; }
[ "$py_out" = "$expected" ] || { echo "FAIL: PY OpenAPI != $fixture" >&2; diff <(echo "$py_out") <(echo "$expected") >&2 || true; exit 1; }
[ "$go_out" = "$expected" ] || { echo "FAIL: GO OpenAPI != $fixture" >&2; diff <(echo "$go_out") <(echo "$expected") >&2 || true; exit 1; }
[ "$nim_out" = "$expected" ] || { echo "FAIL: NIM OpenAPI != $fixture" >&2; diff <(echo "$nim_out") <(echo "$expected") >&2 || true; exit 1; }
echo "OK: openapi parity (TS == PY == GO == NIM == contract fixture)"

