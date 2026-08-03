# Entity-Spec Framework — P0 + P1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure node-server-decorator into a polyglot monorepo (P0), then ship the EntitySpec IR core: entity decorators in TS + Python that emit byte-identical IR, contracted in `contracts/`, compiled to zod/pydantic validation (P1).

**Architecture:** Decorators only record metadata into an `EntitySpec` IR; the IR canonical-JSON form is the cross-language contract (same pattern as the existing cache-key parity). Generators (`gen-zod`, `gen-pydantic`) derive Create/Update/Read/action-input validation schemas from the IR. No HTTP in this plan — adapters are P2+.

**Tech Stack:** TypeScript 5.8 / stage-2 decorators / pnpm 9.14.2 workspaces / Jest 29 · Python ≥3.10 / uv workspaces / hatchling / pytest / mypy strict / ruff · zod ^3.24 · pydantic ≥2.7 · ajv (contracts).

**Spec:** `docs/superpowers/specs/2026-08-04-entity-spec-framework-design.md` (I-004, approved 2026-08-04, incl. E8 multi-replica amendment).

## Global Constraints

- **Lockstep semver (Decision #2):** ALL published packages (Node + Python, core + new) share one version. Only `scripts/bump-version.sh` bumps; `scripts/check-versions.sh` must pass.
- **Contracts protocol:** any `contracts/` change bumps `contracts/VERSION`, updates `contracts/CHANGELOG.md`, AND patches `node/packages/core/src/_contract.ts` + `python/packages/core/src/server_decorator/_contract.py` in the same PR (`ci-contracts.yml` enforces).
- **Node:** pnpm 9.14.2 (pinned via `packageManager`), CommonJS, target es6, `experimentalDecorators: true`. Registry = GitHub Packages (`npm.pkg.github.com`). Never create `package-lock.json`/`yarn.lock`.
- **Python:** ≥3.10, asyncio only (Decision #10), mypy `strict = true`, ruff line-length 100, hatchling, uv as dev runner.
- **Canonical IR JSON (new, this plan):** UTF-8, object keys sorted lexicographically at every level, separators `,` and `:` (no whitespace), `ensure_ascii=false` semantics, **omit** absent options and default-valued flags (`false` flags, `transactional: true`). Both languages must produce byte-identical output for the same declaration.
- **Numeric constraints are integers** (`min`/`max` with `multipleOf: 1` in the schema) — avoids the whole-number-float JSON divergence documented in `contracts/rules/cache-key.md`.
- **E8 (multi-replica):** nothing in P1 may assume single-process state. The IR carries event-topic names derived as `<Entity>.<event>`; no in-memory registries beyond per-process decorator metadata.
- **Execution context:** this repo uses ps-release-workflow. Refine I-004 → F-NNN and claim BEFORE implementing; all edits happen in the per-feature worktree. New commits only — never `git commit --amend`.
- **Per-phase quality gate:** each phase ends with: verify (all commands below green) → independent adversarial review of the phase diff → refactor findings → re-verify. Not optional.

## File structure (end state of this plan)

```
docs/adr/0006-monorepo-restructure.md                    (Task 1)
node/
├── pnpm-workspace.yaml                                  (Task 2)
├── package.json                 # private workspace root (Task 2)
├── pnpm-lock.yaml               # single workspace lock  (Task 2)
└── packages/
    ├── core/                    # moved, name/API unchanged (Task 2)
    │   ├── package.json  src/  tsconfig.json  jest.config.js  .npmignore
    ├── entity/                  # @montionugera/entity-spec   (Tasks 7-8)
    │   └── src/{types.ts,canonical.ts,registry.ts,fields.ts,restful.ts,action.ts,index.ts,testing/user-fixture.ts}
    └── gen-zod/                 # @montionugera/entity-spec-gen-zod (Task 11)
        └── src/{index.ts,map-field.ts}
python/
├── pyproject.toml               # virtual uv workspace root (Task 4)
├── scripts/check.sh             # loops packages             (Task 4)
└── packages/
    ├── core/                    # moved, name/API unchanged  (Task 4)
    │   ├── pyproject.toml  src/server_decorator/  tests/  scripts/check.sh
    ├── entity/                  # PyPI server-decorator-entity (Task 9)
    │   └── src/server_decorator_entity/{__init__.py,types.py,canonical.py,markers.py,restful.py,action.py,testing/user_fixture.py}
    └── gen_pydantic/            # PyPI server-decorator-gen-pydantic (Task 12)
        └── src/server_decorator_gen_pydantic/__init__.py
contracts/
├── VERSION                      # 1.0.0 → 1.1.0             (Task 6)
├── schemas/entity-spec.schema.json                          (Task 6)
├── rules/entity-spec-canonical.md                           (Task 6)
└── fixtures/{entity-spec.valid-user.json, entity-spec.invalid-missing-entity.json, entity-spec.cases.json} (Task 6)
.github/workflows/{ci-node.yml,ci-python.yml,ci-contracts.yml}  (Tasks 3,4,10)
scripts/{bump-version.sh,check-versions.sh}                  (Task 3)
```

---

# Phase P0 — ADR + monorepo restructure

### Task 1: ADR 0006 — supersede Decision #11

**Files:**
- Create: `docs/adr/0006-monorepo-restructure.md`
- Modify: `DECISIONS.md` (append supersession note)

**Interfaces:** Produces the written authority every later task cites. No code.

- [ ] **Step 1: Write the ADR**

```markdown
# ADR 0006 — Monorepo workspaces for the entity-spec layer

Status: Accepted (Mont, 2026-08-04) · Supersedes: Decision #11 (2026-05-05, "two folders, no monorepo tool")

## Context
I-004 adds an entity/IR layer with generators and framework adapters — 4+ new Node
packages and 3+ new Python packages. Publishing them inside the single core package
would force every consumer to install adapters they don't use and would couple core's
semver to adapter churn.

## Decision
- `node/` becomes a pnpm workspace (`packages/*`); the existing package moves to
  `node/packages/core` keeping its published name `@montionugera/server-decorator`.
- `python/` becomes a uv workspace (virtual root, `packages/*`); the existing package
  moves to `python/packages/core` keeping PyPI name `server-decorator`.
- Lockstep semver (Decision #2) now spans ALL published packages in both languages.
- Layering (one direction): entity → depends on nothing; gen-* → entity only;
  adapters (P2+) → entity + gen-* + core.

## Consequences
- `scripts/bump-version.sh` / `check-versions.sh` walk all packages.
- CI installs at the workspace root and fans out with `pnpm -r` / per-package uv runs.
- Consumer install path for core is unchanged (same name, same dist shape).
```

- [ ] **Step 2: Append to `DECISIONS.md`** under the Decision #11 entry: `> Superseded 2026-08-04 by ADR 0006 (docs/adr/0006-monorepo-restructure.md): node/ and python/ become workspaces for the I-004 entity-spec layer.`

- [ ] **Step 3: Commit**

```bash
git add docs/adr/0006-monorepo-restructure.md DECISIONS.md
git commit -m "docs(adr): 0006 monorepo workspaces for entity-spec layer (supersedes Decision #11)"
```

### Task 2: Node pnpm workspace restructure

**Files:**
- Move (git mv): `node/src` → `node/packages/core/src`; `node/tsconfig.json`, `node/jest.config.js`, `node/.npmignore`, `node/package.json` → `node/packages/core/`
- Create: `node/pnpm-workspace.yaml`, new `node/package.json` (private root)
- Modify: root `package.json` (proxy scripts)

**Interfaces:**
- Produces: workspace layout every later Node task assumes; `pnpm -r <script>` from `node/` as the canonical invocation.
- Core's published name `@montionugera/server-decorator`, `main: dist/index.js` — unchanged.

- [ ] **Step 1: Record the baseline package shape** (compared again in Step 7):

```bash
cd node && pnpm install --frozen-lockfile && pnpm test:unit && pnpm run build
npm pack --dry-run 2>&1 | tee /tmp/pack-baseline.txt
```

- [ ] **Step 2: Move the package**

```bash
cd node
mkdir -p packages/core
git mv src tsconfig.json jest.config.js .npmignore package.json packages/core/
git rm pnpm-lock.yaml   # regenerated for the workspace in Step 5
```

- [ ] **Step 3: Create `node/pnpm-workspace.yaml`**

```yaml
packages:
  - 'packages/*'
```

- [ ] **Step 4: Create the new private root `node/package.json`**

```json
{
  "name": "@montionugera/server-decorator-workspace",
  "private": true,
  "scripts": {
    "build": "pnpm -r run build",
    "test": "pnpm -r run test",
    "test:unit": "pnpm -r run test:unit",
    "test:e2e": "pnpm -r run test:e2e",
    "test:e2e:redis": "pnpm -r run test:e2e:redis",
    "test:e2e:rabbitmq": "pnpm -r run test:e2e:rabbitmq",
    "test:e2e:kafka": "pnpm -r run test:e2e:kafka"
  },
  "engines": { "node": ">=18.0.0" },
  "packageManager": "pnpm@9.14.2"
}
```

(`pnpm -r run X` skips packages that don't define script X — safe as packages are added.)

- [ ] **Step 5: Install + verify inside the workspace**

```bash
cd node && pnpm install
pnpm -r test:unit && pnpm -r run build
```
Expected: same test counts as Step 1. `packages/core/tsconfig.json` and `jest.config.js` need no edits — their paths (`./src`, `<rootDir>/src`) are relative to the file.

- [ ] **Step 6: Update root `package.json` proxies** — replace the `"scripts"` block:

```json
"scripts": {
  "test": "cd node && pnpm -r test",
  "test:unit": "cd node && pnpm -r test:unit",
  "test:e2e": "cd node && pnpm -r test:e2e",
  "build": "cd node && pnpm -r run build",
  "py:check": "cd python && bash scripts/check.sh",
  "contracts:validate": "bash contracts/scripts/validate.sh"
}
```

- [ ] **Step 7: Prove the published shape is identical**

```bash
cd node/packages/core && npm pack --dry-run 2>&1 | tee /tmp/pack-after.txt
diff <(grep -E '^\S+ [0-9.]+[kMB]* ' /tmp/pack-baseline.txt | awk '{print $NF}' | sort) \
     <(grep -E '^\S+ [0-9.]+[kMB]* ' /tmp/pack-after.txt | awk '{print $NF}' | sort)
```
Expected: empty diff (same file list). Also `git log --follow packages/core/src/decorators/cache.ts` shows pre-move history.

- [ ] **Step 8: Commit**

```bash
git add -A node package.json
git commit -m "refactor(node): move package to node/packages/core under pnpm workspace (ADR 0006)"
```

### Task 3: Version-lockstep scripts + Node CI for workspaces

**Files:**
- Modify: `scripts/bump-version.sh`, `scripts/check-versions.sh`, `.github/workflows/ci-node.yml`

**Interfaces:**
- Produces: `scripts/bump-version.sh patch|minor|major` bumps EVERY `node/packages/*/package.json` and `python/packages/*/pyproject.toml` to one version; `check-versions.sh` fails on any divergence. Later tasks add packages and get lockstep for free.

- [ ] **Step 1: Rewrite `scripts/check-versions.sh`**

```bash
#!/usr/bin/env bash
# Assert every published package (Node + Python) is at the same version (Decision #2, ADR 0006).
set -euo pipefail
cd "$(dirname "$0")/.."

versions=""
for pkg in node/packages/*/package.json; do
  v=$(node -p "require('./$pkg').version")
  versions+="$pkg=$v\n"
done
for pkg in python/packages/*/pyproject.toml; do
  v=$(grep -oE '^version\s*=\s*"[^"]+"' "$pkg" | grep -oE '"[^"]+"' | tr -d '"')
  versions+="$pkg=$v\n"
done

count=$(printf "%b" "$versions" | cut -d= -f2 | sort -u | wc -l | tr -d ' ')
if [ "$count" != "1" ]; then
  echo "FAIL: package versions diverge:" >&2
  printf "%b" "$versions" >&2
  echo "Run scripts/bump-version.sh to re-sync." >&2
  exit 1
fi
echo "OK: all packages at $(printf "%b" "$versions" | head -1 | cut -d= -f2)"
```

- [ ] **Step 2: Rewrite `scripts/bump-version.sh`**

```bash
#!/usr/bin/env bash
# Bump ALL packages in lock-step (Decision #2, ADR 0006). Usage: scripts/bump-version.sh patch|minor|major
set -euo pipefail
bump=${1:?"usage: $0 patch|minor|major"}
case "$bump" in patch|minor|major) ;; *) echo "error: patch|minor|major" >&2; exit 2 ;; esac
cd "$(dirname "$0")/.."

# Bump core first to compute the new version, then mirror everywhere.
( cd node/packages/core && pnpm version "$bump" --no-git-tag-version >/dev/null )
new_version=$(node -p "require('./node/packages/core/package.json').version")

for pkg in node/packages/*/package.json; do
  [ "$pkg" = "node/packages/core/package.json" ] && continue
  node -e "const f='$pkg',p=require('./'+f);p.version='$new_version';require('fs').writeFileSync(f,JSON.stringify(p,null,2)+'\n')"
done
for pkg in python/packages/*/pyproject.toml; do
  sed -i.bak "s/^version = .*/version = \"$new_version\"/" "$pkg" && rm "$pkg.bak"
done

bash scripts/check-versions.sh
echo "Bumped all packages to v$new_version"
echo "Next: git add -A && git commit -m \"chore: bump to v$new_version\" && git tag v$new_version && git push --tags"
```

- [ ] **Step 3: Run both scripts to verify** — `bash scripts/check-versions.sh` (expect OK at 2.0.2 — only core exists yet on each side after Task 4; if run before Task 4, python path is still `python/pyproject.toml`, so run again after Task 4). `bash scripts/bump-version.sh patch && git checkout -- .` to smoke-test then revert.

- [ ] **Step 4: Update `.github/workflows/ci-node.yml`** — keep triggers/paths; in the `test` job (has `working-directory: node`): `cache-dependency-path: node/pnpm-lock.yaml` stays (single workspace lock); replace `pnpm test:unit` → `pnpm -r test:unit`, `pnpm run build`/`pnpm build` → `pnpm -r run build`, and any e2e invocation → `pnpm -r test:e2e`. In the publish job, replace the single-package `pnpm publish` with:

```yaml
      - run: pnpm -r publish --no-git-checks
        env:
          NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```
and replace any direct `pnpm version patch` auto-bump with `bash ../scripts/bump-version.sh patch` (run from repo root: `bash scripts/bump-version.sh patch`) so Python stays lockstep. Read the existing job carefully — preserve the version-diff-vs-registry check and Slack step as-is.

- [ ] **Step 5: Commit**

```bash
git add scripts/bump-version.sh scripts/check-versions.sh .github/workflows/ci-node.yml
git commit -m "chore(ci): workspace-aware lockstep versioning and Node CI (ADR 0006)"
```

### Task 4: Python uv workspace restructure + Python CI

**Files:**
- Move (git mv): `python/src` → `python/packages/core/src`; `python/tests` → `python/packages/core/tests`; `python/pyproject.toml` → `python/packages/core/pyproject.toml`; `python/scripts/check.sh` → `python/packages/core/scripts/check.sh`; `python/uv.lock` removed (workspace lock regenerates at root)
- Create: new virtual `python/pyproject.toml`, new `python/scripts/check.sh`
- Modify: `.github/workflows/ci-python.yml`

**Interfaces:**
- Produces: `cd python && bash scripts/check.sh` runs every package's gate; `uv sync --all-packages` from `python/`. Core import name `server_decorator` and PyPI name `server-decorator` unchanged.

- [ ] **Step 1: Baseline** — `cd python && bash scripts/check.sh` green before touching anything.

- [ ] **Step 2: Move the package**

```bash
cd python
mkdir -p packages/core
git mv src tests scripts pyproject.toml packages/core/
git rm -f uv.lock 2>/dev/null || rm -f uv.lock
```

- [ ] **Step 3: Create the virtual workspace root `python/pyproject.toml`**

```toml
[tool.uv.workspace]
members = ["packages/*"]
```

- [ ] **Step 4: Create `python/scripts/check.sh`** (root gate, loops members)

```bash
#!/usr/bin/env bash
# Run every package's own gate. Each package keeps a standalone scripts/check.sh.
set -euo pipefail
cd "$(dirname "$0")/.."
for pkg in packages/*/; do
  echo "=== check: $pkg ==="
  ( cd "$pkg" && bash scripts/check.sh )
done
```

- [ ] **Step 5: Sync + verify**

```bash
cd python && uv sync --all-packages --all-extras
bash scripts/check.sh
```
Expected: identical results to Step 1 (24 unit tests, mypy strict clean). `packages/core/pyproject.toml` needs no path edits — `packages = ["src/server_decorator"]`, `files = ["src/server_decorator"]`, `testpaths = ["tests"]` are all package-relative.

- [ ] **Step 6: Update `.github/workflows/ci-python.yml`** — wherever it runs from `python/` against `src`/`tests`, keep `working-directory: python` and change invocations to `bash scripts/check.sh` (the new loop) and integration runs to `cd packages/core && uv run pytest -m integration`. Preserve triggers/path filters, adding nothing.

- [ ] **Step 7: Re-run lockstep check** — `bash scripts/check-versions.sh` from repo root. Expected: `OK: all packages at 2.0.2`. (Also fix the known drift: set `__version__ = "2.0.2"` in `python/packages/core/src/server_decorator/_version.py` — it still says 2.0.0.)

- [ ] **Step 8: Commit**

```bash
git add -A python .github/workflows/ci-python.yml
git commit -m "refactor(python): move package to python/packages/core under uv workspace (ADR 0006)"
```

### Task 5: Repo-wide path audit + P0 gate

**Files:**
- Modify: whatever the audit finds (`interop/scenarios/*/run.sh`, `contracts/scripts/validate.sh`, `CLAUDE.md`, `README.md`, `MIGRATION.md`, `.github/workflows/ci-contracts.yml`, `ci-interop.yml`)

**Interfaces:** Produces a fully green repo at the new layout — the precondition for every P1 task.

- [ ] **Step 1: Audit stale paths**

```bash
grep -rn --include='*.sh' --include='*.yml' --include='*.md' --include='*.json' \
  -e 'node/src' -e 'python/src' -e 'python/pyproject.toml' -e 'cd node &&' -e 'cd python &&' \
  . --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git --exclude-dir=.claude
```
Fix every functional hit (scripts, workflows) to the `packages/core` paths; update doc references (`CLAUDE.md` commands table, READMEs) in the same pass. `ci-contracts.yml` asserts `node/src/_contract.ts` and `python/src/server_decorator/_contract.py` — point both at `node/packages/core/src/_contract.ts` / `python/packages/core/src/server_decorator/_contract.py`.

- [ ] **Step 2: Full verification sweep** (all must be green, output captured):

```bash
(cd node && pnpm -r test:unit && pnpm -r run build)
(cd python && bash scripts/check.sh)
bash contracts/scripts/validate.sh
bash scripts/check-versions.sh
(cd node && pnpm -r test:e2e)          # Docker required
```

- [ ] **Step 3: Commit** — `git add -A && git commit -m "chore: fix remaining paths for workspace layout (ADR 0006)"`

- [ ] **Step 4: PHASE GATE (P0)** — dispatch an independent adversarial review of the full P0 diff (`git diff <pre-P0-commit>..HEAD`); apply findings; re-run Step 2; commit fixes as new commits.

---

# Phase P1 — EntitySpec IR + contracts + generators

### Task 6: Contracts — entity-spec schema, canonical rule, fixtures

**Files:**
- Create: `contracts/schemas/entity-spec.schema.json`, `contracts/rules/entity-spec-canonical.md`, `contracts/fixtures/entity-spec.valid-user.json`, `contracts/fixtures/entity-spec.invalid-missing-entity.json`, `contracts/fixtures/entity-spec.cases.json`
- Modify: `contracts/VERSION` (1.0.0 → 1.1.0), `contracts/CHANGELOG.md`, `node/packages/core/src/_contract.ts`, `python/packages/core/src/server_decorator/_contract.py` (CONTRACT_VERSION → "1.1.0")

**Interfaces:**
- Produces: the IR wire shape all of Tasks 7–12 implement. Field/action key names below are FINAL — later tasks copy them exactly.

- [ ] **Step 1: Write `contracts/schemas/entity-spec.schema.json`**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://server-decorator.dev/schemas/entity-spec/1.1.0.json",
  "title": "EntitySpec",
  "type": "object",
  "required": ["specVersion", "entity", "path", "transports", "ops", "pagination", "fields"],
  "additionalProperties": false,
  "properties": {
    "specVersion": { "const": "1.1.0" },
    "entity": { "type": "string", "pattern": "^[A-Z][A-Za-z0-9]*$" },
    "path": { "type": "string", "pattern": "^[a-z][a-z0-9-]*$" },
    "transports": {
      "type": "array", "minItems": 1, "uniqueItems": true,
      "items": { "enum": ["rest", "rpc", "sse", "ws"] }
    },
    "ops": {
      "type": "array", "uniqueItems": true,
      "items": { "enum": ["list", "get", "create", "update", "delete"] }
    },
    "pagination": { "enum": ["offset", "cursor"] },
    "fields": { "type": "array", "minItems": 1, "items": { "$ref": "#/$defs/field" } },
    "actions": { "type": "array", "items": { "$ref": "#/$defs/action" } }
  },
  "$defs": {
    "field": {
      "type": "object",
      "required": ["name", "type"],
      "additionalProperties": false,
      "properties": {
        "name": { "type": "string", "pattern": "^[a-z][A-Za-z0-9]*$" },
        "type": { "enum": ["str", "int", "float", "bool", "datetime", "enum", "ref", "list", "obj"] },
        "role": { "const": "id" },
        "format": { "enum": ["email", "uuid", "uri"] },
        "enum": { "type": "array", "minItems": 1, "items": { "type": "string" } },
        "min": { "type": "number", "multipleOf": 1 },
        "max": { "type": "number", "multipleOf": 1 },
        "pattern": { "type": "string" },
        "optional": { "const": true },
        "nullable": { "const": true },
        "readonly": { "const": true },
        "writeonly": { "const": true },
        "filterable": { "const": true },
        "item": { "$ref": "#/$defs/field" },
        "ref": { "type": "string" },
        "fields": { "type": "array", "items": { "$ref": "#/$defs/field" } }
      }
    },
    "action": {
      "type": "object",
      "required": ["name"],
      "additionalProperties": false,
      "properties": {
        "name": { "type": "string", "pattern": "^[a-z][A-Za-z0-9]*$" },
        "stateField": { "type": "string" },
        "from": { "type": "string" },
        "to": { "type": "string" },
        "input": { "type": "array", "items": { "$ref": "#/$defs/field" } },
        "transactional": { "const": false }
      }
    }
  }
}
```
Note the deliberate `"const": true` / `"const": false` tricks: flags may only appear when non-default (canonical-form rule), so the schema itself rejects redundant `"optional": false`.

- [ ] **Step 2: Write `contracts/rules/entity-spec-canonical.md`**

```markdown
# EntitySpec canonical JSON (v1.1.0)

Both languages MUST serialize an EntitySpec to the byte-identical canonical form:

1. UTF-8; non-ASCII characters are NOT escaped (Python: `ensure_ascii=False`).
2. Object keys sorted lexicographically (byte order) at every nesting level.
3. Separators `,` and `:` with no whitespace, no trailing newline.
4. Omit-when-default: keys are ABSENT rather than set to a default —
   flags (`optional`, `nullable`, `readonly`, `writeonly`, `filterable`) appear only as `true`;
   `transactional` appears only as `false`; unset options (`format`, `min`, `role`, ...) are omitted.
5. Arrays keep declaration order (fields = class declaration order; `enum` values = declared order).
6. All numbers are integers (no fractional constraints in v1.1.0).
7. Wire names are camelCase. Python declarations are snake_case; the builder converts
   (`login_count` → `loginCount`). Rule: split on `_`, lowercase first segment, capitalize the rest.

Examples: see `fixtures/entity-spec.valid-user.json` (stored in canonical form).
Parity test: TS and Python `testing` fixture entities must emit exactly that file's bytes.
```

- [ ] **Step 3: Write the User fixture** — `contracts/fixtures/entity-spec.valid-user.json`, single line, canonical form. Pretty-printed here for review; the committed file is the canonical (one-line, sorted-key) equivalent:

```json
{
  "specVersion": "1.1.0",
  "entity": "User",
  "path": "users",
  "transports": ["rest", "rpc", "sse", "ws"],
  "ops": ["list", "get", "create", "update", "delete"],
  "pagination": "offset",
  "fields": [
    { "name": "id", "type": "str", "role": "id", "readonly": true },
    { "name": "email", "type": "str", "format": "email", "filterable": true },
    { "name": "name", "type": "str", "min": 2, "max": 80 },
    { "name": "status", "type": "enum", "enum": ["inactive", "active", "banned"], "filterable": true },
    { "name": "loginCount", "type": "int", "min": 0, "readonly": true },
    { "name": "tags", "type": "list", "item": { "name": "tags", "type": "str" } },
    { "name": "profile", "type": "obj", "optional": true,
      "fields": [ { "name": "bio", "type": "str", "max": 500, "optional": true } ] },
    { "name": "birthday", "type": "datetime", "optional": true, "nullable": true }
  ],
  "actions": [
    { "name": "activate", "stateField": "status", "from": "inactive", "to": "active",
      "input": [ { "name": "reason", "type": "str", "max": 200, "optional": true } ] },
    { "name": "ping" }
  ]
}
```
Generate the canonical file with: `node -e 'const s=require("fs").readFileSync(0,"utf8");const c=v=>v===null||typeof v!=="object"?JSON.stringify(v):Array.isArray(v)?`[${v.map(c).join(",")}]`:`{${Object.entries(v).filter(([,x])=>x!==undefined).sort(([a],[b])=>a<b?-1:1).map(([k,x])=>`${JSON.stringify(k)}:${c(x)}`).join(",")}}`;process.stdout.write(c(JSON.parse(s)))' < /tmp/user-pretty.json > contracts/fixtures/entity-spec.valid-user.json`

- [ ] **Step 4: Write the invalid fixture** — `contracts/fixtures/entity-spec.invalid-missing-entity.json`:

```json
{ "specVersion": "1.1.0", "path": "users", "transports": ["rest"], "ops": ["get"], "pagination": "offset", "fields": [{ "name": "id", "type": "str" }] }
```

- [ ] **Step 5: Write `contracts/fixtures/entity-spec.cases.json`** — the cross-language validation-behavior contract for Tasks 11/12 (both generators must produce these verdicts against the User fixture):

```json
{
  "entity": "User",
  "cases": [
    { "name": "create-valid", "dto": "create",
      "payload": { "email": "a@b.co", "name": "Mont", "status": "inactive", "tags": [] },
      "valid": true, "errorFields": [] },
    { "name": "create-missing-email", "dto": "create",
      "payload": { "name": "Mont", "status": "inactive", "tags": [] },
      "valid": false, "errorFields": ["email"] },
    { "name": "create-bad-email-and-short-name", "dto": "create",
      "payload": { "email": "nope", "name": "M", "status": "inactive", "tags": [] },
      "valid": false, "errorFields": ["email", "name"] },
    { "name": "create-rejects-readonly-loginCount", "dto": "create",
      "payload": { "email": "a@b.co", "name": "Mont", "status": "inactive", "tags": [], "loginCount": 5 },
      "valid": false, "errorFields": ["loginCount"] },
    { "name": "create-bad-enum", "dto": "create",
      "payload": { "email": "a@b.co", "name": "Mont", "status": "zombie", "tags": [] },
      "valid": false, "errorFields": ["status"] },
    { "name": "create-nested-bio-too-long", "dto": "create",
      "payload": { "email": "a@b.co", "name": "Mont", "status": "inactive", "tags": [],
                   "profile": { "bio": "<a string of 501 characters — literally repeat the letter x 501 times>" } },
      "valid": false, "errorFields": ["profile.bio"] },
    { "name": "update-partial-ok", "dto": "update", "payload": { "name": "Monty" },
      "valid": true, "errorFields": [] },
    { "name": "update-empty-ok", "dto": "update", "payload": {}, "valid": true, "errorFields": [] },
    { "name": "action-activate-valid", "dto": "action:activate", "payload": { "reason": "ok" },
      "valid": true, "errorFields": [] },
    { "name": "action-activate-reason-too-long", "dto": "action:activate",
      "payload": { "reason": "<repeat the letter x 201 times>" },
      "valid": false, "errorFields": ["reason"] },
    { "name": "action-ping-rejects-extra-keys", "dto": "action:ping", "payload": { "boom": 1 },
      "valid": false, "errorFields": ["boom"] }
  ]
}
```
(Write the two long strings out literally in the committed file — 501 × `x` and 201 × `x`. `errorFields` = wire-name paths, dot-joined, sorted, deduplicated. Extra/unknown keys are always rejected — strict mode in both generators.)

- [ ] **Step 6: Version bump plumbing** — `contracts/VERSION` → `1.1.0`; `contracts/CHANGELOG.md` add `## 1.1.0 — add entity-spec schema, canonical rule, fixtures (I-004 P1)`; `node/packages/core/src/_contract.ts` and `python/packages/core/src/server_decorator/_contract.py` → `"1.1.0"`; update the two smoke tests asserting the old value (`python/packages/core/tests/unit/test_smoke.py`, and grep node unit specs for `1.0.0`).

- [ ] **Step 7: Validate** — `bash contracts/scripts/validate.sh` (valid fixture passes, invalid fails as expected — the script's naming convention `entity-spec.valid-*.json` / `entity-spec.invalid-*.json` maps to `entity-spec.schema.json`). Then `(cd node && pnpm -r test:unit)` and `(cd python && bash scripts/check.sh)` for the contract-version assertions.

- [ ] **Step 8: Commit** — `git add contracts node/packages/core/src/_contract.ts python/packages/core && git commit -m "feat(contracts): entity-spec IR schema v1.1.0 + canonical rule + parity fixtures"`

### Task 7: Node entity package — types, canonical JSON, registry

**Files:**
- Create: `node/packages/entity/package.json`, `tsconfig.json`, `jest.config.js`, `.npmignore`, `src/types.ts`, `src/canonical.ts`, `src/registry.ts`, `src/canonical.spec.ts`, `src/registry.spec.ts`

**Interfaces:**
- Produces (Task 8 consumes): `FieldSpec`, `ActionSpec`, `EntitySpec`, `MutableEntitySpec` types; `canonicalJson(value: unknown): string`; `specFor(ctor: Function): MutableEntitySpec`; `addField(ctor, field)`; `addAction(ctor, action)`.

- [ ] **Step 1: Scaffold the package.** `node/packages/entity/package.json`:

```json
{
  "name": "@montionugera/entity-spec",
  "version": "2.0.2",
  "description": "Declarative entity decorators emitting the language-neutral EntitySpec IR (contracts/schemas/entity-spec.schema.json).",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": ["dist/"],
  "publishConfig": { "registry": "https://npm.pkg.github.com" },
  "scripts": {
    "build": "tsc",
    "test": "jest",
    "test:unit": "jest",
    "clean": "rm -rf dist",
    "prepublishOnly": "pnpm test:unit && pnpm run build"
  },
  "license": "MIT",
  "devDependencies": {
    "@types/jest": "^29.5.14",
    "@types/node": "^22.16.5",
    "ajv": "^8.17.1",
    "ajv-formats": "^3.0.1",
    "jest": "^29.7.0",
    "ts-jest": "^29.4.0",
    "tsx": "^4.19.2",
    "typescript": "^5.8.3"
  },
  "engines": { "node": ">=18.0.0" },
  "packageManager": "pnpm@9.14.2"
}
```
Copy `node/packages/core/tsconfig.json` verbatim (same compiler options). `jest.config.js`:

```js
/** @type {import('ts-jest').JestConfigWithTsJest} **/
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.spec.ts'],
  testTimeout: 10000,
};
```
`.npmignore`: `*.spec.ts`. Run `cd node && pnpm install` to register the workspace member.

- [ ] **Step 2: Write `src/types.ts`** (mirrors the schema from Task 6 exactly):

```ts
export type FieldType = 'str' | 'int' | 'float' | 'bool' | 'datetime' | 'enum' | 'ref' | 'list' | 'obj';
export type Transport = 'rest' | 'rpc' | 'sse' | 'ws';
export type Op = 'list' | 'get' | 'create' | 'update' | 'delete';

export interface FieldSpec {
  name: string;
  type: FieldType;
  role?: 'id';
  format?: 'email' | 'uuid' | 'uri';
  enum?: string[];
  min?: number;
  max?: number;
  pattern?: string;
  optional?: true;
  nullable?: true;
  readonly?: true;
  writeonly?: true;
  filterable?: true;
  item?: FieldSpec;
  ref?: string;
  fields?: FieldSpec[];
}

export interface ActionSpec {
  name: string;
  stateField?: string;
  from?: string;
  to?: string;
  input?: FieldSpec[];
  transactional?: false;
}

export interface EntitySpec {
  specVersion: '1.1.0';
  entity: string;
  path: string;
  transports: Transport[];
  ops: Op[];
  pagination: 'offset' | 'cursor';
  fields: FieldSpec[];
  actions?: ActionSpec[];
}

export interface MutableEntitySpec extends Partial<EntitySpec> {
  fields: FieldSpec[];
  actions: ActionSpec[];
}
```

- [ ] **Step 3: Failing test for canonical JSON** — `src/canonical.spec.ts`:

```ts
import { canonicalJson } from './canonical';

describe('canonicalJson', () => {
  it('sorts keys at every level, no whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: 'x' } }))
      .toBe('{"a":{"c":"x","d":[2,1]},"b":1}');
  });
  it('drops undefined values but keeps null', () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
  });
  it('does not escape non-ASCII', () => {
    expect(canonicalJson({ a: 'ราคา' })).toBe('{"a":"ราคา"}');
  });
});
```
Run: `cd node/packages/entity && pnpm test` → FAIL (module not found).

- [ ] **Step 4: Implement `src/canonical.ts`**

```ts
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}
```
Run tests → PASS.

- [ ] **Step 5: Failing test for the registry** — `src/registry.spec.ts`:

```ts
import { specFor, addField, addAction } from './registry';

describe('registry', () => {
  it('accumulates fields and actions per constructor', () => {
    class A {}
    addField(A, { name: 'x', type: 'str' });
    addAction(A, { name: 'go' });
    expect(specFor(A).fields).toEqual([{ name: 'x', type: 'str' }]);
    expect(specFor(A).actions).toEqual([{ name: 'go' }]);
  });
  it('keeps separate specs for separate classes', () => {
    class B {}
    class C {}
    addField(B, { name: 'b', type: 'int' });
    expect(specFor(C).fields).toEqual([]);
  });
});
```
Run → FAIL.

- [ ] **Step 6: Implement `src/registry.ts`**

```ts
import { ActionSpec, FieldSpec, MutableEntitySpec } from './types';

const registry = new WeakMap<Function, MutableEntitySpec>();

export function specFor(ctor: Function): MutableEntitySpec {
  let spec = registry.get(ctor);
  if (!spec) {
    spec = { fields: [], actions: [] };
    registry.set(ctor, spec);
  }
  return spec;
}

export function addField(ctor: Function, field: FieldSpec): void {
  specFor(ctor).fields.push(field);
}

export function addAction(ctor: Function, action: ActionSpec): void {
  specFor(ctor).actions.push(action);
}
```
Run → PASS.

- [ ] **Step 7: Commit** — `git add node/packages/entity node/pnpm-lock.yaml && git commit -m "feat(entity): package scaffold, IR types, canonical JSON, registry"`

### Task 8: Node entity package — decorators + entitySpec() + fixture parity

**Files:**
- Create: `node/packages/entity/src/fields.ts`, `src/action.ts`, `src/restful.ts`, `src/index.ts`, `src/testing/user-fixture.ts`, `src/entity-spec.spec.ts`, `scripts/emit-fixture.ts`

**Interfaces:**
- Consumes: Task 7's `specFor/addField/addAction/canonicalJson` + types.
- Produces: decorators `Restful(opts)`, `action(name, opts?)`, field decorators `id, str, int, float, bool, datetime, email, uuid, uri, enumOf, listOf, obj, ref`; `entitySpec(ctor): EntitySpec`; `entitySpecCanonical(ctor): string`; fixture entity `UserFixture` exported from `@montionugera/entity-spec/dist/testing/user-fixture`. Tasks 10–11 rely on these exact names.

- [ ] **Step 1: Failing parity test** — `src/entity-spec.spec.ts`:

```ts
import { readFileSync } from 'fs';
import { join } from 'path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { entitySpec, entitySpecCanonical } from './index';
import { UserFixture } from './testing/user-fixture';

const CONTRACTS = join(__dirname, '../../../../contracts');

describe('EntitySpec IR', () => {
  it('emits byte-identical canonical JSON to the contract fixture', () => {
    const expected = readFileSync(join(CONTRACTS, 'fixtures/entity-spec.valid-user.json'), 'utf8').trim();
    expect(entitySpecCanonical(UserFixture)).toBe(expected);
  });
  it('validates against the entity-spec JSON schema', () => {
    const schema = JSON.parse(readFileSync(join(CONTRACTS, 'schemas/entity-spec.schema.json'), 'utf8'));
    const ajv = new Ajv({ strict: false });
    addFormats(ajv);
    expect(ajv.validate(schema, entitySpec(UserFixture))).toBe(true);
  });
  it('throws when a class has no @Restful decorator', () => {
    class Naked {}
    expect(() => entitySpec(Naked)).toThrow(/not decorated with @Restful/);
  });
});
```
Run → FAIL.

- [ ] **Step 2: Implement `src/fields.ts`**

```ts
import { addField } from './registry';
import { FieldSpec } from './types';

type FieldOpts = Partial<Omit<FieldSpec, 'name'>>;

export function field(def: FieldOpts & { type: FieldSpec['type'] }): PropertyDecorator {
  return (target, propertyKey) => {
    addField(target.constructor, { name: String(propertyKey), ...def });
  };
}

type Flags = Pick<FieldSpec, 'optional' | 'nullable' | 'readonly' | 'writeonly' | 'filterable'>;
type StrOpts = Flags & Pick<FieldSpec, 'min' | 'max' | 'pattern' | 'format'>;
type NumOpts = Flags & Pick<FieldSpec, 'min' | 'max'>;

export const id = () => field({ type: 'str', role: 'id', readonly: true });
export const str = (o: StrOpts = {}) => field({ type: 'str', ...o });
export const email = (o: Flags = {}) => field({ type: 'str', format: 'email', ...o });
export const uuid = (o: Flags = {}) => field({ type: 'str', format: 'uuid', ...o });
export const uri = (o: Flags = {}) => field({ type: 'str', format: 'uri', ...o });
export const int = (o: NumOpts = {}) => field({ type: 'int', ...o });
export const float = (o: NumOpts = {}) => field({ type: 'float', ...o });
export const bool = (o: Flags = {}) => field({ type: 'bool', ...o });
export const datetime = (o: Flags = {}) => field({ type: 'datetime', ...o });
export const enumOf = (values: string[], o: Flags = {}) => field({ type: 'enum', enum: values, ...o });
export const ref = (entity: string, o: Flags = {}) => field({ type: 'ref', ref: entity, ...o });

// item/fields take the same shape minus `name` (the builder injects it).
export const listOf = (item: FieldOpts & { type: FieldSpec['type'] }, o: Flags = {}) =>
  field({ type: 'list', item: { name: '', ...item } as FieldSpec, ...o });
export const obj = (fields: Array<FieldSpec>, o: Flags = {}) =>
  field({ type: 'obj', fields, ...o });
```

- [ ] **Step 3: Implement `src/action.ts`**

```ts
import { addAction } from './registry';
import { ActionSpec, FieldSpec } from './types';

export interface ActionOpts {
  stateField?: string;
  from?: string;
  to?: string;
  input?: FieldSpec[];
  transactional?: boolean;
}

export function action(name: string, opts: ActionOpts = {}): MethodDecorator {
  return (target) => {
    const spec: ActionSpec = { name };
    if (opts.from !== undefined || opts.to !== undefined) {
      spec.stateField = opts.stateField ?? 'status';
      spec.from = opts.from;
      spec.to = opts.to;
    }
    if (opts.input && opts.input.length > 0) spec.input = opts.input;
    if (opts.transactional === false) spec.transactional = false;
    addAction(target.constructor, spec);
  };
}
```

- [ ] **Step 4: Implement `src/restful.ts`**

```ts
import { canonicalJson } from './canonical';
import { specFor } from './registry';
import { EntitySpec, Op, Transport } from './types';

export interface RestfulOpts {
  path: string;
  transports?: Transport[];
  ops?: Op[];
  pagination?: 'offset' | 'cursor';
}

const finalized = new WeakMap<Function, EntitySpec>();

export function Restful(opts: RestfulOpts): ClassDecorator {
  return (ctor) => {
    const draft = specFor(ctor);
    const spec: EntitySpec = {
      specVersion: '1.1.0',
      entity: ctor.name,
      path: opts.path,
      transports: opts.transports ?? ['rest'],
      ops: opts.ops ?? ['list', 'get', 'create', 'update', 'delete'],
      pagination: opts.pagination ?? 'offset',
      fields: draft.fields,
      ...(draft.actions.length > 0 ? { actions: draft.actions } : {}),
    };
    finalized.set(ctor, Object.freeze(spec));
  };
}

export function entitySpec(ctor: Function): EntitySpec {
  const spec = finalized.get(ctor);
  if (!spec) throw new Error(`${ctor.name} is not decorated with @Restful`);
  return spec;
}

export function entitySpecCanonical(ctor: Function): string {
  return canonicalJson(entitySpec(ctor));
}
```

- [ ] **Step 5: Write `src/index.ts`**

```ts
export * from './types';
export { canonicalJson } from './canonical';
export { field, id, str, email, uuid, uri, int, float, bool, datetime, enumOf, ref, listOf, obj } from './fields';
export { action, ActionOpts } from './action';
export { Restful, RestfulOpts, entitySpec, entitySpecCanonical } from './restful';
```

- [ ] **Step 6: Write `src/testing/user-fixture.ts`** (must reproduce Task 6's fixture exactly — note `item.name` for lists mirrors the parent name):

```ts
import { Restful, action, id, email, str, enumOf, int, listOf, obj, datetime } from '../index';

@Restful({ path: 'users', transports: ['rest', 'rpc', 'sse', 'ws'] })
class User {
  @id() id!: string;
  @email({ filterable: true }) email!: string;
  @str({ min: 2, max: 80 }) name!: string;
  @enumOf(['inactive', 'active', 'banned'], { filterable: true }) status!: string;
  @int({ min: 0, readonly: true }) loginCount!: number;
  @listOf({ type: 'str' }) tags!: string[];
  @obj([{ name: 'bio', type: 'str', max: 500, optional: true }], { optional: true })
  profile?: { bio?: string };
  @datetime({ optional: true, nullable: true }) birthday?: string | null;

  @action('activate', { from: 'inactive', to: 'active',
    input: [{ name: 'reason', type: 'str', max: 200, optional: true }] })
  activate(): void {}

  @action('ping')
  ping(): void {}
}

export { User as UserFixture };
```
The class is named `User` (the IR `entity` value must be `User` to match the fixture); the export alias keeps test imports readable. Fix the list-item name rule now: in `fields.ts` `listOf`, replace `name: ''` injection with the parent's name — change `field({ type: 'list', item: ... })` usage so the decorator sets `item.name = String(propertyKey)` when empty. Concretely, in `field()` add before `addField`:

```ts
    const f: FieldSpec = { name: String(propertyKey), ...def } as FieldSpec;
    if (f.type === 'list' && f.item && f.item.name === '') f.item = { ...f.item, name: f.name };
    addField(target.constructor, f);
```

- [ ] **Step 7: Run tests** — `pnpm test` in `node/packages/entity`. The parity test failure output shows the first differing bytes; iterate until byte-identical, schema-valid, all green. Common trap: TS class property declaration order = decorator call order for distinct properties, so field order matches the fixture.

- [ ] **Step 8: Write `scripts/emit-fixture.ts`** (used by CI parity in Task 10):

```ts
import { entitySpecCanonical } from '../src/index';
import { UserFixture } from '../src/testing/user-fixture';
process.stdout.write(entitySpecCanonical(UserFixture));
```
Verify: `pnpm exec tsx scripts/emit-fixture.ts | diff - ../../../contracts/fixtures/entity-spec.valid-user.json` → empty.

- [ ] **Step 9: Commit** — `git add node/packages/entity && git commit -m "feat(entity): @Restful/@action/field decorators emit contract-parity EntitySpec IR"`

### Task 9: Python entity package — decorators + parity

**Files:**
- Create: `python/packages/entity/pyproject.toml`, `scripts/check.sh`, `src/server_decorator_entity/{__init__.py,py.typed,types.py,canonical.py,markers.py,action.py,restful.py,testing/__init__.py,testing/user_fixture.py}`, `tests/unit/test_canonical.py`, `tests/unit/test_entity_spec.py`, `scripts/emit_fixture.py`

**Interfaces:**
- Consumes: contract fixture from Task 6 (byte-parity target).
- Produces (Tasks 10, 12 consume): `@restful(path=..., transports=[...])`, `@action("name", from_state=..., to_state=..., input=[...])`, marker classes `Id, Str, Email, Uuid, Uri, Int, Float, Bool, Datetime, EnumOf, Ref, ListOf, Obj` used inside `Annotated[...]`; `entity_spec(cls) -> dict`; `entity_spec_canonical(cls) -> str`; fixture `server_decorator_entity.testing.user_fixture.UserFixture`.

- [ ] **Step 1: Scaffold.** `python/packages/entity/pyproject.toml`:

```toml
[project]
name = "server-decorator-entity"
version = "2.0.2"
description = "Declarative entity decorators emitting the language-neutral EntitySpec IR. Polyglot sibling of @montionugera/entity-spec."
readme = "README.md"
requires-python = ">=3.10"
license = {text = "MIT"}
dependencies = []

[project.optional-dependencies]
dev = ["pytest>=8", "ruff>=0.5", "mypy>=1.10", "jsonschema>=4.21"]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["src/server_decorator_entity"]

[tool.ruff]
line-length = 100
target-version = "py310"

[tool.ruff.lint]
select = ["E", "F", "I", "B", "UP", "N", "ASYNC", "RUF"]

[tool.ruff.lint.per-file-ignores]
"tests/**/*.py" = ["S101"]

[tool.mypy]
python_version = "3.10"
strict = true
files = ["src/server_decorator_entity"]

[tool.pytest.ini_options]
testpaths = ["tests"]
```
`scripts/check.sh` — copy `python/packages/core/scripts/check.sh` verbatim (paths are package-relative). Create empty `README.md` with one descriptive line. Run `cd python && uv sync --all-packages --all-extras` to register the member.

- [ ] **Step 2: Failing canonical test** — `tests/unit/test_canonical.py`:

```python
from server_decorator_entity.canonical import canonical_json


def test_sorts_keys_no_whitespace() -> None:
    assert canonical_json({"b": 1, "a": {"d": [2, 1], "c": "x"}}) == '{"a":{"c":"x","d":[2,1]},"b":1}'


def test_non_ascii_not_escaped() -> None:
    assert canonical_json({"a": "ราคา"}) == '{"a":"ราคา"}'
```
Run: `cd python/packages/entity && uv run pytest -q` → FAIL.

- [ ] **Step 3: Implement `src/server_decorator_entity/canonical.py`**

```python
"""Canonical EntitySpec JSON — contracts/rules/entity-spec-canonical.md."""
import json
from typing import Any


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
```
Run → PASS. (Builders never put `None`/defaults into the dict, so no filtering here — omission happens at build time, mirroring the TS `undefined` filter.)

- [ ] **Step 4: Failing parity test** — `tests/unit/test_entity_spec.py`:

```python
import json
from pathlib import Path

import jsonschema
import pytest

from server_decorator_entity import entity_spec, entity_spec_canonical
from server_decorator_entity.testing.user_fixture import UserFixture

CONTRACTS = Path(__file__).resolve().parents[3] / ".." / ".." / "contracts"


def test_canonical_parity_with_contract_fixture() -> None:
    expected = (CONTRACTS / "fixtures/entity-spec.valid-user.json").read_text().strip()
    assert entity_spec_canonical(UserFixture) == expected


def test_validates_against_schema() -> None:
    schema = json.loads((CONTRACTS / "schemas/entity-spec.schema.json").read_text())
    jsonschema.validate(entity_spec(UserFixture), schema)


def test_undecorated_class_raises() -> None:
    class Naked:
        pass

    with pytest.raises(TypeError, match="not decorated with @restful"):
        entity_spec(Naked)
```
(Adjust `parents[...]` depth so `CONTRACTS` resolves to the repo's `contracts/` — verify with a quick `python -c` before committing.) Run → FAIL.

- [ ] **Step 5: Implement markers** — `src/server_decorator_entity/markers.py`:

```python
"""Field markers used inside Annotated[...] on @restful classes."""
from dataclasses import dataclass, field as dc_field
from typing import Any


@dataclass(frozen=True)
class FieldMarker:
    type: str
    role: str | None = None
    format: str | None = None
    enum: tuple[str, ...] | None = None
    min: int | None = None
    max: int | None = None
    pattern: str | None = None
    optional: bool = False
    nullable: bool = False
    readonly: bool = False
    writeonly: bool = False
    filterable: bool = False
    item: "FieldMarker | None" = None
    ref: str | None = None
    fields: tuple[tuple[str, "FieldMarker"], ...] | None = None  # (name, marker) pairs for obj

    def to_ir(self, name: str) -> dict[str, Any]:
        ir: dict[str, Any] = {"name": name, "type": self.type}
        if self.role: ir["role"] = self.role
        if self.format: ir["format"] = self.format
        if self.enum: ir["enum"] = list(self.enum)
        if self.min is not None: ir["min"] = self.min
        if self.max is not None: ir["max"] = self.max
        if self.pattern: ir["pattern"] = self.pattern
        for flag in ("optional", "nullable", "readonly", "writeonly", "filterable"):
            if getattr(self, flag): ir[flag] = True
        if self.item: ir["item"] = self.item.to_ir(name)
        if self.ref: ir["ref"] = self.ref
        if self.fields is not None:
            ir["fields"] = [m.to_ir(n) for n, m in self.fields]
        return ir


def Id() -> FieldMarker: return FieldMarker(type="str", role="id", readonly=True)
def Str(**kw: Any) -> FieldMarker: return FieldMarker(type="str", **kw)
def Email(**kw: Any) -> FieldMarker: return FieldMarker(type="str", format="email", **kw)
def Uuid(**kw: Any) -> FieldMarker: return FieldMarker(type="str", format="uuid", **kw)
def Uri(**kw: Any) -> FieldMarker: return FieldMarker(type="str", format="uri", **kw)
def Int(**kw: Any) -> FieldMarker: return FieldMarker(type="int", **kw)
def Float(**kw: Any) -> FieldMarker: return FieldMarker(type="float", **kw)
def Bool(**kw: Any) -> FieldMarker: return FieldMarker(type="bool", **kw)
def Datetime(**kw: Any) -> FieldMarker: return FieldMarker(type="datetime", **kw)
def EnumOf(*values: str, **kw: Any) -> FieldMarker: return FieldMarker(type="enum", enum=values, **kw)
def Ref(entity: str, **kw: Any) -> FieldMarker: return FieldMarker(type="ref", ref=entity, **kw)
def ListOf(item: FieldMarker, **kw: Any) -> FieldMarker: return FieldMarker(type="list", item=item, **kw)
def Obj(fields: list[tuple[str, FieldMarker]], **kw: Any) -> FieldMarker:
    return FieldMarker(type="obj", fields=tuple(fields), **kw)
```
(N-naming: these are intentionally CapWords factory functions so declarations read like types; add `# noqa: N802` where ruff complains, at each def line.)

- [ ] **Step 6: Implement `src/server_decorator_entity/action.py`**

```python
from typing import Any, Callable, TypeVar

from server_decorator_entity.markers import FieldMarker

F = TypeVar("F", bound=Callable[..., Any])

_ATTR = "__entity_action__"


def action(
    name: str,
    *,
    state_field: str | None = None,
    from_state: str | None = None,
    to_state: str | None = None,
    input: list[tuple[str, FieldMarker]] | None = None,
    transactional: bool = True,
) -> Callable[[F], F]:
    def mark(fn: F) -> F:
        spec: dict[str, Any] = {"name": name}
        if from_state is not None or to_state is not None:
            spec["stateField"] = state_field or "status"
            if from_state is not None: spec["from"] = from_state
            if to_state is not None: spec["to"] = to_state
        if input:
            spec["input"] = [m.to_ir(n) for n, m in input]
        if not transactional:
            spec["transactional"] = False
        setattr(fn, _ATTR, spec)
        return fn
    return mark
```

- [ ] **Step 7: Implement `src/server_decorator_entity/restful.py`**

```python
import typing
from typing import Any, Callable, TypeVar

from server_decorator_entity.action import _ATTR
from server_decorator_entity.canonical import canonical_json
from server_decorator_entity.markers import FieldMarker

C = TypeVar("C", bound=type)

_SPEC_ATTR = "__entity_spec__"
_DEFAULT_OPS = ["list", "get", "create", "update", "delete"]


def _camel(name: str) -> str:
    head, *rest = name.split("_")
    return head + "".join(s.capitalize() for s in rest)


def restful(
    *,
    path: str,
    transports: list[str] | None = None,
    ops: list[str] | None = None,
    pagination: str = "offset",
) -> Callable[[C], C]:
    def wrap(cls: C) -> C:
        hints = typing.get_type_hints(cls, include_extras=True)
        fields: list[dict[str, Any]] = []
        for attr_name, hint in hints.items():
            marker = next(
                (m for m in getattr(hint, "__metadata__", ()) if isinstance(m, FieldMarker)), None
            )
            if marker is not None:
                fields.append(marker.to_ir(_camel(attr_name)))
        actions = [
            getattr(member, _ATTR)
            for member in vars(cls).values()
            if callable(member) and hasattr(member, _ATTR)
        ]
        spec: dict[str, Any] = {
            "specVersion": "1.1.0",
            "entity": cls.__name__,
            "path": path,
            "transports": transports or ["rest"],
            "ops": ops or list(_DEFAULT_OPS),
            "pagination": pagination,
            "fields": fields,
        }
        if actions:
            spec["actions"] = actions
        setattr(cls, _SPEC_ATTR, spec)
        return cls
    return wrap


def entity_spec(cls: type) -> dict[str, Any]:
    spec = getattr(cls, _SPEC_ATTR, None)
    if spec is None:
        raise TypeError(f"{cls.__name__} is not decorated with @restful")
    return spec  # type: ignore[no-any-return]


def entity_spec_canonical(cls: type) -> str:
    return canonical_json(entity_spec(cls))
```
Note: `vars(cls)` only, never the MRO — same rule as core's class decorators (N2). Python dicts and `get_type_hints` preserve declaration order, matching TS.

- [ ] **Step 8: `__init__.py` + fixture.** `src/server_decorator_entity/__init__.py`:

```python
from server_decorator_entity.action import action
from server_decorator_entity.canonical import canonical_json
from server_decorator_entity.markers import (
    Bool, Datetime, Email, EnumOf, FieldMarker, Float, Id, Int, ListOf, Obj, Ref, Str, Uri, Uuid,
)
from server_decorator_entity.restful import entity_spec, entity_spec_canonical, restful

__all__ = [
    "action", "canonical_json", "restful", "entity_spec", "entity_spec_canonical",
    "FieldMarker", "Id", "Str", "Email", "Uuid", "Uri", "Int", "Float", "Bool",
    "Datetime", "EnumOf", "Ref", "ListOf", "Obj",
]
```
`src/server_decorator_entity/testing/user_fixture.py` (class named `User` so the IR `entity` matches the fixture, aliased for imports — same convention as the TS side):

```python
from typing import Annotated

from server_decorator_entity import Datetime, Email, EnumOf, Id, Int, ListOf, Obj, Str, action, restful


@restful(path="users", transports=["rest", "rpc", "sse", "ws"])
class User:
    id: Annotated[str, Id()]
    email: Annotated[str, Email(filterable=True)]
    name: Annotated[str, Str(min=2, max=80)]
    status: Annotated[str, EnumOf("inactive", "active", "banned", filterable=True)]
    login_count: Annotated[int, Int(min=0, readonly=True)]
    tags: Annotated[list[str], ListOf(Str())]
    profile: Annotated[dict | None, Obj([("bio", Str(max=500, optional=True))], optional=True)]
    birthday: Annotated[str | None, Datetime(optional=True, nullable=True)]

    @action("activate", from_state="inactive", to_state="active",
            input=[("reason", Str(max=200, optional=True))])
    def activate(self) -> None: ...

    @action("ping")
    def ping(self) -> None: ...


UserFixture = User
```
**Mirror this in Task 8:** the TS fixture class must also be named `User` (rename `UserFixture` class to `User`, keep `export { User as UserFixture }`) — otherwise `entity` differs. Apply that rename in the TS fixture before finishing this task.

- [ ] **Step 9: `scripts/emit_fixture.py`**

```python
import sys

from server_decorator_entity import entity_spec_canonical
from server_decorator_entity.testing.user_fixture import UserFixture

sys.stdout.write(entity_spec_canonical(UserFixture))
```

- [ ] **Step 10: Verify** — `cd python/packages/entity && bash scripts/check.sh` green (ruff, mypy strict, pytest). Then byte parity across languages:

```bash
cd <repo-root>
diff <(cd node/packages/entity && pnpm exec tsx scripts/emit-fixture.ts) \
     <(cd python && uv run --package server-decorator-entity python packages/entity/scripts/emit_fixture.py)
```
Expected: empty.

- [ ] **Step 11: Commit** — `git add python/packages/entity node/packages/entity && git commit -m "feat(entity-py): @restful/@action markers emit byte-identical EntitySpec IR"`

### Task 10: Cross-language parity job in CI

**Files:**
- Create: `scripts/check-entity-parity.sh`
- Modify: `.github/workflows/ci-contracts.yml`

**Interfaces:**
- Consumes: Task 8 `scripts/emit-fixture.ts`, Task 9 `scripts/emit_fixture.py`.
- Produces: `bash scripts/check-entity-parity.sh` — the one command that proves TS ≡ PY ≡ contract fixture. P2+ plans extend it with more fixture entities.

- [ ] **Step 1: Write `scripts/check-entity-parity.sh`**

```bash
#!/usr/bin/env bash
# Assert TS and Python entity declarations emit byte-identical IR, equal to the contract fixture.
set -euo pipefail
cd "$(dirname "$0")/.."

fixture=contracts/fixtures/entity-spec.valid-user.json
ts_out=$(cd node/packages/entity && pnpm exec tsx scripts/emit-fixture.ts)
py_out=$(cd python && uv run --package server-decorator-entity python packages/entity/scripts/emit_fixture.py)
expected=$(cat "$fixture")

[ "$ts_out" = "$expected" ] || { echo "FAIL: TS IR != $fixture" >&2; diff <(echo "$ts_out") <(echo "$expected") >&2 || true; exit 1; }
[ "$py_out" = "$expected" ] || { echo "FAIL: PY IR != $fixture" >&2; diff <(echo "$py_out") <(echo "$expected") >&2 || true; exit 1; }
echo "OK: entity-spec parity (TS == PY == contract fixture)"
```

- [ ] **Step 2: Add a job to `ci-contracts.yml`** (alongside the existing validate/version-match jobs, same trigger paths plus `node/packages/entity/**` and `python/packages/entity/**`):

```yaml
  entity-parity:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9.14.2 }
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: 'pnpm', cache-dependency-path: node/pnpm-lock.yaml }
      - uses: astral-sh/setup-uv@v5
      - run: cd node && pnpm install --frozen-lockfile
      - run: cd python && uv sync --all-packages
      - run: bash scripts/check-entity-parity.sh
```

- [ ] **Step 3: Run locally** — `bash scripts/check-entity-parity.sh` → OK.
- [ ] **Step 4: Commit** — `git add scripts/check-entity-parity.sh .github/workflows/ci-contracts.yml && git commit -m "ci(contracts): cross-language entity-spec parity gate"`

### Task 11: gen-zod — IR → zod validation schemas

**Files:**
- Create: `node/packages/gen-zod/package.json`, `tsconfig.json`, `jest.config.js`, `.npmignore`, `src/map-field.ts`, `src/index.ts`, `src/gen-zod.spec.ts`

**Interfaces:**
- Consumes: `EntitySpec`, `FieldSpec` types + `entitySpec()` from `@montionugera/entity-spec` (workspace dep).
- Produces (P2 adapters consume): `createSchema(spec: EntitySpec): z.ZodTypeAny`, `updateSchema(spec)`, `readSchema(spec)`, `actionInputSchema(spec, actionName: string)`. All are `.strict()` object schemas (unknown keys rejected). DTO rules: create = non-readonly fields (readonly present ⇒ rejected as unknown); update = create shape with every key optional; read = non-writeonly; action input = the action's `input` list (empty ⇒ empty strict object).

- [ ] **Step 1: Scaffold** — package.json as in Task 7 Step 1 but `"name": "@montionugera/entity-spec-gen-zod"`, plus `"dependencies": { "@montionugera/entity-spec": "workspace:*", "zod": "^3.24.0" }`. Same tsconfig/jest/.npmignore as Task 7. `cd node && pnpm install`.

- [ ] **Step 2: Failing contract-driven test** — `src/gen-zod.spec.ts`:

```ts
import { readFileSync } from 'fs';
import { join } from 'path';
import { entitySpec } from '@montionugera/entity-spec';
import { UserFixture } from '@montionugera/entity-spec/dist/testing/user-fixture';
import { actionInputSchema, createSchema, updateSchema, readSchema } from './index';

interface Case {
  name: string; dto: string; payload: unknown; valid: boolean; errorFields: string[];
}
const { cases } = JSON.parse(readFileSync(
  join(__dirname, '../../../../contracts/fixtures/entity-spec.cases.json'), 'utf8'
)) as { cases: Case[] };

const spec = entitySpec(UserFixture);

function schemaFor(dto: string) {
  if (dto === 'create') return createSchema(spec);
  if (dto === 'update') return updateSchema(spec);
  if (dto === 'read') return readSchema(spec);
  if (dto.startsWith('action:')) return actionInputSchema(spec, dto.slice(7));
  throw new Error(`unknown dto ${dto}`);
}

describe('gen-zod against contract validation cases', () => {
  for (const c of cases) {
    it(c.name, () => {
      const result = schemaFor(c.dto).safeParse(c.payload);
      expect(result.success).toBe(c.valid);
      if (!result.success) {
        const fields = [...new Set(result.error.issues.map(i => i.path.join('.')))].sort();
        expect(fields).toEqual([...c.errorFields].sort());
      }
    });
  }
});
```
Run → FAIL (module not implemented). Note the error-field rule: zod's `unrecognized_keys` issue has path `[]` and lists keys — `map-field` handling below must convert unknown-key issues so the path becomes the offending key. Implement that in `index.ts` via a `superRefine`-free approach: use `.strict()` and post-process in the test? **No — post-process in the library**, since P2 adapters need the same shape: export `validationErrorFields(error: z.ZodError): string[]` that expands `unrecognized_keys` issues into one entry per key and dot-joins other paths. Use it in the test instead of the inline mapping above:

```ts
        const fields = validationErrorFields(result.error);
        expect(fields).toEqual([...c.errorFields].sort());
```

- [ ] **Step 3: Implement `src/map-field.ts`**

```ts
import { z } from 'zod';
import { FieldSpec } from '@montionugera/entity-spec';

export function zodForField(f: FieldSpec): z.ZodTypeAny {
  let s: z.ZodTypeAny;
  switch (f.type) {
    case 'str': {
      let str = z.string();
      if (f.format === 'email') str = str.email();
      if (f.format === 'uuid') str = str.uuid();
      if (f.format === 'uri') str = str.url();
      if (f.min !== undefined) str = str.min(f.min);
      if (f.max !== undefined) str = str.max(f.max);
      if (f.pattern !== undefined) str = str.regex(new RegExp(f.pattern));
      s = str;
      break;
    }
    case 'int': {
      let n = z.number().int();
      if (f.min !== undefined) n = n.gte(f.min);
      if (f.max !== undefined) n = n.lte(f.max);
      s = n;
      break;
    }
    case 'float': {
      let n = z.number();
      if (f.min !== undefined) n = n.gte(f.min);
      if (f.max !== undefined) n = n.lte(f.max);
      s = n;
      break;
    }
    case 'bool': s = z.boolean(); break;
    case 'datetime': s = z.string().datetime({ offset: true }); break;
    case 'enum': s = z.enum(f.enum as [string, ...string[]]); break;
    case 'ref': s = z.string(); break;
    case 'list': s = z.array(zodForField(f.item as FieldSpec)); break;
    case 'obj': s = strictObject(f.fields ?? [], () => true); break;
  }
  if (f.nullable) s = s.nullable();
  if (f.optional) s = s.optional();
  return s;
}

export function strictObject(fields: FieldSpec[], include: (f: FieldSpec) => boolean): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const f of fields) if (include(f)) shape[f.name] = zodForField(f);
  return z.object(shape).strict();
}
```

- [ ] **Step 4: Implement `src/index.ts`**

```ts
import { z } from 'zod';
import { ActionSpec, EntitySpec, FieldSpec } from '@montionugera/entity-spec';
import { strictObject } from './map-field';

export { zodForField } from './map-field';

export function createSchema(spec: EntitySpec): z.ZodTypeAny {
  return strictObject(spec.fields, f => !f.readonly);
}

export function updateSchema(spec: EntitySpec): z.ZodTypeAny {
  return (createSchema(spec) as z.ZodObject<z.ZodRawShape>).partial();
}

export function readSchema(spec: EntitySpec): z.ZodTypeAny {
  return strictObject(spec.fields, f => !f.writeonly);
}

export function actionInputSchema(spec: EntitySpec, actionName: string): z.ZodTypeAny {
  const action: ActionSpec | undefined = spec.actions?.find(a => a.name === actionName);
  if (!action) throw new Error(`Unknown action "${actionName}" on entity ${spec.entity}`);
  return strictObject(action.input ?? [], () => true);
}

export function validationErrorFields(error: z.ZodError): string[] {
  const fields = new Set<string>();
  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const k of issue.keys) fields.add([...issue.path, k].join('.'));
    } else {
      fields.add(issue.path.join('.'));
    }
  }
  return [...fields].sort();
}
```
One subtlety the cases fixture forces: `update-empty-ok` must pass (partial makes all keys optional — it does) and `create-rejects-readonly-loginCount` passes because `loginCount` isn't in the create shape and `.strict()` flags it — with path `loginCount` via `validationErrorFields`.

- [ ] **Step 5: Run** — `cd node/packages/gen-zod && pnpm test` → all 11 cases green. `pnpm -r run build` still green (entity must build before gen-zod: pnpm topologically orders workspace deps automatically).

- [ ] **Step 6: Commit** — `git add node/packages/gen-zod node/pnpm-lock.yaml && git commit -m "feat(gen-zod): IR-derived create/update/read/action zod schemas, contract-case parity"`

### Task 12: gen-pydantic — IR → pydantic models

**Files:**
- Create: `python/packages/gen_pydantic/pyproject.toml`, `scripts/check.sh`, `README.md`, `src/server_decorator_gen_pydantic/{__init__.py,py.typed}`, `tests/unit/test_gen_pydantic.py`

**Interfaces:**
- Consumes: `entity_spec()` dicts (Task 9), `contracts/fixtures/entity-spec.cases.json` (Task 6).
- Produces (P5 adapter consumes): `create_model_for(spec) -> type[pydantic.BaseModel]`, `update_model_for(spec)`, `read_model_for(spec)`, `action_input_model_for(spec, action_name)`, `validation_error_fields(exc: pydantic.ValidationError) -> list[str]`. Same DTO rules as gen-zod; models use `extra="forbid"` and populate by wire (camelCase) names.

- [ ] **Step 1: Scaffold** — pyproject like Task 9 Step 1 but `name = "server-decorator-gen-pydantic"`, `packages = ["src/server_decorator_gen_pydantic"]`, dependencies:

```toml
dependencies = ["pydantic>=2.7", "server-decorator-entity"]

[tool.uv.sources]
server-decorator-entity = { workspace = true }
```
dev extra: `["pytest>=8", "ruff>=0.5", "mypy>=1.10"]`. `scripts/check.sh` copied as before. `cd python && uv sync --all-packages --all-extras`.

- [ ] **Step 2: Failing contract-driven test** — `tests/unit/test_gen_pydantic.py`:

```python
import json
from pathlib import Path

import pydantic
import pytest

from server_decorator_entity import entity_spec
from server_decorator_entity.testing.user_fixture import UserFixture
from server_decorator_gen_pydantic import (
    action_input_model_for, create_model_for, read_model_for, update_model_for,
    validation_error_fields,
)

CONTRACTS = Path(__file__).resolve().parents[3] / ".." / ".." / "contracts"
CASES = json.loads((CONTRACTS / "fixtures/entity-spec.cases.json").read_text())["cases"]
SPEC = entity_spec(UserFixture)


def model_for(dto: str) -> type[pydantic.BaseModel]:
    if dto == "create": return create_model_for(SPEC)
    if dto == "update": return update_model_for(SPEC)
    if dto == "read": return read_model_for(SPEC)
    if dto.startswith("action:"): return action_input_model_for(SPEC, dto[7:])
    raise ValueError(dto)


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_contract_case(case: dict) -> None:
    model = model_for(case["dto"])
    if case["valid"]:
        model.model_validate(case["payload"])
    else:
        with pytest.raises(pydantic.ValidationError) as ei:
            model.model_validate(case["payload"])
        assert validation_error_fields(ei.value) == sorted(case["errorFields"])
```
Run → FAIL.

- [ ] **Step 3: Implement `src/server_decorator_gen_pydantic/__init__.py`**

```python
"""Compile EntitySpec IR dicts into pydantic v2 models (create/update/read/action DTOs)."""
from typing import Any

import pydantic
from pydantic import ConfigDict, Field, create_model

_CONFIG = ConfigDict(extra="forbid")


def _annotation(f: dict[str, Any]) -> tuple[Any, Any]:
    """Return (type annotation, default) for one IR field."""
    t = f["type"]
    ann: Any
    kwargs: dict[str, Any] = {}
    if t == "str" or t == "ref":
        ann = str
        if f.get("format") == "email":
            ann = pydantic.EmailStr
        if "min" in f: kwargs["min_length"] = f["min"]
        if "max" in f: kwargs["max_length"] = f["max"]
        if "pattern" in f: kwargs["pattern"] = f["pattern"]
        if f.get("format") == "uuid": kwargs["pattern"] = r"^[0-9a-fA-F-]{36}$"
    elif t == "int":
        ann = int
        if "min" in f: kwargs["ge"] = f["min"]
        if "max" in f: kwargs["le"] = f["max"]
    elif t == "float":
        ann = float
        if "min" in f: kwargs["ge"] = f["min"]
        if "max" in f: kwargs["le"] = f["max"]
    elif t == "bool":
        ann = bool
    elif t == "datetime":
        ann = pydantic.AwareDatetime | pydantic.NaiveDatetime
    elif t == "enum":
        from typing import Literal
        ann = Literal[tuple(f["enum"])]
    elif t == "list":
        inner_ann, _ = _annotation(f["item"])
        ann = list[inner_ann]  # type: ignore[valid-type]
    elif t == "obj":
        ann = _model("Obj", f.get("fields", []), lambda _f: True)
    else:
        raise ValueError(f"unknown field type {t}")

    if f.get("nullable"): ann = ann | None
    default: Any = ... if not f.get("optional") else None
    if f.get("optional"): ann = ann | None
    return (ann, Field(default, **kwargs))


def _model(name: str, fields: list[dict[str, Any]], include: Any) -> type[pydantic.BaseModel]:
    defs: dict[str, Any] = {}
    for f in fields:
        if include(f):
            defs[f["name"]] = _annotation(f)
    return create_model(name, __config__=_CONFIG, **defs)


def create_model_for(spec: dict[str, Any]) -> type[pydantic.BaseModel]:
    return _model(f"{spec['entity']}Create", spec["fields"], lambda f: not f.get("readonly"))


def update_model_for(spec: dict[str, Any]) -> type[pydantic.BaseModel]:
    base = spec["fields"]
    optional = [dict(f, optional=True) for f in base if not f.get("readonly")]
    return _model(f"{spec['entity']}Update", optional, lambda f: True)


def read_model_for(spec: dict[str, Any]) -> type[pydantic.BaseModel]:
    return _model(f"{spec['entity']}Read", spec["fields"], lambda f: not f.get("writeonly"))


def action_input_model_for(spec: dict[str, Any], action_name: str) -> type[pydantic.BaseModel]:
    act = next((a for a in spec.get("actions", []) if a["name"] == action_name), None)
    if act is None:
        raise ValueError(f"Unknown action {action_name!r} on entity {spec['entity']}")
    return _model(f"{spec['entity']}Action{action_name.capitalize()}", act.get("input", []), lambda f: True)


def validation_error_fields(exc: pydantic.ValidationError) -> list[str]:
    fields: set[str] = set()
    for err in exc.errors():
        loc = [str(p) for p in err["loc"]]
        fields.add(".".join(loc))
    return sorted(fields)
```
(pydantic reports extra keys with `loc == (key,)` and `type == "extra_forbidden"`, so unknown-key paths already match gen-zod's expanded form. `EmailStr` needs `pydantic[email]` — add `"pydantic[email]>=2.7"` to dependencies instead of plain pydantic. `datetime` cases aren't in the v1 case fixture with payloads, so the str-vs-datetime coercion nuance stays out of contract scope until P2 — the annotation exists for model completeness.)

- [ ] **Step 4: Run** — `cd python/packages/gen_pydantic && bash scripts/check.sh` → all 11 cases green, mypy strict green (add `# type: ignore` narrowly where dynamic `create_model` defeats it; never blanket-disable).

- [ ] **Step 5: Commit** — `git add python/packages/gen_pydantic && git commit -m "feat(gen-pydantic): IR-derived pydantic DTO models, contract-case parity"`

### Task 13: P1 phase gate + release bookkeeping

**Files:**
- Modify: `CLAUDE.md` (commands table gains the new packages + parity script), `README.md` (one paragraph on the entity layer)

- [ ] **Step 1: Full verification sweep**

```bash
(cd node && pnpm -r test:unit && pnpm -r run build)
(cd python && bash scripts/check.sh)
bash contracts/scripts/validate.sh
bash scripts/check-entity-parity.sh
bash scripts/check-versions.sh
(cd node && pnpm -r test:e2e)   # Docker; core e2e unaffected but must stay green
```
All green, outputs captured in the PR description.

- [ ] **Step 2: Docs** — update `CLAUDE.md` (add entity/gen packages to the architecture section and the commands table; note the canonical-JSON rule and parity script) and root `README.md`.

- [ ] **Step 3: Commit** — `git add CLAUDE.md README.md && git commit -m "docs: entity-spec layer commands and architecture notes"`

- [ ] **Step 4: PHASE GATE (P1)** — independent adversarial review of the P1 diff; special attention: canonical-JSON edge cases (unicode, empty arrays, nested obj), the omit-when-default rule enforced in BOTH builders, and DTO include/exclude logic parity. Fix findings, re-run Step 1, new commits.

- [ ] **Step 5: Ship per ps-release-workflow** — `/ps-release-workflow:ship` from the feature worktree (Gate 1 precheck), then next feature or promote.

---

## Self-review notes (kept honest)

- **Spec coverage:** P0 = spec §8 P0 (Tasks 1–5). P1 = spec §8 P1 (Tasks 6–13): IR (§3–4) ✔, contracts + parity (§7 items 1–2) ✔, gen-zod/gen-pydantic (E7) ✔. NOT in this plan by design: adapters, TCK, e2e-over-HTTP, multi-replica scenario (spec §7 items 3–5, E8 runtime behavior) — those are P2/P4 plans; P1's E8 obligation (no in-process state assumptions in the IR) is met by construction.
- **Type consistency:** `entitySpec/entity_spec`, `canonicalJson/canonical_json`, `validationErrorFields/validation_error_fields`, DTO function names — cross-checked between Tasks 7–12.
- **Fixture naming:** both languages declare the fixture class as `User` (IR `entity` = "User"), exported/aliased as `UserFixture` — already consistent in Tasks 8 and 9.
