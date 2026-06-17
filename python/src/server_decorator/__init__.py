"""server-decorator (Python) — public API barrel.

Mirrors `node/src/index.ts`. Method-form decorators behave identically to the Node
versions on the same inputs (per `contracts/`). Class-form decorators (Decision #4)
auto-wrap every qualifying method.
"""

from server_decorator._contract import CONTRACT_VERSION
from server_decorator._version import __version__
from server_decorator.config import configure, get_service
from server_decorator.consumer.inmemory import InMemoryConsumer
from server_decorator.consumer.registry import ConsumerRegistry, global_consumer_registry
from server_decorator.decorators.cache import CACHE_MISS, cache, cache_class
from server_decorator.decorators.emit_on_success import emit_on_success, emit_on_success_class
from server_decorator.decorators.on_event import on_event
from server_decorator.decorators.tracking import tracking, tracking_class
from server_decorator.emitter import global_emitter
from server_decorator.logger import Logger, global_logger, set_global_logger
from server_decorator.queue.adapter import (
    QueueAdapter,
    global_queue,
    has_global_queue,
    set_global_queue,
)
from server_decorator.queue.adapters.inmemory import InMemoryQueueAdapter
from server_decorator.queue.adapters.noop import NoOpQueueAdapter
from server_decorator.queue.message import QueueMessage
from server_decorator.queue.registry import QueueConfig, QueueRegistry, global_queue_registry
from server_decorator.tracker import Tracker, global_tracker, set_global_tracker

__all__ = [
    "__version__",
    "CONTRACT_VERSION",
    # method-form decorators (mirror Node)
    "cache",
    "tracking",
    "emit_on_success",
    # class-form decorators (Decision #4)
    "cache_class",
    "tracking_class",
    "emit_on_success_class",
    # cache miss sentinel (D-B)
    "CACHE_MISS",
    # logger
    "Logger",
    "global_logger",
    "set_global_logger",
    # tracker
    "Tracker",
    "global_tracker",
    "set_global_tracker",
    # in-process emitter
    "global_emitter",
    # queue
    "QueueMessage",
    "QueueAdapter",
    "global_queue",
    "set_global_queue",
    "has_global_queue",
    "QueueRegistry",
    "global_queue_registry",
    "QueueConfig",
    "InMemoryQueueAdapter",
    "NoOpQueueAdapter",
    # config
    "configure",
    "get_service",
    # consumer
    "ConsumerRegistry",
    "global_consumer_registry",
    "InMemoryConsumer",
    # consumer decorator
    "on_event",
]
