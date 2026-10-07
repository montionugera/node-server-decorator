# Research: Rust lane CI, auto-bump lockstep, and workspace parity integration

## Affected Components

1. `scripts/check-versions.sh`: Currently asserts `rust/Cargo.toml=2.0.17` when all other packages are at `2.0.17`.
2. `.github/workflows/ci-node.yml`:
   ```yaml
   - name: Commit version bump
     run: |
       git add node/packages/*/package.json node/pnpm-lock.yaml python/packages/*/pyproject.toml python/packages/*/src/*/_version.py python/uv.lock go/entity/version.go nim/server_decorator.nimble rust/Cargo.toml rust/Cargo.lock
       git commit -m "chore: bump patch version [skip ci]"
       git push
   ```
3. `.github/workflows/ci-contracts.yml`:
   Add `- 'rust/**'` to PR and push path filters.
4. `.github/workflows/ci-rust.yml`:
   Follow patterns established in `ci-go.yml` and `ci-nim.yml`, using `actions-rust-lang/setup-rust-toolchain@v1` or standard rust installation.
