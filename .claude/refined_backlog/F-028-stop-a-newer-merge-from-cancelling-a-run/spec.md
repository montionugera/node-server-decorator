---
title: "Stop a newer merge from cancelling a run before its GitHub Release"
id: F-028
status: refined
from_idea: I-032
---

# Stop a newer merge from cancelling a run before its GitHub Release

## Problem

Runs on main must never be cancelled mid-flight; PR runs still cancel superseded runs.

## Why now

Debt filed in release 2.10; Node 20 retirement and Ubuntu 26 move on 2026-10-19 make CI fragile.

## Sketch

Test first (shell structural test), then minimal workflow edit.

## Acceptance criteria

- [ ] ci-node.yml concurrency.cancel-in-progress is `${{ github.ref != 'refs/heads/main' }}`
- [ ] structural test in scripts/tests/ci-node-steps.test.sh asserts it and fails on literal true
- [ ] SETUP.md known-limitation (line 59) replaced with description of new behaviour
- [ ] other workflows checked: none publish or deploy

## Finding (verified 2026-10-11)
.github/workflows/ci-node.yml:14-16 has workflow-level concurrency with cancel-in-progress: true; the release job (line 272) needs publish (line 274), so a newer merge can cancel after publish and before release, leaving a version with no GitHub Release. Documented as a known limitation at .github/SETUP.md:59.
Done: cancel-in-progress is false for main pushes (or release job is split out), SETUP.md:59 limitation removed.
