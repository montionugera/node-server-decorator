---
title: "docs archive carries version.json for the portal"
id: I-039
status: idea
---

# docs archive carries version.json for the portal

## Problem

The developer portal downloads `docs-site.tgz` from each GitHub Release and cross-checks a root
`version.json` against the release tag (tag `v2.0.25` must match version `2.0.25`). This repo's
archive has no `version.json`, so the portal cannot switch to the downloaded docs.

## Why now

cli-state-handler's archive already has the file; this repo is the remaining blocker.

## Sketch

In the `release` job's "Build docs archive" step, after the docs build and before `tar`, write
`website/dist/version.json` as `{"version":"<x.y.z>"}` using the job's `TAG` env (the publish job's
tag output, with the leading `v` stripped) - the same source the release page step already uses.
No `${{ }}` inside the script; publish job and names untouched.

## Acceptance criteria

- [ ] The "Build docs archive" step produces an archive whose root has `version.json` equal to `{"version":"<TAG without v>"}`.
- [ ] `scripts/tests/ci-node-steps.test.sh` fails without the change and passes with it.
- [ ] `.github/SETUP.md` and README describe the file.
