"""Unit coverage for the pluggable logger."""

from __future__ import annotations

import logging
from collections.abc import Iterator

import pytest

from server_decorator import logger as logger_mod
from server_decorator.logger import _DefaultLogger, set_global_logger


@pytest.fixture(autouse=True)
def _restore_global_logger() -> Iterator[None]:
    original = logger_mod.global_logger
    yield
    logger_mod.global_logger = original


@pytest.mark.parametrize(
    ("method", "level"),
    [
        ("debug", logging.DEBUG),
        ("info", logging.INFO),
        ("warn", logging.WARNING),
        ("error", logging.ERROR),
    ],
)
def test_default_logger_maps_each_method_to_stdlib_level(
    method: str, level: int, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.DEBUG, logger="server_decorator"):
        getattr(_DefaultLogger(), method)(f"hello-{method}")

    records = [r for r in caplog.records if r.name == "server_decorator"]
    assert len(records) == 1
    assert records[0].levelno == level
    assert records[0].getMessage() == f"hello-{method}"


def test_default_logger_does_not_interpret_percent_in_message(
    caplog: pytest.LogCaptureFixture,
) -> None:
    with caplog.at_level(logging.DEBUG, logger="server_decorator"):
        _DefaultLogger().warn("100% done %s %d")

    assert caplog.records[-1].getMessage() == "100% done %s %d"


def test_default_logger_stringifies_non_string_messages(
    caplog: pytest.LogCaptureFixture,
) -> None:
    with caplog.at_level(logging.DEBUG, logger="server_decorator"):
        _DefaultLogger().error({"code": 7})
        _DefaultLogger().info(None)

    assert [r.getMessage() for r in caplog.records] == ["{'code': 7}", "None"]


def test_default_logger_respects_level_threshold(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.WARNING, logger="server_decorator"):
        log = _DefaultLogger()
        log.debug("quiet")
        log.info("quiet")
        log.warn("loud")

    assert [r.getMessage() for r in caplog.records] == ["loud"]


def test_global_logger_defaults_to_default_logger() -> None:
    assert isinstance(logger_mod.global_logger, _DefaultLogger)


def test_set_global_logger_replaces_module_global() -> None:
    class _Recorder:
        def __init__(self) -> None:
            self.lines: list[tuple[str, object]] = []

        def debug(self, msg: object) -> None:
            self.lines.append(("debug", msg))

        def info(self, msg: object) -> None:
            self.lines.append(("info", msg))

        def warn(self, msg: object) -> None:
            self.lines.append(("warn", msg))

        def error(self, msg: object) -> None:
            self.lines.append(("error", msg))

    rec = _Recorder()
    set_global_logger(rec)

    assert logger_mod.global_logger is rec
    logger_mod.global_logger.warn("w")
    logger_mod.global_logger.error("e")
    assert rec.lines == [("warn", "w"), ("error", "e")]
