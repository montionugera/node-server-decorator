# Go and Nim post-tag install smoke test Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** "want go and Nim ship too" — after every release tag, CI proves a consumer can install the Go module and the Nim package at that tag, the same way Node and Python are actually published.

**Architecture:** Two standalone, locally runnable bash scripts (`scripts/smoke-install-go.sh`, `scripts/smoke-install-nim.sh`) each take a git ref and fail non-zero if that ref is not installable. `ci-node.yml`'s existing `publish` job calls both right after its `Tag release` step, fail-closed. Docs (`nim/README.md` Install section, root `CLAUDE.md`) describe the one supported Nim install path.

**Tech Stack:** bash, GitHub Actions (`actions/setup-go@v5`, `jiro4989/setup-nim-action@v2`), Go 1.22 modules, Nim 2.2.12 / nimble.

**Spec:** `.claude/refined_backlog/F-007-go-and-nim-lanes-publish-ship-jobs-match/spec.md`

## Global Constraints

- Checks run **after** `Tag release` in the `publish` job of `.github/workflows/ci-node.yml`, and **fail closed** (no `continue-on-error`).
- Go fetch uses `GOPROXY=direct` and `GOSUMDB=off` (no public-proxy indexing lag).
- Nim install is `git clone --branch <tag> --depth 1 <repo-url>` then `cd nim && nimble install -y` — **no trailing `.`** (`nimble install -y .` fails with "Unsatisfiable dependencies" on this manifest).
- Nim toolchain pinned `nim-version: '2.2.12'`; Go via `go-version-file: go.mod` (both matching `ci-nim.yml` / `ci-go.yml`).
- Out of scope: `nim-lang/packages` index PR, any mirror repo, renaming the `publish` job.
- Locally, Nim lives at `~/.nimble/bin` — `export PATH=$HOME/.nimble/bin:$PATH` first; never brew/choosenim.
- New commits only, never `git commit --amend`.

## Corrections to the spec found while planning (verified 2026-09-13)

1. **The repository is private** (`gh repo view montionugera/node-server-decorator --json visibility` → `PRIVATE`). A fetch from a scratch directory in CI (both `go get` with `GOPROXY=direct` and `git clone`) has no credentials — `actions/checkout` only sets an auth header in the checked-out repo's local config. Task 2 adds a step that rewrites `https://github.com/montionugera/` to a token URL via global git config; the Go script (Task 1) sets `GOPRIVATE`.
2. **`go install <module>/go/entity@<tag>` cannot work** — `go/entity` is a library, and `go install` only accepts `package main`. The Go check instead builds a throwaway consumer module that imports `go/entity` — exactly what a real consumer does.
3. **`?subdir=` is not fully absent from nimble** — nimble 0.24.1 logs `using git (subdir is 'nim')` for `https://github.com/montionugera/node-server-decorator?subdir=nim@#<ref>`, but both attempts failed before install (a branch ref is rejected as "not a valid sha1"; no pushed commit contains `nim/` yet). It stays unverified; the clone path remains the supported, documented one. Filed below as a follow-up, not chased.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `scripts/smoke-install-go.sh` | Create | Resolve + build `go/entity` from a scratch consumer module at a given tag |
| `scripts/smoke-install-nim.sh` | Create | Clone at a given ref, `nimble install -y` inside `nim/` into a scratch nimble dir |
| `.github/workflows/ci-node.yml` | Modify (`publish` job, `Tag release` step and after, ~lines 129-140) | Expose the tag as a step output; set up Go + Nim; authenticate fetches; run both scripts |
| `nim/README.md` | Modify (`## Install`, lines 13-24) | Document the clone install path |
| `CLAUDE.md` | Modify (commands table + "CI workflow gating" `ci-node.yml` bullet) | Point contributors at the smoke scripts |

**Coordination:** the sibling worktree `node-server-decorator-hotfix-publish-dispatch` (branch `hotfix/npmjs-publish-lane`, unpushed commit `b1073e1`) inserts a step between "Publish Node to npm" and "Build Python packages" in the same job. This plan only touches `Tag release` and what follows it — different region. Whichever lands second rebases explicitly; never merge both blind.

---

### Task 1: Smoke-install scripts for Go and Nim

**Files:**
- Create: `scripts/smoke-install-go.sh`
- Create: `scripts/smoke-install-nim.sh`

**Interfaces:**
- Consumes: nothing.
- Produces: `bash scripts/smoke-install-go.sh <tag>` and `bash scripts/smoke-install-nim.sh <ref> [repo-url]`. Both exit 0 and print a line starting `OK:` on success, and exit non-zero on failure. Task 2 calls them with the tag only (default repo URL).

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
# Post-tag smoke test (F-007): the Nim package installs from a clone at <ref> — the documented
# consumer path, since the .nimble lives in nim/ rather than at the repository root.
# Usage: scripts/smoke-install-nim.sh <tag-or-branch> [repo-url]
set -euo pipefail

ref="${1:?usage: smoke-install-nim.sh <tag-or-branch> [repo-url]}"
url="${2:-https://github.com/montionugera/node-server-decorator.git}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

git clone --quiet --depth 1 --branch "$ref" "$url" "$work/src"
cd "$work/src/nim"
# No trailing "." — `nimble install -y .` fails with "Unsatisfiable dependencies" on this manifest.
nimble install -y --nimbleDir:"$work/nimble"

if ! compgen -G "$work/nimble/pkgs2/server_decorator-*" >/dev/null; then
  echo "FAIL: server_decorator missing from $work/nimble/pkgs2 after install" >&2
  exit 1
fi
echo "OK: server_decorator installs from $ref"
```

Then: `chmod +x scripts/smoke-install-go.sh scripts/smoke-install-nim.sh`

- [ ] **Step 3: Lint both scripts**

Run: `shellcheck scripts/smoke-install-go.sh scripts/smoke-install-nim.sh; echo "exit=$?"`
Expected: no findings, `exit=0`.

- [ ] **Step 4: Go negative check — the known-broken tag must fail**

`v2.0.0` predates `go.mod`, so it must not resolve as the `/v2` module.

Run: `out=$(bash scripts/smoke-install-go.sh v2.0.0 2>&1); echo "exit=$?"; printf '%s\n' "$out" | tail -5`
Expected: non-zero exit; the error comes from `go get` naming `v2.0.0` (for example `invalid version` or `no matching versions`), and no `OK:` line. If it prints `OK:`, the check is broken — stop and debug (`systematic-debugging`).

A Go **positive** check is impossible before promotion: no tag or pushed branch contains `go.mod` yet. It is observed on the first `publish` run after 1.2 is promoted (see Task 2, Step 6).

- [ ] **Step 5: Nim negative check — a tag without `nim/` must fail**

Run: `export PATH=$HOME/.nimble/bin:$PATH; out=$(bash scripts/smoke-install-nim.sh v2.0.0 2>&1); echo "exit=$?"; printf '%s\n' "$out" | tail -3`
Expected: non-zero exit (`cd: .../nim: No such file or directory`), no `OK:` line.

- [ ] **Step 6: Nim positive check — the current package must install**

No pushed ref contains `nim/` yet, so clone from the local repository (the release branch is in the shared git directory):

Run: `export PATH=$HOME/.nimble/bin:$PATH; out=$(bash scripts/smoke-install-nim.sh release/1.2 "file://$(git rev-parse --path-format=absolute --git-common-dir)" 2>&1); echo "exit=$?"; printf '%s\n' "$out" | tail -3`
Expected: `OK: server_decorator installs from release/1.2`, `exit=0`. (Git may warn that `--depth` is ignored for local clones — harmless.)

- [ ] **Step 7: Commit**

```bash
git add scripts/smoke-install-go.sh scripts/smoke-install-nim.sh
git commit -m "ci(F-007): Go and Nim post-tag install smoke scripts"
```

- [ ] **Step 8: Phase gate** (rule 7): verify (Steps 3-6 outputs) → independent review (`code-reviewer`, `model: sonnet`, diff < 200 lines; ask specifically about: temp-dir cleanup on failure, set -e behaviour inside pipelines, quoting) → `/simplify` → re-run Steps 3-6.

---

### Task 2: Wire the checks into the publish job, and document the Nim install path

**Files:**
- Modify: `.github/workflows/ci-node.yml` (`publish` job: `Tag release` step ~line 132, then append after it)
- Modify: `nim/README.md:13-24` (`## Install`)
- Modify: `CLAUDE.md` (commands table; "CI workflow gating" `ci-node.yml` bullet)

**Interfaces:**
- Consumes: `bash scripts/smoke-install-go.sh <tag>`, `bash scripts/smoke-install-nim.sh <tag>` from Task 1.
- Produces: step output `steps.tag.outputs.tag` (e.g. `v2.0.5`) on the `Tag release` step.

- [ ] **Step 1: Expose the tag and append the checks**

In `.github/workflows/ci-node.yml`, replace the existing `Tag release` step (the last step of the `publish` job) with:

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

      # Go and Nim have no registry push: "published" means the tag above installs (F-007).
      # Fail-closed, but npm, PyPI and the tag are already out by this point — a red step
      # means investigate before the next release; nothing is rolled back automatically.
      - uses: actions/setup-go@v5
        with: { go-version-file: go.mod, cache: false }

      - uses: jiro4989/setup-nim-action@v2
        with:
          nim-version: '2.2.12'
          repo-token: ${{ secrets.GITHUB_TOKEN }}  # avoids GitHub API rate-limit flakes when resolving the toolchain

      # The repo is private, and the smoke tests fetch from scratch dirs that don't carry
      # actions/checkout's auth header.
      - name: Authenticate fetches of this repository
        env:
          TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: git config --global url."https://x-access-token:${TOKEN}@github.com/montionugera/".insteadOf "https://github.com/montionugera/"

      - name: Smoke-install Go module at tag
        run: bash scripts/smoke-install-go.sh "${{ steps.tag.outputs.tag }}"

      - name: Smoke-install Nim package at tag
        run: bash scripts/smoke-install-nim.sh "${{ steps.tag.outputs.tag }}"
```

Keep the three existing comment lines directly above `Tag release` unchanged. Do not touch any earlier step.

- [ ] **Step 2: Lint the workflow**

Run: `actionlint .github/workflows/ci-node.yml; echo "exit=$?"`
Expected: no findings, `exit=0` (actionlint also shellchecks the `run:` blocks).

- [ ] **Step 3: Rewrite the Nim README Install section**

In `nim/README.md`, replace everything from `## Install` up to (not including) `## Declare an entity` with:

~~~~markdown
## Install

Not on the nimble directory, and a bare git-URL install (`nimble install "https://github.com/montionugera/node-server-decorator@#vX.Y.Z"`) does not work: nimble needs the `.nimble` file at the root of what it fetches, and here it lives in `nim/` of a polyglot repository. Install from a clone at the tag that matches the other lanes:

```bash
git clone --depth 1 --branch vX.Y.Z https://github.com/montionugera/node-server-decorator.git
cd node-server-decorator/nim
nimble install -y          # no trailing "." — `nimble install -y .` fails on this manifest
```

To develop against a checkout instead, run `nimble develop` inside `nim/`. CI runs the same install after every release tag (`scripts/smoke-install-nim.sh`).

> nimble 0.24 recognizes a `?subdir=nim` URL, but that form has not been verified end to end against a published tag. The clone path above is the supported one.
~~~~

- [ ] **Step 4: Update CLAUDE.md**

In `CLAUDE.md`, add this row to the "Common commands" table directly after the `Cross-version assert` row:

```markdown
| Go/Nim install smoke test | `bash scripts/smoke-install-go.sh vX.Y.Z` / `bash scripts/smoke-install-nim.sh vX.Y.Z` (post-tag; run by `ci-node.yml` `publish`) |
```

In the "CI workflow gating" list, replace the `ci-node.yml` bullet with:

```markdown
- `ci-node.yml` — unit + build on every Node/contracts PR; e2e only on `push: main` or PRs with the `run-e2e` label; auto-publishes (Node + Python) on `push: main` by patch-bumping and pushing back, tags `vX.Y.Z`, then smoke-installs the Go module and Nim package at that tag (fail-closed).
```

Run: `grep -n "smoke-install" CLAUDE.md nim/README.md .github/workflows/ci-node.yml`
Expected: 2 hits in `CLAUDE.md` (table row + bullet), 1 in `nim/README.md`, 2 in `ci-node.yml`.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci-node.yml nim/README.md CLAUDE.md
git commit -m "ci(F-007): smoke-install Go and Nim at the release tag in the publish job"
```

- [ ] **Step 6: Phase gate** (rule 7): verify (Step 2 `actionlint` + Step 4 grep + re-run Task 1 Steps 4-6) → independent review (`code-reviewer`, `model: sonnet`; ask specifically about: token exposure in the `insteadOf` step, whether the global git rewrite can affect any earlier step, `GITHUB_OUTPUT` on the idempotent-skip path) → `/simplify` → re-verify.

**Cannot be verified before promotion (state this plainly in the ship report):** the `publish` job only runs on `push: main`. The first real run happens when release 1.2 is promoted and merged. Then watch it once (`gh run watch --exit-status`) and confirm both smoke steps pass against the new tag. That run is also the first Go positive check.

---

## Follow-ups (filed, not in scope)

- Verify the nimble `?subdir=nim@#<tag>` URL form against the first tag that contains `nim/`. If it works, it becomes a one-line install alternative in `nim/README.md`.
- Mirror repo for `nimble install <name>` / community index (spec Approach B).
