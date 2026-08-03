"""QueueRegistry — register multiple named adapters; route by name + topic."""

from __future__ import annotations

from dataclasses import dataclass

from server_decorator.queue.adapter import QueueAdapter
from server_decorator.queue.message import QueueMessage


@dataclass
class QueueConfig:
    adapter: QueueAdapter
    default_topic: str = "default"
    priority: int = 0


class QueueRegistry:
    def __init__(self) -> None:
        self._configs: dict[str, QueueConfig] = {}
        self._default_name: str | None = None

    def register(self, name: str, config: QueueConfig | QueueAdapter) -> None:
        if isinstance(config, QueueConfig):
            self._configs[name] = config
        else:
            self._configs[name] = QueueConfig(adapter=config)
        if self._default_name is None:
            self._default_name = name

    def set_default(self, name: str) -> None:
        if name not in self._configs:
            raise KeyError(f"queue {name!r} not registered")
        self._default_name = name

    def get(self, name: str | None = None) -> QueueConfig:
        if name is not None:
            if name not in self._configs:
                raise KeyError(f"queue {name!r} not registered")
            return self._configs[name]
        if self._default_name is not None:
            return self._configs[self._default_name]
        if not self._configs:
            raise RuntimeError("no queues registered")
        return next(iter(self._configs.values()))

    def clear(self) -> None:
        self._configs.clear()
        self._default_name = None

    async def publish(
        self,
        message: QueueMessage,
        queue_name: str | None = None,
        topic: str | None = None,
    ) -> None:
        config = self.get(queue_name)
        meta = dict(message.get("metadata") or {})
        meta["topic"] = topic or meta.get("topic") or config.default_topic
        message["metadata"] = meta  # type: ignore[typeddict-item]
        await config.adapter.publish(message)


global_queue_registry: QueueRegistry = QueueRegistry()
