"""Cache key algorithm. Spec: contracts/rules/cache-key.md (v1.0.0).

Both Python and Node implement this from the same spec; Node's port lives at
`node/src/decorators/_cache_key.ts`. Parity tests load
`contracts/fixtures/cache-key.examples.json`.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

MAX_KEY_BYTES = 250


def _repr_arg(x: Any) -> str:
    return json.dumps(x, sort_keys=True, default=str, separators=(",", ":"))


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
