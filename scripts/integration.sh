#!/usr/bin/env bash
# Gate 2 (psrw promote): precheck plus the heavier suites that run locally without external services
# (no Docker e2e, no registries, no docs build). A missing toolchain is reported as skipped, never as passed.
set -u
cd "$(dirname "$0")/.."
export PATH="$HOME/.nimble/bin:$HOME/.cargo/bin:$PATH"
source scripts/lib-stages.sh
go_hygiene(){
  local files m; files=$(gofmt -l go) || return 1
  [ -z "$files" ] || { echo "gofmt needed:"; echo "$files"; return 1; }
  go vet ./go/... || return 1
  for m in go/adapter/gin go/adapter/pgxlock; do [ -f "$m/go.mod" ] && { (cd "$m" && go vet ./...) || return 1; }; done
  return 0
}
stage "precheck (gate 1)" bash scripts/precheck.sh
# precheck's own skips must not vanish inside its single "ok" line.
inner=$(printf '%s\n' "$LAST_OUT" | tail -n 1 | sed -n 's/.*skipped (\(.*\)) in [0-9]*s$/\1/p'); [ -z "$inner" ] || skip "precheck sub-stages" "$inner"
if command -v go >/dev/null; then
  stage "go hygiene" go_hygiene
  stage "go tests + coverage gate" bash scripts/check-go-coverage.sh
else skip "go hygiene + tests" "go not installed"; fi
if command -v uv >/dev/null; then stage "python lint, types, unit + coverage" bash -c 'cd python && bash scripts/check.sh'; else skip "python checks" "uv not installed"; fi
if command -v ajv >/dev/null; then stage "contract validation" bash contracts/scripts/validate.sh; else skip "contract validation" "ajv not installed"; fi
if command -v nim >/dev/null && command -v cargo >/dev/null; then
  stage "entity-spec parity" bash scripts/check-entity-parity.sh
  stage "openapi parity" bash scripts/check-openapi-parity.sh
else skip "entity/openapi parity" "needs nim and cargo"; fi
finish integration
