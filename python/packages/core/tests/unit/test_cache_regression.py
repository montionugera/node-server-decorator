"""Regression tests for confirmed @cache / cache-key defects.

Spec: contracts/rules/cache-key.md and contracts/rules/cache-adapter.md.
"""

from __future__ import annotations

import collections
import dataclasses
import decimal
import json
from collections.abc import Iterator
from pathlib import Path
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


# --- receiver detection does not depend on the parameter being named self/cls -----------


def test_receiver_named_this_is_excluded_and_shared_across_instances() -> None:
    adapter = _RecordingAdapter()
    calls = 0

    class Svc:
        @cache(adapter, ttl=60)
        def go(this, n: int) -> int:  # noqa: N805
            nonlocal calls
            calls += 1
            return n * 2

        @cache(adapter, ttl=60)
        def everything(_) -> str:  # noqa: N805
            return "all"

    class Child(Svc):
        pass

    assert Svc().go(3) == 6
    assert Svc().go(3) == 6
    assert Child().go(3) == 6
    assert Svc().everything() == "all"
    assert adapter.gets == ["Svc.go(3)", "Svc.go(3)", "Svc.go(3)", "Svc.everything()"]
    assert calls == 1


async def test_async_receiver_named_this_is_excluded() -> None:
    adapter = _RecordingAdapter()

    class Svc:
        @cache(adapter, ttl=60)
        async def go(this, n: int, *, scale: int = 1) -> int:  # noqa: N805
            return n * scale

    assert await Svc().go(3, scale=2) == 6
    assert adapter.gets == ["Svc.go(3,scale=2)"]


def test_var_positional_method_excludes_the_instance() -> None:
    adapter = _RecordingAdapter()

    class Svc:
        @cache(adapter, ttl=60)
        def go(*args: Any) -> int:
            return len(args)

    assert Svc().go(3, "a") == 3
    assert Svc().go(3, "a") == 3
    assert adapter.gets == ['Svc.go(3,"a")', 'Svc.go(3,"a")']


def test_classmethod_receiver_named_mcs_is_excluded() -> None:
    adapter = _RecordingAdapter()

    class Svc:
        @classmethod
        @cache(adapter, ttl=60)
        def cm(mcs, n: int) -> int:  # noqa: N804
            return n

    class Child(Svc):
        pass

    assert Svc.cm(1) == 1
    assert Child.cm(1) == 1
    assert Svc().cm(1) == 1
    assert adapter.gets == ["Svc.cm(1)", "Svc.cm(1)", "Svc.cm(1)"]


def test_class_form_excludes_a_receiver_named_this() -> None:
    adapter = _RecordingAdapter()

    @cache_class(adapter, ttl=60)
    class Svc:
        def go(this, n: int) -> int:  # noqa: N805
            return n

    Svc().go(3)
    assert adapter.gets == ["Svc.go(3)"]


def test_staticmethod_keeps_its_first_argument_even_an_instance_of_its_own_class() -> None:
    adapter = _RecordingAdapter()

    class Svc:
        def __init__(self, name: str) -> None:
            self.name = name

        def __str__(self) -> str:
            return f"svc:{self.name}"

        @staticmethod
        @cache(adapter, ttl=60)
        def st(first: Any, n: int = 0) -> int:
            return n

    Svc.st(5)
    Svc.st(Svc("a"), 1)
    Svc("b").st(Svc("c"))
    assert adapter.gets == ["Svc.st(5)", 'Svc.st("svc:a",1)', 'Svc.st("svc:c")']


def test_plain_function_whose_only_parameter_is_named_self_keeps_it_in_the_key() -> None:
    adapter = _RecordingAdapter()

    @cache(adapter, ttl=60)
    def load(self: int) -> int:
        return self * 2

    assert load(1) == 2
    assert load(2) == 4
    name = "test_plain_function_whose_only_parameter_is_named_self_keeps_it_in_the_key.load"
    assert adapter.gets == [f"{name}(1)", f"{name}(2)"]


def test_method_in_class_body_called_with_only_keywords_has_no_receiver_to_drop() -> None:
    adapter = _RecordingAdapter()

    class Svc:
        @staticmethod
        @cache(adapter, ttl=60)
        def st(n: int) -> int:
            return n

    assert Svc.st(n=4) == 4
    assert adapter.gets == ["Svc.st(n=4)"]


def test_callable_without_an_inspectable_signature_keeps_every_arg() -> None:
    adapter = _RecordingAdapter()

    def raw(n: int) -> int:
        return n

    raw.__signature__ = "not a signature"  # type: ignore[attr-defined]
    cached = cache(adapter, ttl=60)(raw)

    assert cached(7) == 7
    assert adapter.gets == ["test_callable_without_an_inspectable_signature_keeps_every_arg.raw(7)"]


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


# --- non-finite hidden in default=str containers -----------------------------------------


@dataclasses.dataclass(frozen=True)
class _Holder:
    x: float


@dataclasses.dataclass
class _Node:
    children: list[Any]


def _revive(val: Any) -> Any:
    if isinstance(val, dict):
        if len(val) == 1 and "$nonfinite" in val:
            token = val["$nonfinite"]
            if token == "NaN":
                return float("nan")
            if token == "Infinity":
                return float("inf")
            if token == "-Infinity":
                return float("-inf")
            raise ValueError(f"Unknown nonfinite token: {token}")
        return {k: _revive(v) for k, v in val.items()}
    if isinstance(val, list):
        return [_revive(v) for v in val]
    return val


_FIXTURE_PATH = (
    Path(__file__).resolve().parents[5]
    / "contracts"
    / "fixtures"
    / "cache-key.errors.examples.json"
)
_FIXTURE_DATA = json.loads(_FIXTURE_PATH.read_text(encoding="utf-8"))
_EXAMPLES: list[dict[str, Any]] = _FIXTURE_DATA["examples"]


@pytest.mark.parametrize("value", [float("nan"), float("inf"), float("-inf")])
def test_non_finite_hidden_in_default_str_containers_raise(value: float) -> None:
    with pytest.raises(ValueError):
        build_cache_key("F.b", ({value},), {})
    with pytest.raises(ValueError):
        build_cache_key("F.b", (frozenset([value]),), {})
    with pytest.raises(ValueError):
        build_cache_key("F.b", (_Holder(value),), {})
    with pytest.raises(ValueError):
        build_cache_key("F.b", (collections.deque([value]),), {})
    with pytest.raises(ValueError):
        build_cache_key("F.b", ({"a": [{value}]},), {})
    with pytest.raises(ValueError):
        build_cache_key("F.b", (frozenset([_Holder(value)]),), {})
    with pytest.raises(ValueError):
        build_cache_key("F.b", (), {"k": {value}})
    with pytest.raises(ValueError):
        build_cache_key("F.b", (complex(value, 1),), {})


@pytest.mark.parametrize(
    "value",
    [
        decimal.Decimal("NaN"),
        decimal.Decimal("sNaN"),
        decimal.Decimal("Infinity"),
        decimal.Decimal("-Infinity"),
    ],
)
def test_non_finite_decimal_raises(value: decimal.Decimal) -> None:
    with pytest.raises(ValueError):
        build_cache_key("F.b", (value,), {})
    with pytest.raises(ValueError):
        build_cache_key("F.b", ([value],), {})


def test_finite_values_in_default_str_containers_keep_their_key() -> None:
    assert build_cache_key("F.b", ({1.5},), {}) == "F.b([1.5])"
    assert build_cache_key("F.b", (_Holder(1.5),), {}) == 'F.b("_Holder(x=1.5)")'
    assert build_cache_key("F.b", (decimal.Decimal("1.5"),), {}) == 'F.b("1.5")'
    assert build_cache_key("F.b", (collections.deque([1]),), {}) == 'F.b("deque([1])")'


def test_self_referential_dataclass_does_not_recurse_forever() -> None:
    n = _Node([])
    n.children.append(n)
    res = build_cache_key("F.b", (n,), {})
    assert isinstance(res, str)


@pytest.mark.parametrize("ex", _EXAMPLES, ids=[ex["name"] for ex in _EXAMPLES])
def test_shared_rejection_fixture(ex: dict[str, Any]) -> None:
    revived_args = tuple(_revive(ex["args"]))
    revived_kwargs = _revive(ex["kwargs"])
    with pytest.raises(ValueError):
        build_cache_key(ex["qualname"], revived_args, revived_kwargs)


def test_shared_rejection_fixture_is_not_empty() -> None:
    assert len(_EXAMPLES) >= 8


def test_set_and_frozenset_deterministic_key() -> None:
    assert build_cache_key("q", ({"b", "a", "c"},), {}) == 'q(["a","b","c"])'
    assert build_cache_key("q", (frozenset({"b", "a", "c"}),), {}) == 'q(["a","b","c"])'
    assert build_cache_key("q", ({3, 1, 2},), {}) == "q([1,2,3])"
    with pytest.raises(ValueError):
        build_cache_key("q", ({float("nan")},), {})
    assert build_cache_key("q", ({frozenset({2, 1})},), {}) == "q([[1,2]])"
