# @montionugera/entity-spec-gen-zod (Node)

Compiles the language-neutral EntitySpec IR (emitted by `@montionugera/entity-spec`'s
`@Restful` decorator) into zod `create` / `update` / `read` / action-input DTO schemas — the
polyglot sibling of `server-decorator-gen-pydantic` (Python), sharing the wire-format contracts
in [`../../../contracts`](../../../contracts).

## Install

```bash
pnpm add @montionugera/entity-spec-gen-zod zod
```

## Usage

```ts
import { entitySpec } from '@montionugera/entity-spec';
import { UserFixture } from '@montionugera/entity-spec/dist/testing/user-fixture';
import { createSchema, validationErrorFields } from '@montionugera/entity-spec-gen-zod';

const spec = entitySpec(UserFixture);
const Create = createSchema(spec);

const result = Create.safeParse({ email: 'not-an-email', name: 'M', status: 'inactive', tags: [] });
if (!result.success) validationErrorFields(result.error); // -> ["email", "name"]
```

## DTO rules (parity with gen-pydantic)

- `createSchema` — excludes `readonly` fields. Strict object (rejects unknown keys).
- `updateSchema` — same field set as create, all made optional (partial update); a field's own
  `nullable` flag is unchanged, so a key may be **absent** but an explicitly-provided `null` is
  only accepted when the field is `nullable`.
- `readSchema` — excludes `writeonly` fields.
- `actionInputSchema(spec, name)` — the named action's `input` fields, all required unless
  marked `optional` in the IR.
- Nested `obj`/`list` fields thread the same DTO include predicate recursively, so a
  `readonly`/`writeonly` nested field is excluded from the DTOs that shouldn't see it.

## `datetime` fields

The IR's `datetime` type requires an explicit UTC offset on the wire (multi-replica decision) —
a naive ISO-8601 string (no offset) is rejected.
