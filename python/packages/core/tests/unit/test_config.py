import importlib

import server_decorator.config as cfg


def setup_function() -> None:
    cfg.configure(service=None)


def test_default_service_is_none(monkeypatch) -> None:
    monkeypatch.delenv("SERVER_DECORATOR_SERVICE", raising=False)
    importlib.reload(cfg)
    assert cfg.get_service() is None


def test_env_var_sets_service(monkeypatch) -> None:
    monkeypatch.setenv("SERVER_DECORATOR_SERVICE", "user-svc")
    importlib.reload(cfg)
    assert cfg.get_service() == "user-svc"


def test_configure_overrides_env(monkeypatch) -> None:
    monkeypatch.setenv("SERVER_DECORATOR_SERVICE", "from-env")
    importlib.reload(cfg)
    cfg.configure(service="from-code")
    assert cfg.get_service() == "from-code"
