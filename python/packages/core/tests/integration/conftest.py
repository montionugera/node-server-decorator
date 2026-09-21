from __future__ import annotations

import os
from collections.abc import Generator

import pytest


@pytest.fixture
def redis_url() -> Generator[str, None, None]:
    env_url = os.environ.get("REDIS_URL")
    if env_url:
        yield env_url
        return

    from testcontainers.redis import RedisContainer

    with RedisContainer("redis:7-alpine") as r:
        host = r.get_container_host_ip()
        port = int(r.get_exposed_port(6379))
        yield f"redis://{host}:{port}"
