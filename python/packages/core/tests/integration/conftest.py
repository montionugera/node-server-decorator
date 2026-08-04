import os

import pytest


@pytest.fixture
def redis_url() -> str:
    return os.environ.get("REDIS_URL", "redis://localhost:6379")
