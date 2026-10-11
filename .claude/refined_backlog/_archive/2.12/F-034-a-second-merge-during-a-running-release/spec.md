---
title: "A second merge during a running release ends in a red run; make back-to-back merges release cleanly"
id: F-034
status: refined
from_idea: I-036
---

# A run whose commit is already released must end green without publishing

## Problem

Run A (merge m1) bumps, rebases its bump onto main (which now holds merge m2) and tags the rebased
commit, so A's tag already contains m2 and its code was published. The queued run B (checked out at
m2) still decides `release`, bumps, and dies red at `git pull --rebase` with a CHANGELOG.md conflict.

## Choice

Two fixes were possible: (1) B rebases cleanly and releases m2 again; (2) B notices m2 is already inside
a released tag and exits green. (1) would publish a second version containing no new code and needs
CHANGELOG conflict resolution. (2) is one more rule in `release-decide.sh` (the `none` action from F-033),
and is provable offline: `git tag --contains HEAD` after the checkout's full tag fetch. Chosen: (2).

## Acceptance criteria

- [ ] decide prints `none` when HEAD is an ancestor of any `v*` tag, even if a newer tag exists on another line
- [ ] a throwaway-repo test reproduces the two-run sequence using the real workflow step bodies: A releases, B ends green with `none`, origin has exactly one new tag and no CHANGELOG conflict
- [ ] without A's tag B still decides `release` (control)
- [ ] .github/SETUP.md no longer documents the red failure as expected behaviour
