---
title: "Run the release shell tests in CI"
id: I-031
status: idea
---

# Run the release shell tests in CI

## Problem

(what hurts; concrete examples)

## Why now

(opportunity; deadline; constraint)

## Sketch

(rough shape; not a design yet)

## Acceptance criteria

- [ ] (one observable, testable outcome per item; refine refuses a spec without any)

## Finding (verified 2026-10-11)
scripts/tests/*.test.sh (3 files) are run by no workflow: grep of .github/ finds only a note at .github/SETUP.md:60 saying "not run in CI".
Done: ci-node.yml (or a new job) runs all scripts/tests/*.test.sh on every PR and push; SETUP.md:60 updated.
