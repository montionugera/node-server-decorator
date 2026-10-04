"""Regression tests for confirmed @cache / cache-key defects.

Spec: contracts/rules/cache-key.md and contracts/rules/cache-adapter.md.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest

from server_decorator import CACHE_MISS, cache, cache_class
from server_decorator import logger as logger_mod
from server_decorator.decorators._cache_key import build_cache_key


class _RecordingAdapter:
    def __init__(self) -> None:
        self.store: dict[str, Any] = {}
        self.gets: list[str] = []

    def get(self, key: str) -> Any:
        self.gets.append(key)
        return self.store.get(key, CACHE_MISS)

    def set(self, key: str, value: Any, ttl: int) -> None:
        self.store[key] = value


class _FailingSetAdapter:
    def get(self, key: str) -> Any:
        return CACHE_MISS

    def set(self, key: str, value: Any, ttl: int) -> None:
        raise RuntimeError("redis down")


class _AsyncFailingSetAdapter:
    async def get(self, key: str) -> Any:
        return CACHE_MISS

    async def set(self, key: str, value: Any, ttl: int) -> None:
        raise RuntimeError("redis down")


class _FailingGetAdapter:
    def get(self, key: str) -> Any:
        raise RuntimeError("redis down")

    def set(self, key: str, value: Any, ttl: int) -> None:
        return None


class _CapturingLogger:
    def __init__(self) -> None:
        self.warnings: list[str] = []

    def debug(self, msg: object) -> None: ...
    def info(self, msg: object) -> None: ...
    def error(self, msg: object) -> None: ...

    def warn(self, msg: object) -> None:
        self.warnings.append(str(msg))


@pytest.fixture
def captured_logger() -> Iterator[_CapturingLogger]:
    saved = logger_mod.global_logger
    capturing = _CapturingLogger()
    logger_mod.set_global_logger(capturing)
    try:
        yield capturing
    finally:
        logger_mod.set_global_logger(saved)


# --- receiver (self/cls) is not part of the key -----------------------------------------


def test_instance_method_key_excludes_self_and_is_shared_across_instances() -> None:
    adapter = _RecordingAdapter()
    calls = 0

    class Svc:
        @cache(adapter, ttl=60)
        def go(self, n: int) -> int:
            nonlocal calls
            calls += 1
            return n * 2

    assert Svc().go(3) == 6
    assert Svc().go(3) == 6
    assert adapter.gets == ["Svc.go(3)", "Svc.go(3)"]
    assert calls == 1


async def test_async_instance_method_key_excludes_self() -> None:
    adapter = _RecordingAdapter()

    class Svc:
        @cache(adapter, ttl=60)
        async def go(self, n: int, *, scale: int = 1) -> int:
            return n * scale

    assert await Svc().go(3, scale=2) == 6
    assert adapter.gets == ["Svc.go(3,scale=2)"]


def test_classmethod_key_excludes_cls() -> None:
    adapter = _RecordingAdapter()

    class Svc:
        @classmethod
        @cache(adapter, ttl=60)
        def cm(cls, n: int) -> int:
            return n

    assert Svc.cm(1) == 1
    assert adapter.gets == ["Svc.cm(1)"]


def test_class_form_key_excludes_self() -> None:
    adapter = _RecordingAdapter()

    @cache_class(adapter, ttl=60)
    class Svc:
        def go(self, n: int) -> int:
            return n

    Svc().go(3)
    assert adapter.gets == ["Svc.go(3)"]


def test_free_function_and_staticmethod_keep_every_arg() -> None:
    adapter = _RecordingAdapter()

    @cache(adapter, ttl=60)
    def double(n: int) -> int:
        return n * 2

    class Svc:
        @staticmethod
        @cache(adapter, ttl=60)
        def st(n: int) -> int:
            return n

    double(4)
    Svc.st(5)
    # `double` is nested in this test, so its short qualname carries the enclosing function.
    assert adapter.gets == [
        "test_free_function_and_staticmethod_keep_every_arg.double(4)",
        "Svc.st(5)",
    ]


# --- string escaping ---------------------------------------------------------------------


def test_non_ascii_and_html_chars_are_not_escaped() -> None:
    assert build_cache_key("F.b", ("é<a>&",), {}) == 'F.b("é<a>&")'
    assert build_cache_key("F.b", ({"é": "ก"},), {}) == 'F.b({"é":"ก"})'


def test_byte_cap_counts_utf8_bytes_of_the_unescaped_key() -> None:
    # 80 Thai chars = 240 UTF-8 bytes; raw key is 247 bytes, under the 250 cap.
    # With \uXXXX escaping it would have been 487 bytes and hashed.
    arg = "ก" * 80
    assert build_cache_key("F.b", (arg,), {}) == f'F.b("{arg}")'


# --- non-finite floats -------------------------------------------------------------------


@pytest.mark.parametrize("value", [float("nan"), float("inf"), float("-inf")])
def test_non_finite_floats_raise(value: float) -> None:
    with pytest.raises(ValueError):
        build_cache_key("F.b", (value,), {})
    with pytest.raises(ValueError):
        build_cache_key("F.b", ({"nested": [value]},), {})
    with pytest.raises(ValueError):
        build_cache_key("F.b", (), {"k": value})


def test_non_finite_arg_does_not_call_fn_or_adapter() -> None:
    adapter = _RecordingAdapter()
    calls = 0

    @cache(adapter, ttl=60)
    def price(n: float) -> float:
        nonlocal calls
        calls += 1
        return n

    with pytest.raises(ValueError):
        price(float("nan"))
    assert calls == 0
    assert adapter.gets == []


# --- adapter failures --------------------------------------------------------------------


def test_sync_set_failure_fails_open(captured_logger: _CapturingLogger) -> None:
    calls = 0

    @cache(_FailingSetAdapter(), ttl=60)
    def pay() -> str:
        nonlocal calls
        calls += 1
        return "paid"

    assert pay() == "paid"
    assert calls == 1
    assert len(captured_logger.warnings) == 1
    assert "pay()" in captured_logger.warnings[0]
    assert "redis down" in captured_logger.warnings[0]


async def test_async_fn_sync_adapter_set_failure_fails_open(
    captured_logger: _CapturingLogger,
) -> None:
    calls = 0

    @cache(_FailingSetAdapter(), ttl=60)
    async def pay() -> str:
        nonlocal calls
        calls += 1
        return "paid"

    assert await pay() == "paid"
    assert calls == 1
    assert len(captured_logger.warnings) == 1


async def test_async_adapter_set_failure_fails_open(captured_logger: _CapturingLogger) -> None:
    calls = 0

    @cache(_AsyncFailingSetAdapter(), ttl=60)
    async def pay() -> str:
        nonlocal calls
        calls += 1
        return "paid"

    assert await pay() == "paid"
    assert calls == 1
    assert len(captured_logger.warnings) == 1


def test_sync_get_failure_fails_closed() -> None:
    calls = 0

    @cache(_FailingGetAdapter(), ttl=60)
    def pay() -> str:
        nonlocal calls
        calls += 1
        return "paid"

    with pytest.raises(RuntimeError, match="redis down"):
        pay()
    assert calls == 0


async def test_async_get_failure_fails_closed() -> None:
    calls = 0

    @cache(_FailingGetAdapter(), ttl=60)
    async def pay() -> str:
        nonlocal calls
        calls += 1
        return "paid"

    with pytest.raises(RuntimeError, match="redis down"):
        await pay()
    assert calls == 0
