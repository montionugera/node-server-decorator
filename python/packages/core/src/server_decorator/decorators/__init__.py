"""Decorators subsystem."""

from server_decorator.decorators.cache import CACHE_MISS, cache, cache_class
from server_decorator.decorators.circuit_breaker import (
    CircuitBreaker,
    CircuitBreakerOpenError,
    CircuitState,
    circuit_breaker,
    circuit_breaker_class,
    clear_circuit_breakers,
    get_circuit_breaker,
)
from server_decorator.decorators.coalesce import batch_load
from server_decorator.decorators.emit_on_success import emit_on_success, emit_on_success_class
from server_decorator.decorators.on_event import on_event
from server_decorator.decorators.rate_limit import (
    RateLimitExceededError,
    TokenBucket,
    clear_rate_limiters,
    get_token_bucket,
    rate_limit,
    rate_limit_class,
)
from server_decorator.decorators.retry import retry, retry_class
from server_decorator.decorators.tracking import tracking, tracking_class

from server_decorator.decorators.distributed_lock import (
    LockAcquisitionError,
    RedisLockAdapter,
    clear_global_distributed_lock_adapter,
    configure_distributed_lock,
    distributed_lock,
    distributed_lock_class,
    get_global_distributed_lock_adapter,
)

__all__ = [
    "batch_load",
    "cache",
    "cache_class",
    "CACHE_MISS",
    "tracking",
    "tracking_class",
    "emit_on_success",
    "emit_on_success_class",
    "on_event",
    "retry",
    "retry_class",
    "circuit_breaker",
    "circuit_breaker_class",
    "CircuitBreaker",
    "CircuitBreakerOpenError",
    "CircuitState",
    "get_circuit_breaker",
    "clear_circuit_breakers",
    "rate_limit",
    "rate_limit_class",
    "RateLimitExceededError",
    "TokenBucket",
    "get_token_bucket",
    "clear_rate_limiters",
    "distributed_lock",
    "distributed_lock_class",
    "LockAcquisitionError",
    "RedisLockAdapter",
    "configure_distributed_lock",
    "get_global_distributed_lock_adapter",
    "clear_global_distributed_lock_adapter",
]
