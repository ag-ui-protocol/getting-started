"""Safe deep-copy of crewai objects (CPK-7718 #10).

crewai 1.13+ made ``Flow`` (and ``Crew``) Pydantic ``BaseModel``s that now
carry non-deep-copyable runtime state — a ``memory`` (``UnifiedMemory``) field
whose ``__deepcopy__`` has an upstream bug (``isinstance(v, (ThreadPoolExecutor,
threading.Lock))`` where ``threading.Lock`` is a factory, not a type, so
``isinstance`` raises ``TypeError``) plus raw ``threading.Lock`` / ``RLock`` /
``ThreadPoolExecutor`` objects in ``__pydantic_private__`` / fields that cannot
be pickled. A plain ``copy.deepcopy`` therefore crashes on crewai 1.15.x.

The bridge deep-copies flows (per request) and the wrapped crew (once, at
``ChatWithCrewFlow`` construction) purely to ISOLATE mutable run state across
requests. It does not use crewai's memory / lock internals. So on the first
failure we fall back to a copy that pins any non-deep-copyable object BY
REFERENCE in the ``memo`` (sharing those harmless runtime primitives) while
deep-copying everything else — notably the conversation state — so isolation is
preserved.

Capability-detected, never version-gated: healthy crewai builds that deep-copy
cleanly keep the plain ``copy.deepcopy`` path. This module is a LEAF (stdlib
only) so any module can import it without a cycle.
"""

from __future__ import annotations

import copy
import logging

_LOGGER = logging.getLogger(__name__)

# Latched True the first time a plain deep-copy is seen to fail, so we stop
# paying for a doomed attempt on every subsequent call.
_NEEDS_PIN = False


def _deepcopy_pinning_uncopyable(obj: object) -> object:
    """Deep-copy ``obj`` pinning any value that cannot itself be deep-copied.

    Scans the object's ``__dict__`` (Pydantic fields) and
    ``__pydantic_private__`` (private runtime state). Each value is trial
    deep-copied against a COPY of the working memo; anything that raises is
    pinned by reference in the real memo (shared), so the final
    ``copy.deepcopy`` skips it. Copyable values (notably the conversation
    ``_state``) are still deep-copied and therefore isolated.
    """
    memo: dict = {}
    for container in (
        getattr(obj, "__dict__", None),
        getattr(obj, "__pydantic_private__", None),
    ):
        if not container:
            continue
        for value in list(container.values()):
            if value is None or id(value) in memo:
                continue
            try:
                copy.deepcopy(value, dict(memo))
            except Exception:  # noqa: BLE001 - anything non-copyable gets pinned
                memo[id(value)] = value
    return copy.deepcopy(obj, memo)


def safe_deepcopy(obj: object, *, what: str = "crewai object") -> object:
    """Return an isolated deep-copy of ``obj``, tolerating crewai's copy bugs.

    Uses plain ``copy.deepcopy`` on healthy builds; on the first failure it
    latches to the pin-and-share fallback and warns once.
    """
    global _NEEDS_PIN  # pylint: disable=global-statement
    if _NEEDS_PIN:
        return _deepcopy_pinning_uncopyable(obj)
    try:
        return copy.deepcopy(obj)
    except Exception:  # noqa: BLE001 - fall back to the pin-and-share path
        _NEEDS_PIN = True
        _LOGGER.warning(
            "ag-ui-crewai: plain copy.deepcopy of a %s failed (known crewai "
            "1.15.x Flow/Crew deep-copy bug); falling back to pinning shared "
            "runtime objects (memory / locks / thread pools) by reference. "
            "Per-request run state is still isolated. Further occurrences are "
            "silenced.",
            what,
        )
        return _deepcopy_pinning_uncopyable(obj)
