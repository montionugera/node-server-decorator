import json
from pathlib import Path

import pydantic
import pytest
from server_decorator_entity import entity_spec
from server_decorator_entity.testing.user_fixture import UserFixture

from server_decorator_gen_pydantic import (
    action_input_model_for,
    create_model_for,
    read_model_for,
    update_model_for,
    validation_error_fields,
)

CONTRACTS = Path(__file__).resolve().parents[5] / "contracts"
CASES = json.loads((CONTRACTS / "fixtures/entity-spec.cases.json").read_text())["cases"]
SPEC = entity_spec(UserFixture)


def model_for(dto: str, spec: dict) -> type[pydantic.BaseModel]:
    if dto == "create":
        return create_model_for(spec)
    if dto == "update":
        return update_model_for(spec)
    if dto == "read":
        return read_model_for(spec)
    if dto.startswith("action:"):
        return action_input_model_for(spec, dto[len("action:") :])
    raise ValueError(dto)


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_contract_case(case: dict) -> None:
    # An optional inline `spec` (IR) replaces the User fixture for that case.
    model = model_for(case["dto"], case.get("spec", SPEC))
    if case["valid"]:
        model.model_validate(case["payload"])
    else:
        with pytest.raises(pydantic.ValidationError) as ei:
            model.model_validate(case["payload"])
        assert validation_error_fields(ei.value) == sorted(case["errorFields"])
