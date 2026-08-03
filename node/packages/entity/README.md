# @montionugera/entity-spec (Node)

Declarative entity decorators (`@Restful`, `@action`, field markers) emitting the
language-neutral EntitySpec IR (`contracts/schemas/entity-spec.schema.json`) — polyglot sibling
of `server-decorator-entity` (Python), sharing the wire-format contracts in
[`../../../contracts`](../../../contracts).

## Install

```bash
pnpm add @montionugera/entity-spec
```

## Requires `experimentalDecorators`

This package's decorators (`@Restful`, `@action`, `@id`, `@str`, etc.) are built on the legacy
TC39 Stage 2 decorator proposal that TypeScript ships behind the `experimentalDecorators` flag.
Your `tsconfig.json` **must** enable it:

```json
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  }
}
```

The TC39/TS5-default decorators (the standardized proposal TypeScript now emits by default when
`experimentalDecorators` is unset or `false`) are **not supported** — the metadata shape and
call signature differ from the legacy proposal these decorators are written against, so mixing
the two produces silent breakage rather than a compile error.

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
