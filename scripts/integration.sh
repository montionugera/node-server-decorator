#!/usr/bin/env bash
# Gate 2 (psrw promote): precheck plus the heavier suites that run locally without external services
# (no Docker e2e, no registries, no docs build). A missing toolchain is reported as skipped, never as passed.
set -u
cd "$(dirname "$0")/.."
export PATH="$HOME/.nimble/bin:$HOME/.cargo/bin:$PATH"
source scripts/lib-stages.sh
go_hygiene(){ [ -z "$(gofmt -l go)" ] && go vet ./go/...; }
stage "precheck (gate 1)" bash scripts/precheck.sh
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
