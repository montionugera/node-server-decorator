# I-006 handoff

**Goal (verbatim):** Take the Go-lane idea from `idea -> spec`: capture it in the ps-release-workflow backlog and brainstorm it into a solid, approved spec (do NOT refine or claim it — that gate is deliberate).

**Plan:** `.claude/idea_backlog/I-006-go-lane-third-language-via-go-generate-e/plan.md` — 7 tasks (wire types, builder + parity, generator + drift gate, parity script, version lockstep, CI wiring, docs + sweep) + post-merge tag/`go list` check.

**State (2026-09-13):** spec approved by user and committed (`0ec4eb3`). Plan written; every Go file, the `check-versions.sh` block and the `sed` rewrite were built and run in a scratchpad first (gofmt/vet clean, fixture `cmp` clean, guard tests shown failing then passing). Plan audit: see plan's "Appendix — audit trail".

**Next:** user decides whether to `psrw refine I-006` then `psrw claim F-NNN`. Only after both, execute the plan with subagent-driven-development inside the claimed worktree. Never run refine/claim without that explicit go-ahead.
