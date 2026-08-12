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

## `format: "uuid"` and `format: "uri"` (added post-P1-gate-review, still 1.1.0 unreleased)

Both generators MUST validate against these exact shared regexes — same rationale as `email`
above (each ecosystem's built-in is either absent, too strict, or too lax, and the two disagree
with each other). `ref` fields with these formats follow the same regexes (see the `ref` section
below).

**`uuid`** (canonical 8-4-4-4-12 hex-digit form; version/variant nibbles NOT constrained — any hex
digit is accepted in every position, matching zod's `.uuid()` acceptance of all UUID versions):

```
^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$
```

**`uri`** (pragmatic `scheme://non-space`, not a full RFC 3986 parser — deliberately permissive on
the authority/path/query/fragment so it stays a single portable regex rather than a URI grammar):

```
^[a-zA-Z][a-zA-Z0-9+.-]*://[^\s]+$
```

Implementations: both generators export `UUID_PATTERN` / `URI_PATTERN` alongside `EMAIL_PATTERN`
and apply them via `.regex(...)` / `pydantic.Field(pattern=...)` — never `zod.uuid()`/`.url()` or
`pydantic.AnyUrl`, which are ecosystem-specific and will diverge for the same reason `EmailStr`
did.

## JSON-type strictness for `int`/`float`/`bool`/`datetime`

All payloads arrive as parsed JSON, so JSON's type system (not either language's runtime type
system) is the arbiter of what counts as "the same shape." zod does no cross-type coercion; both
generators MUST match that:

- `int`, `float`, `bool`: a JSON **string** value (`"5"`, `"true"`) is REJECTED, even if its
  contents look numeric/boolean. `gen-pydantic` enforces this with a `BeforeValidator` that raises
  on `isinstance(v, str)` per field, ahead of pydantic's normal (lax) coercion — it does NOT use a
  blanket `strict=True` model config, which would also reject legitimate ISO-string→`datetime`
  parsing.
- `int` additionally keeps pydantic's lax **integral-float** behavior: a JSON number `5.0` is
  ACCEPTED for an `int` field (coerced to `5`) because JS/JSON cannot distinguish `5.0` from `5` —
  zod's `z.number().int()` accepts `5.0` for the same reason. A fractional JSON number (`5.5`) is
  REJECTED.
- `datetime`: a non-string JSON value (e.g. an integer epoch timestamp `1704067200`) is REJECTED.
  `gen-pydantic` enforces this with a `BeforeValidator` that raises on `not isinstance(v, str)`
  ahead of `AwareDatetime` parsing — an epoch integer is neither ISO 8601 nor string-shaped, and
  must not be silently accepted as a `datetime`.

## `ref` — string with the same constraints as `str`

A `ref` value is a string (an entity id), so it carries the same constraints a `str` field would:
`format` (including `uuid`/`uri`/`email`), `min`, `max`, `pattern`. Both generators apply the `str`
branch's full logic to `ref` — `gen-zod`'s `case 'ref'` falls through to the same code as
`case 'str'`; `gen-pydantic`'s `t == "str" or t == "ref"` guard already does this.

## `format` and `pattern` are mutually exclusive

A field MUST NOT declare both `format` and `pattern` — enforced at **decoration time** (throws
building the `EntitySpec`, in both languages), not left to the generators. This closes a
combination the two engines resolved differently (`gen-pydantic` overwrote `pattern` last-write-
wins across format/explicit-pattern assignment; `gen-zod` chained both as separate `.regex()`
calls, so `format`+`pattern` together produced a stricter AND-of-both-patterns validator in Node
but a format-or-pattern-only validator in Python for the same IR). Rather than pick and document
one combination semantic, the combination itself is now invalid IR.

## List item constraints (`type: "list"`)

An item's own constraints (`min`/`max`/`pattern`/`format`, or a nested `obj`'s field list) MUST be
enforced on every element, in both generators — not silently dropped. `gen-zod` recurses
`zodForField` on `f.item`, which naturally carries this through. `gen-pydantic` builds
`list[Annotated[inner_ann, inner_field_info]]` — thread the item's own `(annotation, FieldInfo)`
pair through `Annotated`, never `list[inner_ann]` alone (which discards the `FieldInfo`, and with
it every item-level constraint).

## Non-integer `min`/`max` are rejected at decoration time

Per `entity-spec-canonical.md` rule 6 ("all numbers are integers — no fractional constraints in
v1.1.0"), a `min`/`max` value that is not a whole integer (`2.5`) — or, in Python, a `bool` (which
`isinstance(x, int)` would otherwise let through) — MUST raise at decoration time, in both
languages, rather than silently emit `min`/`max` as IR. Node: `Number.isInteger(v)`. Python:
`isinstance(v, int) and not isinstance(v, bool)`. This also prevents the whole-number-float JSON
serialization divergence documented in `cache-key.md` (`JSON.stringify(2.0)` → `"2"` vs
`json.dumps(2.0)` → `"2.0"`) from ever reaching the IR for this field.

## Empty `enum`, `ops`, `transports` are rejected at decoration time

An `EnumOf()`/`enumOf([])` call with zero values, an empty `ops: []`, or an empty `transports: []`
MUST raise at decoration time in both languages (fail-fast, matching the schema's `minItems: 1` on
`fields`/`transports`/`enum` — `ops` now carries the same `minItems: 1`). Node's `opts.transports
?? [...]` / `opts.ops ?? [...]` previously let an explicit `[]` pass through unchanged (`??` is
null-coalescing, not empty-coalescing); Python's `transports or [...]` / `ops or [...]` previously
silently replaced an explicit `[]` with the default (`or` is truthiness-coalescing). Neither
"pass through invalid IR" nor "silently substitute a default the caller didn't ask for" is
acceptable — both now raise.

## Reserved wire names

A field's wire name (the `name` in IR, i.e. the class attribute name in TS / the `_camel()`-ed
attribute name in Python, or an explicit nested-field/list-item name) MUST NOT collide with a
public `pydantic.BaseModel` attribute — `create_model()` raises
`Field name "<name>" in "<Model>" shadows an attribute in parent "BaseModel"` at model-build time
otherwise, aborting the entire entity's DTO construction. Node has no equivalent restriction
(zod objects don't reserve these names), so this is a Python-generator-driven constraint applied
symmetrically to both entity packages' decoration-time validation, to keep the same IR valid or
invalid in both languages rather than "valid in Node, blows up gen-pydantic later."

**Reserved set** (pydantic v2 `BaseModel`'s public, non-underscore attribute names — computed via
`sorted(a for a in dir(pydantic.BaseModel) if not a.startswith('_'))`; kept here as the literal
list both languages hardcode, so a pydantic version bump can't silently change what's reserved out
from under Node):

```
construct, copy, dict, from_orm, json, model_computed_fields, model_config, model_construct,
model_copy, model_dump, model_dump_json, model_extra, model_fields, model_fields_set,
model_json_schema, model_parametrized_name, model_post_init, model_rebuild, model_validate,
model_validate_json, model_validate_strings, parse_file, parse_obj, parse_raw, schema,
schema_json, update_forward_refs, validate
```

(Names containing `_` can never actually collide with a wire name, since wire names must match
`^[a-z][A-Za-z0-9]*$` — no underscore. They're kept in the list anyway so it stays the literal,
unfiltered `dir(pydantic.BaseModel)` output: trivially re-derivable and re-verifiable, rather than
a hand-curated subset someone has to remember to keep in sync.)

## `pattern` regex flavor: RE2/rust-regex-compatible only

`gen-pydantic` compiles `pattern` with pydantic v2's Rust-backed regex engine, which does **not**
support lookaround (`(?=...)`, `(?!...)`) or backreferences (`\1`) — both valid in JS `RegExp` and
Python's own `re` module, both accepted as schema-valid IR (`pattern` is `{"type": "string"}` with
no engine-compatibility constraint in `entity-spec.schema.json`). A `pattern` using either feature
builds fine in `gen-zod` — the divergence is live at the wire-format level, not just a generator
crash — while `create_model()`/`create_model_for()` in `gen-pydantic` raises, aborting the entire
entity's model build.

**Enforcement is at DECORATION time, in both entity packages, not left to the generators.**
`Restful()`/`restful()` reject a non-portable `pattern` before either generator ever sees the IR:

- **Lookaround**: reject if `pattern` contains the literal substring `(?=`, `(?!`, `(?<=`, or
  `(?<!`.
- **Backreference**: reject if `pattern` contains a backslash immediately followed by a digit
  `1`–`9`, where an **odd** number of consecutive backslashes precede that digit (an odd run means
  the digit itself is escaped, i.e. an actual `\1`-style backreference; an **even** run means the
  backslashes are themselves pairwise-escaped and the digit that follows is a literal character,
  not part of an escape — e.g. `\\1` is a literal backslash followed by a literal `1`, not a
  backreference). `\0` is never treated as a backreference (it is not a capture-group reference in
  either engine).

This is a **conservative lexical scan, not a full regex parser** — deliberately, to keep the check
identical and trivially portable in both languages (`node/packages/entity/src/validate.ts`'s
`assertPortablePattern`/`hasBackreference`, `python/packages/entity/src/server_decorator_entity/validate.py`'s
`assert_portable_pattern`/`_has_backreference`). It does not attempt to validate that the pattern
is otherwise well-formed regex syntax (an unrelated syntax error still surfaces from the
generator, not from this check) — it only rejects the two known-non-portable constructs.
`gen-pydantic` additionally wraps its model-build call and re-raises any pattern-compile failure
as a `ValueError` naming the offending field(s)/pattern(s) as defense-in-depth, in case IR reaches
it from something other than these two entity packages' decorators.
