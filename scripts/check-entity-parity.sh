#!/usr/bin/env bash
# Assert TS, Python, Go and Nim entity declarations emit byte-identical IR, equal to the contract fixture.
set -euo pipefail
cd "$(dirname "$0")/.."

fixture=contracts/fixtures/entity-spec.valid-user.json
ts_out=$(cd node/packages/entity && pnpm exec tsx scripts/emit-fixture.ts)
py_out=$(cd python && uv run --package server-decorator-entity python packages/entity/scripts/emit_fixture.py)
go_out=$(go run ./go/internal/example/emitfixture)
command -v nim >/dev/null || { echo "nim not on PATH (export PATH=\$HOME/.nimble/bin:\$PATH)" >&2; exit 1; }
# nim/config.nims adds ../src to the path; --hints:off keeps stdout to the program's output.
nim_out=$(nim r --hints:off nim/examples/emit_fixture.nim)
expected=$(cat "$fixture")

[ "$ts_out" = "$expected" ] || { echo "FAIL: TS IR != $fixture" >&2; diff <(echo "$ts_out") <(echo "$expected") >&2 || true; exit 1; }
[ "$py_out" = "$expected" ] || { echo "FAIL: PY IR != $fixture" >&2; diff <(echo "$py_out") <(echo "$expected") >&2 || true; exit 1; }
[ "$go_out" = "$expected" ] || { echo "FAIL: GO IR != $fixture" >&2; diff <(echo "$go_out") <(echo "$expected") >&2 || true; exit 1; }
[ "$nim_out" = "$expected" ] || { echo "FAIL: NIM IR != $fixture" >&2; diff <(echo "$nim_out") <(echo "$expected") >&2 || true; exit 1; }
echo "OK: entity-spec parity (TS == PY == GO == NIM == contract fixture)"
