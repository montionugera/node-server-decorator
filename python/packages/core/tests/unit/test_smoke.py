"""Smoke test: package imports cleanly and exports the contract version."""


def test_imports() -> None:
    import server_decorator as sd

    assert sd.__version__ == "2.0.2"
    assert sd.CONTRACT_VERSION == "1.0.0"
    assert sd.cache is not None
    assert sd.tracking is not None
    assert sd.emit_on_success is not None
    assert sd.cache_class is not None
    assert sd.tracking_class is not None
    assert sd.emit_on_success_class is not None
    assert sd.CACHE_MISS is not None
