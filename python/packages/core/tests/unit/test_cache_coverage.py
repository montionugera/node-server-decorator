"""Unit coverage for decorators/cache.py — sync wrapper, fail-open writes, async-adapter
misuse, receiver stripping and the class form."""

from __future__ import annotations

import inspect
import math
from collections.abc import Iterator
from typing import Any

import pytest

from server_decorator import logger as logger_mod
from server_decorator.decorators.cache import CACHE_MISS, _has_receiver, cache, cache_class


class _SyncAdapter:
    def __init__(self) -> None:
        self.store: dict[str, Any] = {}
        self.sets: list[tuple[str, Any, int]] = []

    def get(self, key: str) -> Any:
        return self.store.get(key, CACHE_MISS)

    def set(self, key: str, value: Any, ttl: int) -> None:
        self.sets.append((key, value, ttl))
        self.store[key] = value


class _AsyncAdapter(_SyncAdapter):
    async def get(self, key: str) -> Any:  # type: ignore[override]
        return self.store.get(key, CACHE_MISS)

    async def set(self, key: str, value: Any, ttl: int) -> None:  # type: ignore[override]
        self.sets.append((key, value, ttl))
        self.store[key] = value


class _FailingSetAdapter(_SyncAdapter):
    def set(self, key: str, value: Any, ttl: int) -> None:
        raise ConnectionError("redis down")


class _AsyncFailingSetAdapter(_AsyncAdapter):
    async def set(self, key: str, value: Any, ttl: int) -> None:  # type: ignore[override]
        raise ConnectionError("redis down")


class _CaptureLogger:
    def __init__(self) -> None:
        self.warnings: list[str] = []

    def debug(self, msg: object) -> None: ...
    def info(self, msg: object) -> None: ...
    def error(self, msg: object) -> None: ...

    def warn(self, msg: object) -> None:
        self.warnings.append(str(msg))


@pytest.fixture
def captured_log() -> Iterator[_CaptureLogger]:
    saved = logger_mod.global_logger
    capture = _CaptureLogger()
    logger_mod.set_global_logger(capture)
    yield capture
    logger_mod.set_global_logger(saved)


# --- _has_receiver ----------------------------------------------------------


def test_has_receiver_detects_self_and_cls_first_param() -> None:
    def method(self: Any, a: int) -> None: ...
    def classmethod_like(cls: Any) -> None: ...
    def plain(a: int, self: Any) -> None: ...
    def no_params() -> None: ...

    assert _has_receiver(method) is True
    assert _has_receiver(classmethod_like) is True
    assert _has_receiver(plain) is False  # only the FIRST parameter counts
    assert _has_receiver(no_params) is False


def test_has_receiver_is_false_when_signature_is_unavailable() -> None:
    class _NoSignature:
        @property
        def __signature__(self) -> Any:
            raise ValueError("no signature")

        def __call__(self, *args: Any) -> None: ...

    with pytest.raises(ValueError):
        inspect.signature(_NoSignature())

    assert _has_receiver(_NoSignature()) is False
    assert _has_receiver(42) is False  # type: ignore[arg-type]  # non-callable → TypeError path


# --- sync wrapper -----------------------------------------------------------


def test_sync_miss_runs_fn_and_stores_with_ttl_then_hits() -> None:
    adapter = _SyncAdapter()
    calls: list[int] = []

    @cache(adapter, ttl=30)
    def double(n: int) -> int:
        calls.append(n)
        return n * 2

    assert double(4) == 8
    assert double(4) == 8

    assert calls == [4]  # second call served from cache
    assert len(adapter.sets) == 1
    key, value, ttl = adapter.sets[0]
    assert (value, ttl) == (8, 30)
    assert "double" in key


def test_sync_distinct_args_and_kwargs_get_distinct_keys() -> None:
    adapter = _SyncAdapter()
    calls: list[tuple[int, int]] = []

    @cache(adapter, ttl=1)
    def add(a: int, b: int = 0) -> int:
        calls.append((a, b))
        return a + b

    assert add(1) == 1
    assert add(2) == 2
    assert add(1, b=5) == 6
    assert add(1) == 1  # hit

    assert calls == [(1, 0), (2, 0), (1, 5)]
    assert len({k for k, _, _ in adapter.sets}) == 3


@pytest.mark.parametrize("falsy", [None, 0, "", False, [], {}, 0.0])
def test_sync_falsy_results_are_cached_as_hits(falsy: Any) -> None:
    adapter = _SyncAdapter()
    calls: list[int] = []

    @cache(adapter, ttl=1)
    def produce() -> Any:
        calls.append(1)
        return falsy

    first, second = produce(), produce()

    assert first == falsy and second == falsy
    assert type(second) is type(falsy)
    assert calls == [1]  # D-B: falsy value is a hit, not a miss


def test_sync_nan_result_is_cached() -> None:
    adapter = _SyncAdapter()
    calls: list[int] = []

    @cache(adapter, ttl=1)
    def produce() -> float:
        calls.append(1)
        return math.nan

    assert math.isnan(produce())
    assert math.isnan(produce())
    assert calls == [1]


def test_sync_fn_error_propagates_and_caches_nothing() -> None:
    adapter = _SyncAdapter()

    @cache(adapter, ttl=1)
    def boom() -> None:
        raise ValueError("fn boom")

    with pytest.raises(ValueError, match="fn boom"):
        boom()

    assert adapter.sets == []


def test_sync_get_error_propagates_without_running_fn() -> None:
    class _FailingGet(_SyncAdapter):
        def get(self, key: str) -> Any:
            raise ConnectionError("redis down")

    calls: list[int] = []

    @cache(_FailingGet(), ttl=1)
    def produce() -> int:
        calls.append(1)
        return 1

    with pytest.raises(ConnectionError, match="redis down"):
        produce()

    assert calls == []


def test_sync_set_failure_fails_open_and_warns(captured_log: _CaptureLogger) -> None:
    adapter = _FailingSetAdapter()
    calls: list[int] = []

    @cache(adapter, ttl=1)
    def produce(n: int) -> int:
        calls.append(n)
        return n + 1

    assert produce(1) == 2  # result survives the failed write
    assert produce(1) == 2  # nothing was cached → fn runs again

    assert calls == [1, 1]
    assert len(captured_log.warnings) == 2
    assert "@cache: failed to write key" in captured_log.warnings[0]
    assert "produce" in captured_log.warnings[0]
    assert "ConnectionError" in captured_log.warnings[0]


def test_sync_fn_with_async_adapter_get_raises_type_error_without_running_fn(
    recwarn: pytest.WarningsRecorder,
) -> None:
    calls: list[int] = []

    @cache(_AsyncAdapter(), ttl=1)
    def produce() -> int:
        calls.append(1)
        return 1

    with pytest.raises(TypeError, match="async adapter used with a sync function"):
        produce()

    assert calls == []
    # the stray coroutine was closed, not leaked
    assert not [w for w in recwarn.list if "never awaited" in str(w.message)]


def test_sync_fn_with_async_set_only_adapter_raises_type_error(
    recwarn: pytest.WarningsRecorder,
) -> None:
    class _AsyncSetOnly(_SyncAdapter):
        async def set(self, key: str, value: Any, ttl: int) -> None:  # type: ignore[override]
            self.store[key] = value

    adapter = _AsyncSetOnly()
    calls: list[int] = []

    @cache(adapter, ttl=1)
    def produce() -> int:
        calls.append(1)
        return 1

    with pytest.raises(TypeError, match="async adapter used with a sync function"):
        produce()

    assert calls == [1]  # fn ran, but the un-awaited write is reported, not swallowed
    assert adapter.store == {}
    assert not [w for w in recwarn.list if "never awaited" in str(w.message)]


def test_sync_fn_with_non_closable_awaitable_still_raises_type_error() -> None:
    class _Awaitable:
        def __await__(self) -> Any:
            yield

    class _OddAdapter(_SyncAdapter):
        def get(self, key: str) -> Any:
            return _Awaitable()

    class _OddSetAdapter(_SyncAdapter):
        def set(self, key: str, value: Any, ttl: int) -> Any:
            return _Awaitable()

    @cache(_OddAdapter(), ttl=1)
    def on_get() -> int:
        return 1

    @cache(_OddSetAdapter(), ttl=1)
    def on_set() -> int:
        return 1

    with pytest.raises(TypeError, match="async adapter"):
        on_get()
    with pytest.raises(TypeError, match="async adapter"):
        on_set()


# --- async wrapper ----------------------------------------------------------


@pytest.mark.parametrize("adapter_cls", [_SyncAdapter, _AsyncAdapter])
async def test_async_fn_works_with_sync_and_async_adapters(adapter_cls: type[_SyncAdapter]) -> None:
    adapter = adapter_cls()
    calls: list[int] = []

    @cache(adapter, ttl=7)
    async def triple(n: int) -> int:
        calls.append(n)
        return n * 3

    assert await triple(2) == 6
    assert await triple(2) == 6

    assert calls == [2]
    assert [(v, t) for _, v, t in adapter.sets] == [(6, 7)]


@pytest.mark.parametrize("adapter_cls", [_FailingSetAdapter, _AsyncFailingSetAdapter])
async def test_async_set_failure_fails_open_and_warns(
    adapter_cls: type[_SyncAdapter], captured_log: _CaptureLogger
) -> None:
    @cache(adapter_cls(), ttl=1)
    async def produce() -> str:
        return "value"

    assert await produce() == "value"

    assert len(captured_log.warnings) == 1
    assert "failed to write key" in captured_log.warnings[0]
    assert "redis down" in captured_log.warnings[0]


async def test_async_fn_error_propagates_and_caches_nothing() -> None:
    adapter = _AsyncAdapter()

    @cache(adapter, ttl=1)
    async def boom() -> None:
        raise ValueError("fn boom")

    with pytest.raises(ValueError, match="fn boom"):
        await boom()

    assert adapter.sets == []


async def test_async_none_result_is_a_hit_on_second_call() -> None:
    adapter = _AsyncAdapter()
    calls: list[int] = []

    @cache(adapter, ttl=1)
    async def produce() -> None:
        calls.append(1)

    assert await produce() is None
    assert await produce() is None
    assert calls == [1]


# --- receiver stripping / metadata / class form -----------------------------


def test_method_key_excludes_receiver_so_instances_share_entries() -> None:
    adapter = _SyncAdapter()
    calls: list[int] = []

    class Repo:
        @cache(adapter, ttl=1)
        def find(self, id_: int) -> int:
            calls.append(id_)
            return id_ * 10

    assert Repo().find(1) == 10
    assert Repo().find(1) == 10  # different instance, same key

    assert calls == [1]
    assert len(adapter.store) == 1
    assert "0x" not in next(iter(adapter.store))  # no instance repr / memory address in the key


def test_wrapper_preserves_function_metadata() -> None:
    adapter = _SyncAdapter()

    @cache(adapter, ttl=1)
    def documented(a: int) -> int:
        """Docstring."""
        return a

    @cache(adapter, ttl=1)
    async def documented_async(a: int) -> int:
        return a

    assert documented.__name__ == "documented"
    assert documented.__doc__ == "Docstring."
    assert inspect.iscoroutinefunction(documented_async)
    assert not inspect.iscoroutinefunction(documented)


def test_cache_class_wraps_public_methods_only() -> None:
    adapter = _SyncAdapter()
    calls: list[str] = []

    @cache_class(adapter, ttl=9)
    class Svc:
        def public(self, n: int) -> int:
            calls.append("public")
            return n

        def _private(self, n: int) -> int:
            calls.append("private")
            return n

    svc = Svc()
    assert svc.public(1) == 1
    assert svc.public(1) == 1
    assert svc._private(1) == 1
    assert svc._private(1) == 1

    assert calls == ["public", "private", "private"]
    assert [(v, t) for _, v, t in adapter.sets] == [(1, 9)]


def test_cache_class_exclude_and_include_private() -> None:
    adapter = _SyncAdapter()
    calls: list[str] = []

    @cache_class(adapter, ttl=1, exclude=("skipped",), include_private=True)
    class Svc:
        def skipped(self) -> int:
            calls.append("skipped")
            return 1

        def _private(self) -> int:
            calls.append("private")
            return 2

    svc = Svc()
    assert (svc.skipped(), svc.skipped()) == (1, 1)
    assert (svc._private(), svc._private()) == (2, 2)

    assert calls == ["skipped", "skipped", "private"]
