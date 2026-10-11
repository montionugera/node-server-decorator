---
title: "Run the release shell tests in CI"
id: F-029
status: refined
from_idea: I-031
---

# Run the release shell tests in CI

## Problem

scripts/tests/*.test.sh run in no workflow.

## Why now

Debt filed in release 2.10; Node 20 retirement and Ubuntu 26 move on 2026-10-19 make CI fragile.

## Sketch

Test first (shell structural test), then minimal workflow edit.

## Acceptance criteria

- [ ] pull-request CI has a job that runs every scripts/tests/*.test.sh and fails if any fails
- [ ] a structural test asserts the job exists and loops over all test files
- [ ] SETUP.md no longer says 'not run in CI'

## Finding (verified 2026-10-11)
scripts/tests/*.test.sh (3 files) are run by no workflow: grep of .github/ finds only a note at .github/SETUP.md:60 saying "not run in CI".
Done: ci-node.yml (or a new job) runs all scripts/tests/*.test.sh on every PR and push; SETUP.md:60 updated.
