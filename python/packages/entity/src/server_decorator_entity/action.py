from collections.abc import Callable
from typing import Any, TypeVar

from server_decorator_entity.markers import FieldMarker

F = TypeVar("F", bound=Callable[..., Any])

_ATTR = "__entity_action__"


def action(
    name: str,
    *,
    state_field: str | None = None,
    from_state: str | None = None,
    to_state: str | None = None,
    input: list[tuple[str, FieldMarker]] | None = None,
    transactional: bool = True,
) -> Callable[[F], F]:
    def mark(fn: F) -> F:
        spec: dict[str, Any] = {"name": name}
        if from_state is not None or to_state is not None:
            spec["stateField"] = state_field or "status"
            if from_state is not None:
                spec["from"] = from_state
            if to_state is not None:
                spec["to"] = to_state
        if input:
            spec["input"] = [m.to_ir(n) for n, m in input]
        if not transactional:
            spec["transactional"] = False
        setattr(fn, _ATTR, spec)
        return fn

    return mark
