"""Replay is positional: event IDs are opaque and carry no ordering."""

from __future__ import annotations

from server_decorator.sse import AsyncSSEBroadcaster, SSEEvent


async def test_unknown_last_event_id_replays_whole_history_in_order() -> None:
    broadcaster = AsyncSSEBroadcaster[str](history_limit=10)
    await broadcaster.broadcast(SSEEvent(id="bbb", data="one"))
    await broadcaster.broadcast(SSEEvent(id="aaa", data="two"))

    sub = broadcaster.subscribe(last_event_id="unknown-id")
    assert await anext(sub) == "id: bbb\ndata: one\n\n"
    assert await anext(sub) == "id: aaa\ndata: two\n\n"
    await sub.aclose()


async def test_unknown_numeric_last_event_id_ahead_of_history_replays_everything() -> None:
    # e.g. the server restarted and its ID counter started again
    broadcaster = AsyncSSEBroadcaster[str](history_limit=10)
    await broadcaster.broadcast(SSEEvent(id="1", data="one"))
    await broadcaster.broadcast(SSEEvent(id="2", data="two"))

    sub = broadcaster.subscribe(last_event_id="900")
    assert await anext(sub) == "id: 1\ndata: one\n\n"
    assert await anext(sub) == "id: 2\ndata: two\n\n"
    await sub.aclose()


async def test_live_events_after_replay_with_non_monotonic_ids() -> None:
    broadcaster = AsyncSSEBroadcaster[str](history_limit=10)
    await broadcaster.broadcast(SSEEvent(id="f3c1", data="one"))
    await broadcaster.broadcast(SSEEvent(id="zz99", data="two"))

    sub = broadcaster.subscribe(last_event_id="f3c1")
    assert await anext(sub) == "id: zz99\ndata: two\n\n"
    await broadcaster.broadcast(SSEEvent(id="0a11", data="three"))
    assert await anext(sub) == "id: 0a11\ndata: three\n\n"
    await sub.aclose()


async def test_event_broadcast_between_subscribe_and_first_read_is_not_duplicated() -> None:
    broadcaster = AsyncSSEBroadcaster[str](history_limit=10, heartbeat_seconds=0.05)
    await broadcaster.broadcast(SSEEvent(id="a", data="one"))
    await broadcaster.broadcast(SSEEvent(id="b", data="two"))

    sub = broadcaster.subscribe(last_event_id="a")
    # Lands in both the history and the subscriber queue before the generator starts.
    await broadcaster.broadcast(SSEEvent(id="c", data="three"))

    assert await anext(sub) == "id: b\ndata: two\n\n"
    assert await anext(sub) == "id: c\ndata: three\n\n"
    assert await anext(sub) == ": ping\n\n"
    await sub.aclose()
