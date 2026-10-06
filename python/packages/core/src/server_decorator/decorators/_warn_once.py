from __future__ import annotations

import threading
import weakref
from typing import Any


class OncePerObject:
    """Thread-safe 'is this the first time I see this object' check. Holds objects weakly."""

    def __init__(self) -> None:
        self._seen: weakref.WeakSet[Any] = weakref.WeakSet()
        self._lock = threading.Lock()

    def first(self, obj: Any) -> bool:
        """True exactly once per live object."""
        with self._lock:
            if obj in self._seen:
                return False
            self._seen.add(obj)
            return True
