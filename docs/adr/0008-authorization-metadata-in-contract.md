# ADR 0008 — Authorization metadata in the wire contract: scopes, not roles

Status: Accepted (Mont, 2026-08-16) · Contract: entity-spec 1.2.0

## Context
entity-spec 1.2.0 adds an OpenAPI generator (F-004). A generated API description is only
useful if it is truthful, and an API description that shows every operation as freely
callable is not truthful for any real service. So the IR has to be able to say which
operations require credentials, and what the caller must hold.

That forces a question the contract could not previously avoid: *what* does it record?
The IR is shared across two languages and any number of services, and it is a **wire
contract** — whatever goes in becomes something every consumer must agree on and every
future adapter must honour.

## Decision
An entity may declare `security`:

- **`schemes`** — named security schemes, `type` a closed enum of `http` | `apiKey`.
  Nothing else validates. A closed enum is checkable in both languages and at the schema
  level; an open one would drift into "whatever OpenAPI happens to allow".
- **`ops` / `actions`** — a map from operation or action name to a list of **scope
  strings**. Scopes are opaque: no hierarchy, no wildcards, no implied containment.
  `user:admin` does not contain `user:write`. An entry of `[]` means authentication is
  required but no particular scope; no entry at all means the operation is public.

Scope strings are permission-shaped (`user:write`), and the convention is pinned in
`contracts/rules/rest-conventions.md`.

## Rejected: roles
Role names (`superadmin`, `editor`) are deployment-specific and churn with the org chart.
A wire contract shared across services and languages must not assert an organizational
model — the moment it does, every consumer inherits one team's staffing decisions, and a
role rename becomes a contract change. Roles expand to scopes in the identity provider,
before the request reaches a handler. The contract sees only the expansion.

## Rejected: object-level authorization
"Only the owner may update this record" cannot be expressed here, and deliberately so.
Ownership is a property of the **loaded row at request time**, not of the operation. A
static per-operation declaration has no row to consult, so any encoding of it would be a
lie the generator faithfully reproduced. Object-level and relationship-based
authorization belong in an adapter or handler, permanently — not in a later contract
version. This is a non-goal, not a deferral.

## Consequences
- The contract **declares requirements and never enforces them**. Nothing in 1.2 rejects
  an unauthorized request; `gen-openapi` emits `security` requirements and the 401/403
  responses that go with them, and that is the whole of it.
- Enforcement arrives with the HTTP adapters (1.3+), which will be conformance-tested
  against the document this release produces.
- Because scopes are opaque, a consumer wanting hierarchy implements it in its own
  authorization layer; adding hierarchy to the contract later would be a breaking change
  in meaning even if not in shape, and would need its own ADR.
