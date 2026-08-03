# server-decorator-gen-pydantic (Python)

Compiles the language-neutral EntitySpec IR (emitted by `server-decorator-entity`'s `@restful`
decorator) into pydantic v2 `create` / `update` / `read` / action-input DTO models — the
polyglot sibling of `@montionugera/entity-spec-gen-zod`, sharing the wire-format contracts in
[`../../../contracts`](../../../contracts).

## Usage

```python
from server_decorator_entity import entity_spec
from server_decorator_entity.testing.user_fixture import UserFixture
from server_decorator_gen_pydantic import create_model_for, validation_error_fields
import pydantic

spec = entity_spec(UserFixture)
Create = create_model_for(spec)

try:
    Create.model_validate({"email": "not-an-email", "name": "M", "status": "inactive", "tags": []})
except pydantic.ValidationError as exc:
    validation_error_fields(exc)  # -> ["email", "name"]
```

## DTO rules (parity with gen-zod)

- `create_model_for` — excludes `readonly` fields. `extra="forbid"`.
- `update_model_for` — same field set as create, all made optional (partial update); a field's
  own `nullable` flag is unchanged, so a key may be **absent** but an explicitly-provided `null`
  is only accepted when the field is `nullable`.
- `read_model_for` — excludes `writeonly` fields.
- `action_input_model_for(spec, name)` — the named action's `input` fields, all required unless
  marked `optional` in the IR.
- Nested `obj`/`list` fields thread the same DTO include predicate recursively, so a
  `readonly`/`writeonly` nested field is excluded from the DTOs that shouldn't see it (and
  `extra="forbid"` then rejects it as an unknown key if present).

## `datetime` fields

The IR's `datetime` type requires an explicit UTC offset on the wire (multi-replica decision) —
modeled with `pydantic.AwareDatetime`. A naive ISO-8601 string (no offset) is rejected.
