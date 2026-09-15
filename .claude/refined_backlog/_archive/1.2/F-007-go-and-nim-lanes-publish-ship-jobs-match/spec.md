---
title: "Go and Nim lanes: publish/ship jobs matching Node+Python"
id: F-007
status: refined
from_idea: I-011
---

# Go and Nim lanes: publish/ship jobs matching Node+Python

## Problem

`ci-node.yml` has one `publish` job (`Bump & Publish (Node + Python)`) that, on every push
to `main`, patch-bumps all four language manifests in lockstep, publishes Node to GitHub
Packages and Python to PyPI, then pushes one unified `vX.Y.Z` git tag. `go/` and `nim/` have
their manifests bumped by the same script and are asserted in lockstep by
`scripts/check-versions.sh`, but neither has ANY step that verifies a consumer can actually
install the version the tag claims to publish. The two new language lanes (F-005 Go, F-006
Nim) ride along on the tag with zero verification that the tag is actually consumable.

## Why now

F-005 and F-006 have both shipped into `release/1.2` (not yet promoted). This is the right
moment to close the gap before the next promote cuts the first tag that includes both new
manifests — otherwise a broken Go or Nim consumer experience ships silently, the same way an
untested npm/PyPI publish step would.

## Investigation — what "publish" can even mean here (findings, not sketch)

Node and Python have real package registries with a push step. Go and Nim do not — both are
consumed by resolving a package name against a version control location, so "ship" for them
means something narrower: **make sure the tag we already cut is actually installable.**
Two things were verified empirically (not assumed) before writing this spec, and one
of them contradicts the framing this idea started with:

1. **Go is fine, once a tag exists.** `go.mod` (`module .../v2`) lives at the repo root, so
   Go's ordinary multi-package-per-module resolution applies — `go/entity` is just a
   subpackage path, no monorepo problem. The only reason a live test
   (`go get github.com/montionugera/node-server-decorator/v2@v2.0.0`) fails today is that
   `v2.0.0` predates `go.mod` (added later, in F-005, not yet promoted/tagged). This is a
   sequencing artifact, not a design flaw — the next tag cut after promotion will include
   `go.mod` and should resolve normally. This needs a real post-tag check to become
   confirmed rather than assumed, because it has never been tested against a real tag.

2. **Nim does NOT work today, and the original framing was wrong.** Empirically verified:
   `nimble install "https://github.com/montionugera/node-server-decorator@#v2.0.0"` fails
   with `Could not find a file with a .nimble extension inside the specified directory`.
   Nimble's git-URL install method (and the community `nim-lang/packages` index's URL field)
   both require the `.nimble` file at the URL's root — confirmed against
   https://nim-lang.github.io/nimble/create-packages.html (no subdirectory/monorepo
   mechanism documented) and https://github.com/nim-lang/packages/blob/master/README.md
   (index schema: `name`/`url`/`method`/`tags`/`description`/`license`, single URL, no
   subdir field). Our `.nimble` lives at
   `nim/server_decorator.nimble`, inside a polyglot monorepo. **A plain `nimble install
   server_decorator` or `requires "https://github.com/.../node-server-decorator"` will
   never work against this repo's current layout**, regardless of tagging.

This second finding reverses part of the direction chosen in this idea's batch-grill round
(which had picked "smoke test + Nim community index, draft the PR now") — that PR would be
rejected today (the index's own requirement is "the package should be installable"), and
making it pass would mean standing up and permanently syncing a second, mirror-only GitHub
repo whose root holds just the `nim/` contents. That is real, ongoing infrastructure for a
"nice to have" distribution channel on a decorator library — disproportionate to this idea's
size. **This spec scopes Nim down to what already works: clone the monorepo, `cd nim/`,
`nimble install`** — and documents that instead of chasing one-line `requires` support.

## Design

### Approach A — chosen: post-tag smoke test + docs, no new repo

Append two steps to the existing `ci-node.yml` `publish` job, after the `Tag release` step
(the tag must exist first — both checks need to resolve a real tag):

- **Go check:** `GOPROXY=direct GOSUMDB=off go install github.com/montionugera/node-server-decorator/v2/go/entity@<tag>`
  in a scratch `GOPATH`/`GOMODCACHE`. `GOPROXY=direct` fetches straight from the git tag
  instead of the public module proxy, so there's no proxy-indexing lag to race — this is
  what makes fail-closed (your answer) safe instead of flaky.
- **Nim check:** in a scratch dir, `git clone --branch <tag> --depth 1 <repo-url> tmp &&
  cd tmp/nim && nimble install -y` (no trailing `.` — verified live: `nimble install -y .` fails with "Unsatisfiable dependencies", `nimble install -y` against the same manifest succeeds) using a scratch `NIMBLE_DIR` (this is exactly how a
  human consumer would install it, and exactly what will be documented in `nim/README.md`).

Both run in the same job, right after `Tag release`, and **fail closed** — a bad tag turns
the job red, per your answer. (Note: by the time this runs, Node/npm and Python/PyPI have
already published and the tag is already pushed — "fail closed" here means the release run
is flagged and must be investigated before the next one, not that it prevents the
already-completed npm/PyPI publish or un-pushes the tag. Rolling those back is a separate,
manual action if the check ever fails.)

`nim/README.md` gets a new "Installing" section: `git clone` + `cd nim && nimble install` (no trailing `.`)
(or `nimble develop` for local dev), explicitly noting there is no `requires
"nim-package-name"` one-liner support because of the monorepo layout.

**Toolchain note for the plan:** the `publish` job runs on the same `ubuntu-latest` runner as
today, but it currently only sets up Node/pnpm/uv. It needs `actions/setup-go@v5` (matching
`ci-go.yml`) and `jiro4989/setup-nim-action@v2` pinned to `2.2.12` (matching `ci-nim.yml`)
added as steps before the two new checks.

**Not in this scope:** the `nim-lang/packages` community index PR (dropped — would fail
review today) and any mirror/sync repo (disproportionate new infra). Both are recorded as a
follow-up idea below rather than silently dropped.

**Implementation coordination note:** the sibling worktree
`node-server-decorator-hotfix-publish-dispatch` (branch `hotfix/npmjs-publish-lane`, one
unpushed commit `b1073e1`) already edits this exact `ci-node.yml` `publish` job — it inserts
an npmjs.com publish step between the existing "Publish Node to npm" and "Build Python
packages" steps. This spec's steps append after `Tag release` (the last step), so the two
edits land in different regions of the same job block, but whoever implements this plan
should land one before the other (or rebase explicitly) rather than merge both blind.

### Approach B — considered, not chosen: synced mirror repo for Nim

Stand up a second GitHub repo (e.g. `server-decorator-nim`) whose root always mirrors
`nim/`'s contents (via a `git subtree push` step added to the same publish job), point the
community index and `nimble install <name>` at that repo. This is the only way to get real
one-line `nimble install`/`requires` support. Rejected for this spec: a second repo to keep
in sync forever, a new failure mode (sync step breaks, mirror drifts), and a maintenance
burden for a "nice to have" install path when `git clone && cd nim && nimble install`
already works and is one doc paragraph. Parked as a follow-up idea (see below) in case Nim
consumer demand ever justifies it.

## Testing

- Both new steps are themselves the verification — a broken Go/Nim tag turns the job red.
- Before merging the CI change: manually run both check commands locally against the
  current `v2.0.0` tag (Go) — expected to fail, confirming the check actually catches the
  known-broken case — and against a local clone of this branch's `nim/` (Nim) — expected to
  pass, confirming the check doesn't false-positive on a working package.
- After the next promote+tag: watch the `publish` job once; both new steps should go green
  against the real new tag, closing the gap `F-006/plan.md:1628` already flagged ("AC5 (CI
  green) is observed on the release PR after `psrw ship`" — i.e. confirmable only once a
  real tag exists, same reasoning as this spec's Go finding above).

## Follow-up ideas (parked, not in this spec)

- Mirror repo for real `nimble install <name>` / community index support (Approach B above).
- Whatever the parked `hotfix/npmjs-publish-lane` sibling worktree was for (publishing Node
  to npmjs.com in addition to GitHub Packages) — unrelated to this idea, mentioned only so
  it isn't confused with it.

## Decisions (batch-grill, 2026-09-13)

- Scope of "ship" for Go/Nim → post-tag installability smoke test — catches real breakage,
  no registry involved for either language.
- Job placement → appended to `ci-node.yml`'s existing `publish` job — same job already has
  the tag in context; nothing new to wire.
- Fail mode → fail-closed — paired with `GOPROXY=direct` for Go so there's no proxy-lag
  false failure to guard against.
- Nim community index registration → **reversed after this spec's investigation** (see
  above): dropped from scope, not drafted. The chosen "draft the PR now" answer assumed the
  package was already installable at the repo URL; it verifiably is not, so the PR would
  fail the index's own requirements today. Parked as Approach B above.

## Appendix — audit trail

- 2026-09-13 self-grill-audit: verdict **safe-with-fixes**. Corrected: dropped the trailing
  `.` from every `nimble install` invocation (CRITICAL — `nimble install -y .` verifiably
  fails with "Unsatisfiable dependencies" against this exact manifest; `nimble install -y`
  against the same manifest succeeds and installs `server_decorator-2.0.4` — re-verified
  live before editing); added the `hotfix/npmjs-publish-lane` edit-collision coordination
  note (HIGH — same `ci-node.yml` `publish` job, different insertion point); corrected the
  AC5 citation to `F-006/plan.md:1628` (MEDIUM — prior text misattributed it to "the final
  review"); added direct doc citations for the Nimble monorepo-install claim (LOW). Open:
  none — all CRITICAL/HIGH/MEDIUM/LOW findings applied.
