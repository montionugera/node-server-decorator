# EntitySpec IR — cross-language format validation semantics (v1.1.0)

`format`/`type` values in the EntitySpec IR (`schemas/entity-spec.schema.json`) are wire-shape
hints only — the actual *validation behavior* for each is defined here, and both language
generators (`gen-zod`, `gen-pydantic`) MUST implement it identically. This doc exists because
`format: "email"` diverged silently: pydantic's `EmailStr` accepted `a@b.c` while zod's built-in
`.email()` rejected it — same IR, different generated behavior, discovered by cross-language
contract-case review.

## `format: "email"`

Both generators MUST validate against the exact same regular expression — no built-in
"email validator" of either ecosystem (zod's `.email()`, pydantic's `EmailStr`) is used, because
each ecosystem ships its own opinionated (and mutually divergent) definition of "valid email."
A single shared pattern is the only way to guarantee identical accept/reject behavior across
languages.

**The pattern** (verbatim, both languages):

```
^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$
```

This is the **WHATWG HTML5 `<input type="email">` validation pattern**
(<https://html.spec.whatwg.org/multipage/input.html#valid-e-mail-address>), chosen — not RFC 5322,
not either ecosystem's default — specifically for **deterministic cross-language parity**: it is a
single, unambiguous, non-Unicode-aware regex with no engine-specific quirks, so a straight literal
port between JS `RegExp` and Python `re` produces byte-identical accept/reject decisions.

Consequences worth calling out explicitly:

- `a@b.c` is **valid** (single-character TLD is permitted — the pattern does not enforce a
  minimum TLD length).
- `a@` is **invalid** (empty domain — the domain-label group requires at least one
  alphanumeric character).
- `nope` (no `@`) is **invalid**.

Implementations:

- Node (`gen-zod`): `node/packages/gen-zod/src/map-field.ts` — `str.regex(EMAIL_PATTERN)`, with
  `EMAIL_PATTERN` exported as a named `RegExp` constant so adapters can reuse it directly instead
  of re-deriving it.
- Python (`gen-pydantic`): `python/packages/gen_pydantic/src/server_decorator_gen_pydantic/__init__.py`
  — `str` annotation + `pydantic.Field(pattern=EMAIL_PATTERN)` (a raw string with the same
  characters, mind Python `re`'s escaping of the backtick/quote characters inside the character
  class — no escaping is actually needed for those characters in either engine's character-class
  syntax, but the pattern is kept as a raw string to avoid Python string-literal backslash
  processing surprises). This drops the `pydantic[email]` extra — plain `pydantic>=2.7` is
  sufficient once `EmailStr` is no longer used.

## `type: "datetime"`

`datetime` fields are ISO 8601 timestamps that **REQUIRE an explicit UTC offset** on the wire — a
naive timestamp (no offset, e.g. `2024-01-01T00:00:00`) is REJECTED by both generators. This was
ruled post-review (still 1.1.0, unreleased) because a naive timestamp is ambiguous across a
multi-replica deployment (E8) where replicas may not share a local timezone.

- Node (`gen-zod`): `z.string().datetime({ offset: true })`.
- Python (`gen-pydantic`): `pydantic.AwareDatetime` (never `AwareDatetime | NaiveDatetime` — that
  would accept the naive form).

See `fixtures/entity-spec.cases.json` for the contract cases locking in both rulings
(`create-email-single-char-tld-ok`, `create-email-no-domain-rejected`,
`update-datetime-with-offset-ok`, `update-datetime-naive-rejected`, `update-datetime-null-ok`).
