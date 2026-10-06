"""Regression tests for the GraphQL loader adapter: request isolation, service
resolution by identity, class/factory service forms, and ContextVar scoping."""

import asyncio
import contextvars
from types import SimpleNamespace
from typing import Any

import pytest

from server_decorator import (
    GraphQLLoaderRegistry,
    batch_load,
    create_graphql_loader_context,
    graphql_loader,
    graphql_loader_scope,
)
from server_decorator.adapters.graphql import get_active_graphql_loader_registry

_USER: contextvars.ContextVar[str] = contextvars.ContextVar("test_user", default="nobody")


def _info(ctx: Any) -> SimpleNamespace:
    return SimpleNamespace(context=ctx)


def _noop(*_args: Any, **_kwargs: Any) -> None:
    return None


def _doc_service(queries: list[str]) -> Any:
    class DocService:
        async def batch_find(self, ids: list[str]) -> list[dict[str, str]]:
            user = _USER.get()
            queries.append(f"{user}:{','.join(ids)}")
            return [{"id": i, "owner": user} for i in ids]

        @batch_load(batch_method="batch_find")
        async def find_by_id(self, doc_id: str) -> dict[str, str]: ...

    return DocService()


async def _as_user(user: str, coro_fn: Any) -> Any:
    async def run() -> Any:
        _USER.set(user)
        return await coro_fn()

    return await asyncio.create_task(run())


class TestRequestIsolation:
    async def test_same_key_is_not_served_from_previous_request(self) -> None:
        queries: list[str] = []
        resolver = graphql_loader(
            service=_doc_service(queries), method="find_by_id", key=lambda p: p["doc_id"]
        )(_noop)

        ctx_a = create_graphql_loader_context()
        a = await _as_user("alice", lambda: resolver({"doc_id": "doc1"}, info=_info(ctx_a)))
        await ctx_a["cleanup_loaders"]()

        ctx_b = create_graphql_loader_context()
        b = await _as_user("bob", lambda: resolver({"doc_id": "doc1"}, info=_info(ctx_b)))
        await ctx_b["cleanup_loaders"]()

        assert a == {"id": "doc1", "owner": "alice"}
        assert b == {"id": "doc1", "owner": "bob"}
        assert queries == ["alice:doc1", "bob:doc1"]

    async def test_concurrent_requests_are_not_merged_into_one_batch(self) -> None:
        queries: list[str] = []
        resolver = graphql_loader(
            service=_doc_service(queries), method="find_by_id", key=lambda p: p["doc_id"]
        )(_noop)

        ctx_a = create_graphql_loader_context()
        ctx_b = create_graphql_loader_context()
        a, b = await asyncio.gather(
            _as_user("alice", lambda: resolver({"doc_id": "x"}, info=_info(ctx_a))),
            _as_user("bob", lambda: resolver({"doc_id": "y"}, info=_info(ctx_b))),
        )

        assert a == {"id": "x", "owner": "alice"}
        assert b == {"id": "y", "owner": "bob"}
        assert sorted(queries) == ["alice:x", "bob:y"]

    async def test_no_registry_shares_nothing_between_calls(self) -> None:
        queries: list[str] = []
        resolver = graphql_loader(
            service=_doc_service(queries), method="find_by_id", key=lambda p: p["doc_id"]
        )(_noop)

        a = await _as_user("alice", lambda: resolver({"doc_id": "doc1"}))
        b = await _as_user("bob", lambda: resolver({"doc_id": "doc1"}, info=None))

        assert a == {"id": "doc1", "owner": "alice"}
        assert b == {"id": "doc1", "owner": "bob"}

    async def test_still_coalesces_within_one_request_with_loader_option(self) -> None:
        queries: list[str] = []
        service = _doc_service(queries)
        resolver = graphql_loader(loader=service.find_by_id, key=lambda p: p["doc_id"])(_noop)

        ctx = create_graphql_loader_context()
        await asyncio.gather(*(resolver({"doc_id": d}, info=_info(ctx)) for d in ("a", "b", "c")))
        await ctx["cleanup_loaders"]()

        assert queries == ["nobody:a,b,c"]

    async def test_positional_info_and_object_context_are_supported(self) -> None:
        queries: list[str] = []
        resolver = graphql_loader(
            service=_doc_service(queries), method="find_by_id", key=lambda p: p["doc_id"]
        )(_noop)

        registry = GraphQLLoaderRegistry()
        info = _info(SimpleNamespace(loaders=registry))
        await asyncio.gather(*(resolver({"doc_id": d}, info) for d in ("a", "b")))

        assert queries == ["nobody:a,b"]


class TestServiceResolution:
    async def test_two_instances_of_one_class_resolve_through_their_own_instance(self) -> None:
        class Repo:
            def __init__(self, tenant: str) -> None:
                self.tenant = tenant

            async def find(self, key: str) -> str:
                return f"{self.tenant}:{key}"

        resolver_a = graphql_loader(service=Repo("tenantA"), method="find", key=lambda p: p["id"])(
            _noop
        )
        resolver_b = graphql_loader(service=Repo("tenantB"), method="find", key=lambda p: p["id"])(
            _noop
        )

        ctx = create_graphql_loader_context()
        assert await resolver_a({"id": "1"}, info=_info(ctx)) == "tenantA:1"
        assert await resolver_b({"id": "1"}, info=_info(ctx)) == "tenantB:1"

    async def test_two_batch_load_instances_keep_separate_queues_in_one_request(self) -> None:
        seen: list[str] = []

        class Repo:
            def __init__(self, tenant: str) -> None:
                self.tenant = tenant

            async def batch(self, ids: list[str]) -> list[dict[str, str]]:
                seen.append(f"{self.tenant}:{','.join(ids)}")
                return [{"id": i, "tenant": self.tenant} for i in ids]

            @batch_load(batch_method="batch")
            async def find(self, key: str) -> dict[str, str]: ...

        resolver_a = graphql_loader(service=Repo("tenantA"), method="find", key=lambda p: p["id"])(
            _noop
        )
        resolver_b = graphql_loader(service=Repo("tenantB"), method="find", key=lambda p: p["id"])(
            _noop
        )

        ctx = create_graphql_loader_context()
        a, b = await asyncio.gather(
            resolver_a({"id": "1"}, info=_info(ctx)), resolver_b({"id": "1"}, info=_info(ctx))
        )

        assert a == {"id": "1", "tenant": "tenantA"}
        assert b == {"id": "1", "tenant": "tenantB"}
        assert sorted(seen) == ["tenantA:1", "tenantB:1"]

    async def test_service_class_form_builds_one_instance_per_request(self) -> None:
        instances: list[Any] = []
        calls: list[str] = []

        class Svc:
            def __init__(self) -> None:
                instances.append(self)

            async def batch(self, ids: list[str]) -> list[dict[str, str]]:
                calls.append(",".join(ids))
                return [{"id": i} for i in ids]

            @batch_load(batch_method="batch")
            async def get(self, key: str) -> dict[str, str]: ...

        resolver = graphql_loader(service=Svc, method="get", key=lambda p: p["id"])(_noop)

        ctx = create_graphql_loader_context()
        out = await asyncio.gather(*(resolver({"id": i}, info=_info(ctx)) for i in ("1", "2", "3")))

        assert out == [{"id": "1"}, {"id": "2"}, {"id": "3"}]
        assert len(instances) == 1
        assert calls == ["1,2,3"]

    async def test_factory_runs_once_per_request(self) -> None:
        built: list[Any] = []
        calls: list[str] = []

        class Svc:
            async def batch(self, ids: list[str]) -> list[dict[str, str]]:
                calls.append(",".join(ids))
                return [{"id": i} for i in ids]

            @batch_load(batch_method="batch")
            async def get(self, key: str) -> dict[str, str]: ...

        def factory() -> Svc:
            svc = Svc()
            built.append(svc)
            return svc

        resolver = graphql_loader(service=factory, method="get", key=lambda p: p["id"])(_noop)

        ctx = create_graphql_loader_context()
        await asyncio.gather(*(resolver({"id": i}, info=_info(ctx)) for i in ("1", "2", "3")))
        assert len(built) == 1
        assert calls == ["1,2,3"]

        ctx2 = create_graphql_loader_context()
        await resolver({"id": "1"}, info=_info(ctx2))
        assert len(built) == 2

    def test_missing_method_fails_at_decoration_time(self) -> None:
        class Svc:
            async def other(self, key: str) -> str:
                return key

        with pytest.raises(ValueError, match="Method 'get' not found"):
            graphql_loader(service=Svc(), method="get", key=lambda p: p["id"])
        with pytest.raises(ValueError, match="Method 'get' not found"):
            graphql_loader(service=Svc, method="get", key=lambda p: p["id"])


class TestContextVarScoping:
    async def test_factory_does_not_touch_the_contextvar(self) -> None:
        ctx = create_graphql_loader_context()
        assert get_active_graphql_loader_registry() is None
        await ctx["cleanup_loaders"]()
        assert get_active_graphql_loader_registry() is None

    async def test_overlapping_contexts_cleaned_up_in_creation_order(self) -> None:
        first = create_graphql_loader_context()
        second = create_graphql_loader_context()
        await first["cleanup_loaders"]()
        await second["cleanup_loaders"]()
        assert get_active_graphql_loader_registry() is None

    async def test_cleanup_from_another_task_does_not_raise(self) -> None:
        ctx = await asyncio.create_task(_make_context())
        await asyncio.create_task(ctx["cleanup_loaders"]())

    async def test_info_context_registry_wins_over_contextvar(self) -> None:
        queries: list[str] = []
        resolver = graphql_loader(
            service=_doc_service(queries), method="find_by_id", key=lambda p: p["doc_id"]
        )(_noop)

        explicit = GraphQLLoaderRegistry()
        used: list[Any] = []
        original = explicit.scope_for

        def spy(identity: Any) -> Any:
            used.append(identity)
            return original(identity)

        explicit.scope_for = spy  # type: ignore[method-assign]

        async with graphql_loader_scope() as ambient:
            assert get_active_graphql_loader_registry() is ambient
            await resolver({"doc_id": "d"}, info=_info({"loaders": explicit}))

        assert len(used) == 1

    async def test_scope_sets_and_restores_the_contextvar(self) -> None:
        queries: list[str] = []
        resolver = graphql_loader(
            service=_doc_service(queries), method="find_by_id", key=lambda p: p["doc_id"]
        )(_noop)

        async with graphql_loader_scope() as registry:
            assert get_active_graphql_loader_registry() is registry
            await asyncio.gather(*(resolver({"doc_id": d}) for d in ("a", "b")))
        assert get_active_graphql_loader_registry() is None
        assert queries == ["nobody:a,b"]

    async def test_scope_exit_out_of_order_never_leaves_a_disposed_registry_active(self) -> None:
        outer = graphql_loader_scope()
        inner = graphql_loader_scope()
        await outer.__aenter__()
        await inner.__aenter__()
        await outer.__aexit__(None, None, None)
        await inner.__aexit__(None, None, None)
        assert get_active_graphql_loader_registry() is None


async def _make_context() -> dict[str, Any]:
    return create_graphql_loader_context()
