"""Shared pytest fixtures for the ag_ui_crewai tests.

Primary concern: isolate the module-level ``QUEUES`` mapping (and the
global crewai event-bus listener singleton) from test-to-test leakage. A
ghost queue from one test is harmless in isolation, but in a long test
suite it can obscure the provenance of flaky teardown races.

Intentionally we do NOT swallow the import error (finding #27). If
``ag_ui_crewai.endpoint`` cannot be imported, every downstream test will
fail with the same traceback — a clearer diagnostic than a confused test
suite running against a half-initialised module.
"""

import copy

import pytest

from ag_ui_crewai import endpoint as ep

# The crewai global event bus — used below to clear handlers registered by our
# listener singleton so they don't accumulate across tests (R5 MEDIUM #10).
# CPK-7718: the bus moved from ``crewai.utilities.events`` (0.x) to
# ``crewai.events`` (1.x); ``_capabilities`` resolves whichever exists.
from ag_ui_crewai._capabilities import crewai_event_bus as _crewai_event_bus

# CPK-7718 #4: crewai 1.0.0 split the single ``_handlers`` mapping into
# ``_sync_handlers`` / ``_async_handlers``. The autouse fixture below snapshots
# whichever handler dict(s) the installed crewai exposes so listener isolation
# keeps working across BOTH the 0.x single-dict and the 1.x split-dict shapes
# (resolves the TODO(CPK-7718) that used to live here).
_HANDLER_ATTRS = ("_sync_handlers", "_async_handlers", "_handlers")


@pytest.fixture(autouse=True)
def _clear_endpoint_queues():
    """Ensure the module-level QUEUES dict and listener singleton are
    isolated between tests.

    The crewai global event bus retains registered listeners for the
    lifetime of the process; the endpoint module caches its listener in
    ``GLOBAL_EVENT_LISTENER`` to avoid double-registration. Between
    tests we clear the QUEUES dict, clear the event-bus handlers
    registered by the listener (R5 MEDIUM #10 — listeners accumulate
    otherwise, and previously the only isolation was nulling the
    reference which let older handlers keep firing), and reset the
    listener reference so a test that patches or probes
    ``GLOBAL_EVENT_LISTENER`` starts from a known-clean baseline
    (finding #22).

    R5 MEDIUM #10 details: the crewai ``CrewAIEventsBus`` exposes a
    private ``_handlers`` dict keyed by event type. Nulling
    ``GLOBAL_EVENT_LISTENER`` only drops our Python-side reference —
    the handlers it registered on the bus persist for the process
    lifetime. Over a long suite this accumulates duplicate listeners
    that all enqueue onto ``QUEUES`` (now empty, so the ``None`` guard
    saves us), but the CPU cost and the signal confusion grow with
    suite length. Reaching into ``_handlers`` directly is a pragmatic
    workaround — crewai does not expose a public teardown API.

    CPK-7718 #4 (resolved): crewai 1.0.0 split the single ``_handlers``
    mapping into ``_sync_handlers`` / ``_async_handlers``. The
    snapshot/restore helpers below iterate ``_HANDLER_ATTRS`` and act on
    whichever dict(s) the installed crewai exposes, so listener isolation
    keeps working across BOTH the 0.x single-dict and the 1.x split-dict
    shapes rather than silently degrading to a no-op on 1.x.
    """

    # CR9 MEDIUM: ``handlers.clear()`` on the process-wide event bus
    # wipes ALL handlers — including any registered by another
    # library importing crewai in the same process. Snapshot the
    # handlers dict (key -> list of callables) at setup and restore
    # it on teardown so we only drop what tests registered, not
    # pre-existing subscribers. We deep-copy the lists (``list(v)``)
    # because crewai mutates them in-place via ``append`` during
    # listener registration — a shallow ``dict(...)`` snapshot would
    # still observe our appends post-setup.
    def _snapshot_handlers():
        if _crewai_event_bus is None:
            return None
        snapshot = {}
        for attr in _HANDLER_ATTRS:
            handlers = getattr(_crewai_event_bus, attr, None)
            if handlers is None:
                continue
            try:
                # CPK-7718 #4: crewai 1.x stores handlers as ``frozenset`` (the
                # bus does set-union on registration); ``copy.copy`` preserves
                # that container type, whereas a ``list(...)`` snapshot would
                # corrupt it and break ``_register_handler`` on restore.
                snapshot[attr] = {k: copy.copy(v) for k, v in handlers.items()}
            except Exception:  # pragma: no cover - defensive
                continue
        return snapshot or None

    def _restore_handlers(snapshot):
        if _crewai_event_bus is None or not snapshot:
            return
        for attr, per_attr in snapshot.items():
            handlers = getattr(_crewai_event_bus, attr, None)
            if handlers is None:
                continue
            try:
                handlers.clear()
                for k, v in per_attr.items():
                    handlers[k] = copy.copy(v)
            except Exception:  # pragma: no cover - defensive
                # Unexpected handler-store shape; skip rather than crash.
                pass

    handlers_snapshot = _snapshot_handlers()

    ep.QUEUES.clear()
    # CR9 MEDIUM: clear our module-level ``_ALIAS_WARN_SEEN`` dedup set
    # alongside ``QUEUES`` so a prior test that observed an alias
    # divergence does not suppress the warning (and its log assertion)
    # in a later test.
    try:
        ep._ALIAS_WARN_SEEN.clear()
    except AttributeError:  # pragma: no cover - symbol removed in refactor
        pass
    # Reset singleton; the next test that calls ``add_crewai_*`` will
    # create a fresh FastAPICrewFlowEventListener. Also restore the
    # event-bus handlers from the pre-test snapshot so stale listeners
    # from prior tests don't keep firing and skewing queue counts
    # (R5 MEDIUM #10) — while leaving any pre-existing subscribers
    # from other libraries untouched (CR9 MEDIUM).
    ep.GLOBAL_EVENT_LISTENER = None
    _restore_handlers(handlers_snapshot)
    try:
        yield
    finally:
        ep.QUEUES.clear()
        try:
            ep._ALIAS_WARN_SEEN.clear()
        except AttributeError:  # pragma: no cover
            pass
        ep.GLOBAL_EVENT_LISTENER = None
        _restore_handlers(handlers_snapshot)
