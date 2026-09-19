# server-decorator

Polyglot library shipping decorators for **caching, tracking, queue emission**, and **REST entity-spec generation** in four languages from one repository. The Node and Python implementations share language-neutral wire contracts and cross-language interop tests, while Go and Nim provide byte-identical EntitySpec IR and OpenAPI generation.

| Language | Source | Install | Docs |
| -------- | ------ | ------- | ---- |
| Node / TypeScript | [`./node`](./node) | `pnpm add @montionugera/server-decorator` | [`node/packages/core/README.md`](./node/packages/core/README.md) |
| Python | [`./python`](./python) | `pip install server-decorator` | [`python/packages/core/README.md`](./python/packages/core/README.md) |
| Go | [`./go`](./go) | `go get github.com/montionugera/node-server-decorator/v2` | [`go/README.md`](./go/README.md) |
| Nim | [`./nim`](./nim) | `nimble install server_decorator` | [`nim/README.md`](./nim/README.md) |

The wire format and shared rules (cache key algorithm, queue message schema, topic naming) live in [`./contracts`](./contracts) and are the source of truth all implementations validate against.

## Documentation Portal

A centralized, multilingual documentation website is powered by **Starlight (Astro)** under [`website/`](./website):
- **Synchronized Multi-Language Code Switcher**: Switch code tabs between TypeScript, Python, Go, and Nim simultaneously across the entire site.
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
| `@montionugera/entity-spec-gen-zod` | Node | Compiles an EntitySpec IR into zod `create`/`update`/`read`/action-input DTOs |
| `server-decorator-gen-pydantic` | Python | Same, compiling into pydantic v2 DTO models |
| `@montionugera/entity-spec-gen-openapi` | Node | Compiles an EntitySpec IR into an OpenAPI 3.1 document |
| `server-decorator-gen-openapi` | Python | Same, emitting a byte-identical document |
| `server_decorator/gen_openapi` | Nim | Same, emitting a byte-identical document |

All four languages' `entity` packages emit byte-identical IR for the same declaration (asserted by `scripts/check-entity-parity.sh`), and both `gen-*` DTO packages are validated against `contracts/fixtures/entity-spec.cases.json`. The three `gen-openapi` packages emit a byte-identical OpenAPI 3.1 document from the same IR, checked by `scripts/check-openapi-parity.sh` against `contracts/fixtures/openapi.valid-user.json`.

## Why polyglot

Many microservice estates run a Node producer and a Python consumer, or vice versa. Keeping decorator semantics — event names, cache keys, queue payloads — consistent across runtimes is hard if each language re-derives its own conventions. This repo solves that by treating the contract as the deliverable, with reference implementations.

## Layout

```
.
├── node/         # pnpm workspace: packages/core, entity, gen-zod, gen-openapi
├── python/       # uv workspace: packages/core, entity, gen_pydantic, gen_openapi
├── go/           # Go module: entity IR producer
├── nim/          # Nimble package: macro entity DSL + OpenAPI generator
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

## Versioning

Lockstep semver: one tag, all packages publish together. See `DECISIONS.md` (decision #2) and [`docs/adr/`](./docs/adr) for the rationale.

## License

MIT.
