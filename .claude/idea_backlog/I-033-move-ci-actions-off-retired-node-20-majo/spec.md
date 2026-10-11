---
title: "Move CI actions off retired Node 20 majors and pin ubuntu runner"
id: I-033
status: idea
---

# Move CI actions off retired Node 20 majors and pin ubuntu runner

## Problem

Actions on retired Node 20 majors.

## Why now

Debt filed in release 2.10; Node 20 retirement and Ubuntu 26 move on 2026-10-19 make CI fragile.

## Sketch

Test first (shell structural test), then minimal workflow edit.

## Acceptance criteria

- [ ] every uses: is on a major whose action.yml declares runs.using node24 (or composite/docker)
- [ ] each target verified with gh api; inputs adapted to breaking changes
- [ ] structural test forbids known old majors
- [ ] pypi environment, job and step names untouched; runs-on left as-is unless reason shown

## Finding (verified 2026-10-11)
Old majors across .github/workflows: actions/checkout@v4 (ci-go:18, ci-contracts:46,71, ci-python:25,37, ci-rust:18, ci-nim:20, ci-node:25,45,71,241,279, ci-interop:30); actions/setup-node@v4 (ci-contracts:47,74, ci-node:28,48,79,162,283, ci-interop:33); pnpm/action-setup@v4 (ci-contracts:72, ci-node:26,46,76,281, ci-interop:31); actions/setup-go@v5 (ci-go:20, ci-contracts:78, ci-node:245); astral-sh/setup-uv@v3/v5 (ci-python:26,38, ci-node:86, ci-interop:38, ci-contracts:76); jiro4989/setup-nim-action@v2 (ci-nim:23, ci-contracts:81, ci-node:248); pypa/gh-action-pypi-publish@release/v1 (ci-node:211). No setup-python or artifact actions exist.
runs-on: ubuntu-latest at ci-go:16, ci-contracts:44,69, ci-python:17,32, ci-rust:16, ci-nim:16, ci-node:20,40,60,237,275, ci-interop:27 (moves to Ubuntu 26 on 2026-10-19).
Done: each action on a Node 24 major (verify per action), runner pinned or tested on ubuntu-26, CI green.
