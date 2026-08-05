"""Safe deep-copy of crewai objects.

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


def _assert_state_isolated(original: object, copied: object, what: str) -> None:
    """Fail loudly if the per-request conversation ``_state`` was NOT isolated.

    :func:`_deepcopy_pinning_uncopyable` pins uncopyable values by reference at
    TOP-LEVEL-FIELD granularity. If a single field/private-attr
    value transitively holds BOTH the conversation ``_state`` AND some
    uncopyable object (a lock, a thread pool), the whole field is pinned — so
    the copy would SHARE ``_state`` with the original and per-request isolation
    would be SILENTLY lost (every concurrent request mutating one shared state).
    The entire reason ``safe_deepcopy`` exists is to isolate that ``_state``, so
    assert it post-copy and fail loud rather than serve cross-request bleed.

    Only checked when BOTH objects actually carry a non-None ``_state`` (crewai
    ``Flow`` instances do; a copied ``Crew`` or a test stub may not) — absent or
    ``None`` ``_state`` is nothing to isolate and is left alone.
    """
    original_state = getattr(original, "_state", None)
    copied_state = getattr(copied, "_state", None)
    if original_state is None or copied_state is None:
        return
    if copied_state is original_state:
        raise RuntimeError(
            f"ag-ui-crewai: safe_deepcopy of a {what} did NOT isolate its "
            "conversation `_state` (copy._state is original._state). A "
            "top-level field pinned by the deep-copy fallback transitively "
            "held both `_state` and an uncopyable object, collapsing "
            "per-request isolation — concurrent requests would share and "
            "corrupt one another's state. This is a hard correctness failure, "
            "not a degradation; refusing to serve a non-isolated copy."
        )


def safe_deepcopy(obj: object, *, what: str = "crewai object") -> object:
    """Return an isolated deep-copy of ``obj``, tolerating crewai's copy bugs.

    Uses plain ``copy.deepcopy`` on healthy builds; on the first failure it
    latches to the pin-and-share fallback and warns once. Either way the
    per-request conversation ``_state`` MUST end up isolated — asserted
    fail-loud post-copy.
    """
    global _NEEDS_PIN  # pylint: disable=global-statement
    if _NEEDS_PIN:
        copied = _deepcopy_pinning_uncopyable(obj)
        _assert_state_isolated(obj, copied, what)
        return copied
    try:
        copied = copy.deepcopy(obj)
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
        copied = _deepcopy_pinning_uncopyable(obj)
    _assert_state_isolated(obj, copied, what)
    return copied


def rebind_bound_methods(target: object, attr: str = "_methods") -> None:
    """Rebind the bound callables in ``target.<attr>`` to ``target`` itself.

    crewai 1.15 per-request isolation bug. crewai 1.x drives a
    Flow's ``@start`` / ``@listen`` methods through a ``_methods`` dict of
    BOUND methods, each captured against the instance at construction time
    (``method.__get__(self, type(self))`` in ``_class_bound_methods``). The
    execution engine looks methods up as ``self._methods[name]`` and calls
    them, so ``@start`` runs against ``method.__self__`` — NOT necessarily the
    instance ``kickoff_async`` was called on.

    When the pin-and-share fallback (:func:`_deepcopy_pinning_uncopyable`) is
    used, trial-deep-copying the ``_methods`` dict raises (its bound methods
    reference the uncopyable ``memory`` / locks via ``__self__``), so the dict
    is PINNED — the copy SHARES the original's ``_methods``, whose methods stay
    bound to the ORIGINAL flow. ``kickoff_async(inputs=...)`` on the copy then
    seeds the COPY's ``self._state`` (``messages`` / ``copilotkit`` / …) while
    ``@start`` executes against the ORIGINAL's un-seeded state — a ``KeyError``
    on ``self.state["messages"]`` (and, more broadly, complete loss of
    per-request isolation: every request would mutate the one shared original).

    crewai wraps each ``@start`` / ``@listen`` / ``@router`` method in a
    ``FlowMethod`` descriptor (``crewai.flow.flow_wrappers``) that carries a
    ``__self__`` and rebinds through the standard descriptor protocol:
    ``method.__get__(instance, type(instance))`` returns a fresh wrapper bound
    to ``instance`` (this is exactly how crewai's own ``_class_bound_methods``
    binds them). This rebuilds ``<attr>`` as a FRESH dict (never mutating the
    possibly-shared original) with every entry whose ``__self__`` is not
    ``target`` re-derived via ``__get__``. It is a no-op when:

    * ``<attr>`` is absent or not a dict (e.g. a copied ``Crew``);
    * an entry is already bound to ``target`` (healthy plain-``deepcopy`` builds
      rebind ``__self__`` through the memo, so nothing to do);
    * an entry is not a bound descriptor (no ``__self__`` / no ``__get__``) —
      left as-is.

    Capability-safe: keyed off object shape (a dict of bound descriptors), never
    a crewai version. Leaf module: stdlib-only attribute operations, no imports.
    """
    methods = getattr(target, attr, None)
    if not isinstance(methods, dict):
        return
    rebound: dict = {}
    changed = False
    for name, method in methods.items():
        owner = getattr(method, "__self__", None)
        binder = getattr(method, "__get__", None)
        if owner is not None and owner is not target and callable(binder):
            rebound[name] = binder(target, type(target))
            changed = True
        else:
            rebound[name] = method
    if not changed:
        return
    # Replace the reference on ``target`` only — the original (whose dict we may
    # be sharing) keeps its own bindings intact for concurrent requests.
    # crewai stores ``_methods`` as a Pydantic ``PrivateAttr``; assign straight
    # into ``__pydantic_private__`` when present (BaseModel ``__setattr__`` for a
    # private attr is a no-op on some crewai builds), else fall back to setattr.
    private = getattr(target, "__pydantic_private__", None)
    if isinstance(private, dict) and attr in private:
        private[attr] = rebound
    else:
        setattr(target, attr, rebound)
