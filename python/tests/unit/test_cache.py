"""Unit tests for @cache, cache_class, and the CACHE_MISS sentinel."""

from __future__ import annotations

from typing import Any

import pytest

from server_decorator import CACHE_MISS, cache, cache_class


class _InMemAdapter:
    def __init__(self) -> None:
        self.store: dict[str, Any] = {}
        self.gets: list[str] = []
        self.sets: list[tuple[str, Any, int]] = []

    def get(self, key: str) -> Any:
        self.gets.append(key)
        return self.store.get(key, CACHE_MISS)

    def set(self, key: str, value: Any, ttl: int) -> None:
        self.sets.append((key, value, ttl))
        self.store[key] = value


def test_sync_miss_then_hit() -> None:
    a = _InMemAdapter()
    calls = {"n": 0}

    class Svc:
        @cache(a, ttl=60)
        def go(self, x: int) -> int:
            calls["n"] += 1
            return x * 2

    s = Svc()
    assert s.go(3) == 6
    assert s.go(3) == 6
    assert calls["n"] == 1
    assert len(a.sets) == 1


async def test_async_miss_then_hit() -> None:
    a = _InMemAdapter()
    calls = {"n": 0}

    class Svc:
        @cache(a, ttl=60)
        async def go(self, x: int) -> int:
            calls["n"] += 1
            return x * 2

    s = Svc()
    assert await s.go(3) == 6
    assert await s.go(3) == 6
    assert calls["n"] == 1


def test_caches_falsy_values_via_cache_miss_sentinel() -> None:
    """D-B: None/0/""/False are valid cached values, distinct from miss."""
    a = _InMemAdapter()
    calls = {"none": 0, "zero": 0, "empty": 0, "false": 0}

    class Svc:
        @cache(a, ttl=60)
        def returns_none(self) -> None:
            calls["none"] += 1
            return None

        @cache(a, ttl=60)
        def returns_zero(self) -> int:
            calls["zero"] += 1
            return 0

        @cache(a, ttl=60)
        def returns_empty(self) -> str:
            calls["empty"] += 1
            return ""

        @cache(a, ttl=60)
        def returns_false(self) -> bool:
            calls["false"] += 1
            return False

    s = Svc()
    for _ in range(2):
        assert s.returns_none() is None
        assert s.returns_zero() == 0
        assert s.returns_empty() == ""
        assert s.returns_false() is False
    # Each method called exactly once — second call hit the cache.
    assert all(v == 1 for v in calls.values())


def test_kwargs_in_key() -> None:
    a = _InMemAdapter()
    calls = {"n": 0}

    class Svc:
        @cache(a, ttl=60)
        def go(self, x: int, y: int = 10) -> int:
            calls["n"] += 1
            return x + y

    s = Svc()
    assert s.go(1, y=2) == 3
    assert s.go(1, y=2) == 3
    assert s.go(1, y=3) == 4
    # Different y → different key → separate compute.
    assert calls["n"] == 2


def test_class_form() -> None:
    a = _InMemAdapter()
    calls = {"n": 0}

    @cache_class(a, ttl=60)
    class Svc:
        def go(self, x: int) -> int:
            calls["n"] += 1
            return x * 2

        def _private(self, x: int) -> int:
            return x

    s = Svc()
    s.go(3)
    s.go(3)
    s._private(99)  # not wrapped — no caching
    s._private(99)
    assert calls["n"] == 1


@pytest.mark.parametrize("err_cls", [RuntimeError, ValueError])
def test_underlying_exception_propagates(err_cls: type[BaseException]) -> None:
    a = _InMemAdapter()

    class Svc:
        @cache(a, ttl=60)
        def go(self) -> int:
            raise err_cls("boom")

    with pytest.raises(err_cls, match="boom"):
        Svc().go()
    # Nothing was set.
    assert a.sets == []
