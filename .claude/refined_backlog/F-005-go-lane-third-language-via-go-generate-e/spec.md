---
title: "Go lane: third language via go generate — entity builder API emitting EntitySpec IR + gen-openapi in Go"
id: F-005
status: refined
written: 2026-09-13
revised: 2026-09-13 (post-audit)
from_idea: I-006
---

# Go lane: third language — `entity` builder API emitting EntitySpec IR — design

## Goal

Add a Go `entity` package that emits the **byte-identical** EntitySpec IR already produced by
the Node and Python `entity` packages, so a Go consumer can declare an entity in type-checked
Go and feed the same `contracts/` pipeline — verified against
`contracts/fixtures/entity-spec.valid-user.json`.

## Non-goals (deliberately deferred)

- **`gen-openapi` in Go.** Deferred to a follow-up idea. This release ships only the IR
  producer; the OpenAPI document generator is roughly F-004's 12 tasks over again.
- **DTO validators** (the `gen-zod` / `gen_pydantic` equivalent). Go has no dominant runtime
  validation convention, so the target needs its own design round.
- **HTTP adapters.** Out of scope here exactly as they are for Node and Python (P2+).
- **Marker comments + AST parsing.** Rejected as the declaration surface (see Approaches);
  may return later as optional sugar that emits the same IR.
- **Queue / cache / tracking decorators (a Go `core`).** `core`'s runtime concerns have no Go
  analogue in this release; Go's answer is middleware, which is a separate design. A direct
  consequence: Go adds **no** `_contract` site (see Versioning).

## Decisions (batch-grill, 2026-09-13)

- **Module placement** → root `go.mod`, `module github.com/montionugera/node-server-decorator/v2`,
  packages under `go/` — the only layout where Go shares ADR 0002's single `vX.Y.Z` tag
  namespace. A subdirectory module would require `go/vX.Y.Z` tags and an ADR amendment.
  *Post-audit caveat:* sharing the namespace only helps if tags are actually pushed — today
  they are not (see Versioning → Tags).
- **Private repo** → accepted as-is; document `GOPRIVATE` + git rewrite in the Go README.
  Matches Node's existing behind-auth GitHub Packages posture.
- **First scope** → `entity` only. Smallest lane fully verifiable against `contracts/`.
- **Version gate** → committed `version.go` constant, wired into both `bump-version.sh` and
  `check-versions.sh`, mirroring Python's `_version.py`.
- **Go language version** → `go 1.22` (default, not asked) — matches the locally verified
  toolchain; nothing in the design needs anything newer.

## Approaches considered

1. **Builder API + `go generate`** — *chosen.* Plain typed Go constructs the spec; a
   `main` marshals it to IR JSON. Fully type-checked: a bad field name or marker is a
   **compile** error. Smallest machinery by a wide margin — no AST, no marker registry.
   Cost: the declaration lives beside the struct rather than on it.
2. **Marker comments + AST parsing** (`// +restful:path=/users`, parsed via
   `golang.org/x/tools/go/packages`) — closest in feel to the Node/Python decorators and
   keeps the declaration on the type. Rejected for this release: markers are strings, so
   typos surface at generate time instead of compile time, and it needs a marker parser and
   an AST traversal layer for no gain in what the IR can express.
3. **Struct tags + reflection** — `json:"email" spec:"format=email"`. Rejected: tags are
   field-level only, so there is nowhere to hang entity-level (`@Restful`) or action-level
   (`@action`) metadata, and tag contents are unchecked strings with no nesting story for
   `obj` / `list` fields.

## Architecture

Three files of library code, one generator command, and one fixture emitter. Go joins the
pipeline at the **IR boundary, not the decorator boundary** — the IR is the contract, and
`contracts/` does not care how a language produced conforming bytes. The cross-language gate
compares *documents*, not implementations.

```
go.mod                               module github.com/montionugera/node-server-decorator/v2
go/entity/spec.go                    wire types (Field, Action, Scheme, Security, Spec) + MarshalCanonical
go/entity/build.go                   builder + FieldOpt markers  <- the declaration surface
go/entity/version.go                 const Version, lockstep with node/ and python/
go/entity/testdata/html-escape.json  golden bytes for the escape test (acceptance item 2)
go/cmd/gen-entity-spec/              writes IR JSON files to -out; the //go:generate target
go/internal/example/                 the User entity mirroring entity-spec.valid-user.json
go/internal/example/emitfixture/     prints the User IR to stdout, for check-entity-parity.sh
```

**Layering rule (inherited from CLAUDE.md):** `go/entity` depends on nothing else in this
repo and on no third-party module — standard library only. It must never import `node/`,
`python/`, or a future `go/genopenapi`; the dependency arrow is `entity` → `gen-*` → adapters.

## Components

| Component | Single responsibility |
|---|---|
| `go/entity/spec.go` | The IR wire types and `MarshalCanonical` — the only place that knows the byte format |
| `go/entity/build.go` | Ergonomics: `New`/`Fields`/`Act` builders and `FieldOpt` markers. Produces values; validates nothing |
| `go/entity/version.go` | `const Version` — the runtime version export, lockstep-gated |
| `go/cmd/gen-entity-spec` | CLI: marshal declared specs to files in `-out`. The consumer-facing `go:generate` target |
| `go/internal/example` | The `User` entity; exists solely to feed the parity tests |
| `go/internal/example/emitfixture` | Prints the `User` IR to **stdout** — the Go twin of `node/packages/entity/scripts/emit-fixture.ts` and `python/packages/entity/scripts/emit_fixture.py`, because `check-entity-parity.sh` compares stdout captures, not files |

## The canonical-JSON rules (load-bearing)

The IR's byte format is **sorted keys, compact separators**. Four Go-specific constraints
produce it; each was observed failing in a throwaway prototype, and each must become a test:

1. **Struct field declaration order *is* JSON key order.** `encoding/json` emits struct
   fields in declaration order, not sorted. Every struct in `spec.go` therefore declares its
   fields in alphabetical order of JSON name. Reordering them silently breaks parity.
   *Maps need no handling* — Go sorts map keys, which is why `security.ops` is safe.
2. **`min` / `max` must be `*int`, never `int`.** The fixture contains `"min":0` on
   `loginCount` and `score`. With `omitempty` on a plain `int`, zero is indistinguishable
   from absent and both keys vanish.
3. **`SetEscapeHTML(false)` is mandatory.** Go escapes `<`, `>`, `&` to `\u003c`, `\u003e`, `\u0026` by
   default; JavaScript's `JSON.stringify` and Python's `json.dumps` do not. Any description
   containing those characters would diverge. The current `valid-user` fixture does not
   contain them, so this is a **latent** divergence the fixture cannot catch — it needs a
   dedicated test (see acceptance criteria).
4. **Go forbids a method and a struct field sharing a name.** This rules out fluent setters
   named `Min`/`Max`/`Optional` on `Field`. Markers are therefore package-level
   `FieldOpt` values (`entity.Min(2)`, `entity.Optional`), which live in a different
   namespace — and read closer to the decorator markers than fluent setters would.

## Data flow

```
Go declaration (typed, compile-checked)
   -> entity.Builder.Build()  -> entity.Spec
   -> entity.MarshalCanonical -> sorted-key compact JSON bytes
   -> gen-entity-spec -out    -> entity-spec.<path>.json      (consumer repos)
   -> emitfixture (stdout)    -> check-entity-parity.sh       (this repo)
```

For a **consumer**, the generator runs in their repo via `go generate ./...` and the artifact
is committed there. In **this** repo the IR exists only as test input; it is not a published
product of the library.

## Versioning and lockstep (ADR 0002)

Go joining the lockstep touches **five** existing files, not zero. Each is listed so none is
discovered at implementation time.

- **`go/entity/version.go`** holds `const Version = "<x.y.z>"`.
- **`scripts/bump-version.sh`** gains a `sed` rewrite of that constant, beside the existing
  `_version.py` loop (`scripts/bump-version.sh:32-34`).
- **`scripts/check-versions.sh`** gains a fourth collection loop. The existing three read
  manifests (`package.json`, `pyproject.toml`, `_version.py`); Go needs its own grep for
  `const Version = "…"`. The *comparison* (a single `sort -u` count) is unchanged, so a drifted
  Go constant fails the existing gate once it is collected.
- **`.github/workflows/ci-node.yml` publish job** — its "Commit version bump" step stages an
  explicit path allowlist (`ci-node.yml:106`). `go/entity/version.go` must be added to it;
  otherwise CI bumps the file, commits without it, and `check-versions.sh` is red on `main`
  from the first publish onward.
- **Tags — the publish job must start pushing them.** Go resolves module versions **only** from
  `vX.Y.Z` git tags. Today the newest tag is `v2.0.0` while every package is at `2.0.4`: the
  publish job bumps a patch on each push to `main` but never tags, and `bump-version.sh` only
  prints a manual tag hint (`scripts/bump-version.sh:45`). Without a change, Go consumers would
  see only `v2.0.0` — which predates `go.mod` and is not resolvable as a `/v2` module — or
  pseudo-versions. Fix: after the bump commit, the publish job runs
  `git tag "v$new_version" && git push origin "v$new_version"`, skipping if the tag already
  exists (idempotent re-runs). The job already holds `contents: write`. **The first
  Go-resolvable version is the first tag pushed after `go.mod` lands.** Side effect, stated
  plainly: Node and Python releases also start getting tags, which ADR 0002's single-tag
  scheme assumed but CI never delivered.
- **`psrw promote` is untouched** — it opens the release-branch PR and never tags or publishes.
- **No new secret.** Go "publishing" is the tag push above; there is no registry.

### The contract-version site Go actually mirrors

`node/packages/core/src/_contract.ts` and `python/packages/core/.../_contract.py` hold
`CONTRACT_VERSION` for **`core`** (the queue/wire contract); `ci-contracts.yml` asserts only
those two against `contracts/VERSION`. Go ships no `core`, so it adds **no** `_contract` site.

The entity lane's version is a separate **`specVersion` literal** hardcoded in each producer —
`node/packages/entity/src/restful.ts:36` (with its type at `types.ts:51`) and
`python/packages/entity/src/server_decorator_entity/restful.py:89`. No CI step ties those to
`contracts/VERSION`; they are pinned only indirectly, by byte parity with the fixture. Go adds
a third producer literal, pinned the same way (acceptance item 1). Tying `specVersion` to
`contracts/VERSION` directly is a real gap but predates this idea — **filed as a follow-up,
not folded in.**

## Consumption while the repo is private

Documented in `go/README.md`:

```
GOPRIVATE=github.com/montionugera/*
git config --global url."git@github.com:".insteadOf "https://github.com/"
go get github.com/montionugera/node-server-decorator/v2
```

Consequence to state plainly in that README: `proxy.golang.org` and `pkg.go.dev` will not
serve this module while the repo is private, so there is no rendered API documentation and no
module-proxy caching. Revisit if/when the repo goes public (related: the unpushed
`hotfix/npmjs-publish-lane` branch pursuing the same goal for npm).

*Unverified until acceptance item 11:* private-module resolution was reasoned from Go docs and
never exercised with a real `go get`.

## Tests / acceptance criteria

Every item is a command with an observable result — no item is satisfied by inspection.

1. **Byte parity.** `go test ./go/...` includes a test asserting
   `MarshalCanonical(example.UserSpec)` is byte-equal to
   `contracts/fixtures/entity-spec.valid-user.json` (1461 bytes). This also pins Go's
   `specVersion` literal.
2. **HTML-escape divergence.** A test entity whose `description` contains `<`, `>` and `&`
   marshals byte-equal to `go/entity/testdata/html-escape.json`. That golden file is produced
   by Node's `JSON.stringify` (sorted keys, compact) and cross-checked with Python's
   `json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False)`; the one-liner
   that regenerates it is recorded in the test's doc comment. It lives in Go `testdata/`, not
   `contracts/fixtures/`, so it does not force a contract version bump.
3. **Zero-value retention.** A test asserts `"min":0` survives marshalling, guarding
   constraint 2 against a future change from `*int` to `int`.
4. **Key-order guard.** A test asserts the marshalled key sequence is byte-identical to the
   sorted order, so a future field re-declaration in `spec.go` fails loudly rather than
   silently (constraint 1).
5. **`go generate` drift gate.** The committed generator output must equal what the
   generator produces now; the test fails with *"run go generate ./..."* when stale, and is
   shown failing once (tampered artifact) before passing.
6. **Schema validity — transitive, no script change.** `contracts/scripts/validate.sh` only
   globs committed fixtures (`contracts/fixtures/*.valid*.json`, `validate.sh:23`); it cannot
   validate produced output. It does not need to: item 1 proves Go's bytes equal
   `entity-spec.valid-user.json`, which `validate.sh` already validates against
   `entity-spec.schema.json`. `validate.sh` must still pass unchanged.
7. **Three-language parity.** `scripts/check-entity-parity.sh` gains one stdout capture
   (`go run ./go/internal/example/emitfixture`) and one comparison, and its success line
   becomes `TS == PY == GO == contract fixture`.
8. **Version lockstep.** `scripts/check-versions.sh` passes with `go/entity/version.go`
   collected, and fails when that constant alone is edited by hand.
9. **Hygiene.** `gofmt -l go` prints nothing; `go vet ./go/...` exits 0. Both are scoped to
   `go/` — a root `./...` would walk `node/`, `python/` and `interop/`.
10. **CI wiring — three workflow files.**
    - **New `.github/workflows/ci-go.yml`**: items 1–5 and 9, on PRs touching `go/**`,
      `go.mod`, `go.sum` or `contracts/**`, mirroring `ci-node.yml`'s unit lane.
    - **`ci-contracts.yml`**: add `go/**`, `go.mod`, `go.sum` to both `paths` filters
      (`ci-contracts.yml:13-26`) so items 7 and 8 actually trigger; add `actions/setup-go` to
      the `entity-parity` job (`ci-contracts.yml:58-70`), which runs the extended parity script.
    - **`ci-node.yml` publish job**: the allowlist addition and idempotent tag push from
      Versioning.
11. **Real consumption (post-merge).** After the first publish on `main` following this
    change, `git ls-remote --tags origin "v<new>"` shows the tag, and from a clean directory
    with `GOPRIVATE` set, `go list -m github.com/montionugera/node-server-decorator/v2@v<new>`
    resolves. This is the only item that exercises the private-repo assumption.

## Risks

- **A third language raises the cost of every entity-spec change.** A `specVersion` bump or any
  IR change already means editing two producer literals and the fixture; Go adds a third
  producer. Mitigation: `check-entity-parity.sh` is the enforcement point — CI fails rather
  than drifting. This is the real ongoing cost and should be accepted knowingly.
- **CI starts pushing tags.** A new write to the remote from the publish job, with its own
  failure modes (tag already exists on a re-run; a failed push after a successful commit).
  Mitigation: the skip-if-exists guard, and the tag push runs after the bump commit so a
  failure leaves `main` consistent and only the tag missing. This is an R1 CI change and
  is called out for review at implementation.
- **The import path is ugly.** `github.com/montionugera/node-server-decorator/v2/go/entity`
  carries both a `node-` prefix and a `/go/` segment. Accepted to preserve lockstep; a repo
  rename was offered and declined for now, and remains available later behind GitHub's
  redirects.
- **Consumers download the whole repo.** A root module's zip is every committed file at the
  tag — `node/`, `python/`, `contracts/`, `interop/` included. Acceptable at the current repo
  size; revisit if it grows large.
- **Silent parity breakage.** Constraints 1 and 3 fail invisibly — no error, just different
  bytes. This is why items 2 and 4 above are non-optional.

## Prototype evidence

A throwaway prototype (Go 1.22.4) was built outside the repo during brainstorming and **is not
retained**. It produced output byte-identical to the contract fixture (1461 bytes, `cmp`
clean), passed `go vet`, showed the drift gate failing then passing, and confirmed that a
directory named `go` inside a root module resolves. Because it is gone, **nothing in this spec
depends on it as evidence**: acceptance items 1, 5 and 9 re-prove each of those claims during
implementation. `research.md` reproduces the declaration surface and the canonical marshaller
verbatim so the prototype can be rebuilt.

## Appendix — audit trail

- **2026-09-13, adversarial audit (subagent), verdict *rework*.** 4 CRITICAL, 3 HIGH, 3 MEDIUM,
  2 LOW. Every CRITICAL/HIGH finding was re-checked against the named file:line before applying.
  - CRITICAL — no tag newer than `v2.0.0`; CI never tags → added idempotent tag push to the
    publish job, and acceptance item 11.
  - CRITICAL — publish job's `git add` allowlist omits a Go file → allowlist edit listed in
    Versioning and item 10.
  - CRITICAL ×2 — `_contract.{ts,py}` is `core`'s queue contract, not the entity lane; the real
    site is the `specVersion` literal → rewrote the contract-version subsection and the first
    risk; filed a `specVersion`↔`contracts/VERSION` gate as a follow-up.
  - HIGH — `validate.sh` only globs committed fixtures → item 6 now states transitive coverage.
  - HIGH ×2 — `ci-contracts.yml` has no `go/**` trigger and no `setup-go` → item 10 now edits it.
  - MEDIUM — parity script reads stdout, generator writes files → added `emitfixture`.
  - MEDIUM — `check-versions.sh` needs a bespoke Go loop → wording corrected.
  - MEDIUM — unresolvable `<scratchpad>` path → prototype section rewritten; no claim rests on it.
  - LOW — `go vet ./...` walks the whole repo → scoped to `./go/...`.
  - LOW — tagging is a new CI step, not a no-op → added as a risk.
  - Correction to the audit: `specVersion` is not wholly ungated — fixture parity pins it
    indirectly (it is not tied to `contracts/VERSION`, which is the actual gap).
