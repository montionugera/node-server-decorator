# Implementation Plan: Rust Lane CI, Auto-Bump Lockstep, and Workspace Parity Integration (F-026)

## Summary
Integrate the newly added full-stack Rust lane (`rust/`) into the automated release pipeline, GitHub Actions CI workflows, and version bump automation, ensuring strict lockstep version parity across TS, Python, Go, Nim, and Rust (`2.0.17`).

---

## Tasks

### Task 1: Synchronize Rust Workspace Version to 2.0.17
**Files:**
- Modify: `rust/Cargo.toml`
- Modify: `rust/Cargo.lock`

**Steps:**
- Update `[workspace.package]` in `rust/Cargo.toml` to `version = "2.0.17"`.
- Run `cargo check --manifest-path rust/Cargo.toml` to update `rust/Cargo.lock`.
- Verify with `bash scripts/check-versions.sh` that all packages match `2.0.17`.

---

### Task 2: Update Auto-Bump Git Staging in `ci-node.yml`
**Files:**
- Modify: `.github/workflows/ci-node.yml`

**Steps:**
- In the `Commit version bump` step (line 109), append `rust/Cargo.toml rust/Cargo.lock` to `git add`.
- Verify with dry-run/review that any future `scripts/bump-version.sh` commit includes Rust manifests.

---

### Task 3: Update CI Triggers in `ci-contracts.yml`
**Files:**
- Modify: `.github/workflows/ci-contracts.yml`

**Steps:**
- Add `'rust/**'` to both `pull_request.paths` and `push.paths` in `.github/workflows/ci-contracts.yml`.

---

### Task 4: Add Dedicated Rust CI Workflow (`ci-rust.yml`)
**Files:**
- Create: `.github/workflows/ci-rust.yml`

**Steps:**
- Create `.github/workflows/ci-rust.yml` triggered on PRs and pushes touching `rust/**`, `contracts/**`, or `.github/workflows/ci-rust.yml`.
- Add jobs for:
  - `cargo test --manifest-path rust/Cargo.toml --workspace`
  - `cargo clippy --manifest-path rust/Cargo.toml --all-targets -- -D warnings`
  - `cargo fmt --manifest-path rust/Cargo.toml --all -- --check`

---

### Task 5: Contributor Quality Gate Verification
**Steps:**
- Run `bash scripts/contributor-check.sh` and ensure all 8 quality gates pass green.
- Verify `cargo clippy` and `cargo fmt` pass without warnings.
