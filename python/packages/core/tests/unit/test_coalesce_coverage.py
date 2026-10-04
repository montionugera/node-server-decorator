"""Coverage-gap tests for @batch_load / BatchQueue: LRU edges, L2 tier variants and
failure fallbacks, stale/cancelled loads, prefetch rule shapes, result normalisation
and queue scoping."""

from __future__ import annotations

import asyncio
import contextvars
import gc
import importlib
import time
from typing import Any

import pytest

from server_decorator.decorators.coalesce import (
    BatchQueue,
    LruCache,
    PrefetchRule,
    batch_load,
)

# The package re-exports names from this submodule, so fetch the module object explicitly.
coalesce_mod = importlib.import_module("server_decorator.decorators.coalesce")

_MISSING = coalesce_mod._MISSING_SENTINEL


class _L2:
    """Async L2 fake recording every call."""

    def __init__(self, data: dict[str, Any] | None = None) -> None:
        self.data: dict[str, Any] = dict(data or {})
        self.mget_calls: list[list[str]] = []
        self.set_calls: list[tuple[dict[str, Any], float]] = []
        self.deleted: list[list[str]] = []

    async def mget(self, keys: list[str]) -> dict[str, Any]:
        self.mget_calls.append(sorted(keys))
        return {k: self.data[k] for k in keys if k in self.data}

    async def set_many(self, items: dict[str, Any], ttl: float) -> None:
        self.set_calls.append((dict(items), ttl))
        self.data.update(items)

    async def delete(self, keys: list[str]) -> None:
        self.deleted.append(list(keys))
        for k in keys:
            self.data.pop(k, None)


class _SyncL2:
    """Same surface, plain (non-awaitable) methods."""

    def __init__(self, data: dict[str, Any] | None = None) -> None:
        self.data: dict[str, Any] = dict(data or {})
        self.set_calls: list[tuple[dict[str, Any], float]] = []
        self.deleted: list[list[str]] = []

    def mget(self, keys: list[str]) -> dict[str, Any]:
        return {k: self.data[k] for k in keys if k in self.data}

    def set_many(self, items: dict[str, Any], ttl: float) -> None:
        self.set_calls.append((dict(items), ttl))

    def delete(self, keys: list[str]) -> None:
        self.deleted.append(list(keys))


def _loader(calls: list[list[Any]], missing: tuple[Any, ...] = ()) -> Any:
    async def load(keys: list[Any]) -> dict[Any, Any]:
        calls.append(list(keys))
        return {k: f"v{k}" for k in keys if k not in missing}

    return load


async def _settle() -> None:
    for _ in range(5):
        await asyncio.sleep(0.005)


# ---------------------------------------------------------------- LruCache


def test_lru_get_set_delete_clear() -> None:
    cache = LruCache(capacity=10)
    assert cache.get("missing") is None
    cache.set("a", 0)
    cache.set("b", "")
    # Falsy values are real entries.
    assert cache.get("a") == 0
    assert cache.get("b") == ""
    cache.delete("a")
    cache.delete("never-there")
    assert cache.get("a") is None
    cache.clear()
    assert cache.get("b") is None


def test_lru_evicts_least_recently_used_and_refreshes_on_get() -> None:
    cache = LruCache(capacity=2)
    cache.set("a", 1)
    cache.set("b", 2)
    assert cache.get("a") == 1  # "a" becomes most recent
    cache.set("c", 3)
    assert cache.get("b") is None
    assert (cache.get("a"), cache.get("c")) == (1, 3)


def test_lru_overwrite_at_capacity_does_not_evict() -> None:
    cache = LruCache(capacity=2)
    cache.set("a", 1)
    cache.set("b", 2)
    cache.set("a", 10)
    assert (cache.get("a"), cache.get("b")) == (10, 2)
    # Overwriting refreshed "a", so "b" (touched last by get) survives one more insert of...
    cache.set("c", 3)
    assert cache.get("a") is None
    assert (cache.get("b"), cache.get("c")) == (2, 3)


def test_lru_zero_capacity_is_unbounded() -> None:
    cache = LruCache(capacity=0)
    for i in range(50):
        cache.set(i, i)
    assert [cache.get(i) for i in (0, 25, 49)] == [0, 25, 49]


def test_lru_ttl_expiry_and_custom_ttl() -> None:
    cache = LruCache(capacity=10, ttl_seconds=0.02)
    cache.set("short", 1)
    cache.set("long", 2, custom_ttl=60)
    cache.set("forever", 3, custom_ttl=0)
    assert cache.get("short") == 1
    time.sleep(0.04)
    assert cache.get("short") is None
    # The expired entry is dropped, not just hidden.
    assert "short" not in cache._items
    assert cache.get("long") == 2
    assert cache.get("forever") == 3

    no_ttl = LruCache(capacity=10, ttl_seconds=0)
    no_ttl.set("k", 1)
    assert no_ttl._items["k"] == (1, None)
    negative = LruCache(capacity=10, ttl_seconds=-5)
    negative.set("k", 1)
    assert negative.get("k") == 1


# ---------------------------------------------------------------- helpers


async def test_l2_delete_variants() -> None:
    await coalesce_mod._l2_delete(None, 1)

    l2 = _L2()
    await coalesce_mod._l2_delete(l2, 42)
    assert l2.deleted == [["42"]]

    sync = _SyncL2()
    await coalesce_mod._l2_delete(sync, ("a", 1))
    assert sync.deleted == [["('a', 1)"]]

    # Redis-style clients expose the command as `del`.
    class DelOnly:
        def __init__(self) -> None:
            self.deleted: list[list[str]] = []
            setattr(self, "del", self.deleted.append)

    del_only = DelOnly()
    await coalesce_mod._l2_delete(del_only, "k")
    assert del_only.deleted == [["k"]]

    class NoDelete:
        delete = "not callable"

    assert await coalesce_mod._l2_delete(NoDelete(), "k") is None
    assert await coalesce_mod._l2_delete(object(), "k") is None


async def test_weak_batch_method_does_not_pin_the_instance() -> None:
    class Svc:
        async def batch(self, keys: list[int]) -> dict[int, int]:
            return {k: k * 2 for k in keys}

    svc = Svc()
    call = coalesce_mod._weak_batch_method(svc, "batch", svc.batch)
    assert await call([1, 2]) == {1: 2, 2: 4}

    del svc
    gc.collect()
    with pytest.raises(ReferenceError, match="instance owning 'batch' no longer exists"):
        await call([1])


def test_weak_batch_method_falls_back_for_non_weakrefable_instances() -> None:
    class Slotted:
        __slots__ = ()

        async def batch(self, keys: list[int]) -> list[int]:
            return keys

    inst = Slotted()
    method = inst.batch
    assert coalesce_mod._weak_batch_method(inst, "batch", method) is method


# ---------------------------------------------------------------- BatchQueue: batching


async def test_l1_disabled_queue_reloads_every_time() -> None:
    calls: list[list[Any]] = []
    q: BatchQueue[int, str] = BatchQueue(_loader(calls), l1_max_size=0, l1_ttl_seconds=0)
    assert q.l1_cache is None
    assert await q.load(1) == "v1"
    assert await q.load(1) == "v1"
    assert calls == [[1], [1]]
    # Invalidating with no L1 is still safe.
    await q.clear(1)
    q.clear_local(1)


async def test_without_deduplication_callers_get_separate_futures_but_one_db_key() -> None:
    calls: list[list[Any]] = []
    q: BatchQueue[int, str] = BatchQueue(_loader(calls), deduplicate=False)
    first, second = q.load(1), q.load(1)
    assert first is not second
    assert q.in_flight == {}
    assert await asyncio.gather(first, second) == ["v1", "v1"]
    assert calls == [[1]]

    dedup: BatchQueue[int, str] = BatchQueue(_loader(calls))
    assert dedup.load(2) is dedup.load(2)
    await _settle()
    assert dedup.in_flight == {}


async def test_full_batch_dispatches_immediately_and_cancels_the_window_timer() -> None:
    calls: list[list[Any]] = []
    q: BatchQueue[int, str] = BatchQueue(_loader(calls), max_batch_size=2, window_seconds=30)
    first = q.load(1)
    assert q.scheduled_handle is not None
    second = q.load(2)
    # Queue drained by the size trigger: no 30s wait and no stray timer.
    assert q.scheduled_handle is None
    assert q.queue == []
    assert await asyncio.wait_for(asyncio.gather(first, second), timeout=1) == ["v1", "v2"]
    assert calls == [[1, 2]]


async def test_batch_size_one_dispatches_each_key_alone() -> None:
    calls: list[list[Any]] = []
    q: BatchQueue[int, str] = BatchQueue(_loader(calls), max_batch_size=1, window_seconds=30)
    results = await asyncio.wait_for(asyncio.gather(q.load(1), q.load(2), q.load(3)), timeout=1)
    assert results == ["v1", "v2", "v3"]
    assert calls == [[1], [2], [3]]
    assert q.scheduled_handle is None


async def test_overflow_keeps_the_remainder_on_the_window_timer() -> None:
    calls: list[list[Any]] = []
    q: BatchQueue[int, str] = BatchQueue(_loader(calls), max_batch_size=2, window_seconds=0.01)
    futures = [q.load(k) for k in (1, 2, 3)]
    assert [item.key for item in q.queue] == [3]
    assert q.scheduled_handle is not None
    assert await asyncio.gather(*futures) == ["v1", "v2", "v3"]
    assert calls == [[1, 2], [3]]


async def test_zero_window_dispatches_on_the_next_loop_turn() -> None:
    calls: list[list[Any]] = []
    q: BatchQueue[int, str] = BatchQueue(_loader(calls), window_seconds=0)
    assert await asyncio.gather(q.load(1), q.load(2)) == ["v1", "v2"]
    assert calls == [[1, 2]]


async def test_dispatch_with_nothing_queued_is_a_no_op() -> None:
    calls: list[list[Any]] = []
    q: BatchQueue[int, str] = BatchQueue(_loader(calls))
    q.scheduled_handle = asyncio.get_running_loop().call_later(30, lambda: None)
    handle = q.scheduled_handle
    await q._dispatch_timer()
    handle.cancel()
    assert q.scheduled_handle is None
    await q._dispatch_batch([])
    assert calls == []


# ---------------------------------------------------------------- BatchQueue: L1 / prime


async def test_prime_serves_from_l1_without_calling_the_loader() -> None:
    calls: list[list[Any]] = []
    q: BatchQueue[int, str] = BatchQueue(_loader(calls))
    q.prime(1, "primed")
    assert await q.load(1) == "primed"
    assert calls == []


async def test_prime_creates_an_l1_cache_when_disabled() -> None:
    calls: list[list[Any]] = []
    q: BatchQueue[int, str] = BatchQueue(_loader(calls), l1_max_size=0, l1_ttl_seconds=0)
    q.prime(1, "primed")
    assert q.l1_cache is not None
    assert await q.load(1) == "primed"
    assert calls == []


async def test_prime_writes_through_to_l2() -> None:
    l2 = _L2()
    q: BatchQueue[int, Any] = BatchQueue(_loader([]), l2_cache=l2, l2_ttl_seconds=30)
    q.prime(7, {"id": 7})
    await _settle()
    assert l2.set_calls == [({"7": '{"id": 7}'}, 30)]

    sync = _SyncL2()
    q2: BatchQueue[int, Any] = BatchQueue(_loader([]), l2_cache=sync, serializer=lambda v: f"<{v}>")
    q2.prime(8, "x")
    assert sync.set_calls == [({"8": "<x>"}, 0)]

    # An L2 without set_many is simply skipped.
    q3: BatchQueue[int, Any] = BatchQueue(_loader([]), l2_cache=object())
    q3.prime(9, "y")
    assert await q3.load(9) == "y"


async def test_missing_key_is_negatively_cached() -> None:
    calls: list[list[Any]] = []
    q: BatchQueue[int, Any] = BatchQueue(_loader(calls, missing=(2,)))
    assert await asyncio.gather(q.load(1), q.load(2)) == ["v1", None]
    assert q.l1_cache is not None and q.l1_cache.get(2) is _MISSING
    assert await q.load(2) is None
    assert calls == [[1, 2]]


async def test_negative_cache_expires_after_negative_ttl() -> None:
    calls: list[list[Any]] = []
    q: BatchQueue[int, Any] = BatchQueue(_loader(calls, missing=(2,)), negative_ttl_seconds=0.02)
    assert await q.load(2) is None
    await asyncio.sleep(0.04)
    assert await q.load(2) is None
    assert calls == [[2], [2]]


async def test_queued_load_is_answered_by_a_value_primed_before_dispatch() -> None:
    calls: list[list[Any]] = []
    q: BatchQueue[int, Any] = BatchQueue(_loader(calls), window_seconds=0.01)
    hit, negative, abandoned = q.load(1), q.load(2), q.load(3)
    q.prime(1, "primed")
    assert q.l1_cache is not None
    q.l1_cache.set(2, _MISSING)
    q.prime(3, "unused")
    abandoned.cancel()
    assert await hit == "primed"
    assert await negative is None
    assert abandoned.cancelled()
    # Every queued key was satisfied from L1 at dispatch time.
    assert calls == []


async def test_prefetch_warms_l1_and_ignores_empty_input() -> None:
    calls: list[list[Any]] = []
    q: BatchQueue[int, str] = BatchQueue(_loader(calls))
    q.prefetch([])
    assert q.queue == [] and q.scheduled_handle is None
    q.prefetch([1, 2, 1])
    await _settle()
    assert calls == [[1, 2]]
    assert await q.load(2) == "v2"
    assert calls == [[1, 2]]


# ---------------------------------------------------------------- BatchQueue: L2 tier


async def test_l2_hit_skips_the_loader_and_miss_is_written_back() -> None:
    calls: list[list[Any]] = []
    l2 = _L2({"1": '{"from": "l2"}'})
    q: BatchQueue[int, Any] = BatchQueue(_loader(calls), l2_cache=l2, l2_ttl_seconds=60)

    assert await asyncio.gather(q.load(1), q.load(2), q.load(3)) == [{"from": "l2"}, "v2", "v3"]
    assert l2.mget_calls == [["1", "2", "3"]]
    assert calls == [[2, 3]]
    assert l2.set_calls == [({"2": '"v2"', "3": '"v3"'}, 60)]
    # The L2 hit was promoted to L1.
    assert q.l1_cache is not None and q.l1_cache.get(1) == {"from": "l2"}


async def test_all_l2_hits_never_touch_the_loader_or_set_many() -> None:
    calls: list[list[Any]] = []
    l2 = _L2({"1": '"a"', "2": '"b"'})
    q: BatchQueue[int, Any] = BatchQueue(_loader(calls), l2_cache=l2)
    assert await asyncio.gather(q.load(1), q.load(2)) == ["a", "b"]
    assert calls == []
    assert l2.set_calls == []


async def test_sync_l2_client_and_custom_codec() -> None:
    calls: list[list[Any]] = []
    l2 = _SyncL2({"1": "L2:one"})
    q: BatchQueue[int, Any] = BatchQueue(
        _loader(calls),
        l2_cache=l2,
        serializer=lambda v: f"L2:{v}",
        deserializer=lambda s: s.removeprefix("L2:"),
    )
    assert await asyncio.gather(q.load(1), q.load(2)) == ["one", "v2"]
    assert calls == [[2]]
    assert l2.set_calls == [({"2": "L2:v2"}, 0)]


async def test_default_deserializer_passes_non_string_l2_values_through() -> None:
    class Native:
        async def mget(self, keys: list[str]) -> dict[Any, Any]:
            # Keyed by the raw key and already decoded.
            return {1: {"id": 1}}

    q: BatchQueue[int, Any] = BatchQueue(_loader([]), l2_cache=Native())
    assert await q.load(1) == {"id": 1}


async def test_l2_hit_with_l1_disabled() -> None:
    calls: list[list[Any]] = []
    q: BatchQueue[int, Any] = BatchQueue(
        _loader(calls), l2_cache=_L2({"1": '"a"'}), l1_max_size=0, l1_ttl_seconds=0
    )
    assert await q.load(1) == "a"
    assert q.l1_cache is None
    assert calls == []


async def test_l2_without_mget_or_with_failing_mget_falls_back_to_loader() -> None:
    class SetOnly:
        def __init__(self) -> None:
            self.sets: list[dict[str, Any]] = []

        async def set_many(self, items: dict[str, Any], ttl: float) -> None:
            self.sets.append(dict(items))

    calls: list[list[Any]] = []
    set_only = SetOnly()
    q: BatchQueue[int, Any] = BatchQueue(_loader(calls), l2_cache=set_only)
    assert await q.load(1) == "v1"
    assert set_only.sets == [{"1": '"v1"'}]

    class Down(_L2):
        async def mget(self, keys: list[str]) -> dict[str, Any]:
            raise ConnectionError("redis down")

    down = Down()
    q2: BatchQueue[int, Any] = BatchQueue(_loader(calls), l2_cache=down)
    assert await q2.load(2) == "v2"
    assert calls == [[1], [2]]
    assert down.set_calls == [({"2": '"v2"'}, 0)]

    class GetOnly:
        async def mget(self, keys: list[str]) -> dict[str, Any]:
            return {}

    # No set_many: the loaded value is returned and nothing blows up.
    q3: BatchQueue[int, Any] = BatchQueue(_loader(calls), l2_cache=GetOnly())
    assert await q3.load(3) == "v3"


async def test_corrupt_l2_payload_falls_back_to_loader() -> None:
    calls: list[list[Any]] = []
    q: BatchQueue[int, Any] = BatchQueue(_loader(calls), l2_cache=_L2({"1": "{not json"}))
    assert await q.load(1) == "v1"
    assert calls == [[1]]


async def test_l2_set_many_failure_does_not_reach_callers() -> None:
    class ReadOnly(_L2):
        async def set_many(self, items: dict[str, Any], ttl: float) -> None:
            raise ConnectionError("read-only replica")

    q: BatchQueue[int, Any] = BatchQueue(_loader([]), l2_cache=ReadOnly())
    # Futures are resolved before the write-back, so the failure cannot reach callers.
    assert await q.load(1) == "v1"


async def test_invalidation_during_l2_read_keeps_the_value_out_of_l1() -> None:
    entered, gate = asyncio.Event(), asyncio.Event()

    class Slow:
        async def mget(self, keys: list[str]) -> dict[str, Any]:
            entered.set()
            await gate.wait()
            return {k: '"old"' for k in keys}

    calls: list[list[Any]] = []
    q: BatchQueue[int, Any] = BatchQueue(_loader(calls), l2_cache=Slow())
    stale, abandoned, fresh = q.load(1), q.load(2), q.load(3)
    await entered.wait()
    q.clear_local(1)
    abandoned.cancel()
    gate.set()

    assert await stale == "old"
    assert await fresh == "old"
    await _settle()
    assert q.l1_cache is not None
    # The invalidated key must not be re-cached; the untouched ones are.
    assert q.l1_cache.get(1) is None
    assert q.l1_cache.get(2) == "old"
    assert q.l1_cache.get(3) == "old"
    assert calls == []


# ---------------------------------------------------------------- BatchQueue: L3 loader


async def test_loader_error_rejects_every_waiter_except_cancelled_ones() -> None:
    entered, gate = asyncio.Event(), asyncio.Event()

    async def loader(keys: list[int]) -> dict[int, str]:
        entered.set()
        await gate.wait()
        raise RuntimeError("db down")

    q: BatchQueue[int, str] = BatchQueue(loader)
    gone, waiting = q.load(1), q.load(2)
    await entered.wait()
    gone.cancel()
    gate.set()

    with pytest.raises(RuntimeError, match="db down"):
        await waiting
    assert gone.cancelled()
    # A failed load is not cached: the next call retries.
    assert q.l1_cache is not None and q.l1_cache.get(2) is None
    assert q.in_flight == {}


async def test_cancelled_waiter_is_skipped_when_the_loader_returns() -> None:
    entered, gate = asyncio.Event(), asyncio.Event()

    async def loader(keys: list[int]) -> dict[int, str]:
        entered.set()
        await gate.wait()
        return {k: f"v{k}" for k in keys}

    l2 = _L2()
    q: BatchQueue[int, str] = BatchQueue(loader, l2_cache=l2)
    gone, waiting = q.load(1), q.load(2)
    await entered.wait()
    gone.cancel()
    gate.set()

    assert await waiting == "v2"
    await _settle()
    # Nothing is cached on behalf of the caller that went away.
    assert l2.set_calls == [({"2": '"v2"'}, 0)]
    assert q.l1_cache is not None and q.l1_cache.get(1) is None


async def test_clear_during_load_only_marks_the_cleared_key_stale() -> None:
    entered, gate = asyncio.Event(), asyncio.Event()

    async def loader(keys: list[int]) -> dict[int, str]:
        entered.set()
        await gate.wait()
        return {k: f"v{k}" for k in keys if k != 3}

    l2 = _L2()
    q: BatchQueue[int, Any] = BatchQueue(loader, l2_cache=l2)
    cleared, kept, cleared_missing = q.load(1), q.load(2), q.load(3)
    await entered.wait()
    await q.clear(1)
    await q.clear(3)
    assert 1 not in q.in_flight and 2 in q.in_flight
    gate.set()

    assert await asyncio.gather(cleared, kept, cleared_missing) == ["v1", "v2", None]
    await _settle()
    assert l2.deleted == [["1"], ["3"]]
    assert l2.set_calls == [({"2": '"v2"'}, 0)]
    assert q.l1_cache is not None
    assert q.l1_cache.get(1) is None
    assert q.l1_cache.get(2) == "v2"
    # No negative-cache entry for the invalidated missing key either.
    assert q.l1_cache.get(3) is None


# ---------------------------------------------------------------- _normalize_result


class _WithId:
    def __init__(self, id: int) -> None:
        self.id = id


class _WithKey:
    def __init__(self, key: str) -> None:
        self.key = key


def test_normalize_result_shapes() -> None:
    q: BatchQueue[Any, Any] = BatchQueue(_loader([]))
    mapping = {1: "a"}
    assert q._normalize_result(mapping) is mapping

    a, b = _WithId(1), _WithKey("k")
    normalized = q._normalize_result([a, None, b, {"id": 3}, {"key": "x"}, {"other": 1}, 42])
    assert normalized == {1: a, "k": b, 3: {"id": 3}, "x": {"key": "x"}}

    assert q._normalize_result((a,)) == {1: a}
    assert q._normalize_result([]) == {}
    for unsupported in (None, 5, "abc", object()):
        assert q._normalize_result(unsupported) == {}


def test_normalize_result_last_duplicate_wins_for_relation_one() -> None:
    q: BatchQueue[Any, Any] = BatchQueue(_loader([]))
    assert q._normalize_result([{"id": 1, "v": "old"}, {"id": 1, "v": "new"}]) == {
        1: {"id": 1, "v": "new"}
    }


def test_normalize_result_key_of_and_relation_many() -> None:
    rows = [{"owner": 1, "n": "a"}, {"owner": 2, "n": "b"}, {"owner": 1, "n": "c"}]
    many: BatchQueue[Any, Any] = BatchQueue(
        _loader([]), key_of=lambda row: row["owner"], relation="many"
    )
    assert many._normalize_result(rows) == {1: [rows[0], rows[2]], 2: [rows[1]]}

    one: BatchQueue[Any, Any] = BatchQueue(_loader([]), key_of=lambda row: row["n"])
    assert one._normalize_result(rows) == {"a": rows[0], "b": rows[1], "c": rows[2]}


async def test_list_result_is_matched_back_to_keys() -> None:
    async def loader(keys: list[int]) -> list[dict[str, int]]:
        return [{"id": k, "sq": k * k} for k in reversed(keys) if k != 2]

    q: BatchQueue[int, Any] = BatchQueue(loader)
    assert await asyncio.gather(q.load(1), q.load(2), q.load(3)) == [
        {"id": 1, "sq": 1},
        None,
        {"id": 3, "sq": 9},
    ]


# ---------------------------------------------------------------- prefetch rules


class _ChildLoader:
    """Child exposing only `.load`."""

    def __init__(self) -> None:
        self.loaded: list[Any] = []

    def load(self, key: Any) -> None:
        self.loaded.append(key)


async def _posts(keys: list[int]) -> list[dict[str, Any]]:
    # authors: 1 -> 11, 2 -> 10, 3 -> 11 ; tags as a list with a None and a duplicate.
    return [{"id": k, "author_id": 10 + (k % 2), "tags": [f"t{k}", None, "shared"]} for k in keys]


async def test_prefetch_rule_drives_a_decorated_method_loader() -> None:
    holder: dict[str, Any] = {}

    class Svc:
        def __init__(self) -> None:
            self.user_batches: list[list[int]] = []

        async def _users(self, ids: list[int]) -> list[dict[str, Any]]:
            self.user_batches.append(list(ids))
            return [{"id": i, "name": f"u{i}"} for i in ids]

        async def _post_batch(self, ids: list[int]) -> list[dict[str, Any]]:
            return await _posts(ids)

        @batch_load(batch_method="_users")
        async def get_user(self, user_id: int) -> Any: ...

        @batch_load(
            batch_method="_post_batch",
            prefetch=[
                {
                    "extract": lambda post: post["author_id"],
                    "loader": lambda: holder["svc"].get_user,
                },
                {"not": "a rule"},
                "ignored",  # type: ignore[list-item]
            ],
        )
        async def get_post(self, post_id: int) -> Any: ...

    svc = holder["svc"] = Svc()
    posts = await asyncio.gather(svc.get_post(1), svc.get_post(2), svc.get_post(3))
    assert [p["author_id"] for p in posts] == [11, 10, 11]
    await _settle()
    # Authors were batched once, deduplicated, without anyone asking for them.
    assert svc.user_batches == [[11, 10]]
    assert await svc.get_user(11) == {"id": 11, "name": "u11"}
    assert svc.user_batches == [[11, 10]]


async def test_prefetch_rule_drives_a_free_function_loader() -> None:
    user_batches: list[list[int]] = []

    async def users(ids: list[int]) -> dict[int, str]:
        user_batches.append(list(ids))
        return {i: f"u{i}" for i in ids}

    @batch_load(batch_fn=users)
    async def get_user(user_id: int) -> Any: ...

    q: BatchQueue[int, Any] = BatchQueue(
        _posts, prefetch_rules=[PrefetchRule(lambda p: p["author_id"], lambda: get_user)]
    )
    await asyncio.gather(q.load(1), q.load(2))
    await _settle()
    assert user_batches == [[11, 10]]
    assert await get_user(10) == "u10"
    assert user_batches == [[11, 10]]


async def test_prefetch_rule_with_load_only_child_flattens_and_dedupes_keys() -> None:
    child = _ChildLoader()
    q: BatchQueue[int, Any] = BatchQueue(
        _posts, prefetch_rules=[PrefetchRule(lambda p: p["tags"], lambda: child)]
    )
    await asyncio.gather(q.load(1), q.load(2))
    await _settle()
    assert child.loaded == ["t1", "shared", "t2"]

    as_tuple = _ChildLoader()
    q2: BatchQueue[int, Any] = BatchQueue(
        _posts,
        prefetch_rules=[PrefetchRule(lambda p: (p["author_id"], p["id"]), lambda: as_tuple)],
    )
    await q2.load(4)
    await _settle()
    assert as_tuple.loaded == [10, 4]


async def test_prefetch_rule_with_plain_callable_children() -> None:
    awaited: list[Any] = []
    called: list[Any] = []

    async def fetch(key: Any) -> None:
        awaited.append(key)

    q: BatchQueue[int, Any] = BatchQueue(
        _posts,
        prefetch_rules=[
            PrefetchRule(lambda p: p["author_id"], lambda: fetch),
            PrefetchRule(lambda p: p["author_id"], lambda: called.append),
        ],
    )
    await asyncio.gather(q.load(1), q.load(2), q.load(3))
    await _settle()
    assert awaited == [11, 10]
    assert called == [11, 10]


async def test_prefetch_rules_that_yield_nothing_are_skipped() -> None:
    child = _ChildLoader()
    loader_lookups: list[str] = []

    def no_loader() -> None:
        loader_lookups.append("none")
        return None

    async def loader(keys: list[int]) -> dict[int, Any]:
        # Key 2 legitimately maps to a null row.
        return {1: {"id": 1, "parent": None}, 2: None}

    q: BatchQueue[int, Any] = BatchQueue(
        loader,
        prefetch_rules=[
            PrefetchRule(lambda row: row["id"], no_loader),
            PrefetchRule(lambda row: row["parent"], lambda: child),
            PrefetchRule(lambda row: [None, None], lambda: child),
            PrefetchRule(lambda row: row["id"], lambda: object()),
        ],
    )
    assert await asyncio.gather(q.load(1), q.load(2)) == [{"id": 1, "parent": None}, None]
    await _settle()
    assert loader_lookups == ["none"]
    assert child.loaded == []


async def test_failing_prefetch_rule_never_fails_the_parent_or_later_rules() -> None:
    child = _ChildLoader()

    def bad_extract(post: dict[str, Any]) -> Any:
        raise KeyError("no such column")

    def bad_loader() -> Any:
        raise RuntimeError("container not ready")

    q: BatchQueue[int, Any] = BatchQueue(
        _posts,
        prefetch_rules=[
            PrefetchRule(bad_extract, lambda: child),
            PrefetchRule(lambda p: p["id"], bad_loader),
            PrefetchRule(lambda p: p["id"], lambda: child),
        ],
    )
    post = await q.load(5)
    assert post["id"] == 5
    await _settle()
    assert child.loaded == [5]


async def test_l2_hits_also_trigger_prefetch() -> None:
    child = _ChildLoader()
    calls: list[list[Any]] = []
    q: BatchQueue[int, Any] = BatchQueue(
        _loader(calls),
        l2_cache=_L2({"1": '{"id": 1, "author_id": 77}'}),
        prefetch_rules=[PrefetchRule(lambda p: p["author_id"], lambda: child)],
    )
    assert await q.load(1) == {"id": 1, "author_id": 77}
    assert child.loaded == [77]
    assert calls == []


# ---------------------------------------------------------------- @batch_load wiring


def test_batch_load_rejects_non_coroutine_functions() -> None:
    with pytest.raises(TypeError, match="requires an async coroutine function"):

        @batch_load(batch_fn=_loader([]))
        def not_async(key: int) -> int:
            return key


async def test_without_a_batch_source_the_function_runs_directly() -> None:
    direct_calls: list[int] = []

    @batch_load()
    async def plain(key: int) -> int:
        direct_calls.append(key)
        return key * 2

    # prime / prefetch have no queue to act on and must not pretend otherwise.
    plain.prime(1, 99)  # type: ignore[attr-defined]
    plain.prefetch([1, 2])  # type: ignore[attr-defined]
    await plain.clear(1)  # type: ignore[attr-defined]
    assert await plain(1) == 2
    assert await plain(key=3) == 6
    assert direct_calls == [1, 3]

    class Svc:
        _batch = "not callable"

        @batch_load(batch_method="_batch")
        async def get(self, key: int) -> str:
            return f"direct-{key}"

        @batch_load(batch_method="_does_not_exist")
        async def other(self, key: int) -> str:
            return f"other-{key}"

    assert await Svc().get(4) == "direct-4"
    assert await Svc().other(5) == "other-5"


async def test_key_can_be_passed_by_keyword() -> None:
    calls: list[list[Any]] = []

    class Svc:
        async def _batch(self, keys: list[Any]) -> dict[Any, str]:
            calls.append(list(keys))
            return {k: f"v{k}" for k in keys}

        @batch_load(batch_method="_batch")
        async def get(self, user_id: int) -> Any: ...

    svc = Svc()
    results = await asyncio.gather(
        svc.get(1),
        svc.get(user_id=2),
        svc.get(id=3),  # type: ignore[call-arg]
        svc.get(key=4),  # type: ignore[call-arg]
    )
    assert results == ["v1", "v2", "v3", "v4"]
    assert calls == [[1, 2, 3, 4]]


async def test_free_function_with_batch_fn_and_wrapper_helpers() -> None:
    calls: list[list[Any]] = []
    l2 = _L2()

    @batch_load(batch_fn=_loader(calls), l2_cache=l2)
    async def get(key: int) -> Any: ...

    get.prime(1, "primed")  # type: ignore[attr-defined]
    assert await get(1) == "primed"
    get.prefetch([2, 3])  # type: ignore[attr-defined]
    await _settle()
    assert calls == [[2, 3]]
    assert await get(3) == "v3"
    assert calls == [[2, 3]]

    await get.clear(3)  # type: ignore[attr-defined]
    assert l2.deleted == [["3"]]
    assert await get(3) == "v3"
    assert calls == [[2, 3], [3]]


async def test_each_instance_has_its_own_queue_and_cache() -> None:
    class Svc:
        def __init__(self, tag: str) -> None:
            self.tag = tag
            self.calls: list[list[int]] = []

        async def _batch(self, keys: list[int]) -> dict[int, str]:
            self.calls.append(list(keys))
            return {k: f"{self.tag}{k}" for k in keys}

        @batch_load(batch_method="_batch")
        async def get(self, key: int) -> Any: ...

    a, b = Svc("a"), Svc("b")
    assert await asyncio.gather(a.get(1), b.get(1)) == ["a1", "b1"]
    assert (a.calls, b.calls) == ([[1]], [[1]])
    # clear() on the function invalidates every live instance's cache.
    await Svc.get.clear(1)  # type: ignore[attr-defined]
    assert await asyncio.gather(a.get(1), b.get(1)) == ["a1", "b1"]
    assert (a.calls, b.calls) == ([[1], [1]], [[1], [1]])


async def test_non_weakrefable_instance_uses_the_strong_scope_table() -> None:
    class Slotted:
        __slots__ = ("calls",)

        def __init__(self) -> None:
            self.calls: list[list[int]] = []

        async def _batch(self, keys: list[int]) -> dict[int, int]:
            self.calls.append(list(keys))
            return {k: k * 10 for k in keys}

        @batch_load(batch_method="_batch")
        async def get(self, key: int) -> Any: ...

    inst = Slotted()
    assert await asyncio.gather(inst.get(1), inst.get(2)) == [10, 20]
    assert await inst.get(1) == 10
    assert inst.calls == [[1, 2]]


async def test_context_var_scopes_queues_per_request() -> None:
    request_id: contextvars.ContextVar[Any] = contextvars.ContextVar("request_id")
    calls: list[list[int]] = []

    class Svc:
        async def _batch(self, keys: list[int]) -> dict[int, str]:
            calls.append(list(keys))
            return {k: f"v{k}" for k in keys}

        @batch_load(batch_method="_batch", context_var=request_id)
        async def get(self, key: int) -> Any: ...

    # Unset context var: falls back to per-instance scope.
    svc = Svc()
    assert await svc.get(1) == "v1"
    assert await svc.get(1) == "v1"
    assert calls == [[1]]

    token = request_id.set("req-1")
    try:
        assert await svc.get(1) == "v1"
        assert calls == [[1], [1]]
        # Another instance in the same request shares the request's cache.
        assert await Svc().get(1) == "v1"
        assert calls == [[1], [1]]
        request_id.set("req-2")
        assert await svc.get(1) == "v1"
        assert calls == [[1], [1], [1]]
        request_id.set("req-1")
        assert await svc.get(1) == "v1"
        assert calls == [[1], [1], [1]]
        # A None scope value means "no scope": back to the instance queue.
        request_id.set(None)
        assert await svc.get(1) == "v1"
        assert calls == [[1], [1], [1]]
    finally:
        request_id.reset(token)


async def test_strong_scopes_are_bounded_lru(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(coalesce_mod, "_MAX_STRONG_SCOPES", 2)
    request_id: contextvars.ContextVar[Any] = contextvars.ContextVar("request_id")
    calls: list[list[int]] = []

    @batch_load(batch_fn=_loader(calls), context_var=request_id)
    async def get(key: int) -> Any: ...

    async def load_in(scope: str) -> None:
        token = request_id.set(scope)
        try:
            assert await get(1) == "v1"
        finally:
            request_id.reset(token)

    for scope in ("a", "b"):
        await load_in(scope)
    await load_in("a")  # refresh "a": "b" is now the oldest
    assert len(calls) == 2
    await load_in("c")  # evicts "b"
    assert len(calls) == 3
    await load_in("a")  # still cached
    assert len(calls) == 3
    await load_in("b")  # was evicted: loads again
    assert len(calls) == 4


async def test_cancelling_one_caller_does_not_cancel_a_shared_load() -> None:
    entered, gate = asyncio.Event(), asyncio.Event()

    async def loader(keys: list[int]) -> dict[int, str]:
        entered.set()
        await gate.wait()
        return {k: f"v{k}" for k in keys}

    @batch_load(batch_fn=loader)
    async def get(key: int) -> Any: ...

    first = asyncio.create_task(get(1))
    second = asyncio.create_task(get(1))
    await entered.wait()
    first.cancel()
    gate.set()
    with pytest.raises(asyncio.CancelledError):
        await first
    assert await second == "v1"


async def test_batch_load_accepts_prefetch_rule_instances() -> None:
    child = _ChildLoader()

    @batch_load(batch_fn=_posts, prefetch=[PrefetchRule(lambda p: p["author_id"], lambda: child)])
    async def get_post(post_id: int) -> Any: ...

    assert (await get_post(2))["author_id"] == 10
    await _settle()
    assert child.loaded == [10]
