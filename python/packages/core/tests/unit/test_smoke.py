"""Smoke test: package imports cleanly and exports the contract version."""

from importlib.metadata import version
from pathlib import Path

# test_smoke.py -> unit -> tests -> core -> packages -> python -> repo root
CONTRACTS_VERSION = (Path(__file__).resolve().parents[5] / "contracts/VERSION").read_text().strip()


def test_imports() -> None:
    import server_decorator as sd

    # Compare against installed distribution metadata (pyproject.toml's `version =`),
    # not a hardcoded literal (I1): a literal keeps passing even when bump-version.sh
    # updates pyproject.toml but drifts from _version.py, which is exactly how
    # `__version__ == "2.0.0"` shipped on PyPI 2.0.2 undetected.
    assert sd.__version__ == version("server-decorator")
    # Read contracts/VERSION rather than a literal, for the same I1 reason as above:
    # a literal keeps passing while _contract.py drifts from the contract it claims.
    assert sd.CONTRACT_VERSION == CONTRACTS_VERSION
    assert sd.cache is not None
    assert sd.tracking is not None
    assert sd.emit_on_success is not None
    assert sd.cache_class is not None
    assert sd.tracking_class is not None
    assert sd.emit_on_success_class is not None
    assert sd.CACHE_MISS is not None
