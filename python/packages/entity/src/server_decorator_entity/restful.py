import typing
from collections.abc import Callable
from typing import Any, TypeVar

from server_decorator_entity.action import _ATTR
from server_decorator_entity.canonical import canonical_json
from server_decorator_entity.markers import FieldMarker

C = TypeVar("C", bound=type)

_SPEC_ATTR = "__entity_spec__"
_DEFAULT_OPS = ["list", "get", "create", "update", "delete"]


def _camel(name: str) -> str:
    head, *rest = name.split("_")
    return head + "".join(s.capitalize() for s in rest)


def restful(
    *,
    path: str,
    transports: list[str] | None = None,
    ops: list[str] | None = None,
    pagination: str = "offset",
) -> Callable[[C], C]:
    def wrap(cls: C) -> C:
        hints = typing.get_type_hints(cls, include_extras=True)
        fields: list[dict[str, Any]] = []
        for attr_name, hint in hints.items():
            marker = next(
                (m for m in getattr(hint, "__metadata__", ()) if isinstance(m, FieldMarker)), None
            )
            if marker is not None:
                fields.append(marker.to_ir(_camel(attr_name)))
        actions = [
            getattr(member, _ATTR)
            for member in vars(cls).values()
            if callable(member) and hasattr(member, _ATTR)
        ]
        spec: dict[str, Any] = {
            "specVersion": "1.1.0",
            "entity": cls.__name__,
            "path": path,
            "transports": transports or ["rest"],
            "ops": ops or list(_DEFAULT_OPS),
            "pagination": pagination,
            "fields": fields,
        }
        if actions:
            spec["actions"] = actions
        setattr(cls, _SPEC_ATTR, spec)
        return cls

    return wrap


def entity_spec(cls: type) -> dict[str, Any]:
    spec = getattr(cls, _SPEC_ATTR, None)
    if spec is None:
        raise TypeError(f"{cls.__name__} is not decorated with @restful")
    return spec  # type: ignore[no-any-return]


def entity_spec_canonical(cls: type) -> str:
    return canonical_json(entity_spec(cls))
