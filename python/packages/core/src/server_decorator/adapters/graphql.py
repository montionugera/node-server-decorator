"""GraphQL DataLoader adapter and request-scoped loader registry."""

from __future__ import annotations

import asyncio
import contextvars
import functools
import inspect
from collections.abc import Awaitable, Callable
from typing import Any, TypeVar, cast

T = TypeVar("T")
TParent = TypeVar("TParent")
TKey = TypeVar("TKey")
TResult = TypeVar("TResult")


class GraphQLLoaderRegistry:
    """Request-scoped registry holding loader instances and batch queues."""

    def __init__(self) -> None:
        self._loaders: dict[str, Any] = {}
        self._disposers: list[Callable[[], Any]] = []

    def get_or_create(self, name: str, factory: Callable[[], T]) -> T:
        if name not in self._loaders:
            self._loaders[name] = factory()
        return cast(T, self._loaders[name])

    def on_dispose(self, disposer: Callable[[], Any]) -> None:
        self._disposers.append(disposer)

    async def dispose(self) -> None:
        for disposer in self._disposers:
            try:
                res = disposer()
                if inspect.isawaitable(res):
                    await res
            except Exception:
                pass
        self._loaders.clear()
        self._disposers.clear()


_GRAPHQL_LOADER_CONTEXT: contextvars.ContextVar[GraphQLLoaderRegistry | None] = (
    contextvars.ContextVar("graphql_loader_context", default=None)
)


def get_active_graphql_loader_registry() -> GraphQLLoaderRegistry | None:
    return _GRAPHQL_LOADER_CONTEXT.get()


def create_graphql_loader_context() -> dict[str, Any]:
    """Create request-scoped loader registry context.

    Supports Strawberry, Ariadne, or custom execution engines.
    """
    registry = GraphQLLoaderRegistry()
    token = _GRAPHQL_LOADER_CONTEXT.set(registry)

    async def cleanup() -> None:
        try:
            await registry.dispose()
        finally:
            _GRAPHQL_LOADER_CONTEXT.reset(token)

    return {
        "loaders": registry,
        "cleanup_loaders": cleanup,
    }


def graphql_loader(
    *,
    key: Callable[[Any], Any],
    service: Any = None,
    method: str | None = None,
    loader: Callable[[Any], Awaitable[Any]] | None = None,
    is_list: bool = False,
) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    """Decorator or wrapper adapting a GraphQL field resolver to request-scoped batch loader."""

    def decorator(fn: Callable[..., Any]) -> Callable[..., Any]:
        @functools.wraps(fn)
        async def wrapper(*args: Any, **kwargs: Any) -> Any:
            parent = args[0] if len(args) > 0 else kwargs.get("root") or kwargs.get("parent")
            if parent is None:
                return None

            k = key(parent)
            if k is None:
                return None

            # Resolve registry from active contextvar or info/context kwargs
            registry = get_active_graphql_loader_registry()
            if registry is None:
                # Check if info.context contains loaders
                info = kwargs.get("info")
                if info is not None and hasattr(info, "context") and isinstance(info.context, dict):
                    registry = info.context.get("loaders")

            load_fn = loader
            if load_fn is None and service is not None and method:
                target_service = (
                    service() if callable(service) and not hasattr(service, method) else service
                )
                cache_key = f"{target_service.__class__.__name__}.{method}"
                if registry is not None:
                    load_fn = registry.get_or_create(
                        cache_key, lambda: getattr(target_service, method)
                    )
                else:
                    load_fn = getattr(target_service, method)

            if load_fn is None:
                raise ValueError(
                    "graphql_loader requires either 'loader' or 'service' and 'method'"
                )

            if isinstance(k, (list, tuple)):
                if len(k) == 0:
                    return []
                return await asyncio.gather(*(load_fn(item_key) for item_key in k))

            res = await load_fn(k)
            if is_list:
                return res if isinstance(res, list) else ([res] if res is not None else [])
            return res

        return cast(Callable[..., Any], wrapper)

    return decorator
