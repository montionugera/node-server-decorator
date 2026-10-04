"""Cache key algorithm. Spec: contracts/rules/cache-key.md (v1.0.0).

Both Python and Node implement this from the same spec; Node's port lives at
`node/packages/core/src/decorators/_cache_key.ts`. Parity tests load
`contracts/fixtures/cache-key.examples.json`.
"""

from __future__ import annotations

import collections
import dataclasses
import decimal
import hashlib
import json
import math
from typing import Any

MAX_KEY_BYTES = 250


def _reject_non_finite(x: Any, seen: set[int]) -> None:
    if isinstance(x, float):
        if not math.isfinite(x):
            raise ValueError(f"Out of range float values are not JSON compliant: {x!r}")
        return
    if isinstance(x, decimal.Decimal):
        if not x.is_finite():
            raise ValueError(f"Out of range float values are not JSON compliant: {x!r}")
        return
    if isinstance(x, complex):
        if not (math.isfinite(x.real) and math.isfinite(x.imag)):
            raise ValueError(f"Out of range float values are not JSON compliant: {x!r}")
        return

    x_id = id(x)
    if x_id in seen:
        return

    if isinstance(x, dict):
        seen.add(x_id)
        for k, v in x.items():
            _reject_non_finite(k, seen)
            _reject_non_finite(v, seen)
    elif isinstance(x, (list, tuple, set, frozenset, collections.deque)):
        seen.add(x_id)
        for item in x:
            _reject_non_finite(item, seen)
    elif dataclasses.is_dataclass(x) and not isinstance(x, type):
        seen.add(x_id)
        for f in dataclasses.fields(x):
            _reject_non_finite(getattr(x, f.name), seen)


def _repr_arg(x: Any) -> str:
    seen: set[int] = set()

    def _default(o: Any) -> Any:
        _reject_non_finite(o, seen)
        if isinstance(o, (set, frozenset)):
            return sorted(
                o,
                key=lambda m: json.dumps(
                    m,
                    sort_keys=True,
                    default=_default,
                    separators=(",", ":"),
                    ensure_ascii=False,
                    allow_nan=False,
                ),
            )
        return str(o)

    # ensure_ascii=False: the key stays UTF-8 (byte-identical to Node/Go).
    # allow_nan=False: NaN/Infinity raise ValueError instead of emitting non-JSON tokens.
    # _default rejects non-finite numbers hidden in containers before stringifying,
    # and serialises set/frozenset as a list sorted by member serialised form.
    return json.dumps(
        x,
        sort_keys=True,
        default=_default,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    )


def build_cache_key(
    qualname: str,
    args: tuple[Any, ...] | list[Any],
    kwargs: dict[str, Any],
) -> str:
    arg_pieces = [_repr_arg(a) for a in args]
    if kwargs:
        for k in sorted(kwargs.keys()):
            arg_pieces.append(f"{k}={_repr_arg(kwargs[k])}")
    arg_repr = ",".join(arg_pieces)
    raw = f"{qualname}({arg_repr})"
    if len(raw.encode("utf-8")) <= MAX_KEY_BYTES:
        return raw
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()
    return f"{qualname}(sha256:{digest})"
