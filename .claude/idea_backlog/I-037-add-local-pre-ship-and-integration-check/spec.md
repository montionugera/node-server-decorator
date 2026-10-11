---
title: "Add local pre-ship and integration check scripts so the release tool's two gates run"
id: I-037
status: idea
---

# scripts/precheck.sh (Gate 1) and scripts/integration.sh (Gate 2)

## Problem

`psrw ship` runs `scripts/precheck.sh` and `psrw promote` runs `scripts/integration.sh`; neither exists, so both gates are skipped.

## Sketch

Thin wrappers over what exists, run from the repo root, `set -u`, every stage run even after a failure, one-line summary, non-zero exit on any failure.
- precheck (fast): every `scripts/tests/*.test.sh`, `actionlint` when installed (skipped with a note otherwise), `scripts/check-versions.sh`, Node unit tests (`pnpm -r test:unit`, installing deps when `node/node_modules` is missing).
- integration: precheck plus Go hygiene and tests (`gofmt`, `go vet`, `go test ./go/...`), Python `bash scripts/check.sh`, OpenAPI and entity parity scripts; stages whose toolchain is absent are reported as skipped, never as passed. Docker e2e suites are out of scope.

## Acceptance criteria

- [ ] both scripts exist, are executable, and exit non-zero when any stage fails (proved with an injected failing stage)
- [ ] both print a final one-line summary listing failed and skipped stages
- [ ] a behaviour test covers exit code and summary using stub stages
- [ ] timings of a real run of each are recorded in README/SETUP docs
