"""Pluggable tracker. Default prints to logger; override via `set_global_tracker`."""

from __future__ import annotations

from typing import Protocol

from server_decorator.logger import global_logger


class Tracker(Protocol):
    def track(self, key: str, latency_ms: int, is_error: bool) -> None: ...


class _DefaultTracker:
    def track(self, key: str, latency_ms: int, is_error: bool) -> None:
        global_logger.info(f"[Tracking] key={key} latency_ms={latency_ms} is_error={is_error}")


global_tracker: Tracker = _DefaultTracker()


def set_global_tracker(tracker: Tracker) -> None:
    global global_tracker
    global_tracker = tracker
