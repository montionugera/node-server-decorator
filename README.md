# server-decorator

Polyglot library shipping decorators for **caching, tracking, and queue emission** in two languages from one repo. The Node and Python implementations share language-neutral wire contracts and cross-language interop tests.

| Language | Source | Install | Docs |
| -------- | ------ | ------- | ---- |
| Node / TypeScript | [`./node`](./node) | `pnpm add server-decorator` | [`node/packages/core/README.md`](./node/packages/core/README.md) |
| Python | [`./python`](./python) | `pip install server-decorator` | [`python/packages/core/README.md`](./python/packages/core/README.md) |

The wire format and shared rules (cache key algorithm, queue message schema, topic naming) live in [`./contracts`](./contracts) and are the source of truth both implementations validate against.

## Why polyglot

Many microservice estates run a Node producer and a Python consumer, or vice versa. Keeping decorator semantics — event names, cache keys, queue payloads — consistent across runtimes is hard if each language re-derives its own conventions. This repo solves that by treating the contract as the deliverable, with two reference implementations.

## Layout

```
.
├── node/         # Node / TypeScript package (npm: server-decorator)
├── python/       # Python package (PyPI: server-decorator)
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
