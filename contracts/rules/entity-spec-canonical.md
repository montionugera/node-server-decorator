# EntitySpec canonical JSON (v1.1.0)

Both languages MUST serialize an EntitySpec to the byte-identical canonical form:

1. UTF-8; non-ASCII characters are NOT escaped (Python: `ensure_ascii=False`).
2. Object keys sorted lexicographically (byte order) at every nesting level.
3. Separators `,` and `:` with no whitespace, no trailing newline.
4. Omit-when-default: keys are ABSENT rather than set to a default —
   flags (`optional`, `nullable`, `readonly`, `writeonly`, `filterable`) appear only as `true`;
   `transactional` appears only as `false`; unset options (`format`, `min`, `role`, ...) are omitted.
5. Arrays keep declaration order (fields = class declaration order; `enum` values = declared order).
6. All numbers are integers (no fractional constraints in v1.1.0).
7. Wire names are camelCase. Python declarations are snake_case; the builder converts
   (`login_count` → `loginCount`). Rule: split on `_`, lowercase first segment, capitalize the rest.

Examples: see `fixtures/entity-spec.valid-user.json` (stored in canonical form).
Parity test: TS and Python `testing` fixture entities must emit exactly that file's bytes.
