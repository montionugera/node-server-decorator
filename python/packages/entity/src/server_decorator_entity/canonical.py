"""Canonical EntitySpec JSON — contracts/rules/entity-spec-canonical.md."""

import json
from typing import Any


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
