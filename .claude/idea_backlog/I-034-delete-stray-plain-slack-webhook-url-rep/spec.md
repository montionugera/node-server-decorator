---
title: "Delete stray plain SLACK_WEBHOOK_URL repo variable (secret exists)"
id: I-034
status: idea
---

# Delete stray plain SLACK_WEBHOOK_URL repo variable (secret exists)

## Problem

(what hurts; concrete examples)

## Why now

(opportunity; deadline; constraint)

## Sketch

(rough shape; not a design yet)

## Acceptance criteria

- [ ] (one observable, testable outcome per item; refine refuses a spec without any)

## Finding (verified 2026-10-11)
Claim "webhook is only a variable" is wrong: SLACK_WEBHOOK_URL exists BOTH as a secret and as a plain repository variable (gh variable list / gh secret list, names only). No workflow references it (grep of .github/workflows finds nothing); only .github/SLACK_SETUP.md:44 mentions it, telling the user to create a secret.
Done: the plain variable is deleted (it exposes the webhook to anyone with read access), and either a workflow uses the secret or SLACK_SETUP.md is marked as not wired.
