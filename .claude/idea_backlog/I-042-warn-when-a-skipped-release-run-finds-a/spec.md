---
title: "Warn when a skipped release run finds a tag that has no GitHub Release"
id: I-042
status: idea
---

# Warn when a skipped release run finds a tag that has no GitHub Release

## Problem

If `publish` tags vX and then `release` (GitHub Release + docs archive) fails, "Re-run all jobs"
checks out the same commit; `release-decide.sh` sees HEAD inside tag vX and returns `none`, so every
later job skips and the run ends green with no Release page, docs archive or portal signal.

## Why now

An independent review of release 2.12 found it. "Re-run failed jobs" works, but "Re-run all jobs" is the obvious button.

## Sketch

When the decision is `none` and HEAD is contained in a `v*` tag, check that tag for a GitHub Release
carrying `docs-site.tgz`. If missing, still run the `release` job for that tag (already idempotent: it
creates the Release or re-uploads the asset). Publish, tag and smoke steps stay gated on `action != none`.

## Acceptance criteria

- [ ] A `none` run on a commit inside tag vX whose Release (or docs-site.tgz) is missing outputs vX, and the release job runs for it; no package is re-published.
- [ ] A `none` run whose tag already has its Release with docs-site.tgz outputs nothing and does nothing.
- [ ] A gh failure other than "release not found" fails the step loudly.
- [ ] Tests cover both cases; `.github/SETUP.md` documents the behaviour, that a `none` run still enters the `pypi` environment, and that the decide step uses the runner's `node`.
