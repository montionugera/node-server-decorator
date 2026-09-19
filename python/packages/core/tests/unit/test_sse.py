"""Unit tests for Python Server-Sent Events (SSE) transport engine."""

import pytest

from server_decorator.sse import AsyncSSEBroadcaster, SSEEvent, format_sse_message


def test_sse_event_format_string_data() -> None:
    event = SSEEvent(data="hello world")
    assert event.format() == "data: hello world\n\n"
    assert format_sse_message(event) == "data: hello world\n\n"


def test_sse_event_format_dict_data() -> None:
    event = SSEEvent(data={"foo": "bar", "num": 42})
    assert event.format() == 'data: {"foo": "bar", "num": 42}\n\n'


def test_sse_event_format_with_id_and_event() -> None:
    event = SSEEvent(id="101", event="greeting", data="hello")
    assert event.format() == "id: 101\nevent: greeting\ndata: hello\n\n"


def test_sse_event_format_with_id_only() -> None:
    event = SSEEvent(id="42", data={"ok": True})
    assert event.format() == 'id: 42\ndata: {"ok": true}\n\n'


def test_sse_event_format_with_event_only() -> None:
    event = SSEEvent(event="ping", data="pong")
    assert event.format() == "event: ping\ndata: pong\n\n"


@pytest.mark.asyncio
async def test_broadcaster_single_subscriber() -> None:
    broadcaster = AsyncSSEBroadcaster[str](heartbeat_seconds=1.0)
    sub = broadcaster.subscribe()

    assert broadcaster.subscriber_count == 1

    await broadcaster.broadcast(SSEEvent(id="1", event="test", data="payload1"))
    msg = await anext(sub)
    assert msg == "id: 1\nevent: test\ndata: payload1\n\n"

    await sub.aclose()
    assert broadcaster.subscriber_count == 0


@pytest.mark.asyncio
async def test_broadcaster_multiple_subscribers() -> None:
    broadcaster = AsyncSSEBroadcaster[dict[str, int]](heartbeat_seconds=1.0)
    sub1 = broadcaster.subscribe()
    sub2 = broadcaster.subscribe()

    assert broadcaster.subscriber_count == 2

    await broadcaster.broadcast(SSEEvent(id="1", event="update", data={"val": 10}))

    msg1 = await anext(sub1)
    msg2 = await anext(sub2)

    expected = 'id: 1\nevent: update\ndata: {"val": 10}\n\n'
    assert msg1 == expected
    assert msg2 == expected

    await sub1.aclose()
    assert broadcaster.subscriber_count == 1
    await sub2.aclose()
    assert broadcaster.subscriber_count == 0


@pytest.mark.asyncio
async def test_broadcaster_replay_with_last_event_id() -> None:
    broadcaster = AsyncSSEBroadcaster[str](history_limit=10)

    await broadcaster.broadcast(SSEEvent(id="1", data="first"))
    await broadcaster.broadcast(SSEEvent(id="2", data="second"))
    await broadcaster.broadcast(SSEEvent(id="3", data="third"))

    # Replay after id "1" should return "2" and "3"
    sub = broadcaster.subscribe(last_event_id="1")

    msg1 = await anext(sub)
    assert msg1 == "id: 2\ndata: second\n\n"

    msg2 = await anext(sub)
    assert msg2 == "id: 3\ndata: third\n\n"

    # Next broadcast should arrive normally
    await broadcaster.broadcast(SSEEvent(id="4", data="fourth"))
    msg3 = await anext(sub)
    assert msg3 == "id: 4\ndata: fourth\n\n"

    await sub.aclose()


@pytest.mark.asyncio
async def test_broadcaster_replay_after_non_existent_older_id() -> None:
    broadcaster = AsyncSSEBroadcaster[str](history_limit=10)

    await broadcaster.broadcast(SSEEvent(id="10", data="ten"))
    await broadcaster.broadcast(SSEEvent(id="20", data="twenty"))

    # ID "5" is older than all history items; both should replay
    sub = broadcaster.subscribe(last_event_id="5")

    msg1 = await anext(sub)
    assert msg1 == "id: 10\ndata: ten\n\n"
    msg2 = await anext(sub)
    assert msg2 == "id: 20\ndata: twenty\n\n"

    await sub.aclose()


@pytest.mark.asyncio
async def test_broadcaster_heartbeat_ping() -> None:
    # Set short heartbeat for test
    broadcaster = AsyncSSEBroadcaster[str](heartbeat_seconds=0.05)
    sub = broadcaster.subscribe()

    # Wait for heartbeat ping
    ping_msg = await anext(sub)
    assert ping_msg == ": ping\n\n"

    await sub.aclose()


@pytest.mark.asyncio
async def test_broadcaster_buffer_overflow_drop() -> None:
    # Buffer size 2
    broadcaster = AsyncSSEBroadcaster[str](buffer_size=2)
    sub = broadcaster.subscribe()

    await broadcaster.broadcast(SSEEvent(data="msg1"))
    await broadcaster.broadcast(SSEEvent(data="msg2"))
    # 3rd broadcast overflows buffer and is dropped without blocking
    await broadcaster.broadcast(SSEEvent(data="msg3"))

    msg1 = await anext(sub)
    msg2 = await anext(sub)
    assert msg1 == "data: msg1\n\n"
    assert msg2 == "data: msg2\n\n"

    await sub.aclose()


@pytest.mark.asyncio
async def test_broadcaster_close() -> None:
    broadcaster = AsyncSSEBroadcaster[str](heartbeat_seconds=0.5)
    sub = broadcaster.subscribe()

    assert broadcaster.subscriber_count == 1
    await broadcaster.close()

    # Once closed, next on sub should terminate (StopAsyncIteration)
    with pytest.raises(StopAsyncIteration):
        await anext(sub)

    assert broadcaster.subscriber_count == 0
