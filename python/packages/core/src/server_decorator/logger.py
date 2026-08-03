"""Pluggable logger. Default goes to the stdlib logger; override via `set_global_logger`."""

from __future__ import annotations

import logging
from typing import Protocol


class Logger(Protocol):
    def debug(self, msg: object) -> None: ...
    def info(self, msg: object) -> None: ...
    def warn(self, msg: object) -> None: ...
    def error(self, msg: object) -> None: ...


class _DefaultLogger:
    def __init__(self) -> None:
        self._log = logging.getLogger("server_decorator")

    def debug(self, msg: object) -> None:
        self._log.debug("%s", msg)

    def info(self, msg: object) -> None:
        self._log.info("%s", msg)

    def warn(self, msg: object) -> None:
        self._log.warning("%s", msg)

    def error(self, msg: object) -> None:
        self._log.error("%s", msg)


global_logger: Logger = _DefaultLogger()


def set_global_logger(logger: Logger) -> None:
    global global_logger
    global_logger = logger
