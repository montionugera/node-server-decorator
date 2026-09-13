# Go and Nim post-tag install smoke test Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** "want go and Nim ship too" — after every release tag, CI proves a consumer can install the Go module and the Nim package at that tag, and a Go-only or Nim-only merge to `main` cuts a release like a Node change does.

**Architecture:** Two standalone, locally runnable bash scripts (`scripts/smoke-install-go.sh`, `scripts/smoke-install-nim.sh`) each take a tag and fail non-zero if a consumer cannot install that tag from GitHub. A new `smoke` job in `ci-node.yml` runs both after the existing `publish` job (`needs: publish`), fail-closed and re-runnable on its own. Locally, both scripts are tested before promotion against a scratch bare repository carrying a throwaway tag, reached through a git URL rewrite.

**Tech Stack:** bash, GitHub Actions (`actions/setup-go@v5`, `jiro4989/setup-nim-action@v2`), Go 1.22 modules, Nim 2.2.12 with its bundled nimble 0.24.1.

**Spec:** `.claude/refined_backlog/F-007-go-and-nim-lanes-publish-ship-jobs-match/spec.md`

## Global Constraints

- Checks run **after** the tag is pushed, and **fail closed** (no `continue-on-error`).
- Go fetch uses `GOPROXY=direct` and `GOSUMDB=off` (no public-proxy indexing lag).
- Nim install uses `nimble install -y "https://github.com/montionugera/node-server-decorator?subdir=nim@#<tag>"`; the documented fallback is a clone plus `cd nim && nimble install -y` — **no trailing `.`** (`nimble install -y .` fails with "Unsatisfiable dependencies" on this manifest).
- Nim toolchain pinned `nim-version: '2.2.12'`; Go via `go-version-file: go.mod` (both matching `ci-nim.yml` / `ci-go.yml`).
- Out of scope: `nim-lang/packages` index PR, any mirror repo, renaming the `publish` job, the missing `python/**` push path (filed below).
- Never push a test tag to `origin`. Test tags exist only inside a scratch bare repository.
- Locally, Nim lives at `~/.nimble/bin` — `export PATH=$HOME/.nimble/bin:$PATH` first; never brew/choosenim.
- The executing agents' shell is zsh: capture exit codes as `out=$(cmd 2>&1); echo "exit=$?"`, never `${PIPESTATUS[...]}`.
- New commits only, never `git commit --amend`.

## Corrections to the spec (verified 2026-09-13, planning + self-grill-audit)

1. **The repository is private** (`gh repo view montionugera/node-server-decorator --json visibility` → `PRIVATE`). Fetches from scratch directories carry no credentials, so the CI smoke steps pass a token URL rewrite through `GIT_CONFIG_*` environment variables, scoped to those steps.
2. **`go install <module>/go/entity@<tag>` cannot work** — `go/entity` is a library and `go install` only accepts `package main`. The Go check builds a throwaway consumer module that imports `go/entity`.
3. **Nim one-line install DOES work — spec lines 47-55 are wrong.** Against a scratch bare repo tagged `v2.0.99` (reached via `url.<file-url>.insteadOf`), `nimble install -y "https://github.com/montionugera/node-server-decorator?subdir=nim@#v2.0.99"` installed `server_decorator-2.0.4`; the root URL without `?subdir=nim` failed with "Could not find a file with a .nimble extension". The Nim check and the README now lead with the `?subdir=nim` form. (The community index still can't point at a subdirectory, so spec Approach B stays parked.)
4. **A Go positive check IS possible before promotion**, using the same scratch-bare-repo rewrite (auditor ran it: `OK`, exit 0).
5. **Smoke steps inside `publish` could not be retried**: re-running `publish` fails at the version-bump `git push` (ci-node.yml:108). They go in a separate `smoke` job.
6. **Not "every push to main"**: the push trigger only matches `node/**`, `contracts/**` and `ci-node.yml` (ci-node.yml:8), so a Go-only or Nim-only merge never bumps, tags or publishes. Task 2 adds `go/**`, `go.mod` and `nim/**` to the push paths.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `scripts/smoke-install-go.sh` | Create | Resolve + build `go/entity` from a scratch consumer module at a given tag |
| `scripts/smoke-install-nim.sh` | Create | `nimble install` the `?subdir=nim` URL at a given tag into a scratch nimble dir |
| `.github/workflows/ci-node.yml` | Modify: push `paths` (line 8), `publish` job gets `outputs` + `id: tag`, new `smoke` job appended | Wire the checks |
| `nim/README.md` | Modify (`## Install`, lines 13-24) | Document the one-line install, clone as fallback |
| `CLAUDE.md` | Modify (commands table + "CI workflow gating" `ci-node.yml` bullet) | Point contributors at the smoke scripts |

**Coordination:** the sibling worktree `node-server-decorator-hotfix-publish-dispatch` (branch `hotfix/npmjs-publish-lane`, unpushed commit `b1073e1`) only adds lines after "Publish Node to npm" (ci-node.yml:117). This plan touches line 8, the job header area of `publish` (lines 55-65) and appends after the last step. Whichever lands second rebases explicitly; never merge both blind.

---

### Task 1: Smoke-install scripts for Go and Nim

**Files:**
- Create: `scripts/smoke-install-go.sh`
- Create: `scripts/smoke-install-nim.sh`

**Interfaces:**
- Consumes: nothing.
- Produces: `bash scripts/smoke-install-go.sh <tag>` and `bash scripts/smoke-install-nim.sh <tag>`. Both fetch from `https://github.com/montionugera/node-server-decorator` (overridable only through git config, e.g. `GIT_CONFIG_*` env), exit 0 and print a line starting `OK:` on success, and exit non-zero on failure. Task 2 calls them with the tag.

- [ ] **Step 1: Write the Go script**

Create `scripts/smoke-install-go.sh`:

```bash
#!/usr/bin/env bash
# Post-tag smoke test (F-007): a fresh consumer module can resolve and build go/entity at <tag>.
# go/entity is a library, so this builds an importing module rather than `go install`-ing it.
# Usage: scripts/smoke-install-go.sh <tag>        e.g. v2.0.5
set -euo pipefail

tag="${1:?usage: smoke-install-go.sh <tag>}"
module="github.com/montionugera/node-server-decorator/v2"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Scratch caches so a warm local cache can't mask a broken tag; -modcacherw lets rm -rf clean up.
export GOPATH="$work/gopath" GOMODCACHE="$work/modcache" GOFLAGS=-modcacherw
# Straight from the git tag: no public-proxy indexing lag, and the repo is private.
export GOPROXY=direct GOSUMDB=off GOPRIVATE="github.com/montionugera/*"

mkdir "$work/consumer"
cd "$work/consumer"
go mod init example.com/smoke >/dev/null 2>&1
cat > main.go <<EOF
package main

import _ "$module/go/entity"

func main() {}
EOF

go get "$module@$tag"
go build ./...
echo "OK: $module/go/entity@$tag resolves and builds"
```

- [ ] **Step 2: Write the Nim script**

Create `scripts/smoke-install-nim.sh`:

```bash
#!/usr/bin/env bash
# Post-tag smoke test (F-007): the Nim package installs at <tag> the way nim/README.md documents.
# ?subdir=nim is required because the .nimble lives in nim/, not at the repository root.
# Usage: scripts/smoke-install-nim.sh <tag>       e.g. v2.0.5
set -euo pipefail

tag="${1:?usage: smoke-install-nim.sh <tag>}"
url="https://github.com/montionugera/node-server-decorator?subdir=nim@#$tag"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

nimble --version | head -n 1
nimble install -y --nimbleDir:"$work/nimble" "$url"

if ! compgen -G "$work/nimble/pkgs2/server_decorator-*" >/dev/null; then
  echo "FAIL: server_decorator missing from $work/nimble/pkgs2 after install" >&2
  exit 1
fi
echo "OK: server_decorator installs from $url"
```

Then: `chmod +x scripts/smoke-install-go.sh scripts/smoke-install-nim.sh`

- [ ] **Step 3: Lint both scripts**

Run: `shellcheck scripts/smoke-install-go.sh scripts/smoke-install-nim.sh; echo "exit=$?"`
Expected: no findings, `exit=0`.

- [ ] **Step 4: Build the scratch fixture (a bare repo with a throwaway tag)**

Use the session scratchpad directory as `$S` (never the repo, never `/tmp` directly). The tag is created ONLY in the scratch bare repo — never in this repository, never pushed.

```bash
S=<session scratchpad>/f007-fixture
common="$(cd "$(git rev-parse --git-common-dir)" && pwd)"
git clone --quiet --bare "$common" "$S/bare.git"
git -C "$S/bare.git" tag v2.99.0 "$(git rev-parse HEAD)"
git -C "$S/bare.git" cat-file -e v2.99.0:go.mod && git -C "$S/bare.git" cat-file -e v2.99.0:nim/server_decorator.nimble && echo fixture-ok
```

Expected: `fixture-ok`. (`HEAD` is the feature branch, which contains `go.mod` and `nim/`; Task 1's scripts need not be committed yet since they run from the working tree.)

Every local run below uses this rewrite prefix, so `https://github.com/montionugera/node-server-decorator` resolves to the fixture:

```bash
export GIT_CONFIG_COUNT=2 \
  GIT_CONFIG_KEY_0="url.file://$S/bare.git.insteadOf" GIT_CONFIG_VALUE_0="https://github.com/montionugera/node-server-decorator" \
  GIT_CONFIG_KEY_1="protocol.file.allow" GIT_CONFIG_VALUE_1="always"
export PATH=$HOME/.nimble/bin:$PATH
```

- [ ] **Step 5: Positive checks — the fixture tag must install**

Run (with the Step 4 exports): `out=$(bash scripts/smoke-install-go.sh v2.99.0 2>&1); echo "exit=$?"; printf '%s\n' "$out" | tail -3`
Expected: `exit=0`, last line `OK: github.com/montionugera/node-server-decorator/v2/go/entity@v2.99.0 resolves and builds`.

Run (with the Step 4 exports): `out=$(bash scripts/smoke-install-nim.sh v2.99.0 2>&1); echo "exit=$?"; printf '%s\n' "$out" | tail -3`
Expected: `exit=0`, last line starts `OK: server_decorator installs from`.

- [ ] **Step 6: Negative checks — broken tags must fail**

`v2.0.0` exists in the fixture (cloned from this repo) but predates `go.mod` and `nim/`.

Run (with the Step 4 exports): `out=$(bash scripts/smoke-install-go.sh v2.0.0 2>&1); echo "exit=$?"; printf '%s\n' "$out" | tail -3`
Expected: non-zero exit, no `OK:` line; the `go get` error names `v2.0.0` (observed: `found (v2.0.0+incompatible), but does not contain package .../v2`).

Run (with the Step 4 exports): `out=$(bash scripts/smoke-install-nim.sh v2.0.0 2>&1); echo "exit=$?"; printf '%s\n' "$out" | tail -3`
Expected: non-zero exit, no `OK:` line.

Run (with the Step 4 exports): `out=$(bash scripts/smoke-install-nim.sh v9.9.9 2>&1); echo "exit=$?"; printf '%s\n' "$out" | tail -3`
Expected: non-zero exit (tag does not exist), no `OK:` line.

If any negative prints `OK:`, the check is broken — stop and debug (`systematic-debugging`).

- [ ] **Step 7: Commit**

```bash
git add scripts/smoke-install-go.sh scripts/smoke-install-nim.sh
git commit -m "ci(F-007): Go and Nim post-tag install smoke scripts"
```

- [ ] **Step 8: Phase gate** (rule 7): verify (Steps 3, 5, 6 outputs) → independent review (`code-reviewer`, `model: sonnet`, diff < 200 lines; ask specifically about temp-dir cleanup on failure, quoting, and whether a stale nimble/Go cache could mask a broken tag) → `/simplify` → re-run Steps 3, 5, 6.

---

### Task 2: Wire a `smoke` job into ci-node.yml, and document the installs

**Files:**
- Modify: `.github/workflows/ci-node.yml` (line 8 push paths; `publish` job header lines 55-65; `Tag release` step ~line 132; append a `smoke` job at the end)
- Modify: `nim/README.md:13-24` (`## Install`)
- Modify: `CLAUDE.md` (commands table; "CI workflow gating" `ci-node.yml` bullet)

**Interfaces:**
- Consumes: `bash scripts/smoke-install-go.sh <tag>`, `bash scripts/smoke-install-nim.sh <tag>` from Task 1.
- Produces: job output `needs.publish.outputs.tag` (e.g. `v2.0.5`).

- [ ] **Step 1: Let Go-only and Nim-only merges trigger a release**

In `.github/workflows/ci-node.yml`, change only the `push:` block's `paths` (line 8; leave the `pull_request` paths on line 5 unchanged, so Go/Nim PRs don't run Node tests):

```yaml
  push:
    branches: [main]
    paths: ['node/**', 'contracts/**', 'go/**', 'go.mod', 'nim/**', '.github/workflows/ci-node.yml']
```

- [ ] **Step 2: Expose the tag from the `publish` job**

In the `publish` job, add an `outputs` block directly after `runs-on: ubuntu-latest`:

```yaml
    outputs:
      tag: ${{ steps.tag.outputs.tag }}
```

Then change the `Tag release` step (keep its three comment lines above it unchanged — it stays the last step of `publish`, so they remain true) to:

```yaml
      - name: Tag release
        id: tag
        run: |
          tag="v$(node -p "require('./node/packages/core/package.json').version")"
          echo "tag=$tag" >> "$GITHUB_OUTPUT"
          if git ls-remote --exit-code --tags origin "refs/tags/$tag" >/dev/null; then
            echo "Tag $tag already exists on origin; skipping."
          else
            git tag "$tag"
            git push origin "$tag"
          fi
```

- [ ] **Step 3: Append the `smoke` job**

Append at the end of the file (same indentation level as `publish:`):

```yaml
  # Go and Nim have no registry push: "published" means the tag installs (F-007). Separate
  # job so a failure can be re-run alone — re-running `publish` would fail at the bump push.
  # Fail-closed, but npm, PyPI and the tag are already out: red means investigate, not rollback.
  smoke:
    name: Smoke-install Go + Nim at tag
    needs: [publish]
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ needs.publish.outputs.tag }}

      - uses: actions/setup-go@v5
        with: { go-version-file: go.mod, cache: false }

      - uses: jiro4989/setup-nim-action@v2
        with:
          nim-version: '2.2.12'
          repo-token: ${{ secrets.GITHUB_TOKEN }}  # avoids GitHub API rate-limit flakes when resolving the toolchain

      # The repo is private and scratch-dir fetches carry no checkout auth header. The rewrite
      # lives in step env (not `git config --global`), so the token never lands in ~/.gitconfig
      # and never touches the checkout step.
      - name: Go module installs at tag
        env:
          GIT_CONFIG_COUNT: '1'
          GIT_CONFIG_KEY_0: url.https://x-access-token:${{ secrets.GITHUB_TOKEN }}@github.com/montionugera/.insteadOf
          GIT_CONFIG_VALUE_0: https://github.com/montionugera/
        run: bash scripts/smoke-install-go.sh "${{ needs.publish.outputs.tag }}"

      - name: Nim package installs at tag
        env:
          GIT_CONFIG_COUNT: '1'
          GIT_CONFIG_KEY_0: url.https://x-access-token:${{ secrets.GITHUB_TOKEN }}@github.com/montionugera/.insteadOf
          GIT_CONFIG_VALUE_0: https://github.com/montionugera/
        run: bash scripts/smoke-install-nim.sh "${{ needs.publish.outputs.tag }}"
```

Rationale check before moving on: with `permissions: contents: read`, this job's `GITHUB_TOKEN` is read-only, so the rewrite carries no write access.

- [ ] **Step 4: Lint the workflow**

Run: `actionlint .github/workflows/ci-node.yml; echo "exit=$?"`
Expected: no findings, `exit=0`.

- [ ] **Step 5: Rewrite the Nim README Install section**

In `nim/README.md`, replace everything from `## Install` up to (not including) `## Declare an entity` with:

~~~~markdown
## Install

Not on the nimble directory. Install straight from the git tag that matches the other lanes:

```bash
nimble install "https://github.com/montionugera/node-server-decorator?subdir=nim@#vX.Y.Z"
```

`?subdir=nim` is required: the repository root is a polyglot workspace, and without it nimble reports "Could not find a file with a .nimble extension". CI installs every release tag this way (`scripts/smoke-install-nim.sh`).

Fallback, or to develop against a checkout:

```bash
git clone --depth 1 --branch vX.Y.Z https://github.com/montionugera/node-server-decorator.git
cd node-server-decorator/nim
nimble install -y          # no trailing "." — `nimble install -y .` fails on this manifest (use `nimble develop` for local dev)
```
~~~~

- [ ] **Step 6: Update CLAUDE.md**

In `CLAUDE.md`, add this row to the "Common commands" table directly after the `Cross-version assert` row:

```markdown
| Go/Nim install smoke test | `bash scripts/smoke-install-go.sh vX.Y.Z` / `bash scripts/smoke-install-nim.sh vX.Y.Z` (post-tag; the `smoke` job in `ci-node.yml` runs both) |
```

In the "CI workflow gating" list, replace the `ci-node.yml` bullet with:

```markdown
- `ci-node.yml` — unit + build on every Node/contracts PR; e2e only on `push: main` or PRs with the `run-e2e` label; auto-publishes (Node + Python) on `push: main` touching `node/`, `contracts/`, `go/`, `go.mod` or `nim/` by patch-bumping, pushing back and tagging `vX.Y.Z`; a follow-up `smoke` job then installs the Go module and Nim package at that tag (fail-closed, re-runnable alone).
```

Run: `grep -c "smoke-install" CLAUDE.md nim/README.md .github/workflows/ci-node.yml`
Expected: `CLAUDE.md:1`, `nim/README.md:1`, `.github/workflows/ci-node.yml:2`.

- [ ] **Step 7: Commit**

```bash
git add .github/workflows/ci-node.yml nim/README.md CLAUDE.md
git commit -m "ci(F-007): smoke job installs Go and Nim at the release tag; Go/Nim merges trigger publish"
```

- [ ] **Step 8: Phase gate** (rule 7): verify (Step 4 `actionlint`, Step 6 grep, re-run Task 1 Steps 5-6 against the fixture) → independent review (`code-reviewer`, `model: sonnet`; ask specifically about token exposure via `GIT_CONFIG_KEY_0`, `needs.publish.outputs.tag` on the idempotent tag-skip path, and whether the new push paths can trigger a publish loop with the `[skip ci]` bump commit) → `/simplify` → re-verify.

**Cannot be verified before promotion (state this plainly in the ship report):** `publish` and `smoke` only run on `push: main`. After release 1.2 is promoted and merged, watch that run once (`gh run watch --exit-status`) and confirm the `smoke` job passes against the real tag.

---

## Follow-ups (filed, not in scope)

- `python/**` is also missing from the push paths, so a Python-only merge never publishes.
- Nimble downloads the official package list on every fresh `--nimbleDir`; if that ever flakes the `smoke` job, cache or pre-seed it.
- Mirror repo for `nimble install <name>` / community index (spec Approach B).

## Appendix — audit trail

- 2026-09-13 self-grill-audit (plan rev 1): verdict **safe-with-fixes**, no CRITICAL/HIGH. Corrected in rev 2: a Go positive check and a `?subdir=nim` positive check both run before promotion via a scratch bare repo (auditor evidence re-inspected: `server_decorator-2.0.4` installed from fixture tag `v2.0.99`); Nim check and README switched to the `?subdir=nim` one-liner (refutes spec lines 47-55); smoke steps moved to a separate `smoke` job (re-running `publish` fails at ci-node.yml:108); `go/**`, `go.mod`, `nim/**` added to push paths (ci-node.yml:8 blind spot); token rewrite scoped to the two smoke steps' env, with a read-only job token instead of `git config --global`; `Tag release` stays last in `publish` so its comment stays true; Go negative error text updated to the observed message; fragile `--path-format` command removed. Open: none.
