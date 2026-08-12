import json
from pathlib import Path

import jsonschema
import pytest

from server_decorator_entity import entity_spec, entity_spec_canonical
from server_decorator_entity.testing.user_fixture import UserFixture

# test_entity_spec.py -> unit -> tests -> entity -> packages -> python -> repo root
CONTRACTS = Path(__file__).resolve().parents[5] / "contracts"


def test_canonical_parity_with_contract_fixture() -> None:
    expected = (CONTRACTS / "fixtures/entity-spec.valid-user.json").read_text().strip()
    assert entity_spec_canonical(UserFixture) == expected


def test_validates_against_schema() -> None:
    schema = json.loads((CONTRACTS / "schemas/entity-spec.schema.json").read_text())
    jsonschema.validate(entity_spec(UserFixture), schema)


def test_undecorated_class_raises() -> None:
    class Naked:
        pass

    with pytest.raises(TypeError, match="not decorated with @restful"):
        entity_spec(Naked)
