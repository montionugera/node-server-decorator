"""Unit coverage for adapters/graphql.py: registry lifecycle, registry discovery and the
graphql_loader wrapper's edge and error paths."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from server_decorator.adapters.graphql import (
    GraphQLLoaderRegistry,
    create_graphql_loader_context,
    get_active_graphql_loader_registry,
    graphql_loader,
    graphql_loader_scope,
)
from server_decorator.decorators.coalesce import batch_load_scope

# ----------------------------------------------------------------------------- registry


def test_get_or_create_builds_once_per_name() -> None:
    registry = GraphQLLoaderRegistry()
    built: list[str] = []

    def factory(tag: str) -> Any:
        built.append(tag)
        return object()

    first = registry.get_or_create("users", lambda: factory("a"))
    again = registry.get_or_create("users", lambda: factory("b"))
    other = registry.get_or_create("orders", lambda: factory("c"))

    assert first is again
    assert other is not first
    assert built == ["a", "c"]


def test_get_or_create_caches_falsy_values() -> None:
    registry = GraphQLLoaderRegistry()
    calls = 0

    def factory() -> None:
        nonlocal calls
        calls += 1
        return None

    assert registry.get_or_create("n", factory) is None
    assert registry.get_or_create("n", factory) is None
    assert calls == 1


def test_scope_for_and_service_for_are_keyed_by_identity() -> None:
    registry = GraphQLLoaderRegistry()
    a, b = [], []  # equal but distinct objects

    assert registry.scope_for(a) is registry.scope_for(a)
    assert registry.scope_for(a) is not registry.scope_for(b)
    assert GraphQLLoaderRegistry().scope_for(a) is not registry.scope_for(a)

    built = registry.service_for(a, lambda: {"n": 1})
    assert registry.service_for(a, lambda: {"n": 2}) is built
    assert registry.service_for(b, lambda: {"n": 3}) == {"n": 3}


async def test_dispose_runs_sync_and_async_disposers_in_order_and_survives_errors() -> None:
    registry = GraphQLLoaderRegistry()
    order: list[str] = []

    def sync_disposer() -> None:
        order.append("sync")

    def failing_disposer() -> None:
        order.append("fail")
        raise RuntimeError("disposer boom")

    async def async_disposer() -> None:
        order.append("async")

    async def failing_async_disposer() -> None:
        order.append("async-fail")
        raise ValueError("async disposer boom")

    for d in (sync_disposer, failing_disposer, async_disposer, failing_async_disposer):
        registry.on_dispose(d)
    registry.get_or_create("x", object)
    identity = object()
    token_before = registry.scope_for(identity)
    registry.service_for(identity, object)

    await registry.dispose()

    assert order == ["sync", "fail", "async", "async-fail"]
    assert registry._disposed is True
    assert registry._loaders == {} and registry._services == {} and registry._scopes == {}
    # Disposers are one-shot, and state built after dispose is fresh.
    await registry.dispose()
    assert order == ["sync", "fail", "async", "async-fail"]
    assert registry.scope_for(identity) is not token_before


async def test_create_context_cleanup_disposes_without_touching_ambient_registry() -> None:
    ctx = create_graphql_loader_context()
    registry = ctx["loaders"]
    disposed: list[bool] = []
    registry.on_dispose(lambda: disposed.append(True))

    assert isinstance(registry, GraphQLLoaderRegistry)
    assert get_active_graphql_loader_registry() is None

    await ctx["cleanup_loaders"]()

    assert disposed == [True]
    assert registry._disposed is True


async def test_loader_scope_sets_and_restores_ambient_registry() -> None:
    assert get_active_graphql_loader_registry() is None

    async with graphql_loader_scope() as outer:
        assert get_active_graphql_loader_registry() is outer
        async with graphql_loader_scope() as inner:
            assert inner is not outer
            assert get_active_graphql_loader_registry() is inner
        assert inner._disposed is True
        assert get_active_graphql_loader_registry() is outer

    assert outer._disposed is True
    assert get_active_graphql_loader_registry() is None


async def test_loader_scope_never_restores_a_disposed_previous_registry() -> None:
    async with graphql_loader_scope() as outer:
        async with graphql_loader_scope():
            await outer.dispose()
        assert get_active_graphql_loader_registry() is None


async def test_loader_scope_disposes_when_body_raises() -> None:
    captured: list[GraphQLLoaderRegistry] = []

    with pytest.raises(KeyError):
        async with graphql_loader_scope() as registry:
            captured.append(registry)
            raise KeyError("resolver failed")

    assert captured[0]._disposed is True
    assert get_active_graphql_loader_registry() is None


# ------------------------------------------------------------------------ graphql_loader


def _loader_recording(seen: list[Any]) -> Any:
    async def load(k: Any) -> Any:
        seen.append(k)
        return f"v:{k}"

    return load


async def test_missing_parent_returns_none_without_loading() -> None:
    seen: list[Any] = []

    @graphql_loader(key=lambda p: p["id"], loader=_loader_recording(seen))
    async def resolver(parent: Any, info: Any = None) -> Any: ...

    assert await resolver() is None
    assert await resolver(None) is None
    assert await resolver(root=None, parent=None) is None
    assert seen == []


async def test_none_key_returns_none_without_loading() -> None:
    seen: list[Any] = []

    @graphql_loader(key=lambda p: p.get("author_id"), loader=_loader_recording(seen))
    async def resolver(parent: Any, info: Any = None) -> Any: ...

    assert await resolver({"title": "no author"}) is None
    assert seen == []


async def test_falsy_but_valid_key_is_loaded() -> None:
    seen: list[Any] = []

    @graphql_loader(key=lambda p: p["id"], loader=_loader_recording(seen))
    async def resolver(parent: Any, info: Any = None) -> Any: ...

    assert await resolver({"id": 0}) == "v:0"
    assert await resolver({"id": ""}) == "v:"
    assert seen == [0, ""]


async def test_parent_taken_from_root_or_parent_kwarg() -> None:
    @graphql_loader(key=lambda p: p["id"], loader=_loader_recording([]))
    async def resolver(*args: Any, **kwargs: Any) -> Any: ...

    assert await resolver(root={"id": 1}) == "v:1"
    assert await resolver(parent={"id": 2}) == "v:2"


async def test_list_and_tuple_keys_load_each_item_in_order() -> None:
    seen: list[Any] = []

    @graphql_loader(key=lambda p: p["ids"], loader=_loader_recording(seen))
    async def resolver(parent: Any, info: Any = None) -> Any: ...

    assert await resolver({"ids": [3, 1, 2]}) == ["v:3", "v:1", "v:2"]
    assert await resolver({"ids": (7,)}) == ["v:7"]
    assert sorted(seen) == [1, 2, 3, 7]


async def test_empty_key_list_returns_empty_list_without_loading() -> None:
    seen: list[Any] = []

    @graphql_loader(key=lambda p: p["ids"], loader=_loader_recording(seen))
    async def resolver(parent: Any, info: Any = None) -> Any: ...

    assert await resolver({"ids": []}) == []
    assert await resolver({"ids": ()}) == []
    assert seen == []


@pytest.mark.parametrize(
    ("loaded", "expected"),
    [(["a", "b"], ["a", "b"]), ([], []), ("one", ["one"]), (0, [0]), (None, [])],
)
async def test_is_list_normalises_result(loaded: Any, expected: list[Any]) -> None:
    async def load(_k: Any) -> Any:
        return loaded

    @graphql_loader(key=lambda p: p["id"], loader=load, is_list=True)
    async def resolver(parent: Any, info: Any = None) -> Any: ...

    assert await resolver({"id": 1}) == expected


async def test_without_is_list_result_is_returned_untouched() -> None:
    async def load(_k: Any) -> Any:
        return None

    @graphql_loader(key=lambda p: p["id"], loader=load)
    async def resolver(parent: Any, info: Any = None) -> Any: ...

    assert await resolver({"id": 1}) is None


async def test_neither_loader_nor_service_raises_value_error_on_call() -> None:
    @graphql_loader(key=lambda p: p["id"])
    async def resolver(parent: Any, info: Any = None) -> Any: ...

    with pytest.raises(ValueError, match="requires either 'loader' or 'service' and 'method'"):
        await resolver({"id": 1})


async def test_service_without_method_name_raises_value_error_on_call() -> None:
    class Svc:
        async def load(self, k: Any) -> Any:
            return k

    @graphql_loader(key=lambda p: p["id"], service=Svc())
    async def resolver(parent: Any, info: Any = None) -> Any: ...

    with pytest.raises(ValueError, match="requires either"):
        await resolver({"id": 1})


def test_instance_missing_method_is_rejected_at_decoration_time() -> None:
    class Svc:
        load = "not callable"

    with pytest.raises(ValueError, match="Method 'load' not found on service"):
        graphql_loader(key=lambda p: p, service=Svc(), method="load")
    with pytest.raises(ValueError, match="Method 'missing' not found"):
        graphql_loader(key=lambda p: p, service=SimpleNamespace(), method="missing")


async def test_factory_whose_product_lacks_method_raises_on_call() -> None:
    def factory() -> Any:
        return SimpleNamespace(other=1)

    @graphql_loader(key=lambda p: p["id"], service=factory, method="load")
    async def resolver(parent: Any, info: Any = None) -> Any: ...

    with pytest.raises(ValueError, match="Method 'load' not found on service"):
        await resolver({"id": 1})


async def test_class_service_is_one_instance_per_registry_and_fresh_without_one() -> None:
    instances: list[Any] = []

    class Svc:
        def __init__(self) -> None:
            instances.append(self)

        async def load(self, k: Any) -> Any:
            return (id(self), k)

    @graphql_loader(key=lambda p: p["id"], service=Svc, method="load")
    async def resolver(parent: Any, info: Any = None) -> Any: ...

    async with graphql_loader_scope():
        a = await resolver({"id": 1})
        b = await resolver({"id": 2})
    assert a[0] == b[0]
    assert len(instances) == 1

    c = await resolver({"id": 1})
    d = await resolver({"id": 1})
    assert len(instances) == 3
    assert c[1] == d[1] == 1


async def test_factory_service_is_called_once_per_registry() -> None:
    built = 0

    def factory() -> Any:
        nonlocal built
        built += 1

        async def load(k: Any) -> Any:
            return k * 2

        return SimpleNamespace(load=load)

    @graphql_loader(key=lambda p: p["id"], service=factory, method="load")
    async def resolver(parent: Any, info: Any = None) -> Any: ...

    ctx = create_graphql_loader_context()
    info = SimpleNamespace(context=ctx)

    assert await resolver({"id": 2}, info) == 4
    assert await resolver({"id": 5}, info=info) == 10
    assert built == 1


async def test_batch_scope_is_the_registry_during_load_and_reset_after() -> None:
    observed: list[Any] = []

    async def load(k: Any) -> Any:
        observed.append(batch_load_scope.get())
        return k

    @graphql_loader(key=lambda p: p["id"], loader=load)
    async def resolver(parent: Any, info: Any = None) -> Any: ...

    dict_registry = GraphQLLoaderRegistry()
    attr_registry = GraphQLLoaderRegistry()

    await resolver({"id": 1}, SimpleNamespace(context={"loaders": dict_registry}))
    await resolver({"id": 1}, info=SimpleNamespace(context=SimpleNamespace(loaders=attr_registry)))
    async with graphql_loader_scope() as ambient:
        await resolver({"id": 1})
        # An explicit info.context registry wins over the ambient one.
        await resolver({"id": 1}, SimpleNamespace(context={"loaders": dict_registry}))
        # A non-registry "loaders" value is ignored in favour of the ambient registry.
        await resolver({"id": 1}, SimpleNamespace(context={"loaders": "nope"}))
    await resolver({"id": 1})

    assert observed[0] is dict_registry
    assert observed[1] is attr_registry
    assert observed[2] is ambient
    assert observed[3] is dict_registry
    assert observed[4] is ambient
    # No registry anywhere: a throwaway per-call scope, never None and never shared.
    assert isinstance(observed[5], GraphQLLoaderRegistry)
    assert observed[5] not in (dict_registry, attr_registry, ambient)
    assert batch_load_scope.get() is None


async def test_batch_scope_is_reset_when_loader_raises() -> None:
    async def load(_k: Any) -> Any:
        raise LookupError("row missing")

    @graphql_loader(key=lambda p: p["id"], loader=load)
    async def resolver(parent: Any, info: Any = None) -> Any: ...

    with pytest.raises(LookupError, match="row missing"):
        await resolver({"id": 1})
    with pytest.raises(LookupError):
        await resolver({"id": [1, 2]})

    assert batch_load_scope.get() is None


def test_wrapper_preserves_resolver_metadata() -> None:
    @graphql_loader(key=lambda p: p, loader=_loader_recording([]))
    async def author(parent: Any, info: Any = None) -> Any:
        """Resolve the author."""

    assert author.__name__ == "author"
    assert author.__doc__ == "Resolve the author."
