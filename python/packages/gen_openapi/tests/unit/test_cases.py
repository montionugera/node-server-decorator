import json
from pathlib import Path
from typing import Any

import pytest

from server_decorator_gen_openapi import openapi_document

# test_cases.py -> unit -> tests -> gen_openapi -> packages -> python -> repo root
_CASES_FILE = Path(__file__).resolve().parents[5] / "contracts/fixtures/entity-spec.cases.json"
CASES: list[dict[str, Any]] = json.loads(_CASES_FILE.read_text()).get("openapi", [])


def _resolve(doc: Any, pointer: str) -> Any:
    """RFC 6901 JSON Pointer.

    Path keys in an OpenAPI document contain "/" ("/users/{id}"), so a naive split on "/"
    cannot address them — segments escape "/" as "~1" and "~" as "~0". gen-openapi's Node
    runner resolves pointers identically; keep the two in step.
    """
    node: Any = doc
    for raw in pointer.split("/")[1:]:
        if node is None:
            return None
        key = raw.replace("~1", "/").replace("~0", "~")
        node = node[int(key)] if isinstance(node, list) else node.get(key)
    return node


def test_at_least_one_case() -> None:
    assert len(CASES) > 0


@pytest.mark.parametrize("case", CASES, ids=lambda c: str(c["name"]))
def test_case(case: dict[str, Any]) -> None:
    doc = openapi_document([case["spec"]], "1.2.0")
    for pointer, expected in case["expect"].items():
        assert _resolve(doc, pointer) == expected, pointer
