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

## Security
- NPM token stored as encrypted secret
- Publishes only from `main` branch
- Version check prevents duplicate publishes
- Tests must pass before publish 