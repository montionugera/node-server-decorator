# server-decorator-gen-openapi

Compiles the EntitySpec IR into an OpenAPI 3.1 document, following
`contracts/rules/rest-conventions.md`. Pure functions — no HTTP framework, no
dependency on `server-decorator` or on `server-decorator-gen-pydantic`.

Polyglot sibling of `@montionugera/entity-spec-gen-openapi`; both emit a
byte-identical document, enforced by `scripts/check-openapi-parity.sh`.
