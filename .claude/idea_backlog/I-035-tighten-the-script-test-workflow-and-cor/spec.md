---
title: "Tighten the script-test workflow and correct the release queue note"
id: I-035
status: idea
---

# Tighten the script-test workflow and correct the release queue note

## Problem

ci-scripts.yml only triggers on a narrow paths filter although the tests scan every workflow file; it has no permissions block; SETUP.md claims a second run on main "waits in the queue", which is misleading.

## Why now

Review findings on release 2.10.

## Sketch

Widen paths to .github/workflows/**, add contents: read, rewrite the SETUP.md note, extend ci-shell-tests.test.sh.

## Acceptance criteria

- [ ] ci-scripts.yml triggers on .github/workflows/** and has top-level permissions contents: read, asserted by scripts/tests/ci-shell-tests.test.sh
- [ ] SETUP.md describes the real serialised-run behaviour
