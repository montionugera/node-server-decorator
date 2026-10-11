# 🚀 GitHub Actions Setup

## Required Secrets

None for publishing. npmjs.com and PyPI both use trusted publishing (OIDC), so there is no token to store or rotate.

### npmjs.com trusted publisher (once per package)
1. On [npmjs.com](https://www.npmjs.com/), open the package → **Settings** → **Trusted Publisher** → **GitHub Actions**
2. Organization or user: `montionugera`
3. Repository: `node-server-decorator`
4. Workflow filename: `ci-node.yml`
5. Environment: leave blank (or `pypi`, the environment the publish job runs in)
6. Allowed actions: tick **npm publish**

A package must already exist on npmjs.com before a trusted publisher can be added, so a brand-new package needs one manual first publish.

## Workflows

### 🚀 Publish Package (`publish.yml`)
- **Triggers**: Push to `main` branch, PRs to `main`
- **Actions**: 
  - Runs tests and builds on all triggers
  - Publishes to NPM only on `main` push (if version changed)
  - Creates GitHub release automatically
  - Skips publish if version already exists

### 🔢 Version Bump (`version-bump.yml`)
- **Triggers**: Manual workflow dispatch
- **Actions**:
  - Bumps version (patch/minor/major)
  - Commits changes to `main`
  - Creates git tag
  - Triggers publish workflow

## Usage

### Auto Publish Flow
1. Bump version: Go to **Actions** → **Version Bump** → **Run workflow**
2. Select version type (patch/minor/major)
3. Workflow will bump version and commit
4. Push to `main` triggers publish workflow
5. Package published to NPM automatically

### Manual Flow  
1. Update `package.json` version manually
2. Commit and push to `main`
3. Publish workflow runs automatically

## Release notes and repair

Applies to `.github/workflows/ci-node.yml` (the `publish` job, then the `release` job).

- **Decide rule.** The first step of `publish` runs `scripts/release-decide.sh`. If the newest commit on `main` is the bot's bump commit (`chore: bump patch version [skip ci]`) and the tag for the version in `node/packages/core/package.json` is not on `origin`, the run is a **repair**: it skips the bump, changelog and commit steps, publishes that version, and PyPI uses `skip-existing`. Anything else is a normal **release** that bumps a new patch version. If `git ls-remote` itself fails, the step fails and nothing is published.
- **Never use the manual trigger (`workflow_dispatch`) to test.** It bumps and publishes a real, permanent version.
- **A `publish` job that died before tagging** is repaired with the manual trigger on `main`, not a re-run, and only works if nothing has merged since; otherwise the trigger bumps a new version and the dead one stays partial. Re-running the job after a failure is not verified and is not recommended.
- **Release page.** The separate `release` job (`contents: write` only, no registry access) writes the page for the new tag from the `CHANGELOG.md` entry and attaches `docs-site.tgz`, whose root also holds `version.json` (`{"version":"<x.y.z>"}`, the release tag without the `v`) so the developer portal can check the archive against the tag. If the docs build fails the page is still created, without the archive, and the run shows a warning.
- **Action versions.** Every `uses:` is on a Node 24 major (checked against each action's `action.yml`; `scripts/tests/ci-action-majors.test.sh` pins them). `actions/setup-node` stays on v6 on purpose: v7 stops exporting a dummy `NODE_AUTH_TOKEN`, which the keyless npmjs.com step's `.npmrc` needs, and that step is `continue-on-error`, so a break would be silent. `astral-sh/setup-uv` is on v7 (v8+ publish no floating major tag) with `enable-cache: false` to keep the old no-cache behaviour. `runs-on: ubuntu-latest` is deliberately unpinned (it moves to Ubuntu 26 on 2026-10-19); no step depends on the image version, so a failure after the move is the signal to pin.
- **Portal signal is inert.** The last `release` step only dispatches the developer-portal workflow when the secret `PORTAL_DISPATCH_TOKEN` is set; leave it unset until the portal can download `docs-site.tgz`.
- **Known limitation: notes can lag the tag.** A commit that lands on `main` while a run is in flight can be inside that version's tag but missing from its notes.
- **Main runs are serialised, never cancelled.** Workflow concurrency sets `cancel-in-progress` to false on `main` (true on pull requests), so a run is never killed between `publish` and `release`; a second run starts only after the first ends (GitHub keeps only the newest waiting run). If a second merge lands before the first run pushes its version-bump commit, the second run stops red at the rebase step (a `CHANGELOG.md` conflict) before publishing anything. The first run's rebase already picked up that second merge, so its release contains the code but its notes do not list it. Re-running the failed run does not help: it re-checks-out the same commit and conflicts again. Instead start the manual trigger on `main` (or push any later commit under a watched path), which bumps and releases a new version.
- **Verified locally only** (stubbed `npm`, `pnpm`, `gh`; throwaway git repos; `scripts/tests/*.test.sh`, which the `CI - Scripts` workflow also runs on every pull request touching `scripts/` or `.github/workflows/`). **Unproven until the first real merge:** that GitHub and the registries accept the edited workflow, the `release` job against the real GitHub API, and the docs build on the runner. **Unproven until a genuine mid-run failure:** the repair path end to end, `pnpm -r publish` skipping versions already on GitHub Packages, and PyPI `skip-existing` with attestations.

## Security
- NPM token stored as encrypted secret
- Publishes only from `main` branch
- Version check prevents duplicate publishes
- Tests must pass before publish 