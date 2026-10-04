"""@batch_load decorator for transparent async call coalescing and multi-tier batch loading.

Collects concurrent individual lookups within a micro-tick or time window and dispatches
them through a 3-tier read hierarchy (L1 memory LRU, L2 distributed Redis MGET, L3 DB query).
"""

from __future__ import annotations

import asyncio
import contextvars
import functools
import inspect
import json
import time
import weakref
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from typing import Any, Generic, TypeVar, cast

from server_decorator.decorators._class_apply import _mark_wrapped

F = TypeVar("F", bound=Callable[..., Any])
K = TypeVar("K")
V = TypeVar("V")

_MISSING_SENTINEL = object()

# Scope values that cannot be weakly referenced (str/int request ids, tuples) cannot be released
# automatically, so at most this many of their queues are kept per decorated function (LRU).
_MAX_STRONG_SCOPES = 1024

# Ambient batching scope. While set, every @batch_load method keys its queue (and L1 cache) by
# ``scope.scope_for(instance)`` instead of the service instance, so the state belongs to the
# scope owner (e.g. one GraphQL request). The value must expose ``scope_for(identity) -> object``.
batch_load_scope: contextvars.ContextVar[Any | None] = contextvars.ContextVar(
    "server_decorator_batch_load_scope", default=None
)


class QueuedItem(Generic[K, V]):
    __slots__ = ("future", "key", "stale")

    def __init__(self, key: K, future: asyncio.Future[V]) -> None:
        self.future = future
        self.key = key
        # Set by clear(): the value this load reads may predate the invalidation; do not cache it.
        self.stale = False


def _weak_batch_method(instance: Any, name: str, method: Any) -> Any:
    """Resolve ``instance.<name>`` lazily through a weak reference.

    A queue scoped to a service instance must not keep that instance (and thereby itself)
    alive, or transient instances would never be collected.
    """
    try:
        ref = weakref.ref(instance)
    except TypeError:
        return method

    async def _call(keys: list[Any]) -> Any:
        inst = ref()
        if inst is None:
            raise ReferenceError(f"@batch_load: instance owning {name!r} no longer exists")
        return await getattr(inst, name)(keys)

    return _call


async def _l2_delete(l2_cache: Any, key: Any) -> None:
    if l2_cache is None:
        return
    del_fn = getattr(l2_cache, "delete", None) or getattr(l2_cache, "del", None)
    if callable(del_fn):
        res = del_fn([str(key)])
        if inspect.isawaitable(res):
            await res


class LruCache:
    def __init__(self, capacity: int = 10000, ttl_seconds: float = 0) -> None:
        self.capacity = capacity
        self.ttl_seconds = ttl_seconds
        self._items: dict[Any, tuple[Any, float | None]] = {}

    def get(self, key: Any) -> Any:
        if key not in self._items:
            return None
        val, expires_at = self._items[key]
        if expires_at is not None and time.monotonic() > expires_at:
            del self._items[key]
            return None
        del self._items[key]
        self._items[key] = (val, expires_at)
        return val

    def set(self, key: Any, val: Any, custom_ttl: float | None = None) -> None:
        ttl = custom_ttl if custom_ttl is not None else self.ttl_seconds
        expires_at = time.monotonic() + ttl if ttl > 0 else None
        if key in self._items:
            del self._items[key]
        elif self.capacity > 0 and len(self._items) >= self.capacity:
            oldest_key = next(iter(self._items))
            del self._items[oldest_key]
        self._items[key] = (val, expires_at)

    def delete(self, key: Any) -> None:
        self._items.pop(key, None)

    def clear(self) -> None:
        self._items.clear()


class PrefetchRule:
    """Rule defining how to extract child keys and which child loader to invoke."""

    def __init__(
        self,
        extract: Callable[[Any], Any],
        loader: Callable[[], Any],
    ) -> None:
        self.extract = extract
        self.loader = loader


class BatchQueue(Generic[K, V]):
    def __init__(
        self,
        loader_fn: Callable[[list[K]], Awaitable[Any]],
        max_batch_size: int = 100,
        window_seconds: float = 0.001,
        deduplicate: bool = True,
        key_of: Callable[[Any], K] | None = None,
        l1_max_size: int = 10000,
        l1_ttl_seconds: float = 10.0,
        l2_cache: Any = None,
        l2_ttl_seconds: float = 0,
        negative_ttl_seconds: float = 5,
        serializer: Callable[[Any], str] | None = None,
        deserializer: Callable[[str], Any] | None = None,
        prefetch_rules: list[PrefetchRule] | None = None,
        relation: str = "one",
    ) -> None:
        self.loader_fn = loader_fn
        self.max_batch_size = max_batch_size
        self.window_seconds = window_seconds
        self.deduplicate = deduplicate
        self.key_of = key_of
        self.relation = relation
        self.l1_cache = (
            LruCache(capacity=l1_max_size, ttl_seconds=l1_ttl_seconds)
            if l1_max_size > 0 or l1_ttl_seconds > 0
            else None
        )
        self.l2_cache = l2_cache
        self.l2_ttl_seconds = l2_ttl_seconds
        self.negative_ttl_seconds = negative_ttl_seconds
        self.serializer = serializer or (lambda v: json.dumps(v))
        self.deserializer = deserializer or (lambda s: json.loads(s) if isinstance(s, str) else s)
        self.prefetch_rules = prefetch_rules or []

        self.queue: list[QueuedItem[K, V]] = []
        self.scheduled_handle: asyncio.TimerHandle | asyncio.Handle | None = None
        self.in_flight: dict[K, asyncio.Future[V]] = {}
        # Every load that has not settled yet; clear() marks the matching ones stale so that a
        # value read before the invalidation is never written back to L1/L2.
        self._pending: set[QueuedItem[K, V]] = set()
        self._background_tasks: set[asyncio.Task[Any]] = set()

    def _spawn_task(self, coro: Awaitable[Any]) -> None:
        async def _run() -> Any:
            return await coro

        task: asyncio.Task[Any] = asyncio.create_task(_run())
        self._background_tasks.add(task)
        task.add_done_callback(self._background_tasks.discard)

    def load(self, key: K) -> asyncio.Future[V]:
        loop = asyncio.get_running_loop()

        # 1. Immediate L1 check
        if self.l1_cache is not None:
            cached = self.l1_cache.get(key)
            if cached is not None:
                fut: asyncio.Future[V] = loop.create_future()
                if cached is _MISSING_SENTINEL:
                    fut.set_result(cast(V, None))
                else:
                    fut.set_result(cached)
                return fut

        if self.deduplicate and key in self.in_flight:
            return self.in_flight[key]

        fut = loop.create_future()
        queued = QueuedItem(key, fut)
        self.queue.append(queued)
        self._pending.add(queued)

        if self.deduplicate:
            self.in_flight[key] = fut

        def _clean(_: Any) -> None:
            self._pending.discard(queued)
            # Only drop the in-flight entry if it is still ours: clear() may have let a newer
            # flight take the slot.
            if self.in_flight.get(key) is fut:
                del self.in_flight[key]

        fut.add_done_callback(_clean)

        if len(self.queue) >= self.max_batch_size:
            batch = self.queue[: self.max_batch_size]
            self.queue = self.queue[self.max_batch_size :]
            if not self.queue and self.scheduled_handle:
                self.scheduled_handle.cancel()
                self.scheduled_handle = None
            self._spawn_task(self._dispatch_batch(batch))
        elif self.scheduled_handle is None:
            self._schedule_dispatch(loop)

        return fut

    def prime(self, key: K, val: V) -> None:
        if self.l1_cache is None:
            self.l1_cache = LruCache(capacity=10000, ttl_seconds=10.0)
        self.l1_cache.set(key, val)
        if self.l2_cache is not None:
            set_fn = getattr(self.l2_cache, "set_many", None)
            if callable(set_fn):
                res = set_fn({str(key): self.serializer(val)}, self.l2_ttl_seconds)
                if inspect.isawaitable(res):
                    self._spawn_task(res)

    def prefetch(self, keys: list[K]) -> None:
        if not keys:
            return
        for k in keys:
            self.load(k)

    def _trigger_prefetch(self, items: list[V]) -> None:
        if not self.prefetch_rules or not items:
            return

        for rule in self.prefetch_rules:
            try:
                raw_loader = rule.loader()
                if raw_loader is None:
                    continue

                child_keys: list[Any] = []
                seen: set[Any] = set()

                for item in items:
                    if item is None:
                        continue
                    extracted = rule.extract(item)
                    if extracted is None:
                        continue

                    if isinstance(extracted, (list, tuple, set)):
                        for k in extracted:
                            if k is not None and k not in seen:
                                seen.add(k)
                                child_keys.append(k)
                    elif extracted not in seen:
                        seen.add(extracted)
                        child_keys.append(extracted)

                if not child_keys:
                    continue

                prefetch_fn = getattr(raw_loader, "prefetch", None)
                if callable(prefetch_fn):
                    inst = getattr(raw_loader, "__self__", None)
                    if inst is not None:
                        prefetch_fn(child_keys, instance=inst)
                    else:
                        prefetch_fn(child_keys)
                else:
                    load_fn = getattr(raw_loader, "load", None)
                    if callable(load_fn):
                        for ck in child_keys:
                            load_fn(ck)
                    elif callable(raw_loader):
                        for ck in child_keys:
                            res = raw_loader(ck)
                            if inspect.isawaitable(res):
                                self._spawn_task(res)
            except Exception:
                # Suppress prefetch errors so parent never fails
                pass

    def clear_local(self, key: K) -> None:
        """Invalidate this queue's own state for ``key``: L1 entry and any load in flight."""
        if self.l1_cache is not None:
            self.l1_cache.delete(key)
        # A load in flight may already have read the pre-invalidation value: later reads must
        # not join it, and it must not write that value back to L1/L2 when it settles.
        self.in_flight.pop(key, None)
        for item in self._pending:
            if item.key == key:
                item.stale = True

    async def clear(self, key: K) -> None:
        self.clear_local(key)
        await _l2_delete(self.l2_cache, key)

    def _schedule_dispatch(self, loop: asyncio.AbstractEventLoop) -> None:
        if self.window_seconds > 0:
            self.scheduled_handle = loop.call_later(
                self.window_seconds, lambda: self._spawn_task(self._dispatch_timer())
            )
        else:
            self.scheduled_handle = loop.call_soon(lambda: self._spawn_task(self._dispatch_timer()))

    async def _dispatch_timer(self) -> None:
        self.scheduled_handle = None
        if not self.queue:
            return

        batch = self.queue
        self.queue = []
        await self._dispatch_batch(batch)

    async def _dispatch_batch(self, batch: list[QueuedItem[K, V]]) -> None:
        if not batch:
            return

        # Phase A: L1 check
        l1_misses: list[QueuedItem[K, V]] = []
        for item in batch:
            if self.l1_cache is not None:
                cached = self.l1_cache.get(item.key)
                if cached is not None:
                    if not item.future.done():
                        if cached is _MISSING_SENTINEL:
                            item.future.set_result(cast(V, None))
                        else:
                            item.future.set_result(cached)
                    continue
            l1_misses.append(item)

        if not l1_misses:
            return

        # Phase B: L2 Distributed Cache (MGET)
        l2_misses: list[QueuedItem[K, V]] = []
        l2_resolved_items: list[V] = []
        if self.l2_cache is not None:
            try:
                mget_fn = getattr(self.l2_cache, "mget", None)
                if callable(mget_fn):
                    str_keys = list({str(it.key) for it in l1_misses})
                    mget_res = mget_fn(str_keys)
                    if inspect.isawaitable(mget_res):
                        mget_res = await mget_res

                    res_map = self._normalize_result(mget_res)
                    for item in l1_misses:
                        s_key = str(item.key)
                        raw_val = res_map.get(s_key) or res_map.get(item.key)
                        if raw_val is not None:
                            val = self.deserializer(raw_val)
                            if self.l1_cache is not None and not item.stale:
                                self.l1_cache.set(item.key, val)
                            if not item.future.done():
                                item.future.set_result(val)
                            l2_resolved_items.append(val)
                        else:
                            l2_misses.append(item)
                else:
                    l2_misses = l1_misses
            except Exception:
                l2_misses = l1_misses
        else:
            l2_misses = l1_misses

        if l2_resolved_items:
            self._trigger_prefetch(l2_resolved_items)

        if not l2_misses:
            return

        # Phase C: L3 Batch Loader
        unique_keys: list[K] = []
        seen: set[Any] = set()
        for item in l2_misses:
            if item.key not in seen:
                seen.add(item.key)
                unique_keys.append(item.key)

        try:
            raw_result = await self.loader_fn(unique_keys)
            result_map = self._normalize_result(raw_result)
            l2_set_items: dict[str, Any] = {}
            l3_resolved_items: list[V] = []

            for item in l2_misses:
                if not item.future.done():
                    if item.key in result_map:
                        val = result_map[item.key]
                        if self.l1_cache is not None and not item.stale:
                            self.l1_cache.set(item.key, val)
                        if self.l2_cache is not None and not item.stale:
                            l2_set_items[str(item.key)] = self.serializer(val)
                        item.future.set_result(val)
                        l3_resolved_items.append(val)
                    else:
                        # Negative cache
                        if self.l1_cache is not None and not item.stale:
                            self.l1_cache.set(
                                item.key, _MISSING_SENTINEL, self.negative_ttl_seconds
                            )
                        item.future.set_result(cast(V, None))

            if l2_set_items and self.l2_cache is not None:
                set_fn = getattr(self.l2_cache, "set_many", None)
                if callable(set_fn):
                    set_res = set_fn(l2_set_items, self.l2_ttl_seconds)
                    if inspect.isawaitable(set_res):
                        await set_res

            if l3_resolved_items:
                self._trigger_prefetch(l3_resolved_items)
        except Exception as exc:
            for item in l2_misses:
                if not item.future.done():
                    item.future.set_exception(exc)

    def _normalize_result(self, raw: Any) -> dict[Any, Any]:
        if isinstance(raw, dict):
            return raw
        if isinstance(raw, (list, tuple, set)):
            res: dict[Any, Any] = {}
            for elem in raw:
                if elem is not None:
                    if self.key_of is not None:
                        k = self.key_of(elem)
                    elif hasattr(elem, "id"):
                        k = elem.id
                    elif hasattr(elem, "key"):
                        k = elem.key
                    elif isinstance(elem, dict) and "id" in elem:
                        k = elem["id"]
                    elif isinstance(elem, dict) and "key" in elem:
                        k = elem["key"]
                    else:
                        continue
                    if self.relation == "many":
                        res.setdefault(k, []).append(elem)
                    else:
                        res[k] = elem
            return res
        return {}


async def _await_shared(shared: asyncio.Future[Any]) -> Any:
    if shared.done():
        return shared.result()
    loop = asyncio.get_running_loop()
    waiter: asyncio.Future[Any] = loop.create_future()

    def _on_shared_done(fut: asyncio.Future[Any]) -> None:
        if waiter.done():
            if not fut.cancelled():
                fut.exception()
            return
        if fut.cancelled():
            waiter.cancel()
        else:
            exc = fut.exception()
            if exc is not None:
                waiter.set_exception(exc)
            else:
                waiter.set_result(fut.result())

    shared.add_done_callback(_on_shared_done)
    return await waiter


def batch_load(
    batch_fn: Callable[[list[Any]], Awaitable[Any]] | None = None,
    *,
    batch_method: str | None = None,
    max_batch_size: int = 100,
    window_seconds: float = 0.001,
    deduplicate: bool = True,
    key_of: Callable[[Any], Any] | None = None,
    context_var: contextvars.ContextVar[Any] | None = None,
    l1_max_size: int = 10000,
    l1_ttl_seconds: float = 10.0,
    l2_cache: Any = None,
    l2_ttl_seconds: float = 0,
    negative_ttl_seconds: float = 5,
    serializer: Callable[[Any], str] | None = None,
    deserializer: Callable[[str], Any] | None = None,
    prefetch: list[PrefetchRule | dict[str, Any]] | None = None,
    relation: str = "one",
) -> Callable[[F], F]:
    """Decorator that coalesces individual async calls into a single multi-tier batch call."""

    normalized_prefetch_rules: list[PrefetchRule] = []
    if prefetch:
        for p in prefetch:
            if isinstance(p, PrefetchRule):
                normalized_prefetch_rules.append(p)
            elif isinstance(p, dict) and "extract" in p and "loader" in p:
                normalized_prefetch_rules.append(PrefetchRule(p["extract"], p["loader"]))

    def decorator(fn: F) -> F:
        if not inspect.iscoroutinefunction(fn):
            raise TypeError(f"@batch_load requires an async coroutine function, got {fn}")

        # Queues are owned by their scope (request context value, service instance): a weak
        # mapping lets a queue and its L1 cache die with the scope. Scope values that cannot be
        # weakly referenced fall back to a bounded LRU.
        weak_queues: weakref.WeakKeyDictionary[Any, BatchQueue[Any, Any]] = (
            weakref.WeakKeyDictionary()
        )
        strong_queues: OrderedDict[Any, BatchQueue[Any, Any]] = OrderedDict()
        all_queues: weakref.WeakSet[BatchQueue[Any, Any]] = weakref.WeakSet()

        owner_cache: weakref.WeakKeyDictionary[type, bool] = weakref.WeakKeyDictionary()

        def _unwraps_to_wrapper(val: Any, target: Any) -> bool:
            cur = val
            for _ in range(10):
                if cur is target:
                    return True
                try:
                    # Foreign class attribute raising non-AttributeError must not break.
                    if hasattr(cur, "__func__"):
                        cur = cur.__func__
                    elif hasattr(cur, "__wrapped__"):
                        cur = cur.__wrapped__
                    else:
                        break
                except Exception:
                    break
            return cur is target

        def _first_arg_is_receiver(first_arg: Any) -> bool:
            target_type: type = first_arg if isinstance(first_arg, type) else type(first_arg)
            cached = owner_cache.get(target_type)
            if cached is not None:
                return cached
            mros: list[type] = []
            if isinstance(first_arg, type):
                mros.extend(getattr(first_arg, "__mro__", ()))
            mros.extend(getattr(type(first_arg), "__mro__", ()))
            seen_classes: set[type] = set()
            for cls_obj in mros:
                if cls_obj in seen_classes:
                    continue
                seen_classes.add(cls_obj)
                cls_vars = vars(cls_obj)
                for val in cls_vars.values():
                    if isinstance(val, staticmethod):
                        continue
                    if _unwraps_to_wrapper(val, async_wrapper):
                        owner_cache[target_type] = True
                        return True
            owner_cache[target_type] = False
            return False

        sig = inspect.signature(fn)
        pos_params = [
            p.name
            for p in sig.parameters.values()
            if p.kind
            in (
                inspect.Parameter.POSITIONAL_ONLY,
                inspect.Parameter.POSITIONAL_OR_KEYWORD,
            )
        ]
        qualname_parts = getattr(fn, "__qualname__", "").split(".")
        in_class_body = len(qualname_parts) >= 2 and qualname_parts[-2] != "<locals>"

        if (
            pos_params
            and pos_params[0] in ("self", "cls")
            and (len(pos_params) >= 2 or in_class_body)
        ):
            receiver_mode = "always"
        elif len(pos_params) >= 2 and in_class_body:
            receiver_mode = "ambiguous"
        else:
            receiver_mode = "never"

        def _get_or_create_queue(instance: Any) -> BatchQueue[Any, Any] | None:
            resolved_batch_fn = batch_fn
            if resolved_batch_fn is None and batch_method and instance is not None:
                method = getattr(instance, batch_method, None)
                if callable(method):
                    resolved_batch_fn = _weak_batch_method(instance, batch_method, method)

            if resolved_batch_fn is None:
                return None

            scope_target: Any = None
            ambient_scope = batch_load_scope.get()
            if ambient_scope is not None:
                scope_target = ambient_scope.scope_for(instance if instance is not None else fn)
            elif context_var is not None:
                try:
                    scope_target = context_var.get()
                except LookupError:
                    scope_target = None
            if scope_target is None:
                scope_target = instance if instance is not None else fn

            try:
                queue = weak_queues.get(scope_target)
                weak_scope = True
            except TypeError:
                weak_scope = False
                queue = strong_queues.get(scope_target)
                if queue is not None:
                    strong_queues.move_to_end(scope_target)
            if queue is None:
                queue = BatchQueue(
                    resolved_batch_fn,
                    max_batch_size=max_batch_size,
                    window_seconds=window_seconds,
                    deduplicate=deduplicate,
                    key_of=key_of,
                    l1_max_size=l1_max_size,
                    l1_ttl_seconds=l1_ttl_seconds,
                    l2_cache=l2_cache,
                    l2_ttl_seconds=l2_ttl_seconds,
                    negative_ttl_seconds=negative_ttl_seconds,
                    serializer=serializer,
                    deserializer=deserializer,
                    prefetch_rules=normalized_prefetch_rules,
                    relation=relation,
                )
                if weak_scope:
                    weak_queues[scope_target] = queue
                else:
                    strong_queues[scope_target] = queue
                    while len(strong_queues) > _MAX_STRONG_SCOPES:
                        strong_queues.popitem(last=False)
                all_queues.add(queue)

            return queue

        @functools.wraps(fn)
        async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
            # Determine scope and key
            if receiver_mode == "always":
                has_receiver = True
            elif receiver_mode == "never" or not args:
                has_receiver = False
            else:
                has_receiver = _first_arg_is_receiver(args[0])

            instance = args[0] if has_receiver and args else None
            key_index = 1 if has_receiver else 0
            key_name = pos_params[key_index] if len(pos_params) > key_index else None

            if len(args) > key_index:
                key = args[key_index]
            elif key_name is not None and key_name in kwargs:
                key = kwargs[key_name]
            else:
                key = kwargs.get("id", kwargs.get("key"))

            queue = _get_or_create_queue(instance)
            if queue is None:
                return await fn(*args, **kwargs)

            # Waiter future avoids asyncio.shield log noise while ensuring cancelling
            # this caller never cancels the shared load or other waiters.
            return await _await_shared(queue.load(key))

        def _prime(key: Any, val: Any, instance: Any = None) -> None:
            queue = _get_or_create_queue(instance)
            if queue is not None:
                queue.prime(key, val)

        def _prefetch(keys: list[Any], instance: Any = None) -> None:
            queue = _get_or_create_queue(instance)
            if queue is not None:
                queue.prefetch(keys)

        async def _clear(key: Any) -> None:
            # Every queue of this function shares one L2 cache: invalidate each live queue's own
            # state, then delete from L2 once instead of once per queue.
            for q in list(all_queues):
                q.clear_local(key)
            await _l2_delete(l2_cache, key)

        async_wrapper.clear = _clear  # type: ignore[attr-defined]
        async_wrapper.prime = _prime  # type: ignore[attr-defined]
        async_wrapper.prefetch = _prefetch  # type: ignore[attr-defined]
        _mark_wrapped(async_wrapper, "batch_load")
        return cast(F, async_wrapper)

    return decorator
