---
title: "Rust lane CI, auto-bump lockstep, and workspace parity integration"
id: F-026
status: refined
from_idea: I-029
---

# Rust lane CI, auto-bump lockstep, and workspace parity integration

## Problem

With the introduction of the full-stack Rust lane (`rust/`), the automated GitHub Actions post-merge version bump job in `.github/workflows/ci-node.yml` did not include `rust/Cargo.toml` and `rust/Cargo.lock` in its explicit `git add` allowlist. As a result, when PR #15 merged to `main`, Node, Python, Go, and Nim were bumped to `2.0.17`, while Rust remained pinned at `2.0.16`, causing `scripts/check-versions.sh` to fail on `main`.

Additionally:
1. There is no dedicated GitHub Actions CI workflow for the Rust workspace (`.github/workflows/ci-rust.yml`) running `cargo test --workspace` and `cargo clippy`.
2. `.github/workflows/ci-contracts.yml` does not trigger on changes under `rust/**`.
3. Rust packages need to be updated to `2.0.17` so all workspace packages across TS, PY, GO, NIM, and RUST are in strict lockstep.

## Why now

Maintaining strict version lockstep is a core invariant of `node-server-decorator`. Without this integration:
- Post-merge auto-bumps on `main` break the contributor quality gates.
- Rust code changes on PRs do not get automated CI validation across all targets.

## Sketch

1. Bump `rust/Cargo.toml` and `rust/Cargo.lock` to `2.0.17` so `scripts/check-versions.sh` passes.
2. Update `.github/workflows/ci-node.yml` line 109 to append `rust/Cargo.toml rust/Cargo.lock` to the `git add` command during version bump.
3. Update `.github/workflows/ci-contracts.yml` paths to include `rust/**`.
4. Create `.github/workflows/ci-rust.yml` that runs `cargo test --workspace`, `cargo clippy -- -D warnings`, and `cargo fmt --check`.
5. Run full contributor check and verify all 8 quality gates pass.

## Acceptance criteria

- [ ] `rust/Cargo.toml` and `rust/Cargo.lock` are aligned to `2.0.17` and `bash scripts/check-versions.sh` passes cleanly.
- [ ] `.github/workflows/ci-node.yml` stages `rust/Cargo.toml` and `rust/Cargo.lock` during auto-bump.
- [ ] `.github/workflows/ci-contracts.yml` triggers on `rust/**` path changes.
- [ ] `.github/workflows/ci-rust.yml` exists and validates cargo test, clippy, and fmt.
- [ ] All 8 contributor quality gates in `scripts/contributor-check.sh` pass green.
