# F-007 handoff

- **Goal (verbatim):** "want go and Nim ship too" — after each release tag, CI proves the Go module and Nim package install at that tag.
- **Spec:** `.claude/refined_backlog/F-007-go-and-nim-lanes-publish-ship-jobs-match/spec.md` (approved by user 2026-09-13)
- **Plan:** `.claude/refined_backlog/F-007-go-and-nim-lanes-publish-ship-jobs-match/plan.md` (2 tasks)
- **State (2026-09-13):** I-011 refined to F-007 on release/1.2; plan written; self-grill-audit of the plan next; not yet claimed.
- **Next:** apply audit fixes → `psrw claim F-007` → fast-forward `release/1.2` into the new feature worktree (claim cuts from main) → subagent-driven-development on the plan.
- **Can't verify before promote:** the `publish` job runs only on `push: main`; the Go positive check and both CI steps are first observed after 1.2 promotes.
