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
- **Release page.** The separate `release` job (`contents: write` only, no registry access) writes the page for the new tag from the `CHANGELOG.md` entry and attaches `docs-site.tgz`. If the docs build fails the page is still created, without the archive, and the run shows a warning.
- **Portal signal is inert.** The last `release` step only dispatches the developer-portal workflow when the secret `PORTAL_DISPATCH_TOKEN` is set; leave it unset until the portal can download `docs-site.tgz`.
- **Known limitation: notes can lag the tag.** A commit that lands on `main` while a run is in flight can be inside that version's tag but missing from its notes.
- **Main runs are never cancelled.** Workflow concurrency sets `cancel-in-progress` to false on `main` (true on pull requests), so a second merge waits in the queue instead of cancelling a run between `publish` and `release`. Only the newest waiting run is kept; GitHub drops older pending ones, and the repair rule above covers a skipped version.
- **Verified locally only** (stubbed `npm`, `pnpm`, `gh`; throwaway git repos; `scripts/tests/*.test.sh`, which the `CI - Scripts` workflow also runs on every pull request touching `scripts/` or `ci-node.yml`). **Unproven until the first real merge:** that GitHub and the registries accept the edited workflow, the `release` job against the real GitHub API, and the docs build on the runner. **Unproven until a genuine mid-run failure:** the repair path end to end, `pnpm -r publish` skipping versions already on GitHub Packages, and PyPI `skip-existing` with attestations.

## Security
- NPM token stored as encrypted secret
- Publishes only from `main` branch
- Version check prevents duplicate publishes
- Tests must pass before publish 