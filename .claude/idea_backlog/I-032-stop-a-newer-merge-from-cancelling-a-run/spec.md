---
title: "Stop a newer merge from cancelling a run before its GitHub Release"
id: I-032
status: idea
---

# Stop a newer merge from cancelling a run before its GitHub Release

## Problem

(what hurts; concrete examples)

## Why now

(opportunity; deadline; constraint)

## Sketch

(rough shape; not a design yet)

## Acceptance criteria

- [ ] (one observable, testable outcome per item; refine refuses a spec without any)

## Finding (verified 2026-10-11)
.github/workflows/ci-node.yml:14-16 has workflow-level concurrency with cancel-in-progress: true; the release job (line 272) needs publish (line 274), so a newer merge can cancel after publish and before release, leaving a version with no GitHub Release. Documented as a known limitation at .github/SETUP.md:59.
Done: cancel-in-progress is false for main pushes (or release job is split out), SETUP.md:59 limitation removed.
