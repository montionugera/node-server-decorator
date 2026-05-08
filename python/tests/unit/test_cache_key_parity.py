"""Cache-key parity test: load contracts/fixtures/cache-key.examples.json and assert
build_cache_key produces the expected key for each example."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from server_decorator.decorators._cache_key import MAX_KEY_BYTES, build_cache_key

FIXTURE = (
    Path(__file__).resolve().parents[3]
    / "contracts"
    / "fixtures"
    / "cache-key.examples.json"
)


def _load_examples() -> list[dict]:
    return json.loads(FIXTURE.read_text())["examples"]


@pytest.mark.parametrize("ex", _load_examples(), ids=lambda e: e["name"])
def test_cache_key_matches_fixture(ex: dict) -> None:
    actual = build_cache_key(ex["qualname"], tuple(ex["args"]), ex["kwargs"])
    if "expected" in ex:
        assert actual == ex["expected"]
    elif "expected_prefix" in ex:
        assert actual.startswith(ex["expected_prefix"])
        # And the full raw form would have exceeded the byte cap.
        # (We don't reconstruct it, but the prefix presence implies the SHA path.)
    else:
        pytest.fail(f"fixture {ex['name']} has neither expected nor expected_prefix")


def test_max_key_bytes_constant() -> None:
    assert MAX_KEY_BYTES == 250
