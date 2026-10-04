"""GraphQL DataLoader adapter and request-scoped loader registry."""

from __future__ import annotations

import asyncio
import contextlib
import contextvars
import functools
import inspect
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any, TypeVar, cast

from server_decorator.decorators.coalesce import batch_load_scope

T = TypeVar("T")
TParent = TypeVar("TParent")
TKey = TypeVar("TKey")
TResult = TypeVar("TResult")


class _ScopeToken:
    """Hashable, weak-referenceable key for one (registry, service instance) batch queue."""

    __slots__ = ("__weakref__",)


class GraphQLLoaderRegistry:
    """Request-scoped registry holding loader instances and batch queues."""

    def __init__(self) -> None:
        self._loaders: dict[str, Any] = {}
        self._disposers: list[Callable[[], Any]] = []
        # Keyed by id(); the identity object is kept alongside so its id cannot be reused.
        self._scopes: dict[int, tuple[Any, object]] = {}
        self._services: dict[int, tuple[Any, Any]] = {}
        self._disposed = False

    def scope_for(self, identity: Any) -> object:
        """Batching scope token for a service instance, unique to this registry.

        @batch_load keys its queue and L1 cache by this token, so neither is shared with
        another request nor outlives dispose().
        """
        entry = self._scopes.get(id(identity))
        if entry is None:
            entry = (identity, _ScopeToken())
            self._scopes[id(identity)] = entry
        return entry[1]

    def service_for(self, source: Any, factory: Callable[[], T]) -> T:
        """Get or build the service for a service option, keyed by identity (never name)."""
        entry = self._services.get(id(source))
        if entry is None:
            entry = (source, factory())
            self._services[id(source)] = entry
        return cast(T, entry[1])

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
        self._disposed = True
        self._loaders.clear()
        self._scopes.clear()
        self._services.clear()
        self._disposers.clear()


_GRAPHQL_LOADER_CONTEXT: contextvars.ContextVar[GraphQLLoaderRegistry | None] = (
    contextvars.ContextVar("graphql_loader_context", default=None)
)


def get_active_graphql_loader_registry() -> GraphQLLoaderRegistry | None:
    return _GRAPHQL_LOADER_CONTEXT.get()


def create_graphql_loader_context() -> dict[str, Any]:
    """Create a request-scoped loader registry context.

    Returns {"loaders": registry, "cleanup_loaders": cleanup} to merge into the GraphQL
    context (info.context). It does NOT touch any ContextVar, so contexts may overlap and
    be cleaned up in any order or from any task. Use graphql_loader_scope() when resolvers
    cannot reach info.context.
    """
    registry = GraphQLLoaderRegistry()

    async def cleanup() -> None:
        await registry.dispose()

    return {
        "loaders": registry,
        "cleanup_loaders": cleanup,
    }


@contextlib.asynccontextmanager
async def graphql_loader_scope() -> AsyncIterator[GraphQLLoaderRegistry]:
    """Make a fresh registry the ambient one for the enclosed block (ContextVar scoped)."""
    registry = GraphQLLoaderRegistry()
    previous = _GRAPHQL_LOADER_CONTEXT.get()
    _GRAPHQL_LOADER_CONTEXT.set(registry)
    try:
        yield registry
    finally:
        await registry.dispose()
        # Never reset(token): it raises across tasks and restores stale registries when
        # scopes exit out of order. Only step back if this registry is still the active one,
        # and never to a registry that has already been disposed.
        if _GRAPHQL_LOADER_CONTEXT.get() is registry:
            live = previous is not None and not previous._disposed
            _GRAPHQL_LOADER_CONTEXT.set(previous if live else None)


def _registry_from_info(
    args: tuple[Any, ...], kwargs: dict[str, Any]
) -> GraphQLLoaderRegistry | None:
    info = kwargs.get("info")
    if info is None and len(args) > 1:
        info = args[1]
    context = getattr(info, "context", None)
    if isinstance(context, dict):
        candidate = context.get("loaders")
    else:
        candidate = getattr(context, "loaders", None)
    return candidate if isinstance(candidate, GraphQLLoaderRegistry) else None


def graphql_loader(
    *,
    key: Callable[[Any], Any],
    service: Any = None,
    method: str | None = None,
    loader: Callable[[Any], Awaitable[Any]] | None = None,
    is_list: bool = False,
) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    """Decorator or wrapper adapting a GraphQL field resolver to request-scoped batch loader."""

    # A class is instantiated; a callable that does not expose the method is a factory;
    # anything else is a pre-built instance used as-is.
    is_class = inspect.isclass(service)
    is_factory = not is_class and callable(service) and not hasattr(service, method or "")

    def build_service() -> Any:
        return service() if is_class or is_factory else service

    if loader is None and service is not None and method and not is_factory:
        if not callable(getattr(service, method, None)):
            raise ValueError(f"Method '{method}' not found on service {service!r}")

    def decorator(fn: Callable[..., Any]) -> Callable[..., Any]:
        @functools.wraps(fn)
        async def wrapper(*args: Any, **kwargs: Any) -> Any:
            parent = args[0] if len(args) > 0 else kwargs.get("root") or kwargs.get("parent")
            if parent is None:
                return None

            k = key(parent)
            if k is None:
                return None

            # An explicit per-request registry on info.context wins over the ambient ContextVar.
            registry = _registry_from_info(args, kwargs) or get_active_graphql_loader_registry()

            load_fn = loader
            if load_fn is None and service is not None and method:
                # One instance per request for classes/factories; without a registry nothing
                # is shared between calls.
                target_service = (
                    registry.service_for(service, build_service)
                    if registry is not None
                    else build_service()
                )
                load_fn = getattr(target_service, method, None)
                if not callable(load_fn):
                    raise ValueError(f"Method '{method}' not found on service {target_service!r}")

            if load_fn is None:
                raise ValueError(
                    "graphql_loader requires either 'loader' or 'service' and 'method'"
                )

            # Batch queues and L1 caches are owned by the request registry. Without one, use
            # a scope that lives for this call only: no batching across calls, but nothing
            # shared across requests either.
            scope = registry if registry is not None else GraphQLLoaderRegistry()
            raw_load = load_fn

            async def scoped_load(item_key: Any) -> Any:
                token = batch_load_scope.set(scope)
                try:
                    return await raw_load(item_key)
                finally:
                    batch_load_scope.reset(token)

            if isinstance(k, (list, tuple)):
                if len(k) == 0:
                    return []
                return await asyncio.gather(*(scoped_load(item_key) for item_key in k))

            res = await scoped_load(k)
            if is_list:
                return res if isinstance(res, list) else ([res] if res is not None else [])
            return res

        return cast(Callable[..., Any], wrapper)

    return decorator
