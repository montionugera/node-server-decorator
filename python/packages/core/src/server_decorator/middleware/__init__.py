"""Middleware package for server-decorator."""

from server_decorator.middleware.auth import (
    ProblemDetails,
    ScopeAuthMiddleware,
    ScopeExtractor,
    check_scopes,
    enforce_scope_auth,
)

__all__ = [
    "ProblemDetails",
    "check_scopes",
    "ScopeExtractor",
    "ScopeAuthMiddleware",
    "enforce_scope_auth",
]
