# F-006 handoff

**Goal (verbatim):** "Want it all" + "using ultracode" — a Nim lane covering everything the TS lane has, split into four backlog ideas I-007 → I-008 → I-009 → I-010; for each, in order: brainstorm/spec → self-grill-audit → `psrw refine` → `psrw claim` → writing-plans → subagent-driven implementation with adversarial review → `psrw ship` into release/1.2. Never promote/merge to main without asking.

**Plan:** `.claude/refined_backlog/F-006-nim-lane-fourth-language-entity-ir-produ/plan.md` — 6 tasks (types+canonical+emit/parse, validate port, `restful` macro + fixture + compile-error harness, gen_openapi port + cases, wiring scripts/CI, docs) then `psrw ship --no-deploy`.

**State (2026-09-13):** I-007 spec audited (safe-with-fixes, applied) → refined to F-006 → claimed; worktree `.claude/worktrees/F-006-nim-lane-fourth-language-entity-ir-produ` (branch `feat/F-006`, fast-forwarded onto release/1.2 because `psrw claim` cut it from main). Every Nim file in the plan was built and run in a scratchpad on Nim 2.2.12: 6 modules / 32 tests green, IR and OpenAPI byte-identical to both fixtures, `nimble check` valid, no lockfile created (A4 verified). Plan audit: see plan's "Appendix — audit trail".

**Next:** execute the plan with subagent-driven-development inside the F-006 worktree (`export PATH=$HOME/.nimble/bin:$PATH` first), phase gates as written, then `psrw ship --no-deploy`. Then repeat the chain for I-008, I-009, I-010. Stop before `psrw promote`.
