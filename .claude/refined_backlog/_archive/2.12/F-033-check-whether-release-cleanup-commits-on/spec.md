---
title: "Check whether release cleanup commits on main trigger an extra version bump and publish (2.0.23 and 2.0.24 appeared without a feature release)"
id: F-033
status: refined
from_idea: I-038
---

# Release runs that change nothing must not bump or publish

## Problem

Versions 2.0.24 and 2.0.27 appeared next to the feature releases. Evidence (gh run list + git tags):
the "finalize X.Y cleanup on main" commits only touch `.claude/`, which no ci-node.yml push path
matches, so they start NO run (checked: zero workflow runs on those SHAs). The spurious bump is the
manual `workflow_dispatch` retrigger: `release-decide.sh` answers `release` whenever HEAD is not an
untagged bump commit, so a dispatch on an already-released HEAD (v2.0.23 -> v2.0.24 empty bump) or on
a cleanup commit publishes a new version with no code change. 2.0.27 itself was a real merge (#23).

## Sketch

`release-decide.sh` prints `action=none` when nothing but `.claude/**`, `.release.json` changed since
the last `v*` tag reachable from HEAD (zero changes included). ci-node.yml: decide runs first and every
later publish step, plus the smoke and release jobs, is skipped on `none`. Repair precedence is unchanged.

## Acceptance criteria

- [ ] decide prints `action=none` for HEAD == last tag, and for only `.claude/` or `.release.json` files since it
- [ ] decide still prints `release` when any other file changed, and `repair` for an untagged bump commit
- [ ] on `none` no step that publishes, bumps or tags runs; smoke and release jobs are skipped
- [ ] the behaviour tests in scripts/tests cover each case
