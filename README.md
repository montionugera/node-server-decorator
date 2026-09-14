# server-decorator

Polyglot library shipping decorators for **caching, tracking, and queue emission** in two languages from one repo. The Node and Python implementations share language-neutral wire contracts and cross-language interop tests.

| Language | Source | Install | Docs |
| -------- | ------ | ------- | ---- |
| Node / TypeScript | [`./node`](./node) | `pnpm add server-decorator` | [`node/packages/core/README.md`](./node/packages/core/README.md) |
| Python | [`./python`](./python) | `pip install server-decorator` | [`python/packages/core/README.md`](./python/packages/core/README.md) |

The wire format and shared rules (cache key algorithm, queue message schema, topic naming) live in [`./contracts`](./contracts) and are the source of truth both implementations validate against.

## Entity-spec layer

Alongside the core decorators, each language ships a small **entity-spec** stack for declaring
REST-ish entities once and deriving validation DTOs and a REST contract from that declaration:

| Package | Language | What it does |
| ------- | -------- | ------------- |
| `@montionugera/entity-spec` | Node | `@Restful`/`@action`/field decorators emitting the language-neutral **EntitySpec IR** |
| `server-decorator-entity` | Python | Same, via `@restful`/`@action`/field markers |
| `@montionugera/entity-spec-gen-zod` | Node | Compiles an EntitySpec IR into zod `create`/`update`/`read`/action-input DTOs |
| `server-decorator-gen-pydantic` | Python | Same, compiling into pydantic v2 DTO models |
| `@montionugera/entity-spec-gen-openapi` | Node | Compiles an EntitySpec IR into an OpenAPI 3.1 document |
| `server-decorator-gen-openapi` | Python | Same, emitting a byte-identical document |

Both languages' `entity` packages emit byte-identical IR for the same declaration (checked by
`scripts/check-entity-parity.sh`), and both `gen-*` packages are validated against the same
`contracts/fixtures/entity-spec.cases.json` cases, so DTO behavior — which fields a `create`
payload accepts, which a `read` payload exposes — stays in lockstep across languages too. The
two `gen-openapi` packages emit a byte-identical OpenAPI 3.1 document from the same IR, checked
by `scripts/check-openapi-parity.sh` against `contracts/fixtures/openapi.valid-user.json`;
routes, component names and error shapes are pinned in `contracts/rules/rest-conventions.md`.
HTTP adapters that serve those routes are not part of this release.

## Why polyglot

Many microservice estates run a Node producer and a Python consumer, or vice versa. Keeping decorator semantics — event names, cache keys, queue payloads — consistent across runtimes is hard if each language re-derives its own conventions. This repo solves that by treating the contract as the deliverable, with two reference implementations.

## Layout

```
.
├── node/         # pnpm workspace: packages/core, entity, gen-zod, gen-openapi
├── python/       # uv workspace: packages/core, entity, gen_pydantic, gen_openapi
├── contracts/    # JSON schemas + rule docs + fixtures (the wire format)
├── interop/      # Cross-language end-to-end tests (Node ↔ Python)
├── docs/adr/     # Architecture Decision Records
├── DECISIONS.md  # Locked design decisions (in-repo summary)
└── MIGRATION.md  # v1.x → v2.0.0 upgrade guide
```

## Versioning

Lockstep semver: one tag, both packages publish together. See `DECISIONS.md` (decision #2) and [`docs/adr/`](./docs/adr) for the rationale.

## License

MIT.
