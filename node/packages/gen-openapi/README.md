# @montionugera/entity-spec-gen-openapi (Node)

Compiles the language-neutral EntitySpec IR (emitted by `@montionugera/entity-spec`'s `@Restful` decorator) into an OpenAPI 3.1 document, following `contracts/rules/rest-conventions.md`. Pure functions — no HTTP framework, no dependency on `@montionugera/server-decorator` or on `@montionugera/entity-spec-gen-zod`.

Polyglot sibling of `server-decorator-gen-openapi` (Python) and `server_decorator/gen_openapi` (Nim); all three emit a byte-identical OpenAPI 3.1 document from the same IR, verified by `scripts/check-openapi-parity.sh`.

## Install

```bash
pnpm add @montionugera/entity-spec-gen-openapi
```

## Usage

```ts
import { entitySpec } from '@montionugera/entity-spec';
import { UserFixture } from '@montionugera/entity-spec/dist/testing/user-fixture';
import { openapiDocument } from '@montionugera/entity-spec-gen-openapi';

const spec = entitySpec(UserFixture);
const doc = openapiDocument([spec], {
  title: 'User Service API',
  version: '1.0.0',
});

console.log(JSON.stringify(doc, null, 2));
```

## Generated Structure

Following `contracts/rules/rest-conventions.md`:
- **Paths**: CRUD paths (`/{entity}`, `/{entity}/{id}`) plus custom `@action` paths.
- **Components**: `schemas` derived using the same strict field rules as `gen-zod` and `gen-pydantic` (`readonly` fields excluded from Create DTOs, `writeonly` fields excluded from Read DTOs).
- **Responses**: Standard RFC 9457 Problem Details (`ProblemDetails`, `ValidationErrorDetails`) for HTTP 400, 404, 422, 500 errors.

## Parity Guarantee

Checked against `contracts/fixtures/openapi.valid-user.json` in CI to ensure 100% byte-identical output with the Python and Nim generators.
