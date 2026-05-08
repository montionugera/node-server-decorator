# ADR 0003 — Cache key format

**Status:** Accepted (2026-05-05). Locked as Decision #6.

## Context

The pre-v2.0.0 Node `@cache` decorator built keys via `` `${ClassName}.${methodName}(${args.join(',')})` ``. Two problems:

1. **`args.join(',')` is brittle.** `[[1,2], 3].join(',')` produces `"1,2,3"`, conflating nested arrays. Distinct calls produce identical keys.
2. **Not language-portable.** Python has no equivalent of `Array.prototype.join`, and a naive port would diverge.

For a polyglot library, both problems are blockers.

## Decision

Build the key as `<ClassName>.<methodName>(<argRepr>)` where `argRepr` is the JSON-stringification of args (with stable key ordering and `default=str`-style coercion of non-JSON types) joined by commas, plus sorted `key=value` pairs for kwargs. Spec: [`contracts/rules/cache-key.md`](../../contracts/rules/cache-key.md). When the UTF-8 byte length exceeds 250, replace the parens content with `sha256:<hex>`.

## Why

- **Deterministic across languages.** Python `json.dumps(x, sort_keys=True)` and Node's `stableStringify` produce identical bytes (modulo one irreducible JSON edge case for whole-number floats — see the rule doc).
- **Unambiguous for nested structures.** `[[1,2],3]` becomes `[[1,2],3]`, distinct from `[1,2,3]` which becomes `[1,2,3]`.
- **Bounded length.** Redis and most KV stores reject very long keys. SHA-256 caps the worst case at ~80 chars (the hex + qualname wrapper).

## Consequences (D-A)

Every existing cached entry on a Node consumer becomes a miss on first access after v2.0.0. For consumers with hot, high-cardinality caches, this can cause a thundering-herd incident against the underlying datastore. **Operator action required: flush the cache namespace before deploying v2.0.0** in any environment with non-trivial cache traffic, or accept a brief miss spike.

No dual-read compat layer ships in v2.0.0 — the simplicity is intentional. Operators with a strong rollout-safety requirement can implement their own dual-read cache adapter externally if needed.
