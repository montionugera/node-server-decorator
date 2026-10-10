# Release notes, GitHub Release with docs archive, and portal signal: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing publish run of `node-server-decorator` also write a `CHANGELOG.md` entry, create a GitHub Release with the docs site attached as `docs-site.tgz`, repair a half-published version from the manual trigger, and carry a switched-off developer-portal signal, without changing how or where packages are published.

**Architecture:** Two small shell scripts (`release-notes.sh`, `release-decide.sh`) plus edits inside the existing `publish` job of `.github/workflows/ci-node.yml`, and one new `release` job in the same file that only has `contents: write`. No step is moved or renamed, and nothing new sits between the first registry publish and the version tag.

**Tech Stack:** bash, git, `gh` (GitHub CLI), GitHub Actions YAML, `actionlint` (workflow linter, installed at `/usr/local/bin/actionlint`), ruby (stdlib YAML; used only on the developer machine, by one test and the Task 0 step lister, to read step bodies; no workflow runs these tests, so the runner needs no ruby and CI gains no dependency), pnpm 9.14.2, Astro + Storybook (docs site in `website/`).

**Spec:** `.claude/idea_backlog/I-030-adopt-release-notes-github-release-with/spec.md` (I-030 is this idea's backlog id; after `psrw refine` the same file lives under `.claude/refined_backlog/F-NNN-*/spec.md`). Read it before starting.

## Global Constraints

- **Merging this change to `main` publishes one real, permanent version** (expected 2.0.22) to GitHub Packages, npmjs.com and PyPI. Nothing in this plan assumes that approval. Every irreversible step is prefixed `STOP — needs the owner's yes:`.
- The npmjs.com step and the PyPI step stay in `.github/workflows/ci-node.yml`, job `publish`, `environment: pypi`. Both registries use trusted publishing (the registry trusts this repo + workflow file + environment through a short-lived identity token), so a rename or move can break the next release.
- No new workflow file. No change to the bump rule, the primary registry (GitHub Packages), or `concurrency`. `ref: main` is **not** added to the checkout.
- Out of scope, do not build: anything in the spec's "Separate follow-ups" list (stop cancelling a publish on `main`, `ref: main`, a third decide outcome `none`, a shared reusable workflow), the portal downloading the archive, setting `PORTAL_DISPATCH_TOKEN`, backfilling old releases. Off-goal discoveries go as one line in `docs/superpowers/ideas.md`, not into this change.
- Never run the manual trigger (`workflow_dispatch`, `gh workflow run`) to "try it": it bumps and publishes a real version.
- Never `git commit --amend`; one commit per logical unit. Do not touch the sibling worktrees `../node-server-decorator-*`. The main checkout blocks edits; all work is in the feature worktree.
- Bot bump commit title, exact: `chore: bump patch version [skip ci]`. Fallback note lines, exact: `- Maintenance release` (empty range) and `- Release X.Y.Z` (notes failed).

## File Map

| File | Action | Responsibility |
|---|---|---|
| `scripts/release-notes.sh` | create | Print one `- <commit title>` per commit between a previous tag and an end ref |
| `scripts/release-decide.sh` | create | Print `action=repair` or `action=release` |
| `scripts/tests/release-notes.test.sh`, `release-decide.test.sh`, `ci-node-steps.test.sh` | create | Plain-bash tests (the repo has no bash test runner; none is added) |
| `.github/workflows/ci-node.yml` | modify | `publish` job edits + new `release` job |
| `CHANGELOG.md` | create | One-line header; entries are written by the publish run |
| `README.md`, `.github/SETUP.md`, `CLAUDE.md` (line 84 only) | modify | Describe the new behaviour |

## How this is verified without publishing

- **Scripts** run against throwaway git repositories under `mktemp -d`, with a local bare repository as `origin`. They never contact GitHub.
- **Workflow step bodies** are read out of the YAML by `scripts/tests/ci-node-steps.test.sh` and executed in a fixture with `npm`, `pnpm` and `gh` replaced by stub scripts first on `PATH` that only append their arguments to a log file. No registry or GitHub call is possible. Step bodies are run with `bash -e` and no `pipefail`, which is how GitHub runs a step that has no `shell:` key. All three test files are **local only**: nothing in `.github/workflows` runs them (checked: no workflow on `main` references `scripts/tests`), and this change does not wire them in.
- **Workflow structure** is checked by `actionlint` and by diff commands against `origin/main`. **Docs archive** is built locally with `pnpm docs:build` and `tar`.
- **Only the one real merge can prove:** that GitHub accepts the edited workflow, that npmjs.com and PyPI still trust it, that the `release` job creates the page and uploads the asset with the run's token, and the live-run acceptance criteria. **Nothing before a genuine mid-run failure can prove** the `repair` path end to end, that `pnpm -r publish` skips versions already on GitHub Packages, or that PyPI `skip-existing` works together with attestations.

---

### Task 0: Workspace and baseline

**Files:** none edited. **Produces:** a feature worktree, `$BASE` (a saved copy of the workflow as on `main`).

- [ ] **Step 1: Promote the idea and claim it.** From the `_release` worktree (`.claude/worktrees/_release`, the long-lived checkout of branch `release/2.9`): run `psrw refine I-030` (mints feature id F-NNN and commits the backlog move locally), then `psrw claim F-NNN` (creates the isolated feature worktree; it prints the path). `cd` into that path for everything below. Neither command pushes or contacts GitHub (checked in the toolkit source, `~/.claude/ps-release-workflow/scripts/promote_idea_to_refined.py` and `init_work_refined_backlog.py`: no `git push`, no `gh` call); both only commit on the local `release/2.9` branch.
- [ ] **Step 2: Install dependencies** (a fresh worktree has none): `(cd node && pnpm install --frozen-lockfile) && (cd website && pnpm install --frozen-lockfile)`. Expected: both exit 0.
- [ ] **Step 3: Confirm the starting point matches `main`.** Run `git fetch origin main && git diff --stat origin/main -- .github/workflows scripts README.md .github/SETUP.md`. Expected: no output. Then the spec's sequencing check: `git diff origin/main fix/npmjs-trusted-publishing -- .github/workflows/ci-node.yml .github/SETUP.md`. Expected: no output (or "unknown revision" if that branch was deleted, which is equally fine). Any other output: stop and report.
- [ ] **Step 4: Save the baseline and define the step lister** used by later gates:

```bash
BASE=$(mktemp); git show origin/main:.github/workflows/ci-node.yml > "$BASE"
steps(){ ruby -ryaml -e 'j=YAML.load_file(ARGV[0])["jobs"]["publish"]; puts "env=#{j["environment"]}"; j["steps"].each{|s| puts(s["name"]||s["uses"])}' "$1"; }
steps "$BASE" | head -3   # Expected: env=pypi / actions/checkout@v4 / pnpm/action-setup@v4
```

### Task 1: `scripts/release-notes.sh`

**Files:** Create `scripts/release-notes.sh`; Test `scripts/tests/release-notes.test.sh`.
**Interfaces:** Produces `bash scripts/release-notes.sh <previous tag> [<end ref>, default HEAD]`: stdout is one `- <title>` line per non-merge commit in `<previous tag>..<end>`, oldest first, bot bump commits removed; `- Maintenance release` when the range is empty; non-zero exit when the argument is missing or the tag is unknown.

- [ ] **Step 1: Write the failing test** `scripts/tests/release-notes.test.sh`:

```bash
#!/usr/bin/env bash
# Run: bash scripts/tests/release-notes.test.sh   (throwaway repo; never touches a remote)
set -uo pipefail
R="$(cd "$(dirname "$0")/../.." && pwd)"; S="$R/scripts/release-notes.sh"; T=$(mktemp -d); trap 'rm -rf "$T"' EXIT; fail=0
check(){ if [ "$2" = "$3" ]; then echo "ok - $1"; else echo "FAIL - $1: got '$2', want '$3'"; fail=1; fi; }
check "real history v2.0.20..v2.0.21" "$(cd "$R" && bash "$S" v2.0.20 v2.0.21)" "- fix(ci): publish to npmjs.com via trusted publishing instead of NPM_TOKEN (#17)"
git init -q "$T/w"; cd "$T/w" || exit 1; git config user.email t@t; git config user.name t; git config commit.gpgsign false
c(){ git commit -q --allow-empty -m "$1"; }
c 'feat: base'; git tag v1.0.0
check "empty range -> maintenance line" "$(bash "$S" v1.0.0)" "- Maintenance release"
c 'feat: one (#1)'; c 'chore: bump patch version [skip ci]'; c 'fix: two (#2)'
check "oldest first, bump commits dropped" "$(bash "$S" v1.0.0)" $'- feat: one (#1)\n- fix: two (#2)'
check "explicit end ref" "$(bash "$S" v1.0.0 HEAD~2)" "- feat: one (#1)"
bash "$S" >/dev/null 2>&1; check "missing argument -> non-zero" "$([ $? -ne 0 ] && echo nonzero)" "nonzero"
bash "$S" v0.0.0-nope >/dev/null 2>&1; check "unknown tag -> non-zero" "$([ $? -ne 0 ] && echo nonzero)" "nonzero"
exit "$fail"
```

- [ ] **Step 2: Run it and watch it fail.** `bash scripts/tests/release-notes.test.sh`. Expected: `FAIL - real history v2.0.20..v2.0.21` (script missing), exit 1.
- [ ] **Step 3: Write `scripts/release-notes.sh`:**

```bash
#!/usr/bin/env bash
# Usage: release-notes.sh <previous tag> [<end ref>, default HEAD]
# Prints "- <commit title>" for each commit in the range, oldest first, minus the bot's bump commits.
set -euo pipefail
prev="${1:?usage: release-notes.sh <previous tag> [<end ref>]}"
log=$(git log "$prev..${2:-HEAD}" --no-merges --reverse --format='- %s')
notes=$(printf '%s\n' "$log" | grep -v '^- chore: bump patch version' | grep . || true)
printf '%s\n' "${notes:-- Maintenance release}"
```

- [ ] **Step 4: Run it and watch it pass.** `bash scripts/tests/release-notes.test.sh`. Expected: six `ok -` lines, exit 0.
- [ ] **Step 5: Commit.** `git add scripts/release-notes.sh scripts/tests/release-notes.test.sh && git commit -m "feat(release): release-notes.sh derives notes from commit titles since the previous tag"`

### Task 2: `scripts/release-decide.sh`

**Files:** Create `scripts/release-decide.sh`; Test `scripts/tests/release-decide.test.sh`.
**Interfaces:** Produces `bash scripts/release-decide.sh` (run from the repo root): stdout is exactly `action=repair` or `action=release`. `repair` only when the HEAD commit title is the bot bump title **and** `v<version in node/packages/core/package.json>` has no tag on `origin` (`git ls-remote --exit-code` returned 2). Any other `ls-remote` failure exits non-zero.

- [ ] **Step 1: Write the failing test** `scripts/tests/release-decide.test.sh`:

```bash
#!/usr/bin/env bash
# Run: bash scripts/tests/release-decide.test.sh   ("origin" is a local bare repo; never touches GitHub)
set -uo pipefail
S="$(cd "$(dirname "$0")/.." && pwd)/release-decide.sh"; T=$(mktemp -d); trap 'rm -rf "$T"' EXIT; fail=0
check(){ if [ "$2" = "$3" ]; then echo "ok - $1"; else echo "FAIL - $1: got '$2', want '$3'"; fail=1; fi; }
git init -q --bare "$T/origin.git"; git clone -q "$T/origin.git" "$T/w" 2>/dev/null; cd "$T/w" || exit 1
git config user.email t@t; git config user.name t; git config commit.gpgsign false
mkdir -p node/packages/core; echo '{"version":"9.9.9"}' > node/packages/core/package.json
git add -A; git commit -qm 'feat: something (#1)'
check "normal commit -> release" "$(bash "$S" 2>&1)" "action=release"
git commit -q --allow-empty -m 'chore: bump patch version [skip ci]'
check "bump commit, no tag on origin -> repair" "$(bash "$S" 2>&1)" "action=repair"
git tag v9.9.9; git push -q origin v9.9.9
check "bump commit, tag on origin -> release" "$(bash "$S" 2>&1)" "action=release"
git remote set-url origin "$T/missing.git"
out=$(bash "$S" 2>/dev/null); rc=$?
check "unreachable origin -> fails and prints no action" "$rc:$out" "128:"
exit "$fail"
```

- [ ] **Step 2: Run it and watch it fail.** `bash scripts/tests/release-decide.test.sh`. Expected: `FAIL - normal commit -> release`, exit 1.
- [ ] **Step 3: Write `scripts/release-decide.sh`:**

```bash
#!/usr/bin/env bash
# Prints action=repair when HEAD is the bot's bump commit and its version has no tag on origin
# (a publish run died before tagging and nothing merged since). Otherwise action=release.
set -euo pipefail
action=release
if [ "$(git log -1 --format=%s)" = "chore: bump patch version [skip ci]" ]; then
  tag="v$(node -p "require('./node/packages/core/package.json').version")"
  rc=0; git ls-remote --exit-code --tags origin "refs/tags/$tag" >/dev/null || rc=$?
  case "$rc" in
    0) ;;
    2) action=repair ;;
    *) echo "release-decide: git ls-remote failed with status $rc" >&2; exit "$rc" ;;
  esac
fi
echo "action=$action"
```

- [ ] **Step 4: Run it and watch it pass.** `bash scripts/tests/release-decide.test.sh`. Expected: four `ok -` lines, exit 0. If the last check reports a status other than 128 on this git version, change the test's expected value to the observed non-zero, non-2 status; do not change the script.
- [ ] **Step 5: Commit.** `git add scripts/release-decide.sh scripts/tests/release-decide.test.sh && git commit -m "feat(release): release-decide.sh chooses release or repair"`
- [ ] **Step 6: Phase gate for Tasks 1 and 2** (one gate; both are small and in `scripts/`):
  1. Implement: Steps above, committed.
  2. Verify: `bash scripts/tests/release-notes.test.sh && bash scripts/tests/release-decide.test.sh && shellcheck -S warning scripts/release-notes.sh scripts/release-decide.sh scripts/tests/*.test.sh`. Expected: ten `ok -` lines, no shellcheck output, exit 0. Also the spec's own check in a clone of a clone: `T=$(mktemp -d) && git clone -q . "$T/a" && git clone -q "$T/a" "$T/b" && (cd "$T/b" && bash scripts/release-decide.sh)`. Expected: `action=release`.
  3. Review: dispatch the `code-reviewer` agent on `git diff origin/main...HEAD -- scripts/`, asking specifically whether any path can print `action=repair` wrongly or hide a `git` failure.
  4. Refactor: apply the review's findings (new commit).
  5. Re-verify: repeat the command in item 2; same expected output.

### Task 3: Edits inside the existing `publish` job

**Files:** Modify `.github/workflows/ci-node.yml` (job `publish` only); Create `CHANGELOG.md`; Test `scripts/tests/ci-node-steps.test.sh`.
**Interfaces:** Consumes both scripts. Produces step id `decide` with output `action`; a `CHANGELOG.md` whose line 1 is `# Changelog` and whose newest entry starts at line 3 as `## X.Y.Z - YYYY-MM-DD`.

- [ ] **Step 1: Write the failing test** `scripts/tests/ci-node-steps.test.sh` (it reads step bodies from the YAML, so the workflow is the single source; step names here must match the YAML exactly):

```bash
#!/usr/bin/env bash
# Run: bash scripts/tests/ci-node-steps.test.sh   (npm, pnpm and gh are stubs that only log; nothing is published)
set -uo pipefail
R="$(cd "$(dirname "$0")/../.." && pwd)"; WF="$R/.github/workflows/ci-node.yml"; T=$(mktemp -d); trap 'rm -rf "$T"' EXIT; fail=0
check(){ if [ "$2" = "$3" ]; then echo "ok - $1"; else echo "FAIL - $1: got '$2', want '$3'"; fail=1; fi; }
run_of(){ ruby -ryaml -e 's=YAML.load_file(ARGV[0])["jobs"][ARGV[1]]["steps"].find{|x|x["name"]==ARGV[2]} or abort "no step: #{ARGV[2]}"; puts s["run"]' "$WF" "$1" "$2"; }
command -v ruby >/dev/null || { echo "FAIL - this test needs ruby (it is run locally only, never in CI)"; exit 1; }
# GitHub runs a step that has no `shell:` key as `bash -e` WITHOUT pipefail; run the bodies the same way.
step(){ bash -e -c "$(run_of "$1" "$2")"; }
export LOG="$T/log" RUNNER_TEMP="$T/rt" GITHUB_OUTPUT="$T/out"; : > "$LOG"; mkdir -p "$T/bin" "$RUNNER_TEMP"
printf '#!/bin/sh\necho "npm $*" >> "$LOG"\n[ "$1" = view ] && [ "$2" = "@x/a@1.0.0" ] && echo 1.0.0\nexit 0\n' > "$T/bin/npm"
printf '#!/bin/sh\nmkdir -p .t/package && cp package.json .t/package/ && tar -czf "$3/$(basename "$PWD").tgz" -C .t package && rm -rf .t\n' > "$T/bin/pnpm"
printf '#!/bin/sh\necho "gh $*" >> "$LOG"\n[ "$1 $2" = "release view" ] && exit "${GH_VIEW_RC:-1}"\nexit 0\n' > "$T/bin/gh"
chmod +x "$T/bin"/*; export PATH="$T/bin:$PATH"
mk(){ git init -q "$1"; cd "$1" || exit 1; git config user.email t@t; git config user.name t; git config commit.gpgsign false; }
mk "$T/w"; cp -R "$R/scripts" .; mkdir -p node/packages/core; echo '{"version":"9.9.10"}' > node/packages/core/package.json
printf '# Changelog\n\n## 9.9.9 - 2026-01-01\n\n- old: thing (#1)\n' > CHANGELOG.md; git add -A; git commit -qm 'feat: base'; git tag v9.9.9; git commit -q --allow-empty -m 'feat: thing (#7)'
: > "$GITHUB_OUTPUT"; step publish 'Decide release or repair' >/dev/null; rc=$?
check "decide: writes the action to the step output" "$rc:$(cat "$GITHUB_OUTPUT")" "0:action=release"
step publish 'Write CHANGELOG entry' >/dev/null
check "changelog: header kept, entry at line 3, notes at line 5" "$(sed -n '1p;3p;5p' CHANGELOG.md)" "$(printf '# Changelog\n## 9.9.10 - %s\n- feat: thing (#7)' "$(date -u +%F)")"
export TAG=v9.9.10 ASSET=docs-site.tgz; : > docs-site.tgz
GH_VIEW_RC=1 step release 'Create GitHub Release' >/dev/null
check "release: creates with verified tag, notes file and asset" "$(grep -c '^gh release create v9.9.10 --verify-tag --title v9.9.10 --notes-file notes.md docs-site.tgz$' "$LOG")" "1"
check "release: notes come from that version's section" "$(grep -c '^- ' notes.md):$(grep -c 'feat: thing (#7)' notes.md)" "1:1"
GH_VIEW_RC=0 step release 'Create GitHub Release' >/dev/null
check "release: existing release gets the asset re-uploaded, not re-created" "$(grep -c '^gh release upload v9.9.10 docs-site.tgz --clobber$' "$LOG"):$(grep -c '^gh release create' "$LOG")" "1:1"
: > "$LOG"; out=$(ASSET="" GH_VIEW_RC=1 step release 'Create GitHub Release')
check "release: without the archive it still creates the release, and warns" "$(grep -c '^gh release create v9.9.10 --verify-tag --title v9.9.10 --notes-file notes.md$' "$LOG"):$(echo "$out" | grep -c '::warning::')" "1:1"
out=$(GH_TOKEN="" step release 'Signal the developer portal')
check "portal: warns and sends nothing while the secret is unset" "$(echo "$out" | grep -c 'PORTAL_DISPATCH_TOKEN is not set'):$(grep -c 'workflow run' "$LOG")" "1:0"
git tag -d v9.9.9 >/dev/null; out=$(step publish 'Write CHANGELOG entry'); rc=$?
check "changelog: failure warns, writes placeholder, exits 0" "$rc:$(echo "$out" | grep -c '::warning::'):$(sed -n 5p CHANGELOG.md)" "0:1:- Release 9.9.10"
mk "$T/d"; cp -R "$R/scripts" .; mkdir -p node/packages/core; echo '{"version":"9.9.9"}' > node/packages/core/package.json
git add -A; git commit -qm 'chore: bump patch version [skip ci]'; git remote add origin "$T/missing.git"
: > "$GITHUB_OUTPUT"; step publish 'Decide release or repair' >/dev/null 2>&1; rc=$?
check "decide: a failing script fails the step and sets no action" "$([ "$rc" -ne 0 ] && echo nonzero):$(cat "$GITHUB_OUTPUT")" "nonzero:"
mk "$T/n"; for p in a b; do mkdir -p "packages/$p"; echo "{\"name\":\"@x/$p\",\"version\":\"1.0.0\"}" > "packages/$p/package.json"; done
git add -A; git commit -qm base; : > "$LOG"; step publish 'Publish Node to npmjs.com' >/dev/null; rc=$?
check "npmjs: publishes only the missing package" "$rc:$(grep -c '^npm publish' "$LOG"):$(grep -c '^npm publish .*/b.tgz' "$LOG")" "0:1:1"
exit "$fail"
```

- [ ] **Step 2: Run it and watch it fail.** `bash scripts/tests/ci-node-steps.test.sh`. Expected: `no step: Decide release or repair`, then `FAIL` lines, exit 1.
- [ ] **Step 3: Edit the `publish` job.** Six edits, nothing else in the job changes:
  1. Checkout: add `fetch-depth: 0` under the existing `with:` (keep `token:`). Do not add `ref:`.
  2. New step directly after "Configure git":
     ```yaml
           - name: Decide release or repair
             id: decide
             run: |
               out=$(bash scripts/release-decide.sh)
               echo "$out" | tee -a "$GITHUB_OUTPUT"
     ```
     Do not shorten this to `bash scripts/release-decide.sh | tee ...`: GitHub runs the step as `bash -e` without `pipefail`, so a failing script behind a pipe leaves the step green with an empty `action`, every `if: ... == 'release'` step is then skipped, and the job goes on to publish. The assignment form makes the step fail, as the spec requires ("Decide: fails the run").
  3. Add `if: steps.decide.outputs.action == 'release'` to exactly these steps: "Bump patch version (Node + Python in lock-step)", "Update Node lockfile", "Commit version bump", and the new step in edit 4.
  4. New step directly after "Update Node lockfile":
     ```yaml
           - name: Write CHANGELOG entry
             if: steps.decide.outputs.action == 'release'
             run: |
               v=$(node -p "require('./node/packages/core/package.json').version")
               notes=$(bash scripts/release-notes.sh "$(git describe --tags --abbrev=0 --match 'v[0-9]*' HEAD)") || notes=""
               if [ -z "$notes" ]; then
                 echo "::warning::release notes could not be derived; writing a placeholder entry"
                 notes="- Release $v"
               fi
               [ -f CHANGELOG.md ] || echo '# Changelog' > CHANGELOG.md
               { head -n 1 CHANGELOG.md; printf '\n## %s - %s\n\n%s\n' "$v" "$(date -u +%F)" "$notes"; tail -n +2 CHANGELOG.md; } > CHANGELOG.tmp
               mv CHANGELOG.tmp CHANGELOG.md
     ```
  5. "Commit version bump": append ` CHANGELOG.md` to the end of the existing `git add` line. Nothing else in that step.
  6. "Publish Node to npmjs.com": replace only the body of the final `for tgz in ...` loop; and "Publish Python to PyPI": add one input. The guard compares the version `npm view` **prints**, never its exit status. A package whose name cannot be read is counted as a failure and the loop moves on (`|| { rc=1; continue; }`), so the step still tries every package and still reaches `git checkout -- .`, as it does today.
     ```bash
               for tgz in "$RUNNER_TEMP"/npmjs/*.tgz; do
                 spec=$(tar -xOzf "$tgz" package/package.json | node -p "const p=JSON.parse(require('fs').readFileSync(0,'utf8')); p.name+'@'+p.version") || { rc=1; continue; }
                 if [ "$(npm view "$spec" version 2>/dev/null)" = "${spec##*@}" ]; then
                   echo "::notice::$spec is already on npmjs.com; skipping"
                   continue
                 fi
                 npm publish "$tgz" --access public || rc=1
               done
     ```
     ```yaml
             with:
               packages-dir: python/dist
               skip-existing: ${{ steps.decide.outputs.action == 'repair' }}
     ```
- [ ] **Step 4: Create `CHANGELOG.md`** containing the single line `# Changelog`.
- [ ] **Step 5: Run the test.** `bash scripts/tests/ci-node-steps.test.sh`. Expected: five `ok -` lines (two `decide:`, two `changelog:`, one `npmjs:`); the five `release:` / `portal:` checks still fail (`no step: ...`) until Task 4.
- [ ] **Step 6: Checks for the spec's UNVERIFIED items that are checkable now** (read-only; record each result in the commit body):
  - `gh api 'repos/pypa/gh-action-pypi-publish/contents/action.yml?ref=release/v1' --jq .content | base64 -d | grep -n -A4 'skip-existing'`. Expected: the input exists. If it does not, stop and report; do not invent another input.
  - `pnpm help publish | head -20` and the pnpm docs line the spec quotes ("versions not yet published to the registry"). This confirms documentation only; behaviour against GitHub Packages stays unproven until a real repair.
  - "What happens when the `publish` job is re-run" stays unverified on purpose: checking it would publish. The docs in Task 5 say to use the manual trigger for a genuine failure, never a re-run.
- [ ] **Step 7: Commit.** `git add .github/workflows/ci-node.yml CHANGELOG.md scripts/tests/ci-node-steps.test.sh && git commit -m "feat(ci): changelog entry, release-or-repair decision and skip guards in the publish job"`
- [ ] **Step 8: Phase gate** (full gate: publish path):
  1. Implement: Steps 1-7.
  2. Verify, all four:
     - `actionlint .github/workflows/ci-node.yml` → exit 0, no output.
     - **Publish steps unmoved:** `diff <(steps "$BASE") <(steps .github/workflows/ci-node.yml) | grep '^[<>]'` → exactly two lines, both starting with `>`: `Decide release or repair` and `Write CHANGELOG entry`. No line starts with `<`: every step that existed is still there, in the same order, under the same name. (`steps` and `$BASE` come from Task 0 Step 4; it prints `env=pypi` first, so a changed environment shows as a `<` line.)
     - `git diff --stat origin/main...HEAD -- .github/workflows` → lists only `ci-node.yml`; `grep -c 'environment: pypi' .github/workflows/ci-node.yml` → `1`; `git diff origin/main...HEAD -- .github/workflows/ci-node.yml | grep -c '^-.*\(uses: pypa\|npm publish\|pnpm -r publish\|id-token\)'` → `0` (no publish line removed; this is why edit 6 keeps the `npm publish "$tgz" --access public || rc=1` line byte-identical, indentation included).
     - `bash scripts/tests/ci-node-steps.test.sh 2>&1 | grep -c '^ok - \(decide\|changelog\|npmjs\)'` → `5`.
  3. Review: dispatch `code-reviewer` and `security-reviewer` on `git diff origin/main...HEAD -- .github/workflows/ci-node.yml`, with the spec path, asking: can any new line fail the run after the first publish; can `repair` be reached by a push run; is any `${{ }}` expression interpolated into a shell body.
  4. Refactor: apply findings (new commit).
  5. Re-verify: repeat item 2.

### Task 4: New `release` job

**Files:** Modify `.github/workflows/ci-node.yml` (append one job after `smoke`).
**Interfaces:** Consumes `needs.publish.outputs.tag` (already an output of `publish`) and the `CHANGELOG.md` section written in Task 3. Produces a GitHub Release for the tag with asset `docs-site.tgz`.

- [ ] **Step 1: Failing test already exists**: the five `release:` / `portal:` checks in `scripts/tests/ci-node-steps.test.sh` fail with `no step: Create GitHub Release`.
- [ ] **Step 2: Check the spec's UNVERIFIED docs-build items.** `node -p "require('./website/node_modules/astro/package.json').engines.node"` gives the Node range the docs site needs; use the lowest current LTS major that satisfies it as `node-version` below (the block assumes `'22'`; change that one value if the range says otherwise). Then `time pnpm docs:build && A=$(mktemp -d)/docs-site.tgz && tar -czf "$A" -C website/dist . && tar -tzf "$A" | grep -c '^\./index\.html$'`. Expected: build exits 0, prints `1`. Note the build time in the commit body. `website/dist` is build output; do not commit it.
- [ ] **Step 3: Append the job** (the signal step's shell body is the same as the one in the sibling repo `cli-state-handler`, `.github/workflows/release.yml`):

```yaml
  # Separate job on purpose: the docs build runs third-party build tooling, which must not run in a
  # job that can mint registry identity tokens, and this job can be re-run alone without publishing.
  release:
    name: GitHub Release + docs archive
    needs: [publish]
    runs-on: ubuntu-latest
    permissions: { contents: write }
    env: { TAG: '${{ needs.publish.outputs.tag }}' }
    steps:
      - uses: actions/checkout@v4
        with: { ref: '${{ needs.publish.outputs.tag }}' }
      - uses: pnpm/action-setup@v4
        with: { version: 9.14.2 }
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - name: Build docs archive
        id: docs
        continue-on-error: true
        run: |
          (cd website && pnpm install --frozen-lockfile && pnpm build)
          tar -czf docs-site.tgz -C website/dist .
          echo "built=true" >> "$GITHUB_OUTPUT"
      - name: Create GitHub Release
        env:
          GH_TOKEN: ${{ github.token }}
          ASSET: ${{ steps.docs.outputs.built == 'true' && 'docs-site.tgz' || '' }}
        run: |
          v="${TAG#v}"
          awk -v h="## $v - " 'index($0,h)==1{f=1;next} /^## /{f=0} f' CHANGELOG.md > notes.md
          grep -q '[^[:space:]]' notes.md || echo "- Release $v" > notes.md
          [ -n "$ASSET" ] || echo "::warning::docs archive was not built; releasing without docs-site.tgz"
          if gh release view "$TAG" >/dev/null 2>&1; then
            if [ -n "$ASSET" ]; then gh release upload "$TAG" "$ASSET" --clobber; fi
          else
            gh release create "$TAG" --verify-tag --title "$TAG" --notes-file notes.md ${ASSET:+"$ASSET"}
          fi
      - name: Signal the developer portal
        if: steps.docs.outputs.built == 'true'
        continue-on-error: true
        env:
          GH_TOKEN: ${{ secrets.PORTAL_DISPATCH_TOKEN }}
        run: |
          if [ -z "$GH_TOKEN" ]; then
            echo "::warning::PORTAL_DISPATCH_TOKEN is not set; the developer portal was not signalled"
            exit 0
          fi
          gh workflow run ci.yml -R montionugera/joy-design --ref main
```

- [ ] **Step 4: Run the test.** `bash scripts/tests/ci-node-steps.test.sh`. Expected: ten `ok -` lines, exit 0.
- [ ] **Step 5: Confirm the secret is absent** (read-only): `gh secret list -R montionugera/node-server-decorator | grep -c PORTAL_DISPATCH_TOKEN`. Expected: `0`. **STOP — needs the owner's yes:** creating or changing any secret or repository variable, here or in `gh-secrets`; this plan never does it. The token's scope and whether one token can serve both repos belong to follow-up (a) (the joy-design docs-archive download) and stay unverified here.
- [ ] **Step 6: Commit.** `git add .github/workflows/ci-node.yml && git commit -m "feat(ci): release job creates the GitHub Release with docs-site.tgz and an inert portal signal"`
- [ ] **Step 7: Phase gate** (full gate: release path):
  1. Implement: Steps 1-6.
  2. Verify: `actionlint .github/workflows/ci-node.yml` → exit 0; `bash scripts/tests/ci-node-steps.test.sh` → ten `ok -`, exit 0; the three "publish steps unmoved" commands from Task 3 Step 8 → same expected output; `ruby -ryaml -e 'j=YAML.load_file(ARGV[0])["jobs"]["release"]; puts j["permissions"].inspect, j.key?("environment")' .github/workflows/ci-node.yml` → `{"contents"=>"write"}` and `false`.
  3. Review: dispatch `code-reviewer` and `security-reviewer` on the `release` job diff, asking: can this job publish to any registry; can a docs-build failure block the release page; does the tag always exist before checkout.
  4. Refactor: apply findings (new commit).
  5. Re-verify: repeat item 2.

### Task 5: Documentation (written after Tasks 1-4 are verified)

**Files:** Modify `README.md` (section "Versioning", line 111), `.github/SETUP.md`, `CLAUDE.md` (line 84, the `ci-node.yml` bullet).

- [ ] **Step 1: Find every description of the release flow:** `grep -rn -i 'publish\|release' README.md CONTRIBUTING.md CLAUDE.md .github/SETUP.md | grep -i 'ci-node\|tag\|workflow' | head -30`. Edit only the three files above; if another file states something this change makes false, fix that sentence and nothing around it.
- [ ] **Step 2: `README.md`**: add a paragraph titled **Releases** under "Versioning": each version has a `CHANGELOG.md` entry and a GitHub Release page whose text is that entry; `docs-site.tgz` on the release is the built docs site (`website/dist`); if the release page or asset is missing, re-run only the `release` job (`gh run rerun --job <job id>`), which cannot publish packages.
- [ ] **Step 3: `.github/SETUP.md`**: add a section **Release notes and repair** covering: the decide rule in plain words (manual trigger on a bump commit with no tag finishes that version; anything else bumps a new one); never use the manual trigger to test; a `publish` job that died before tagging is repaired with the manual trigger, not a re-run; the portal signal is inert and `PORTAL_DISPATCH_TOKEN` must stay unset until the portal can download `docs-site.tgz`. Do not rewrite the stale `publish.yml` / `version-bump.yml` sections (filed in the spec as a separate cleanup).
- [ ] **Step 4: `CLAUDE.md` line 84**: extend the existing `ci-node.yml` bullet with one clause: the publish run also writes `CHANGELOG.md`, and a `release` job creates the GitHub Release with `docs-site.tgz`.
- [ ] **Step 5: Format and commit.** `npx prettier --check README.md .github/SETUP.md CLAUDE.md` (fix only lines you added), then `git add README.md .github/SETUP.md CLAUDE.md && git commit -m "docs: release notes, GitHub Release, docs archive and repair flow"`
- [ ] **Step 6: Phase gate:** verify `grep -c 'Releases' README.md` → `1` or more and `grep -c 'Release notes and repair' .github/SETUP.md` → `1`; review: dispatch `code-reviewer` to compare each documented statement with the workflow as written; refactor on findings (new commit); re-verify with the same two commands plus the full local suite: `bash scripts/tests/release-notes.test.sh && bash scripts/tests/release-decide.test.sh && bash scripts/tests/ci-node-steps.test.sh && actionlint .github/workflows/ci-node.yml`.

### Task 6: Ship, promote, merge, and the acceptance run (owner-gated)

- [ ] **Step 1: Pre-ship check, run by hand.** This repo has no `scripts/precheck.sh` (Gate 1, the pre-ship build/test script `psrw ship` looks for) and no `scripts/integration.sh` (Gate 2, the pre-promote script). Checked in the toolkit source (`~/.claude/ps-release-workflow/scripts/ship_current_work_to_release.py`, `_run_precheck`): when `precheck.sh` is absent, `psrw ship` prints `⚠️ Gate 1 SKIPPED — <path> not found` to stderr and **carries on with the merge**; it does not fail. So the only pre-ship check is the one run here. Do not create a `precheck.sh` in this change. Run: `git status --short` → empty; then `bash scripts/tests/release-notes.test.sh && bash scripts/tests/release-decide.test.sh && bash scripts/tests/ci-node-steps.test.sh && actionlint .github/workflows/ci-node.yml` → twenty `ok -` lines, exit 0.
- [ ] **Step 2:** **STOP — needs the owner's yes:** `psrw ship --no-deploy`, run from the feature worktree. **Local only, pushes nothing** (checked: the ship script has no `git push` and no `gh` call). What it does: fetches `origin/main` (read-only) and merges it into the local `release/2.9` if that branch is behind, merges the feature branch into local `release/2.9`, marks the feature shipped in the catalog, and **removes the feature worktree** (the branch is kept). Expect the `Gate 1 SKIPPED` warning from Step 1; that warning is not a failure. Everything after this step runs from the `_release` worktree.
- [ ] **Step 3:** **STOP — needs the owner's yes:** `psrw promote --allow-missing-gate2`, run from the `_release` worktree. **This is the first step that pushes:** it pushes `release/2.9` to GitHub and opens the pull request to `main` (`gh pr create`). The flag is needed because plain `psrw promote` refuses when `scripts/integration.sh` is missing (`Gate 2 requested but ... is missing`); with the flag the pull request body says Gate 2 did not run. Do not pass `--babysit` (it would also merge). No other `git push` is part of this plan; any other push needs its own yes.
- [ ] **Step 4:** **STOP — needs the owner's yes:** squash-merging that pull request. Say plainly when asking: this publishes one permanent version (expected 2.0.22) to GitHub Packages, npmjs.com and PyPI; the squash title becomes that version's changelog line and release text, so it should describe the change; the title must not contain `[skip ci]`; no other merge should land on `main` while the run is in flight (a second qualifying merge cancels it, existing behaviour).
- [ ] **Step 5: After the merge, check the spec's live acceptance criteria** with `V` the released version and `RUN` the run id (all read-only). Run from the `_release` worktree (the feature worktree was removed by `psrw ship`) after `git fetch origin --tags`, so the scripts and the new tag are both present:
  - `gh run view $RUN --json conclusion --jq .conclusion` → `success`; `gh run view $RUN --log | grep -c 'PORTAL_DISPATCH_TOKEN is not set'` → `1` or more.
  - `gh release view v$V --json isDraft,assets --jq '[.isDraft,.assets[].name]|@csv'` → `false,"docs-site.tgz"`.
  - `git fetch origin && git show origin/main:CHANGELOG.md | grep -c "^## $V - "` → `1`; `gh release view v$V --json body --jq .body | grep -c '^- '` equals `bash scripts/release-notes.sh v2.0.21 v$V | wc -l`.
  - `gh release download v$V -p docs-site.tgz -O - | tar -tzf - | grep -c '^\./index\.html$'` → `1`.
  - `npm view @montionugera/server-decorator@$V version --registry https://registry.npmjs.org` → `$V`; `git ls-remote --tags origin "v$V"` → one line.
  - If only the `release` job failed: **STOP — needs the owner's yes:** `gh run rerun --job <release job id>` (re-runs that job alone; it cannot publish).
- [ ] **Step 6: Report** each criterion with its command output. The `repair` path, pnpm's skip on GitHub Packages and PyPI `skip-existing` remain proven only by local tests and documentation; say so.

## If it goes wrong

- **Before merge:** nothing is published; fix forward on the feature branch with new commits, or `psrw unclaim` to abandon (the branch is kept).
- **A `publish` job died before tagging:** **STOP — needs the owner's yes:** the manual trigger (`workflow_dispatch`) on `main`, which takes the `repair` path only if nothing has merged since; otherwise it bumps a new version and the dead one stays partial (deliberate, see the spec's Risks).
- **Reverting the change:** **STOP — needs the owner's yes:** merge a revert pull request with `[skip ci]` in the squash title. A plain revert touches `ci-node.yml` and would publish one more permanent version. Keep `CHANGELOG.md` when reverting.
- **Published versions stay published;** nothing here can or should unpublish them.
- **Removing a release page:** **STOP — needs the owner's yes:** `gh release delete vX.Y.Z --yes`. Never add `--cleanup-tag`: Go consumers resolve versions from the tags.

## Audit trail

Independent audit, 2026-10-09. All embedded code was copied out of this plan into a scratch clone whose `origin` is a local bare repository, the planned workflow edits were applied to a copy of `ci-node.yml` from `origin/main`, and the tests were run there. Nothing was run in the repo, and no workflow was dispatched.

| Severity | Finding | What changed |
|---|---|---|
| HIGH | The Decide step was `release-decide.sh \| tee`. GitHub runs steps as `bash -e` without `pipefail`, so a failing script left the step green with an empty `action` (reproduced: exit 0, no output); the bump and commit steps would be skipped and the job would go on to publish. | Step now assigns the output first, so a failure fails the step. Two `decide:` checks added to the step test. |
| HIGH | The step test ran bodies with `bash -eo pipefail`, stricter than the runner, which is why it could not see the finding above; the Decide step had no test at all. | Bodies now run with `bash -e`. |
| HIGH | The "notes come from that version's section" check could not fail: the fixture changelog had one section, so an extractor that returned the whole file still passed. | Fixture now has an older section; breaking the extractor fails the check. |
| HIGH | Task 6 Step 3 said `psrw promote`; it refuses when `scripts/integration.sh` is missing, which it is. | Command is now `psrw promote --allow-missing-gate2`, with what that means. |
| HIGH | Task 6 left "what does `psrw ship` do without `precheck.sh`" to be discovered at run time, and did not say which commands push. | Stated from the toolkit source: Gate 1 is skipped with a warning and the merge proceeds; `refine`, `claim`, `ship` are local, `promote` pushes and opens the pull request. The plan's own suite is now the explicit pre-ship check. |
| MEDIUM | `shellcheck -S warning` was expected silent but printed SC2164 for a bare `cd` in all three tests. | `cd ... \|\| exit 1`. |
| MEDIUM | A failed package-name read inside the npmjs.com loop would have ended the step early, skipping the remaining packages and the tree restore. | `\|\| { rc=1; continue; }`. |
| MEDIUM | Release without the docs archive was untested. | One check added. |
| MEDIUM | `psrw ship` removes the feature worktree, so the post-merge checks had no stated place to run. | Run from the `_release` worktree after `git fetch origin --tags`. |
| LOW | Counts of expected `ok -` lines and the expected first failure were wrong for the step test. | Corrected (ten checks; five pass after Task 3). |
| LOW | Ruby dependency was not scoped. | Stated: local only, no workflow runs the tests. |

Checked and found correct: the six `publish` edits add exactly two steps, both before the first publish (`Decide release or repair`, `Write CHANGELOG entry`), remove no publish line, keep `environment: pypi` once, and change the checkout only by `fetch-depth: 0`; `cancel-in-progress`, `ref: main` and a `none` outcome are absent; the `release` job has `contents: write` only and no `environment`, and checks out the tag; `gh release create --verify-tag --title --notes-file` and `gh release upload --clobber` are valid flags; `skip-existing` is an input of the PyPI action at `release/v1`. The portal step is inert because its shell body exits early when `GH_TOKEN` (from `secrets.PORTAL_DISPATCH_TOKEN`) is empty: the repository has only `NPM_TOKEN` and `SLACK_WEBHOOK_URL`, its owner is a user account so there are no organisation secrets, and the job names no environment.

Scratch test result. Before the fixes: 6/6, 4/4 and 7/7 checks passed, `actionlint` exit 0, `shellcheck` exit 1 (SC2164), and two defects were invisible to the tests (the Decide pipe; the section extractor). After the fixes: 6/6, 4/4 and 10/10 passed, `actionlint` exit 0, `shellcheck` silent. Each of 19 deliberate breakages (9 of the two scripts, 10 of the workflow step bodies) made at least one check fail.

Still unproven until the one real merge or a genuine mid-run failure: the docs build on the runner (it was not run in this audit), the `release` job against the real GitHub API, the `repair` path end to end, pnpm skipping versions already on GitHub Packages, and PyPI `skip-existing` with attestations.
