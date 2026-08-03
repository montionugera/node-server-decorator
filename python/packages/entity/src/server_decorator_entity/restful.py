import copy
import inspect
import re
import typing
from collections.abc import Callable
from typing import Any, TypeVar

from server_decorator_entity.action import _ATTR
from server_decorator_entity.canonical import canonical_json
from server_decorator_entity.markers import FieldMarker

C = TypeVar("C", bound=type)

_SPEC_ATTR = "__entity_spec__"
_DEFAULT_OPS = ["list", "get", "create", "update", "delete"]
_WIRE_NAME_RE = re.compile(r"^[a-z][A-Za-z0-9]*$")


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
        # Own-class declarations only (N2: no MRO walk) — a @restful subclass must not
        # re-collect its base's fields. get_type_hints() still resolves the (possibly
        # string/forward-ref) annotation values; own_annotations only supplies which
        # names — and their declaration order — belong to this class.
        own_annotations: dict[str, Any] = inspect.get_annotations(cls)
        hints = typing.get_type_hints(cls, include_extras=True)
        fields: list[dict[str, Any]] = []
        seen_wire_names: set[str] = set()
        for attr_name in own_annotations:
            hint = hints.get(attr_name)
            marker = next(
                (m for m in getattr(hint, "__metadata__", ()) if isinstance(m, FieldMarker)), None
            )
            if marker is None:
                continue
            wire_name = _camel(attr_name)
            if not _WIRE_NAME_RE.match(wire_name):
                raise ValueError(
                    f"{cls.__name__}.{attr_name}: computed wire name {wire_name!r} does not "
                    f"match ^[a-z][A-Za-z0-9]*$"
                )
            if wire_name in seen_wire_names:
                raise ValueError(
                    f"{cls.__name__}.{attr_name}: wire name {wire_name!r} collides with "
                    f"another field"
                )
            seen_wire_names.add(wire_name)
            fields.append(marker.to_ir(wire_name))

        # `or` is truthiness-coalescing, not None-coalescing — an explicit `transports=[]`/
        # `ops=[]` must fail fast here (not be silently replaced by the default), matching TS's
        # `??`-then-validate approach (C4). Only an omitted (`None`) argument gets the default.
        resolved_transports = ["rest"] if transports is None else transports
        if not resolved_transports:
            raise ValueError(f"{cls.__name__}: transports must not be empty")
        resolved_ops = list(_DEFAULT_OPS) if ops is None else ops
        if not resolved_ops:
            raise ValueError(f"{cls.__name__}: ops must not be empty")

        actions: list[dict[str, Any]] = []
        for member in vars(cls).values():
            if isinstance(member, (staticmethod, classmethod)):
                underlying = member.__func__
                if hasattr(underlying, _ATTR):
                    kind = "static" if isinstance(member, staticmethod) else "class"
                    raise TypeError(
                        f"@action must decorate an instance method (got {kind} method "
                        f"'{underlying.__name__}')"
                    )
                continue
            if callable(member) and hasattr(member, _ATTR):
                actions.append(getattr(member, _ATTR))
        spec: dict[str, Any] = {
            "specVersion": "1.1.0",
            "entity": cls.__name__,
            "path": path,
            "transports": resolved_transports,
            "ops": resolved_ops,
            "pagination": pagination,
            "fields": fields,
        }
        if actions:
            spec["actions"] = actions
        setattr(cls, _SPEC_ATTR, spec)
        return cls

    return wrap


def _stored_spec(cls: type) -> dict[str, Any]:
    # Own-attribute only (cls.__dict__, never getattr's MRO walk) — an undecorated
    # subclass of a @restful base must not silently inherit the base's spec.
    spec = cls.__dict__.get(_SPEC_ATTR)
    if spec is None:
        raise TypeError(f"{cls.__name__} is not decorated with @restful")
    return spec  # type: ignore[no-any-return]


def entity_spec(cls: type) -> dict[str, Any]:
    # Deep copy so callers can't poison the memoized spec (parity with Node's deep-freeze).
    return copy.deepcopy(_stored_spec(cls))


def entity_spec_canonical(cls: type) -> str:
    return canonical_json(_stored_spec(cls))
