---
title: "F-004 execution handoff"
id: F-004
from_idea: I-005
release: "1.2"
status: refined, planned, NOT claimed, NOT started
written: 2026-08-16
---

# F-004 — REST/OpenAPI generator: execution handoff

Read this file first. It is the only state that survives between sessions.

## Goal (verbatim — restate before every batch of work)

> Add a `gen-openapi` package to each language that compiles the existing EntitySpec IR
> into a **byte-identical** OpenAPI 3.1 document, so a consumer can go from a decorated
> class to a real REST contract without writing route code by hand.

Scope is **release 1.2**. HTTP adapters (Express / FastAPI) are explicitly **out** — they
come after, and they will be conformance-tested against the document this release produces.

## The two documents that matter

| What | Path (relative to repo root) |
|---|---|
| Design spec (approved) | `docs/superpowers/specs/2026-08-15-rest-openapi-generator-design.md` |
| Implementation plan (12 TDD tasks) | `docs/superpowers/plans/2026-08-15-rest-openapi-generator.md` |

Both are committed on `release/1.2` in the `_release` worktree. The plan contains full
source for every file to be created — there are no placeholders and nothing says
"translate the other language". Follow it literally.

## Where things stand

- Release `1.2` is **in progress**. `_release` worktree lives at `.claude/worktrees/_release`, on branch `release/1.2`.
- Commits so far on `release/1.2`, newest first:
  - `f83a76f` docs(plan): implementation plan for gen-openapi (F-004)
  - `b111a9f` chore(backlog): promote I-005 → F-004
  - `70fd8e9` docs(spec): pin scope-string convention, exclude object-level auth
  - `957e019` docs(spec): REST delivery layer part 1 — OpenAPI generator design
  - `01151b9` chore(backlog): add I-005
- **F-004 is not claimed.** No feature worktree exists. **No implementation code has been written.**
- Current versions: `contracts/VERSION` = `1.1.0`; all packages = `2.0.4`.

## Next command

```bash
psrw claim F-004
```

That creates the isolated feature worktree. Do all implementation there — the
PreToolUse guard blocks Edit/Write in the main checkout by **filesystem location**, not
branch name, so checking out a branch in the main tree will still be refused.

A fresh worktree has **no `node_modules`**. Run the install and build before testing:

```bash
cd node && pnpm install --frozen-lockfile && pnpm -r run build
```

(Task 1 exists precisely to make that build step unnecessary going forward.)

## The 12 tasks

| # | Task | Note |
|---|---|---|
| 1 | Fix clean-checkout build order, add `exports` map | Unblocks everything; a 4th package hits the same failure otherwise |
| 2 | Write `contracts/rules/rest-conventions.md` | Conventions pinned **before** any generator implements them |
| 3 | Node entity accepts `description`, `tags`, `security` | `specVersion` stays `1.1.0` so the commit is green |
| 4 | Python entity — same three options | same |
| 5 | Bump contract to `1.2.0` + extend shared fixture | **Atomic and deliberately large.** Schema const, both emitters and the golden fixture cannot land separately without a red tree in between |
| 6 | Node `gen-openapi`: field → JSON Schema mapper | |
| 7 | Node `gen-openapi`: components (DTO schemas, envelope, problems) | |
| 8 | Node `gen-openapi`: paths + document assembly | |
| 9 | Python `gen_openapi` — complete mirror | Full source is in the plan; do not re-derive it |
| 10 | Case-driven coverage against `contracts/fixtures/entity-spec.cases.json` | Required by CLAUDE.md: a change that only updates one language's tests is incomplete |
| 11 | Golden document, `check-openapi-parity.sh`, meta-schema validation | The byte-identical gate |
| 12 | ADR 0008, CI wiring, version lockstep | Closes the release |

Every task in the plan is TDD-shaped: write the failing test → run it and confirm it
fails → implement → run and confirm it passes → commit.

## Constraints that will bite if forgotten

- **Contract changes are a package deal.** Touching `contracts/` requires bumping
  `contracts/VERSION`, updating `CHANGELOG.md`, and patching **both**
  `node/packages/core/src/_contract.ts` and
  `python/packages/core/src/server_decorator/_contract.py` in the same commit.
  `ci-contracts.yml` fails otherwise. This is why Task 5 is atomic.
- **Lockstep versions.** Eight packages ship at one version. Use
  `bash scripts/bump-version.sh`, never `pnpm version` alone.
- **Layering.** `entity` → `gen-*` → adapters. A `gen-openapi` package imports only its
  own language's `entity` package — never the other language, never `core`.
- **All new IR fields are optional**, so existing specs stay valid.
- **Never `git commit --amend`.** New commit on top, always.
- Scope strings are **permissions** (`user:write`), not roles (`superadmin`) and not
  relationships (`owner`). Object-level/ownership authorization is permanently out of
  contract scope — the spec's Non-goals section records why.
- The `.html` renders next to each `.md` are local view artifacts. Leave them untracked.

## Open decision for the next session

Execution mode was never settled. The user's global CLAUDE.md rule 6 defaults plan
execution to **subagent-driven** (fresh subagent per task, two-stage review) and says not
to re-prompt. But this environment was configured with "do not call the Agent tool unless
the user requested it". Ask once, then proceed under rule 6's "keep going, don't
checkpoint for permission" — R1 steps get done and reported, not asked about.
