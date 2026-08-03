# @montionugera/entity-spec (Node)

Declarative entity decorators (`@Restful`, `@action`, field markers) emitting the
language-neutral EntitySpec IR (`contracts/schemas/entity-spec.schema.json`) — polyglot sibling
of `server-decorator-entity` (Python), sharing the wire-format contracts in
[`../../../contracts`](../../../contracts).

## Install

```bash
pnpm add @montionugera/entity-spec
```

## Usage

```ts
import { Restful, id, email, entitySpec } from '@montionugera/entity-spec';

@Restful({ path: 'users' })
class User {
  @id() id!: string;
  @email() email!: string;
}

const spec = entitySpec(User); // -> EntitySpec IR, byte-identical to the Python emitter
```

`entitySpecCanonical(User)` returns the IR as a canonical JSON string (codepoint-sorted keys,
`undefined`-dropping) — the exact bytes both languages' generators and the cross-language
parity check compare against.
