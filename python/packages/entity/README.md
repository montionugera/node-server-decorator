# server-decorator-entity (Python)

Declarative entity decorators (`@restful`, `@action`, field markers) emitting the language-neutral EntitySpec IR — polyglot sibling of `@montionugera/entity-spec`, sharing the wire-format contracts in [`../../../contracts`](../../../contracts).

## Install

```bash
pip install server-decorator-entity
```

## Usage

```python
from typing import Annotated
from server_decorator_entity import restful, Id, Email, entity_spec

@restful(path="users")
class User:
    id: Annotated[str, Id()]
    email: Annotated[str, Email()]

spec = entity_spec(User)  # -> EntitySpec IR, byte-identical to the Node emitter
```

`entity_spec_canonical(User)` returns the IR as a canonical JSON string (codepoint-sorted keys,
`None`-dropping) — the exact bytes both languages' generators and the cross-language parity
check compare against.
