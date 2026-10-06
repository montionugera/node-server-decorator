# server-decorator

Polyglot library shipping decorators for **caching, tracking, queue emission**, and **REST entity-spec generation** in five languages from one repository. The Node and Python implementations share language-neutral wire contracts and cross-language interop tests, while Go, Nim, and Rust provide byte-identical EntitySpec IR and OpenAPI generation.

| Language | Source | Install | Docs |
| -------- | ------ | ------- | ---- |
| Node / TypeScript | [`./node`](./node) | `pnpm add @montionugera/server-decorator` | [`node/packages/core/README.md`](./node/packages/core/README.md) |
| Python | [`./python`](./python) | `pip install server-decorator` | [`python/packages/core/README.md`](./python/packages/core/README.md) |
| Go | [`./go`](./go) | `go get github.com/montionugera/node-server-decorator/v2` | [`go/README.md`](./go/README.md) |
| Nim | [`./nim`](./nim) | `nimble install server_decorator` | [`nim/README.md`](./nim/README.md) |
| Rust | [`./rust`](./rust) | `cargo add server-decorator` | [`rust/README.md`](./rust/README.md) |

The wire format and shared rules (cache key algorithm, queue message schema, topic naming) live in [`./contracts`](./contracts) and are the source of truth all implementations validate against.

## Documentation Portal

A centralized, multilingual documentation website is powered by **Starlight (Astro)** under [`website/`](./website):
- **Synchronized Multi-Language Code Switcher**: Switch code tabs between TypeScript, Python, Go, Nim, and Rust simultaneously across the entire site.
- **Internationalization (i18n)**: Out-of-the-box multilingual support with built-in English and Thai (`/th/`) documentation.
- **Offline Full-Text Search**: Built-in Pagefind search indexing.

Run locally:
```bash
# Start documentation dev server
pnpm run docs:dev

# Build static production documentation
pnpm run docs:build
```

## Entity-spec layer

Alongside the core decorators, each language ships a small **entity-spec** stack for declaring REST entities once and deriving validation DTOs and an OpenAPI 3.1 REST contract from that declaration:

| Package | Language | What it does |
| ------- | -------- | ------------- |
| `@montionugera/entity-spec` | Node | `@Restful`/`@action`/field decorators emitting the language-neutral **EntitySpec IR** |
| `server-decorator-entity` | Python | Same, via `@restful`/`@action`/field markers |
| `go/entity` | Go | Same, via `entity.Build(...)` fluent builder |
| `server_decorator` | Nim | Same, via `restful` block macro DSL and field pragmas |
| `server-decorator-entity` | Rust | Same, via `EntitySpecBuilder` fluent builder & derive macros |
| `@montionugera/entity-spec-gen-zod` | Node | Compiles an EntitySpec IR into zod `create`/`update`/`read`/action-input DTOs |
| `server-decorator-gen-pydantic` | Python | Same, compiling into pydantic v2 DTO models |
| `server-decorator-dto` | Rust | Compiles an EntitySpec IR into runtime validation DTOs |
| `@montionugera/entity-spec-gen-openapi` | Node | Compiles an EntitySpec IR into an OpenAPI 3.1 document |
| `server-decorator-gen-openapi` | Python | Same, emitting a byte-identical document |
| `server_decorator/gen_openapi` | Nim | Same, emitting a byte-identical document |
| `server-decorator-openapi` | Rust | Same, emitting a byte-identical document |

All five languages' `entity` packages emit byte-identical IR for the same declaration (asserted by `scripts/check-entity-parity.sh`), and the `gen-*` / `dto` packages are validated against `contracts/fixtures/entity-spec.cases.json`. The four `gen-openapi` packages emit a byte-identical OpenAPI 3.1 document from the same IR, checked by `scripts/check-openapi-parity.sh` against `contracts/fixtures/openapi.valid-user.json`.

## Why polyglot

Many microservice estates run a Node producer and a Python consumer, or vice versa. Keeping decorator semantics — event names, cache keys, queue payloads — consistent across runtimes is hard if each language re-derives its own conventions. This repo solves that by treating the contract as the deliverable, with reference implementations.

## Layout

```
.
├── node/         # pnpm workspace: packages/core, entity, gen-zod, gen-openapi
├── python/       # uv workspace: packages/core, entity, gen_pydantic, gen_openapi
├── go/           # Go module: entity IR producer
├── nim/          # Nimble package: macro entity DSL + OpenAPI generator
├── rust/         # Cargo workspace: entity, dto, openapi, core, axum
├── contracts/    # JSON schemas + rule docs + fixtures (the wire format)
├── website/      # Multilingual Starlight documentation portal
├── interop/      # Cross-language end-to-end tests (Node ↔ Python)
├── docs/adr/     # Architecture Decision Records
├── DECISIONS.md  # Locked design decisions (in-repo summary)
├── CONTRIBUTING.md # Contributor guidelines and quality gates
└── MIGRATION.md  # v1.x → v2.0.0 upgrade guide
```

## Contributing & Quality Gates

Contributors must follow the rules outlined in [`CONTRIBUTING.md`](./CONTRIBUTING.md). Verify your changes locally before submitting a PR:

```bash
bash scripts/contributor-check.sh
```

### Coverage gates

Unit-test coverage is enforced per package; a drop below the threshold fails the command and CI. Thresholds are a ratchet (raise them, never lower them). e2e and integration tests are not counted.

| Lane | Command | Gate |
| ---- | ------- | ---- |
| Node | `cd node && pnpm -r test:unit` | Line coverage, `coverageThreshold` in each package's `jest.config.js`: core 98, entity 97, gen-zod 100, gen-openapi 100 |
| Python | `cd python && bash scripts/check.sh` | Line coverage, `COV_MIN` in each package's `scripts/check.sh`: core 99, entity 96, gen_openapi 96, gen_pydantic 97 |
| Go | `bash scripts/check-go-coverage.sh` | Statement coverage per package, thresholds at the top of the script; a new package must declare one |

Nim has no coverage gate; `nimble test` is its quality gate.

### Behaviour changes in contract 1.3.0

Contract `1.3.0` writes down rules that were previously implicit and aligns the lanes on them. The full list is in [`contracts/CHANGELOG.md`](./contracts/CHANGELOG.md); the ones a consumer can observe:

- **Python auto topic**: `@emit_on_success(event_name=...)` without an explicit `topic` now publishes to `ClassName.methodName`, as Node does, not to the event name. Update consumers bound to the old topic or pin `topic=`.
- **Cache keys**: Python keys with non-ASCII arguments and Go keys containing `<`, `>`, `&`, U+2028 or U+2029 change spelling to match Node, so those entries are re-computed once. NaN / Infinity arguments raise instead of producing a key.
- **Distributed lock**: a lease lost mid-section raises `LockLostError` (Node, Python) or returns `ErrLockLost` (Go) instead of a normal result. Go now auto-renews by default.
- **Tracing**: `traceparent` must be version `00` with lower-case hex; anything else starts a new trace. Each traced message consumed exports one extra `consume <eventName>` span.
- **Kafka consumers**: a failed record is redelivered after `retryBackoffMs` / `retry_backoff_ms` (default 1000 ms), so a permanently failing record blocks its partition instead of being skipped.
- **Emit side effects**: a throwing `transform` is logged and skips the emit; the caller still gets the method's result.
- **Secured routes** answer `401` when no scope extractor was supplied to the route adapter.

## Versioning

Lockstep semver: one tag, all packages publish together. See `DECISIONS.md` (decision #2) and [`docs/adr/`](./docs/adr) for the rationale.

## License

MIT.
