---
title: "Make core rate-limit and distributed-lock unit specs deterministic under load (3 timing failures in a full run, green alone)"
id: I-040
status: idea
---

# Make core rate-limit and distributed-lock unit specs deterministic under load

## Problem

Two core unit specs (rate-limit, distributed-lock) fail under heavy machine load and pass alone. scripts/precheck.sh hides this by retrying the unit run up to twice.

## Why now

The retry masks real regressions and slows every gate.

## Sketch

Reproduce under CPU pressure, find the root cause per spec, make tests deterministic (fake timers / injected clock) or fix a genuine product race. Then drop the retry from precheck.

## Acceptance criteria

- [ ] Both specs pass 30 consecutive runs under the pressure that reproduced the failure
- [ ] The retry-with-warning workaround is removed from precheck and its gates test updated
- [ ] Full unit suite, precheck.sh and all scripts/tests/*.test.sh pass
