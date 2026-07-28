"""
AG-UI FastAPI server for CrewAI.
"""
import asyncio
import logging
import re
import time
import uuid
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse

from ._env import _parse_env_float
from ._copyutil import safe_deepcopy

# CPK-7718: the flow/method lifecycle events, the event bus, and the listener
# base moved from ``crewai.utilities.events`` (crewai 0.x) to ``crewai.events``
# (crewai 1.x). ``_capabilities`` resolves whichever location exists and caches
# the crewai capability probe (run once at import).
from ._capabilities import (
    CAPABILITIES,
    FlowStartedEvent,
    FlowFinishedEvent,
    MethodExecutionStartedEvent,
    MethodExecutionFinishedEvent,
    BaseEventListener,
    crewai_event_bus,
)
from crewai.flow.flow import Flow

from ag_ui.core import (
    RunAgentInput,
    EventType,
    RunStartedEvent,
    RunFinishedEvent,
    RunErrorEvent,
    Message,
    Tool
)
from ag_ui.core.events import (
  TextMessageChunkEvent,
  ToolCallChunkEvent,
  StepStartedEvent,
  StepFinishedEvent,
  MessagesSnapshotEvent,
  StateSnapshotEvent,
  CustomEvent,
)
from ag_ui.encoder import EventEncoder

from .events import (
  BridgedTextMessageChunkEvent,
  BridgedToolCallChunkEvent,
  BridgedCustomEvent,
  BridgedStateSnapshotEvent
)
from .context import flow_context
from .sdk import litellm_messages_to_ag_ui_messages
from .crews import ChatWithCrewFlow, CrewBaseInstance

_LOGGER = logging.getLogger(__name__)

# Explicit ``__all__`` so ``from .endpoint import *`` only exposes the
# public surface (the FastAPI helpers + ``crewai_prepare_inputs``). Module
# sentinels like ``_UNSET`` and private helpers (``_cancel_and_join``,
# ``_run_flow_event_stream``, ``_flow_timeout_seconds`` …) already have
# leading underscores and would be excluded from star-imports, but
# pinning ``__all__`` makes the public contract documentation-grade
# (R5 LOW #20) so downstream consumers can rely on it.
#
# ``create_queue`` / ``get_queue`` / ``delete_queue`` are intentionally
# NOT exported (CR6-7 LOW #1): they are internal plumbing keyed by
# ``id(flow)`` and exposing them makes it look like downstream code may
# safely hook the queue lifecycle, which it cannot. Tests that need them
# import via ``ag_ui_crewai.endpoint`` by attribute access, which still
# works regardless of ``__all__``.
__all__ = [
    "add_crewai_flow_fastapi_endpoint",
    "add_crewai_crew_fastapi_endpoint",
    "crewai_prepare_inputs",
    "FastAPICrewFlowEventListener",
    "CrewBaseInstance",
]


# ``CrewBaseInstance`` (the structural type for a ``@CrewBase`` crew) now
# lives in ``crews.py`` alongside ``ChatWithCrewFlow`` — which also
# annotates its constructor with it — and is imported above. It stays in
# ``__all__`` so downstream callers keep importing it from
# ``ag_ui_crewai.endpoint`` (CPK-7717 review round 2, finding 2).

# Sentinel to distinguish "no item delivered" from a legitimate ``None``
# queue payload (the happy-path stream-end sentinel). Used by the
# cancel-race guard in ``_run_flow_event_stream`` (finding #1 HIGH H1)
# where an item may have been delivered to ``get_task`` between
# ``asyncio.wait`` returning and the ``finally`` clause cancelling it.
_UNSET = object()


class _KickoffCancelled(Exception):
    """Sentinel raised when the kickoff task is observed in the cancelled
    state via an external path (e.g. a cooperating task cancelled the
    ``kickoff_task`` out from under the generator).

    CR8 HIGH #2: pre-fix, when ``kickoff_task.done() and
    kickoff_task.cancelled()`` in the main-loop fast path, the code
    silently fell through (drained the queue and broke out), closing
    the stream with no ``RUN_ERROR`` event. Clients could not
    distinguish "flow finished successfully" from "flow was cancelled
    out from under us". Raising this sentinel from the fast path lets
    the error-handling block emit ``AGUI_CREWAI_KICKOFF_CANCELLED`` so
    the client gets a correlated, categorised error.
    """


class _CeilingExceeded(Exception):
    """Sentinel raised when our configured flow-ceiling deadline fires.

    Distinguishes the ceiling-fired path (our ``asyncio.wait`` / monotonic
    deadline produced the timeout) from an upstream ``TimeoutError`` that
    bubbled out of ``kickoff_async`` (e.g. a LiteLLM/httpx read timeout).

    CR7 CRITICAL: prior to this split, both paths emitted
    ``AGUI_CREWAI_FLOW_TIMEOUT`` with a "exceeded ceiling=..." message —
    which is correct for the ceiling-fired case but an outright lie for the
    upstream-timeout-with-ceiling-disabled case (the ceiling did not fire,
    an upstream read timeout did). Downstream log consumers and dashboards
    treat ``AGUI_CREWAI_FLOW_TIMEOUT`` as "we hit our configured ceiling",
    so conflating upstream failures under that code makes alerting lie.
    """

# Process-wide global registry of in-flight flow queues, keyed by a
# per-flow ``uuid.uuid4().hex`` stored on the flow as the
# ``_agui_queue_key`` attribute (CR8 MEDIUM). Writes are serialised via
# ``QUEUES_LOCK``; reads go through ``get_queue`` which relies on
# GIL-atomic ``dict.get`` (see ``get_queue`` for the full contract).
# Between tests this dict is cleared by the autouse
# ``_clear_endpoint_queues`` fixture in ``tests/conftest.py``.
#
# CR8 MEDIUM rationale: prior versions keyed by ``id(flow)``. CPython
# reuses ``id`` values aggressively once an object is garbage-collected,
# which left a theoretical (though hard to exploit) window where a
# late-arriving listener callback for a torn-down flow could route its
# event onto a NEW flow's queue whose ``id`` happened to match. UUID
# keys eliminate the collision concern entirely — each flow gets a
# fresh hex key that is never reused across the process lifetime.
QUEUES = {}
QUEUES_LOCK = asyncio.Lock()

# CPK-7718 breaking change #2: crewai 1.x no longer dispatches event-bus
# handlers inline on the caller's thread. Sync handlers (all of ours) are now
# submitted to a ThreadPoolExecutor; only ``LLMStreamChunkEvent`` keeps the
# inline path. Every ``Bridged*`` handler in
# ``FastAPICrewFlowEventListener.setup_listeners`` therefore runs on a WORKER
# thread and must reach the per-request ``asyncio.Queue`` via
# ``loop.call_soon_threadsafe`` — a bare ``put_nowait`` from off-loop corrupts
# the queue's getter-wakeup. We capture the request's running loop in
# ``create_queue`` (which is awaited on that loop) and stash it here, keyed by
# the same UUID as ``QUEUES``.
#
# NOTE (CPK-7719): the StreamFrame integration removes this listener entirely,
# so this loop-capture + call_soon_threadsafe plumbing is the INTERIM
# thread-safe fix, not the final design.
QUEUE_LOOPS: dict = {}

# Attribute name we set on flow objects to carry their per-request queue
# key. Module-level so tests and the listener callbacks share one
# source of truth.
_QUEUE_KEY_ATTR = "_agui_queue_key"

# Hard wall-clock ceiling on a single flow run. A runaway flow (e.g. a hung
# LiteLLM stream or an infinite loop in a user task) must not be able to pin
# the process indefinitely. Override via the ``AGUI_CREWAI_FLOW_TIMEOUT_SECONDS``
# environment variable; defaults to 10 minutes. Deployments with legitimately
# long-running crews should set the env var explicitly or use a non-positive
# value to disable the ceiling.
_DEFAULT_FLOW_TIMEOUT_SECONDS = 600.0

# When we see a FlowFinishedEvent the listener puts ``None`` on the queue
# *before* kickoff_async has actually returned. Give the task a short grace
# period to complete cleanly before we force-cancel it in _cancel_and_join.
# This grace window is drawn from the SHARED ``_cancel_join_timeout_seconds``
# teardown budget (finding #7): total upper bound on teardown from entry to
# ``_cancel_and_join`` is one ceiling window, not ``grace + join``.
_CANCEL_GRACE_SECONDS = 1.0

# If a cancelled task refuses to terminate within this window, log a warning
# so operators have visibility into stuck cancellations instead of a silent
# swallow. Default override-able via ``AGUI_CREWAI_CANCEL_JOIN_TIMEOUT_SECONDS``
# so operators can tune it under disconnect-heavy load (finding #8).
_CANCEL_JOIN_TIMEOUT_SECONDS = 10.0

# Caps on the happy-path drain (R5 HIGH #3). Unconditional
# ``_DRAIN_MAX_PASSES`` loop with an ``asyncio.sleep(0)`` between passes
# and a wall-clock ``_DRAIN_BUDGET_SECONDS`` ceiling that short-circuits
# the loop when the budget is exhausted mid-pass.
#
# CR8 LOW: hoisted from function scope to module scope alongside the
# other tuning constants so operators grepping for tunables find them
# all in one place.
_DRAIN_MAX_PASSES = 10
_DRAIN_BUDGET_SECONDS = 0.050

# Regex to sanitize exception class names before embedding them in a
# ``code`` field. Peer events' codes match ``^[A-Z][A-Z0-9_]+$``; a
# custom exception with dynamically-generated or unicode name (e.g.
# ``class WeirdError42(Exception): pass``) must be forced into that
# shape before going on the wire. CR8 MEDIUM.
_CODE_SANITIZE_RE = re.compile(r"[^A-Z0-9_]")


def _sanitize_exception_code(name: str) -> str:
    """Sanitize an exception class name for the ``code`` field.

    Peer events on this wire use ``^[A-Z][A-Z0-9_]+$`` codes. Exception
    class names may contain lowercase letters, digits, or even unicode
    (custom exceptions with dynamically-generated names are legal in
    Python). Upper-case the name and replace any character that is not
    an ASCII uppercase letter, digit, or underscore with ``_`` so the
    composed code stays greppable and regex-matchable by downstream
    alerting. CR8 MEDIUM.
    """
    sanitized = _CODE_SANITIZE_RE.sub("_", name.upper())
    # CR9 LOW: collapse runs of underscores into a single underscore
    # (a class name like ``weird exception`` would otherwise produce
    # ``WEIRD_EXCEPTION`` which is fine, but a unicode name like
    # ``ErrorXé`` sanitizes to ``ERRORX_`` and a name like ``Error__X``
    # would produce ``ERROR__X`` — collapse both consistently). Strip
    # leading/trailing underscores so the result respects the peer
    # convention. If the sanitized-and-stripped result is empty or does
    # NOT start with ``[A-Z]`` (e.g. the class name was digits-only or
    # all-unicode) prefix ``E_`` so the composed code still matches
    # ``^[A-Z][A-Z0-9_]+$``.
    sanitized = re.sub(r"_+", "_", sanitized).strip("_")
    if not sanitized or not sanitized[0].isascii() or not sanitized[0].isalpha():
        sanitized = f"E_{sanitized}" if sanitized else "E"
    return sanitized


def _stamp_correlation_ids(event: object, *, thread_id: str, run_id: str) -> None:
    """Stamp ``thread_id`` / ``run_id`` on ``event`` if the fields exist.

    CR9 MEDIUM: the main-loop previously only rewrote these ids on
    ``RUN_STARTED`` / ``RUN_FINISHED`` — any future ag-ui.core event
    that also carries thread/run correlation (e.g. RUN_ERROR on the
    error path) would ship the listener's ``"?"`` placeholders unless
    stamped here. Rather than enumerate event types, probe attributes
    with ``hasattr`` so new correlated events are covered automatically.
    Events without these fields (StepStartedEvent, MessagesSnapshotEvent,
    etc.) are left untouched — they do not carry correlation on the
    wire today. Model ``__setattr__`` on Pydantic events is allowed by
    ``model_config`` (no frozen).
    """
    if hasattr(event, "thread_id"):
        try:
            event.thread_id = thread_id
        except (AttributeError, ValueError):  # pragma: no cover - defensive
            pass
    if hasattr(event, "run_id"):
        try:
            event.run_id = run_id
        except (AttributeError, ValueError):  # pragma: no cover - defensive
            pass


def _flow_timeout_seconds() -> float | None:
    """Return the configured flow-execution ceiling in seconds.

    A non-positive value (e.g. ``0`` or ``-1``) disables the ceiling. A
    NaN or any other non-finite value is treated as unparseable and falls
    back to the default — ``float('nan') > 0`` is False, which would
    otherwise silently disable the ceiling (finding #17).
    """
    return _parse_env_float(
        "AGUI_CREWAI_FLOW_TIMEOUT_SECONDS",
        _DEFAULT_FLOW_TIMEOUT_SECONDS,
        allow_disable=True,
    )


def _cancel_join_timeout_seconds() -> float:
    """Return the configured cancel-and-join teardown ceiling in seconds.

    Exists so that operators running disconnect-heavy workloads can tune
    the per-request teardown window via
    ``AGUI_CREWAI_CANCEL_JOIN_TIMEOUT_SECONDS`` without redeploying code
    (finding #8). Non-finite or non-positive values fall back to the
    conservative default so a fat-fingered env var cannot disable the
    ceiling entirely.

    Intentional divergence from the flow-timeout / LLM-timeout helpers
    (CR7 LOW): those helpers treat ``<=0`` as "disable the ceiling" and
    return ``None``. Cancel-join MUST always have a bounded positive
    value — disabling it would make teardown able to block indefinitely
    and break client-disconnect semantics, so the safer fallback here
    is to silently use the default rather than surface a ``None`` that
    the caller would then have to defend against at every use site.
    """
    result = _parse_env_float(
        "AGUI_CREWAI_CANCEL_JOIN_TIMEOUT_SECONDS",
        _CANCEL_JOIN_TIMEOUT_SECONDS,
        allow_disable=False,
    )
    # ``allow_disable=False`` guarantees a non-None return, but the
    # signature of ``_parse_env_float`` is ``float | None`` — narrow
    # here so callers can use the float without a type assertion.
    # CR8 LOW: ``assert`` is stripped under ``python -O``; use an
    # explicit defensive guard that collapses to the default on the
    # (impossible) None path rather than silently returning None to
    # the caller under -O. CR9 LOW: kept (not removed) — this is an
    # assertion-in-code-form. ``allow_disable=False`` guarantees
    # non-None today, but a future refactor that widens the contract
    # (or that introduces a fallback branch that returns None) would
    # fall through to this guard rather than propagate ``None`` to
    # every call site. Cheaper to keep than to audit every caller
    # again.
    if result is None:  # pragma: no cover - defensive; allow_disable=False guarantees non-None today
        return _CANCEL_JOIN_TIMEOUT_SECONDS
    return result


async def _cancel_and_join(
    task: asyncio.Task | None,
    *,
    thread_id: str | None = None,
    run_id: str | None = None,
    allow_grace: bool = True,
) -> None:
    """Cancel ``task`` and await its completion, letting CancelledError propagate.

    Used in the ``finally`` block of the event generators so that a client
    disconnect (which closes the generator) tears down the kickoff coroutine
    instead of leaking it.

    Semantics:
    - A SINGLE shared monotonic deadline (``_cancel_join_timeout_seconds``)
      bounds the combined wait of (grace window + force-cancel join +
      outer-cancel recovery). There is one ceiling window for the entire
      teardown, not three (finding #7).
    - If ``allow_grace`` and the task is mid-flight on a happy path, wait up
      to ``min(_CANCEL_GRACE_SECONDS, remaining-budget)`` for it to finish
      on its own (the FlowFinishedEvent listener enqueues ``None``
      microseconds before ``kickoff_async`` actually returns). A quick
      ``sleep(0)`` + ``task.done()`` probe fast-paths the common case where
      the task is microseconds from returning, so happy-path requests do
      NOT systematically pay the 1s grace latency tax (finding #9).
    - The grace wait is SHIELDED and protected by the same outer-cancel
      recovery pattern used post-grace (finding #5). If the caller is
      cancelled during the grace wait, ``task.cancel()`` still fires via
      the ``finally`` and the task is cleanly unwound within the remaining
      budget; we don't leave a cancelled-but-unjoined task behind.
    - We deliberately do NOT catch ``BaseException``. ``SystemExit`` /
      ``KeyboardInterrupt`` / ``CancelledError`` must propagate; we only
      swallow ``TimeoutError`` (explicitly) and recoverable ``Exception``
      subclasses from the task itself.
    - On Python 3.11+, catching ``CancelledError`` does NOT decrement
      ``Task.cancelling()``: any subsequent ``await`` re-raises immediately
      unless we call ``asyncio.current_task().uncancel()``. Without that,
      the bounded recovery wait in the CancelledError branch is defeated
      (re-raises on entry). We invoke ``uncancel`` via ``getattr`` so the
      implementation remains compatible with 3.10 (where the method does
      not exist).
    """
    if task is None:
        return
    if task.done():
        # CR8 LOW: if the task is already done with a stored exception
        # (e.g. kickoff raised before the generator reached this
        # teardown path), defensively call ``.exception()`` so the
        # exception is marked retrieved and does NOT surface as a
        # "Task exception was never retrieved" GC warning. ``.exception()``
        # is only safe on a non-cancelled done task.
        if not task.cancelled():
            try:
                task.exception()
            except Exception:  # noqa: BLE001 - defensive
                pass
        return

    # Shared monotonic deadline covering the ENTIRE teardown — grace
    # window, force-cancel join, and outer-cancel recovery (finding #7).
    ceiling = _cancel_join_timeout_seconds()
    deadline = time.monotonic() + ceiling

    def _remaining() -> float:
        return max(0.0, deadline - time.monotonic())

    try:
        if allow_grace:
            # Fast-path probe (finding #9): let the task advance a tick
            # before paying the 1s grace wait. The common case is that
            # ``kickoff_async`` is microseconds from returning once the
            # listener has enqueued the ``None`` sentinel; yielding once
            # usually lets the task complete without blocking.
            await asyncio.sleep(0)
            if task.done():
                return

            # Grace period for happy-path completion. ``shield`` keeps the
            # task alive if our wait_for is itself cancelled. Note (3.10
            # compatibility): ``asyncio.TimeoutError`` is aliased to the
            # builtin ``TimeoutError`` on 3.11+, but the dual tuple is
            # load-bearing on 3.10 where they are distinct classes.
            grace_budget = min(_CANCEL_GRACE_SECONDS, _remaining())
            if grace_budget > 0:
                try:
                    await asyncio.wait_for(
                        asyncio.shield(task), timeout=grace_budget
                    )
                    return
                except (asyncio.TimeoutError, TimeoutError):
                    # Happy path did not complete in time; fall through to
                    # force-cancel below.
                    #
                    # CR8 MEDIUM: emit a debug log before silently
                    # falling through so operators diagnosing stuck
                    # teardown see a signal at the grace-expired
                    # boundary (other branches in this function log;
                    # this one was the only silent fall-through).
                    _LOGGER.debug(
                        "CrewAI kickoff grace window expired "
                        "thread=%s run=%s grace=%gs; "
                        "proceeding to force-cancel",
                        thread_id,
                        run_id,
                        grace_budget,
                    )
                except asyncio.CancelledError as grace_outer_cancel:
                    # Outer-cancel during the grace wait. Mirror the
                    # post-grace recovery pattern (finding #5): ensure
                    # task.cancel() fires within the remaining budget and
                    # await its unwind so we do not leave a
                    # cancelled-but-unjoined task behind.
                    #
                    # R5 HIGH #2: capture the CancelledError *instance* so
                    # we can re-raise it with ``.args`` and traceback
                    # intact. Raising the bare class (``raise
                    # asyncio.CancelledError``) loses the message and the
                    # chained traceback of the original cancel.
                    current = asyncio.current_task()
                    uncancel = getattr(current, "uncancel", None)
                    if callable(uncancel):
                        uncancel()
                    grace_teardown: asyncio.Future | None = None
                    # CR7 LOW (retrieve task exception): if the task
                    # happened to complete during the grace wait we
                    # skip the teardown/drain path entirely; defensively
                    # call ``task.exception()`` so a stored exception
                    # is marked retrieved and does NOT surface as a GC
                    # "Task exception was never retrieved" warning when
                    # we re-raise below. ``exception()`` is only safe
                    # on a non-cancelled done task.
                    if task.done() and not task.cancelled():
                        try:
                            task.exception()
                        except Exception:  # noqa: BLE001 - defensive
                            pass
                    if not task.done():
                        task.cancel()
                        grace_teardown = asyncio.ensure_future(
                            asyncio.wait_for(
                                asyncio.gather(task, return_exceptions=True),
                                timeout=_remaining(),
                            )
                        )
                        # CR9 MEDIUM: if the recovery wait below times
                        # out and we re-raise ``grace_outer_cancel``,
                        # the stored ``TimeoutError`` on ``grace_teardown``
                        # is never retrieved by anyone and the GC logs
                        # ``Task exception was never retrieved``. Attach
                        # a done-callback that drains the stored
                        # exception so the future is left clean regardless
                        # of the code path we exit through.
                        grace_teardown.add_done_callback(
                            lambda f: f.exception() if not f.cancelled() else None
                        )
                        try:
                            await asyncio.shield(grace_teardown)
                        except (asyncio.TimeoutError, TimeoutError):
                            _log_stuck_cancel(
                                thread_id,
                                run_id,
                                after_outer_cancel=True,
                                ceiling=ceiling,
                            )
                        except asyncio.CancelledError:
                            # Recovery wait itself cancelled. The inner
                            # ``asyncio.gather(task, return_exceptions=True)``
                            # already swallows any task exception into
                            # its result list, so there is nothing to
                            # "drain" from ``grace_teardown.exception()``
                            # (CR8 MEDIUM — the prior drain log never
                            # fired with a useful value; removed). Just
                            # propagate the outer cancel.
                            raise
                        # CR8 MEDIUM: no exception-drain log on normal
                        # completion either — ``gather(return_exceptions=True)``
                        # has already retrieved any task exception into
                        # its result list, so ``grace_teardown.exception()``
                        # here is always ``None`` / a bare TimeoutError
                        # from ``wait_for`` (already handled above).
                    # Re-raise the ORIGINAL outer cancel instance so args
                    # and traceback propagate intact (R5 HIGH #2).
                    raise grace_outer_cancel
                except Exception as grace_exc:  # pylint: disable=broad-exception-caught
                    # The task itself raised during the grace wait. It has
                    # finished — nothing left to clean up. Log the
                    # exception rather than silently swallowing it so that
                    # operators can diagnose teardown surprises.
                    if task.done():
                        return
                    # Unusual ordering: log loudly and fall through to
                    # force-cancel.
                    _LOGGER.warning(
                        "CrewAI grace-period wait raised a non-Timeout error "
                        "while task is not done; proceeding to force-cancel "
                        "thread=%s run=%s cause=%s",
                        thread_id,
                        run_id,
                        type(grace_exc).__name__,
                    )

        if task.done():
            return

        # Force-cancel from here on out; the finally clause guarantees
        # task.cancel() runs exactly once even if we are cancelled mid-flight.
        task.cancel()

        # Build a teardown coroutine and shield it so outer cancellation
        # cannot abandon the task mid-teardown. We want resources (httpx
        # clients, file descriptors, LLM subscriptions) to actually unwind.
        teardown = asyncio.ensure_future(
            asyncio.wait_for(
                asyncio.gather(task, return_exceptions=True),
                timeout=_remaining(),
            )
        )
        # CR9 MEDIUM: if the recovery wait below times out and we
        # re-raise ``outer_cancel``, the stored ``TimeoutError`` on
        # ``teardown`` is never retrieved by anyone and the GC logs
        # ``Task exception was never retrieved``. Attach a done-callback
        # that drains the stored exception so the future is left clean
        # regardless of the code path we exit through.
        teardown.add_done_callback(
            lambda f: f.exception() if not f.cancelled() else None
        )
        try:
            await asyncio.shield(teardown)
        except asyncio.CancelledError as outer_cancel:
            # Outer scope was cancelled. On Python 3.11+, we must uncancel
            # the current task before issuing another ``await`` — otherwise
            # the next ``await`` re-raises CancelledError immediately and
            # the bounded recovery wait is a no-op (finding #2).
            current = asyncio.current_task()
            uncancel = getattr(current, "uncancel", None)
            if callable(uncancel):
                uncancel()
            try:
                await asyncio.wait_for(
                    asyncio.shield(teardown),
                    timeout=_remaining(),
                )
            except (asyncio.TimeoutError, TimeoutError):
                _log_stuck_cancel(
                    thread_id,
                    run_id,
                    after_outer_cancel=True,
                    ceiling=ceiling,
                )
            except Exception as recov_exc:  # pylint: disable=broad-exception-caught
                # A non-timeout, non-cancel error surfaced from the
                # recovery wait; surface it in DEBUG logs rather than
                # swallowing silently (finding #10).
                _LOGGER.debug(
                    "CrewAI cancel-recovery wait swallowed %s "
                    "(thread=%s run=%s)",
                    type(recov_exc).__name__,
                    thread_id,
                    run_id,
                )
            # CR8 MEDIUM: the prior ``_drain`` callback on ``teardown``
            # was effectively dead code. ``asyncio.gather(task,
            # return_exceptions=True)`` already swallows ``task``'s
            # exception into its result list, so ``teardown.exception()``
            # here only surfaces a ``TimeoutError`` from ``wait_for``
            # (already handled above) or ``None``. Nothing to drain.
            # Re-raise the original CancelledError so traceback and
            # ``.args`` context propagate intact to the outer scope
            # (finding #14). A bare ``raise`` would reference ``outer_cancel``
            # via the active handler; using the captured name is explicit.
            raise outer_cancel
        except (asyncio.TimeoutError, TimeoutError):
            _log_stuck_cancel(
                thread_id,
                run_id,
                after_outer_cancel=False,
                ceiling=ceiling,
            )
    finally:
        # Last-ditch: if the task is still running (e.g. we were cancelled
        # before reaching ``task.cancel()`` above), schedule cancellation
        # so we don't leak a running kickoff_async. ``Task.cancel()`` is
        # idempotent on a done task, so the pre-R5 ``cancellation_scheduled``
        # guard was redundant with ``task.done()`` — simplified per R5 LOW
        # #15.
        if task is not None and not task.done():
            task.cancel()


def _log_stuck_cancel(
    thread_id: str | None,
    run_id: str | None,
    *,
    after_outer_cancel: bool,
    ceiling: float,
) -> None:
    """Emit a single consolidated warning when a cancelled task won't terminate.

    Centralised so the message format, fields, and distinguishing context are
    identical at both call sites.

    ``ceiling`` is passed explicitly rather than re-read from the env
    (R5 MEDIUM #7) so the logged value matches the deadline that actually
    governed this teardown — an operator who flips
    ``AGUI_CREWAI_CANCEL_JOIN_TIMEOUT_SECONDS`` mid-request will still see
    the ceiling that was in effect for the stuck task.
    """
    suffix = " (after outer cancel)" if after_outer_cancel else ""
    # %g matches _format_timeout_message (R5 LOW #13) so grep/alerting
    # patterns that compare the two numeric formats don't have to special
    # case trailing zeros.
    _LOGGER.warning(
        "CrewAI kickoff task did not terminate within %gs of cancel%s"
        " thread=%s run=%s",
        ceiling,
        suffix,
        thread_id,
        run_id,
    )


async def create_queue(flow: object) -> asyncio.Queue:
    """Create a queue for a flow and stamp the flow with its UUID key.

    CR8 MEDIUM: keys are ``uuid.uuid4().hex`` rather than ``id(flow)``
    so the registry cannot suffer from id-reuse collisions after a flow
    is garbage-collected. The key is stored on the flow as
    ``_agui_queue_key`` so listener callbacks that receive a flow via
    the event bus can look up the queue without threading the key
    through another side channel.
    """
    queue_key = uuid.uuid4().hex
    # CR9 LOW: register the queue in the module-level mapping BEFORE
    # stamping the key on the flow. The pre-fix order (stamp first,
    # then lock+insert) left a window — however small — where
    # ``get_queue(flow)`` could observe the attribute and then miss
    # the (not-yet-inserted) key in ``QUEUES``, returning ``None``
    # and silently dropping an event. Reversing the order closes the
    # window: the flow is not visible as "has a queue key" until
    # there is a queue to look up.
    # ``setattr`` rather than direct ``flow._agui_queue_key = ...`` so
    # pylint / type-checkers don't flag the private-attribute write on
    # an arbitrary ``object``; crewai ``Flow`` instances accept
    # arbitrary attribute writes but the static-typing path must stay
    # clean.
    # Capture the request's running loop so off-thread listener callbacks can
    # enqueue via ``loop.call_soon_threadsafe`` (CPK-7718 #2). ``create_queue``
    # is always awaited on the request loop, so this is that loop.
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:  # pragma: no cover - create_queue is always awaited
        loop = None
    async with QUEUES_LOCK:
        queue = asyncio.Queue()
        QUEUES[queue_key] = queue
        QUEUE_LOOPS[queue_key] = loop
        # Stamp only AFTER the queue is registered under its key so
        # a concurrent ``get_queue(flow)`` never observes the attr
        # pointing at a not-yet-present entry.
        #
        # CPK-7718 #8: crewai 1.13+ made ``Flow`` a Pydantic ``BaseModel``.
        # Try a normal ``setattr`` first (it honours any custom
        # ``__setattr__`` — some callers/tests instrument the write — and works
        # on crewai 1.15.x, which accepts our underscore-prefixed key); if a
        # stricter Pydantic ``Flow`` rejects the undeclared attribute, fall back
        # to ``object.__setattr__`` which bypasses Pydantic entirely. Either
        # way the key lands in the instance ``__dict__`` and reads back via
        # plain ``getattr`` (see ``get_queue``).
        try:
            setattr(flow, _QUEUE_KEY_ATTR, queue_key)
        except (ValueError, AttributeError, TypeError):
            object.__setattr__(flow, _QUEUE_KEY_ATTR, queue_key)
        return queue


def get_queue(flow: object) -> asyncio.Queue | None:
    """Get the queue for a flow.

    CR6-7 MEDIUM: ``QUEUES_LOCK`` is intentionally NOT taken here.

    Contract:
    * ``QUEUES`` is a plain ``dict`` keyed by the per-flow UUID hex
      stored on the flow as ``_agui_queue_key`` (CR8 MEDIUM). CPython's
      GIL makes ``dict.get(k)`` atomic at the bytecode level — we
      cannot observe a half-constructed mapping. CR7 LOW: this assumes
      a CPython-with-GIL interpreter. Free-threaded CPython 3.13+ (PEP
      703, opt-in ``--disable-gil``) removes the bytecode-atomicity
      guarantee and would require wrapping the read in a
      ``threading.Lock`` (or migrating ``QUEUES`` to a thread-safe
      mapping). This is forward-compat documentation only — the module
      does not ship free-thread support today.
    * CR7 MEDIUM (threading model): crewai's ``CrewAIEventsBus`` emits
      listener callbacks SYNCHRONOUSLY from whatever call stack raised
      the event. In our code path the events are raised from within
      ``kickoff_async`` — which we ``await`` on the event loop — so in
      practice listeners always run on the loop thread. The prior
      docstring warned callers that callbacks may run from a non-loop
      thread, which implied ``queue.put_nowait`` in the listener
      callbacks was unsafe. That warning was conservative to the point
      of being misleading: in the current architecture every listener
      callback fires on the loop thread, so ``put_nowait`` is the right
      primitive. If crewai ever invokes the bus from a worker thread
      (e.g. a future background-executor feature), every ``put_nowait``
      call site in ``FastAPICrewFlowEventListener.setup_listeners`` must
      be revisited and converted to ``loop.call_soon_threadsafe`` — but
      there is no such path today.
    * This function is called from TWO contexts:
      (a) Synchronous crewai event-listener callbacks. Those run on the
          event loop thread (see threading model note above), but via
          synchronous call stacks where we cannot ``await`` — hence no
          ``QUEUES_LOCK`` acquisition.
      (b) The async endpoint code paths, which always take
          ``QUEUES_LOCK`` for writes (``create_queue``, ``delete_queue``)
          but not reads.
    * The one race that remains is SEMANTIC rather than data-structural:
      a late listener callback that fires after ``delete_queue`` has
      removed the entry will observe ``None`` and silently no-op. This
      is the intended behaviour — an event for a torn-down flow has
      nowhere to land. The ``_cancel_and_join`` teardown widens the
      window during which late callbacks can arrive after delete, but
      does not change the semantics: late events were already lost on
      the happy-path, and continue to be lost here.
    * A flow that was never registered with ``create_queue`` (e.g. a
      listener callback routed to an unrelated Flow) will not carry
      the ``_agui_queue_key`` attribute; we default to ``None`` and
      the ``get`` returns ``None`` as intended.
    """
    queue_key = getattr(flow, _QUEUE_KEY_ATTR, None)
    if queue_key is None:
        return None
    return QUEUES.get(queue_key)


def _get_queue_loop(flow: object) -> "asyncio.AbstractEventLoop | None":
    """Return the request loop captured for ``flow`` in ``create_queue``.

    Mirrors ``get_queue``'s lock-free contract (GIL-atomic ``dict.get``): the
    off-thread listener callbacks read it without acquiring ``QUEUES_LOCK``.
    """
    queue_key = getattr(flow, _QUEUE_KEY_ATTR, None)
    if queue_key is None:
        return None
    return QUEUE_LOOPS.get(queue_key)


def _enqueue(source: object, event: object) -> None:
    """Thread-safely enqueue ``event`` onto ``source``'s per-request queue.

    CPK-7718 #2: crewai 1.x dispatches our sync bus handlers on a
    ThreadPoolExecutor worker thread, so a bare ``queue.put_nowait`` would run
    off the queue's owning loop and corrupt the getter-wakeup. We hop back onto
    the captured request loop via ``call_soon_threadsafe``. If we happen to
    already be on that loop (e.g. a future inline-dispatch path, or a unit test
    driving the listener directly on the loop thread) we put directly to keep
    behaviour synchronous. If no loop was captured, fall back to a direct put.
    """
    queue = get_queue(source)
    if queue is None:
        return
    loop = _get_queue_loop(source)
    if loop is None:
        queue.put_nowait(event)
        return
    try:
        running = asyncio.get_running_loop()
    except RuntimeError:
        running = None
    if running is loop:
        queue.put_nowait(event)
    else:
        loop.call_soon_threadsafe(queue.put_nowait, event)


async def delete_queue(flow: object) -> None:
    """Delete the queue for a flow."""
    queue_key = getattr(flow, _QUEUE_KEY_ATTR, None)
    if queue_key is None:
        return
    async with QUEUES_LOCK:
        QUEUES.pop(queue_key, None)
        QUEUE_LOOPS.pop(queue_key, None)


# How long the run-end event-bus flush may block (seconds). crewai 1.x can drop
# in-flight off-thread handlers at run end; ``flush`` waits for them. Bounded so
# a stuck handler cannot pin teardown. Overridable for operators tuning
# disconnect-heavy load (mirrors the other AGUI_CREWAI_* knobs' spirit).
_EVENT_BUS_FLUSH_TIMEOUT = 5.0


def _copy_flow(flow: object) -> object:
    """Return a per-request isolated copy of ``flow``.

    Delegates to ``_copyutil.safe_deepcopy`` — plain ``copy.deepcopy`` on
    healthy crewai builds, pin-and-share fallback on the crewai 1.15.x
    ``Flow`` deep-copy bug (CPK-7718 #10, a NEW breaking change beyond the
    enumerated nine, found by running the suite on the 1.15.7 wheel). Isolation
    of the per-request conversation state is preserved either way.
    """
    return safe_deepcopy(flow, what="flow")


async def _flush_event_bus() -> None:
    """Best-effort run-end flush of the crewai event bus (CPK-7718 #5).

    crewai 1.x dispatches sync handlers off-thread and can drop in-flight
    handlers at run end; ``flush(timeout=...)`` waits for them so resources
    unwind and our late listener callbacks settle before the queue/context are
    torn down. No-op on crewai builds without ``flush`` (0.x). Run in the
    default executor so the bounded blocking wait does not stall the request
    loop, and swallow failures — this is hygiene, not correctness-critical.
    """
    if not CAPABILITIES.event_bus_has_flush:
        return
    flush = getattr(crewai_event_bus, "flush", None)
    if not callable(flush):
        return
    try:
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(
            None, lambda: flush(_EVENT_BUS_FLUSH_TIMEOUT)
        )
    except Exception as exc:  # noqa: BLE001 - flush is best-effort
        _LOGGER.debug(
            "ag-ui-crewai event-bus flush at run end failed: %s",
            type(exc).__name__,
        )


GLOBAL_EVENT_LISTENER = None

class FastAPICrewFlowEventListener(BaseEventListener):
    """FastAPI CrewFlow event listener.

    WARNING (CR8 MEDIUM): do NOT construct this class directly in
    application code. ``add_crewai_flow_fastapi_endpoint`` and
    ``add_crewai_crew_fastapi_endpoint`` auto-instantiate a process-wide
    singleton the first time either is called; constructing a second
    instance manually (and then calling a factory) registers DUPLICATE
    listeners on the crewai global event bus, which then enqueues every
    event TWICE onto the per-flow queues and doubles the wire output.

    The class remains in ``__all__`` for introspection / type-hinting
    in downstream code (some callers legitimately want to reference
    the listener instance via ``ag_ui_crewai.endpoint.GLOBAL_EVENT_LISTENER``),
    but direct construction is not a supported usage pattern.
    """

    def setup_listeners(self, crewai_event_bus):
        """Setup listeners for the FastAPI CrewFlow event listener.

        CPK-7718 #2: every callback below runs on a ThreadPoolExecutor WORKER
        thread under crewai 1.x (sync handlers are no longer dispatched inline
        on the caller's thread). All queue writes therefore go through
        ``_enqueue``, which hops back onto the request loop via
        ``call_soon_threadsafe``. The ``None`` happy-path sentinel is enqueued
        the same way so it stays ordered behind the ``RUN_FINISHED`` event on
        the loop.

        CPK-7718 #3: crewai 1.x dispatch is now EXACT-TYPE (keyed on
        ``type(event)``), not ``isinstance`` — a handler registered on a base
        class silently stops receiving subclasses. Every ``.on(...)`` below is
        registered on the EXACT event type we emit / crewai emits (the
        lifecycle events and our concrete ``Bridged*`` classes), so exact-type
        dispatch delivers to each handler as before. No handler is registered
        on a shared base class.
        """
        @crewai_event_bus.on(FlowStartedEvent)
        def _(source, event):  # pylint: disable=unused-argument
            _enqueue(
                source,
                RunStartedEvent(
                    type=EventType.RUN_STARTED,
                    # will be replaced by the correct thread_id/run_id when sending the event
                    thread_id="?",
                    run_id="?",
                ),
            )
        @crewai_event_bus.on(FlowFinishedEvent)
        def _(source, event):  # pylint: disable=unused-argument
            _enqueue(
                source,
                RunFinishedEvent(
                    type=EventType.RUN_FINISHED,
                    thread_id="?",
                    run_id="?",
                ),
            )
            _enqueue(source, None)
        @crewai_event_bus.on(MethodExecutionStartedEvent)
        def _(source, event):
            _enqueue(
                source,
                StepStartedEvent(
                    type=EventType.STEP_STARTED,
                    step_name=event.method_name
                )
            )
        @crewai_event_bus.on(MethodExecutionFinishedEvent)
        def _(source, event):
            if get_queue(source) is None:
                return
            # source.state may be a Pydantic model (with .messages attr) or a plain dict
            state = source.state
            raw_messages = getattr(state, "messages", None) or (state.get("messages") if isinstance(state, dict) else None) or []
            messages = litellm_messages_to_ag_ui_messages(raw_messages)

            _enqueue(
                source,
                MessagesSnapshotEvent(
                    type=EventType.MESSAGES_SNAPSHOT,
                    messages=messages
                )
            )
            _enqueue(
                source,
                StateSnapshotEvent(
                    type=EventType.STATE_SNAPSHOT,
                    snapshot=state if isinstance(state, dict) else state.model_dump() if hasattr(state, "model_dump") else {}
                )
            )
            _enqueue(
                source,
                StepFinishedEvent(
                    type=EventType.STEP_FINISHED,
                    step_name=event.method_name
                )
            )
        @crewai_event_bus.on(BridgedTextMessageChunkEvent)
        def _(source, event):
            _enqueue(
                source,
                TextMessageChunkEvent(
                    type=EventType.TEXT_MESSAGE_CHUNK,
                    message_id=event.message_id,
                    role=event.role,
                    delta=event.delta,
                )
            )
        @crewai_event_bus.on(BridgedToolCallChunkEvent)
        def _(source, event):
            _enqueue(
                source,
                ToolCallChunkEvent(
                    type=EventType.TOOL_CALL_CHUNK,
                    tool_call_id=event.tool_call_id,
                    tool_call_name=event.tool_call_name,
                    delta=event.delta,
                )
            )
        @crewai_event_bus.on(BridgedCustomEvent)
        def _(source, event):
            _enqueue(
                source,
                CustomEvent(
                    type=EventType.CUSTOM,
                    name=event.name,
                    value=event.value
                )
            )
        @crewai_event_bus.on(BridgedStateSnapshotEvent)
        def _(source, event):
            _enqueue(
                source,
                StateSnapshotEvent(
                    type=EventType.STATE_SNAPSHOT,
                    snapshot=event.snapshot
                )
            )


def _format_timeout_message(timeout: float | None) -> str:
    """Build the ``TimeoutError`` message for the flow-ceiling path.

    Extracted (finding #13) so the two TimeoutError construction sites and
    the client-facing error message derive from a single source of truth.

    ``timeout`` is always a finite positive value here — the flow-ceiling
    code paths that raise ``TimeoutError`` are guarded by ``timeout is not
    None``. Using ``%g`` (up to 6 significant digits, no trailing zeros)
    avoids the truncation of sub-decisecond values that ``%.1f`` produces
    (finding #14). For ``0.2``, ``%g`` renders ``0.2``; for ``0.25``,
    ``0.25``; for ``600``, ``600``.
    """
    return f"CrewAI flow exceeded {timeout:g}s ceiling"


# Per-alias WARN dedup (CR7 MEDIUM): ``_field_alias`` previously claimed
# "Emit a single WARN" but fired on every call, producing per-event log
# spam under a misconfigured ag-ui.core upgrade. Track ``(model_name,
# field_name)`` tuples that have already warned so the log stays
# actionable (one line per divergence) rather than noise.
_ALIAS_WARN_SEEN: set[tuple[str, str]] = set()


def _field_alias(model_cls, field_name: str, default: str) -> str:
    """Return the serialization alias for ``field_name`` on ``model_cls``.

    Pydantic models in ag-ui.core set camelCase aliases via an alias
    generator; we derive the wire name here so a future rename of the
    alias policy propagates automatically (finding #30) instead of
    silently diverging from this module's hardcoded camelCase literals.
    Falls back to ``default`` if the model does not declare the field
    (keeps the code path stable under library upgrades).

    R5 LOW #16 / CR7 MEDIUM: if BOTH ``serialization_alias`` and
    ``alias`` are ``None`` on an existing field, that almost certainly
    means Pydantic internals changed and our alias inference is
    silently wrong. Emit ONE WARN per (model, field) tuple (tracked in
    the module-level ``_ALIAS_WARN_SEEN`` set) so the divergence is
    visible in the log without spamming a line per request / per event.
    """
    try:
        field = model_cls.model_fields[field_name]
    except (AttributeError, KeyError):
        return default
    # Pydantic v2 exposes the alias either as ``alias`` (explicit) or via
    # ``serialization_alias``; prefer the latter if set.
    serialization_alias = getattr(field, "serialization_alias", None)
    basic_alias = getattr(field, "alias", None)
    # CR8 LOW: use an explicit None check rather than ``or`` so an empty
    # string (legal, if unusual) on ``serialization_alias`` does not
    # silently fall through to ``basic_alias``.
    alias = (
        serialization_alias
        if serialization_alias is not None
        else basic_alias
    )
    if alias is None:
        model_name = getattr(model_cls, "__name__", str(model_cls))
        dedup_key = (model_name, field_name)
        if dedup_key not in _ALIAS_WARN_SEEN:
            _ALIAS_WARN_SEEN.add(dedup_key)
            _LOGGER.warning(
                "ag-ui-crewai could not infer a serialization alias for "
                "%s.%s; both serialization_alias and alias were None — this "
                "usually indicates Pydantic internals changed. Falling back "
                "to hardcoded default=%r (further occurrences for this "
                "(model, field) will be silenced).",
                model_name,
                field_name,
                default,
            )
        return default
    return alias


def _run_error_extras(input_data: RunAgentInput) -> dict:
    """Return the extras kwargs for a RunErrorEvent, camelCased to match
    peer events' wire format.

    ``ConfiguredBaseModel`` uses ``extra="allow"`` — extras bypass the
    alias generator, so pre-camelCased keys are required to line up with
    declared-field peers (``RunStartedEvent.thread_id`` / ``run_id`` emit
    as ``threadId`` / ``runId`` via the alias generator). Finding #3.

    The alias names are derived from ``RunStartedEvent.model_fields``
    (finding #30) so a rename of the alias policy in ag-ui.core does not
    silently regress this module.

    LOAD-BEARING ASSUMPTION (CR6-7 LOW #2): ``RunStartedEvent`` and
    ``RunErrorEvent`` share the same alias-generator policy (both derive
    from ``ConfiguredBaseModel`` in ag-ui.core). We derive the alias
    names from ``RunStartedEvent.model_fields`` and apply them to
    ``RunErrorEvent`` extras on the premise that the wire name for
    ``thread_id`` / ``run_id`` is IDENTICAL across the two models. If
    ag-ui.core ever splits the alias policy per-model (e.g. a future
    event keeps ``thread_id`` snake_case), this derivation silently
    diverges: extras on ``RunErrorEvent`` would be camelCased while the
    declared fields on the same event would not. The failure mode is
    subtle (wire format mismatch, not a crash) so verifying the shared
    policy at test time is the right escalation point rather than
    asserting it dynamically here.
    """
    thread_alias = _field_alias(RunStartedEvent, "thread_id", "threadId")
    run_alias = _field_alias(RunStartedEvent, "run_id", "runId")
    return {
        thread_alias: input_data.thread_id,
        run_alias: input_data.run_id,
    }


async def _run_flow_event_stream(
    *,
    flow_copy: object,
    encoder: EventEncoder,
    input_data: RunAgentInput,
    inputs: dict,
    timeout: float | None,
):
    """Drive a single flow kickoff and yield encoded AG-UI events.

    Extracted from the flow and crew endpoints so they share identical
    cancellation, timeout, and error-reporting semantics. The generator:

    * spawns ``kickoff_async`` as a task (kept in scope so it can be torn
      down on client disconnect);
    * reads from the per-flow queue with a wall-clock deadline;
    * surfaces timeouts and other exceptions as a ``RunErrorEvent`` whose
      ``message`` carries thread/run correlation AND whose event-level
      extras (``threadId`` / ``runId``) mirror the peer events' wire
      format (finding #3);
    * on exit, cancels the kickoff task, drops the queue, and resets the
      context var — unconditionally, even if the outer scope is cancelled.
    """
    # CR7 MEDIUM (resource leak): ``create_queue`` registers an entry in
    # the module-level ``QUEUES`` mapping keyed by ``id(flow_copy)``. If
    # ``flow_context.set`` raises between ``create_queue`` and the main
    # ``try:`` block, the registered queue is orphaned — nothing deletes
    # it, and the next request whose ``id(flow)`` collides inherits a
    # stale reference. Wrap both in a narrow ``try/except`` that
    # ``delete_queue``'s on failure so the registration is symmetric.
    queue = await create_queue(flow_copy)
    try:
        token = flow_context.set(flow_copy)
    except BaseException:
        # ``flow_context.set`` is ``contextvars.ContextVar.set`` which
        # does not raise in normal paths, but we defend against a future
        # refactor / wrapper that could. On failure the queue entry is
        # now orphaned — drop it before propagating so we do not leak.
        #
        # CR9 HIGH: if the BaseException we caught is a CancelledError
        # on Python 3.11+, a bare ``await delete_queue(flow_copy)`` will
        # re-raise CancelledError on entry because ``Task.cancelling()``
        # is still non-zero — the cleanup never runs and the queue leaks.
        # Mirror the ``_cancel_and_join`` pattern (lines 364-367,
        # 459-462): call ``asyncio.current_task().uncancel()`` via
        # ``getattr`` (3.10-compat) before the cleanup await so the
        # teardown completes before we re-raise the original exception.
        current = asyncio.current_task()
        uncancel = getattr(current, "uncancel", None)
        if callable(uncancel):
            uncancel()
        await delete_queue(flow_copy)
        raise
    # Hold a reference to the kickoff task so we can cancel it on
    # client disconnect. Without this reference the task can outlive
    # the request (orphaned), continuing to drive LiteLLM / tools
    # after nobody is listening.
    kickoff_task: asyncio.Task | None = None
    # ``allow_grace`` controls whether _cancel_and_join waits up to
    # _CANCEL_GRACE_SECONDS for a happy-path completion. Only the normal
    # ``None`` sentinel exit sets this to True; disconnect / timeout /
    # exception paths force an immediate cancel to keep teardown snappy.
    allow_grace = False
    try:
        try:
            kickoff_task = asyncio.create_task(
                flow_copy.kickoff_async(inputs=inputs)  # type: ignore[attr-defined]
            )

            deadline = (
                time.monotonic() + timeout
                if timeout is not None
                else None
            )

            # ``_DRAIN_MAX_PASSES`` / ``_DRAIN_BUDGET_SECONDS`` are
            # module-level constants (CR8 LOW) so the tuning surface
            # is grouped with the other env-var-backed ceilings above.
            async def _drain_queue_until_sentinel_or_empty():
                """Async-generator: drain queued items until sentinel or quiet.

                This is an ``async def`` generator (``yield``s encoded
                frames); it does NOT return a boolean. Callers should
                iterate with ``async for`` and rely on their outer control
                flow to decide what happens after the drain. An empty
                iteration means either (a) the ``None`` sentinel was
                consumed or (b) the queue quiesced within the drain
                budget. (R5 HIGH #4: docstring was stale — previously
                claimed ``Returns True`` which is syntactically impossible
                for a generator.)

                Algorithm (CR6-6 LOW #1 — docstring rewritten to match
                the actual implementation; pre-fix text still described
                the legacy 2-pass "probe once more" shape):
                * Each pass drains any currently-queued items via
                  non-blocking ``get_nowait``. If the ``None`` sentinel
                  appears we stop immediately.
                * After each pass we yield one scheduler tick
                  (``asyncio.sleep(0)``) — UNCONDITIONALLY, regardless of
                  whether the pass drained anything — so any
                  ``call_soon`` / ``call_later(0)`` chained by a
                  listener has a chance to run before we probe again.
                * We loop up to ``_DRAIN_MAX_PASSES`` (10) passes or
                  until the cumulative ``_DRAIN_BUDGET_SECONDS`` wall
                  clock is exhausted — whichever comes first. This
                  covers listener chains that need multiple scheduler
                  ticks to materialise their enqueue (e.g. a listener
                  callback that itself schedules another ``call_soon``).
                * Budget-exhaustion mid-pass is logged at DEBUG so
                  operators can correlate dropped events; the hard pass
                  cap is likewise logged so a pathological listener that
                  keeps enqueueing forever is visible.

                Pre-fix behaviour (R5 HIGH #3): a 2-pass early-return
                dropped late-arriving items that needed more than a
                single ``sleep(0)`` tick to land. R6 (CR6-6 LOW #4)
                widened the cap from 5 to 10 to cover the listener-chain
                scenarios observed in the R4/R5 history.
                """
                drain_deadline = time.monotonic() + _DRAIN_BUDGET_SECONDS
                drained_anything_ever = False
                for _pass_index in range(_DRAIN_MAX_PASSES):
                    drained_this_pass = False
                    while True:
                        try:
                            item_local = queue.get_nowait()
                        except asyncio.QueueEmpty:
                            break
                        drained_this_pass = True
                        drained_anything_ever = True
                        if item_local is None:
                            # Sentinel consumed — happy-path terminator.
                            return
                        # CR9 MEDIUM: stamp thread/run correlation on
                        # ANY event whose schema carries those fields,
                        # not just RUN_STARTED / RUN_FINISHED. The
                        # listener enqueues ``"?"`` placeholders for
                        # events it constructs (RunStarted/Finished),
                        # but a future ag-ui.core event that also
                        # carries correlation would otherwise ship the
                        # stale ``"?"``s unchanged. ``_stamp_correlation_ids``
                        # is a no-op for today's extras events
                        # (StepStarted, MessagesSnapshot, ...) since
                        # they don't declare the fields.
                        _stamp_correlation_ids(
                            item_local,
                            thread_id=input_data.thread_id,
                            run_id=input_data.run_id,
                        )
                        yield encoder.encode(item_local)

                    # Budget exhausted: exit regardless of what the
                    # current pass produced. Log only when we cut a
                    # productive pass short (so operators can correlate
                    # truly dropped events).
                    if time.monotonic() >= drain_deadline:
                        if drained_this_pass:
                            _LOGGER.debug(
                                "CrewAI drain budget exhausted mid-pass "
                                "thread=%s run=%s passes=%d",
                                input_data.thread_id,
                                input_data.run_id,
                                _pass_index + 1,
                            )
                        return

                    # Yield a tick so any ``call_soon`` / ``call_later(0)``
                    # callback chained by a listener has a chance to run.
                    # R5 HIGH #3: unconditionally continue up to
                    # ``_DRAIN_MAX_PASSES`` (regardless of whether this
                    # pass drained anything) so a listener that needs >1
                    # scheduler tick to enqueue — e.g. one that itself
                    # schedules another ``call_soon`` — is not silently
                    # dropped. The pre-fix 2-pass early-return was the
                    # off-by-one: a 3-tick-delayed enqueue lost its event.
                    await asyncio.sleep(0)
                # Hard pass cap reached — surface at DEBUG for operators
                # investigating dropped events. The happy-path common case
                # breaks out via the ``None`` sentinel long before here.
                _LOGGER.debug(
                    "CrewAI drain pass cap reached thread=%s run=%s "
                    "drained_anything_ever=%s",
                    input_data.thread_id,
                    input_data.run_id,
                    drained_anything_ever,
                )

            while True:
                # Surface kickoff exceptions promptly. Without this race, a
                # crash inside ``kickoff_async`` (auth failure, library
                # assertion) would leave the main loop blocked on
                # ``queue.get()`` until the flow-timeout ceiling, and users
                # would see ``AGUI_CREWAI_FLOW_TIMEOUT`` instead of the real
                # traceback. We use ``await kickoff_task`` (rather than
                # ``raise kickoff_task.exception()``) so the original
                # traceback is preserved — finding #4: re-raising the
                # stored exception via ``raise exc`` starts a new
                # traceback chain whose innermost frame is this ``raise``
                # line, hiding the real origin.
                if kickoff_task.done():
                    # CR8 HIGH #2: if the task was cancelled externally,
                    # surface it as a categorised RUN_ERROR so the
                    # client can distinguish "completed successfully"
                    # from "cancelled out from under us". Pre-fix this
                    # fell through to the happy-path drain+break,
                    # closing the stream with no error event at all.
                    if kickoff_task.cancelled():
                        raise _KickoffCancelled(
                            "CrewAI kickoff task was cancelled"
                        )
                    # Guard against ``.exception()`` raising
                    # CancelledError if the task was cancelled externally
                    # (finding #2): only read ``.exception()`` on a
                    # non-cancelled task. R5 LOW #12: dropped the
                    # unused ``kickoff_exc`` local — its only role was
                    # the None check, which is inlined here.
                    if kickoff_task.exception() is not None:
                        # ``await`` re-raises the stored exception
                        # WITH its original traceback intact.
                        await kickoff_task
                    # Happy path: task finished without error. Drain any
                    # remaining queue items (for example the ``None``
                    # sentinel enqueued by the FlowFinishedEvent listener),
                    # then break. Critically we do NOT fall through to
                    # ``asyncio.wait({get_task, kickoff_task}, ...)``
                    # below, because that wait would return immediately
                    # (kickoff_task is already done) and cause a CPU spin
                    # (finding #1).
                    async for encoded in _drain_queue_until_sentinel_or_empty():
                        yield encoded
                    # ``allow_grace`` only matters while the task is in
                    # flight (`_cancel_and_join` short-circuits if the
                    # task is already done). We leave the default False
                    # here rather than setting True on the inline-sentinel
                    # branch — the value is dead either way (finding
                    # #15), and an explicit False is less misleading.
                    break

                get_task = asyncio.ensure_future(queue.get())
                item: object = _UNSET  # sentinel: not yet populated
                try:
                    if deadline is not None:
                        remaining = deadline - time.monotonic()
                        if remaining <= 0:
                            # Ceiling-fired path: our deadline tripped.
                            raise _CeilingExceeded(
                                _format_timeout_message(timeout)
                            )
                        done, _pending = await asyncio.wait(
                            {get_task, kickoff_task},
                            return_when=asyncio.FIRST_COMPLETED,
                            timeout=remaining,
                        )
                    else:
                        done, _pending = await asyncio.wait(
                            {get_task, kickoff_task},
                            return_when=asyncio.FIRST_COMPLETED,
                        )

                    if not done:
                        # Ceiling-fired path: our ``asyncio.wait`` timed out.
                        raise _CeilingExceeded(
                            _format_timeout_message(timeout)
                        )

                    # Prefer propagating the kickoff exception (if any)
                    # over consuming a queued event — the exception is
                    # the real story. Guard against CancelledError
                    # (finding #2). R5 LOW #12: dropped the unused
                    # ``kickoff_exc`` local in favour of the inline
                    # None check, same semantics.
                    if (
                        kickoff_task in done
                        and not kickoff_task.cancelled()
                        and kickoff_task.exception() is not None
                    ):
                        await kickoff_task

                    if get_task in done:
                        # CR9 LOW: narrow guard against CancelledError
                        # on ``get_task.result()``. The happy-path ``done``
                        # membership check normally implies the task
                        # completed normally, but a concurrent outer-cancel
                        # that propagated into ``get_task`` after
                        # ``asyncio.wait`` returned can leave it
                        # ``done()`` AND ``cancelled()`` — reading
                        # ``.result()`` then raises CancelledError, which
                        # would bypass the ``except _CeilingExceeded`` /
                        # ``except Exception`` handlers below. Fall back
                        # to the ``_UNSET`` sentinel so the next loop
                        # iteration hits the ``kickoff_task.done()``
                        # fast path.
                        try:
                            item = get_task.result()
                        except asyncio.CancelledError:
                            item = _UNSET
                    else:
                        # kickoff finished without error but no item was
                        # enqueued yet; the top-of-loop guard on the next
                        # iteration will observe ``kickoff_task.done()``
                        # and drain via the fast path above (no spin —
                        # finding #1).
                        pass
                finally:
                    # Cancel-race guard (finding #1 HIGH H1): between
                    # ``asyncio.wait`` returning and us cancelling
                    # ``get_task``, the queue may have delivered an item
                    # to the getter. If we blindly cancel, that item is
                    # dropped. Check ``get_task.done()`` first and, if so,
                    # harvest the result (even when the primary branch
                    # above did not because ``get_task`` was not in
                    # ``done`` — e.g. it completed between ``asyncio.wait``
                    # returning and this ``finally``).
                    if not get_task.done():
                        get_task.cancel()
                    elif item is _UNSET and not get_task.cancelled():
                        try:
                            pending_item = get_task.result()
                        except Exception:  # noqa: BLE001
                            # R5 MEDIUM #6: narrow from BaseException.
                            # ``queue.get()`` cannot produce SystemExit /
                            # KeyboardInterrupt / CancelledError through
                            # its result path in practice; if anything
                            # does it is a runtime bug we should not
                            # swallow. ``Exception`` keeps the
                            # defensive-harvest intent without masking
                            # control-flow exceptions.
                            pending_item = _UNSET
                        if pending_item is not _UNSET:
                            item = pending_item

                if item is _UNSET:
                    # No item to yield — either kickoff exited without
                    # enqueueing, or only kickoff was in ``done`` and
                    # ``get_task`` was cleanly cancelled. Loop back to the
                    # top to hit the ``kickoff_task.done()`` fast path.
                    continue

                if item is None:
                    # Happy-path sentinel: grant the kickoff task a short
                    # grace period so a task that is microseconds from
                    # returning does not get needlessly cancelled.
                    allow_grace = True
                    break

                # CR9 MEDIUM: stamp correlation on any event whose
                # schema declares the fields (see _stamp_correlation_ids).
                # RUN_STARTED / RUN_FINISHED always do; future
                # correlated events are covered automatically.
                _stamp_correlation_ids(
                    item,
                    thread_id=input_data.thread_id,
                    run_id=input_data.run_id,
                )

                yield encoder.encode(item)

        except _KickoffCancelled:
            # CR8 HIGH #2: kickoff task was cancelled externally (not by
            # our teardown path, which propagates CancelledError through
            # to the outer scope). Emit a categorised RUN_ERROR so the
            # client can distinguish an external cancel from a clean
            # finish.
            _LOGGER.warning(
                "CrewAI kickoff cancelled externally thread=%s run=%s",
                input_data.thread_id,
                input_data.run_id,
            )
            message = (
                f"thread={input_data.thread_id} run={input_data.run_id}: "
                # CR9 LOW: align wording with the internal sentinel
                # message ("CrewAI kickoff task was cancelled") so the
                # code (``AGUI_CREWAI_KICKOFF_CANCELLED``), the
                # server-side log ("kickoff cancelled externally"),
                # and the client-facing message all agree on
                # "kickoff" rather than mixing "flow" and "kickoff".
                f"CrewAI kickoff was cancelled"
            )
            yield encoder.encode(
                RunErrorEvent(
                    message=message,
                    code="AGUI_CREWAI_KICKOFF_CANCELLED",
                    **_run_error_extras(input_data),
                )
            )
        except _CeilingExceeded as ceiling_exc:
            # Ceiling-fired path (CR7 CRITICAL): our configured flow
            # deadline tripped. Message / code must advertise the ceiling
            # actually in force so downstream alerting can trust the
            # signal. ``timeout`` is guaranteed finite positive here — the
            # only sites that raise ``_CeilingExceeded`` are guarded by a
            # deadline that requires a positive ``timeout``.
            ceiling_display = f"{timeout:g}s"
            _LOGGER.warning(
                "CrewAI flow exceeded ceiling thread=%s run=%s ceiling=%s detail=%s",
                input_data.thread_id,
                input_data.run_id,
                ceiling_display,
                # R5 / CR7 LOW: include the helper's descriptive message
                # in the server-side log so traceback / grep lines carry
                # the human-readable form without the client needing to
                # round-trip through the exception repr.
                ceiling_exc.args[0] if ceiling_exc.args else "",
            )
            message = (
                f"thread={input_data.thread_id} run={input_data.run_id}: "
                f"CrewAI flow exceeded ceiling={ceiling_display}"
            )
            yield encoder.encode(
                RunErrorEvent(
                    message=message,
                    code="AGUI_CREWAI_FLOW_TIMEOUT",
                    **_run_error_extras(input_data),
                )
            )
        except (asyncio.TimeoutError, TimeoutError) as upstream_exc:
            # Upstream timeout path (CR7 CRITICAL): a ``TimeoutError``
            # bubbled out of ``kickoff_async`` itself — typically a
            # LiteLLM/httpx read timeout. Our ceiling did NOT fire; we
            # MUST NOT advertise ``AGUI_CREWAI_FLOW_TIMEOUT``, which
            # downstream consumers treat as "we hit the configured
            # ceiling". Use a distinct code + message so alerting can
            # distinguish the two failure modes.
            #
            # ``timeout`` here can be anything (finite ceiling or
            # ``None`` when disabled). We surface it for operator context
            # but make clear the ceiling did not fire.
            ceiling_display = (
                "disabled" if timeout is None else f"{timeout:g}s"
            )
            _LOGGER.warning(
                "CrewAI upstream timeout during kickoff thread=%s run=%s "
                "ceiling=%s cause=%s",
                input_data.thread_id,
                input_data.run_id,
                ceiling_display,
                type(upstream_exc).__name__,
            )
            message = (
                f"thread={input_data.thread_id} run={input_data.run_id}: "
                f"CrewAI upstream timeout during kickoff "
                f"(ceiling={ceiling_display} did not fire)"
            )
            yield encoder.encode(
                RunErrorEvent(
                    message=message,
                    code="AGUI_CREWAI_UPSTREAM_TIMEOUT",
                    **_run_error_extras(input_data),
                )
            )
        except Exception as e:  # pylint: disable=broad-exception-caught
            # Log full traceback server-side; send a coarse, correlated
            # message to the client (do not leak internal repr of e).
            _LOGGER.exception(
                "CrewAI flow failed thread=%s run=%s cause=%s",
                input_data.thread_id,
                input_data.run_id,
                type(e).__name__,
            )
            # Tight message (finding #5): the exception class name already
            # lives in ``code`` (AGUI_CREWAI_FLOW_ERROR_<Class>); the
            # run_id already appears once as a prefix — do not duplicate.
            # R5 LOW #19: ``_`` separator rather than ``:`` so the code
            # field matches the ``^[A-Z][A-Z0-9_]+$`` convention used by
            # peer events (the ``:`` was an artefact of an earlier
            # pass-through of ``type.__name__``).
            message = (
                f"thread={input_data.thread_id} run={input_data.run_id}: "
                f"CrewAI flow failed; see server logs"
            )
            # CR8 MEDIUM: sanitize the exception class name before
            # embedding it in the ``code`` field. Python exception
            # classes can have dynamically-generated or unicode names,
            # which would violate the ``^[A-Z][A-Z0-9_]+$`` convention
            # peer events follow and break downstream regex-matchers.
            sanitized_name = _sanitize_exception_code(type(e).__name__)
            yield encoder.encode(
                RunErrorEvent(
                    message=message,
                    code=f"AGUI_CREWAI_FLOW_ERROR_{sanitized_name}",
                    **_run_error_extras(input_data),
                )
            )
    finally:
        # Teardown must run unconditionally — including when the outer
        # scope has been cancelled. Nested try/finally ensures that even if
        # _cancel_and_join raises CancelledError, we still drop the queue
        # and reset the context var.
        try:
            await _cancel_and_join(
                kickoff_task,
                thread_id=input_data.thread_id,
                run_id=input_data.run_id,
                allow_grace=allow_grace,
            )
        finally:
            # CPK-7718 #5: flush the crewai event bus at run end so in-flight
            # off-thread handlers settle before we drop the queue / reset the
            # context var (crewai 1.x can otherwise drop them). Best-effort and
            # a no-op on crewai builds without ``flush``.
            try:
                await _flush_event_bus()
            finally:
                try:
                    await delete_queue(flow_copy)
                finally:
                    flow_context.reset(token)


def add_crewai_flow_fastapi_endpoint(app: FastAPI, flow: Flow, path: str = "/"):
    """Adds a CrewAI endpoint to the FastAPI app."""
    global GLOBAL_EVENT_LISTENER # pylint: disable=global-statement

    # Set up the global event listener singleton
    # we are doing this here because calling add_crewai_flow_fastapi_endpoint is a clear indicator
    # that we are not running on CrewAI enterprise
    if GLOBAL_EVENT_LISTENER is None:
        GLOBAL_EVENT_LISTENER = FastAPICrewFlowEventListener()

    @app.post(path)
    async def agentic_chat_endpoint(input_data: RunAgentInput, request: Request):
        """Agentic chat endpoint"""

        flow_copy = _copy_flow(flow)

        # Get the accept header from the request
        accept_header = request.headers.get("accept")

        # Create an event encoder to properly format SSE events
        encoder = EventEncoder(accept=accept_header)

        inputs = crewai_prepare_inputs(
            state=input_data.state,
            messages=input_data.messages,
            tools=input_data.tools,
        )
        inputs["id"] = input_data.thread_id

        timeout = _flow_timeout_seconds()

        return StreamingResponse(
            _run_flow_event_stream(
                flow_copy=flow_copy,
                encoder=encoder,
                input_data=input_data,
                inputs=inputs,
                timeout=timeout,
            ),
            media_type=encoder.get_content_type(),
        )


def add_crewai_crew_fastapi_endpoint(
    app: FastAPI, crew: CrewBaseInstance, path: str = "/"
):
    """Adds a CrewAI crew endpoint to the FastAPI app.

    ``crew`` must be a crew wrapper exposing a ``crew()`` factory (see
    :class:`CrewBaseInstance`) — a ``@CrewBase``-decorated instance or an
    equivalent wrapper — NOT a bare :class:`crewai.Crew`. The deferred
    ``ChatWithCrewFlow`` construction calls ``crew.crew()`` and reads the
    crew name via ``_read_crew_name`` (which accepts either a
    ``@CrewBase``'s ``_crew_name`` or a hand-rolled ``.name``; CPK-7717
    defect 5 / review round 3).

    ChatWithCrewFlow construction is deferred to first request because the
    constructor calls crew_chat_generate_crew_chat_inputs which makes an LLM
    call. At import time the LLM mock server may not be running yet.
    """
    global GLOBAL_EVENT_LISTENER # pylint: disable=global-statement
    if GLOBAL_EVENT_LISTENER is None:
        GLOBAL_EVENT_LISTENER = FastAPICrewFlowEventListener()

    _cached_flow = None
    # Dedicated per-endpoint lock so two concurrent first-requests cannot
    # both call ``ChatWithCrewFlow(crew=crew)`` — which issues a real LLM
    # call — and waste API budget / memory (finding #6). Not sharing
    # QUEUES_LOCK: the flow-construction critical section is independent
    # of queue lifecycle and should not serialise per-request queue
    # teardown.
    _flow_lock = asyncio.Lock()

    async def _get_flow():
        nonlocal _cached_flow
        if _cached_flow is not None:
            return _cached_flow
        async with _flow_lock:
            if _cached_flow is None:
                _cached_flow = ChatWithCrewFlow(crew=crew)
            return _cached_flow

    @app.post(path)
    async def crew_endpoint(input_data: RunAgentInput, request: Request):
        """Crew chat endpoint with deferred initialization."""
        flow = await _get_flow()
        flow_copy = _copy_flow(flow)

        accept_header = request.headers.get("accept")
        encoder = EventEncoder(accept=accept_header)

        inputs = crewai_prepare_inputs(
            state=input_data.state,
            messages=input_data.messages,
            tools=input_data.tools,
        )
        inputs["id"] = input_data.thread_id

        timeout = _flow_timeout_seconds()

        return StreamingResponse(
            _run_flow_event_stream(
                flow_copy=flow_copy,
                encoder=encoder,
                input_data=input_data,
                inputs=inputs,
                timeout=timeout,
            ),
            media_type=encoder.get_content_type(),
        )


def crewai_prepare_inputs(  # pylint: disable=unused-argument, too-many-arguments
    *,
    state: dict,
    messages: list[Message],
    tools: list[Tool],
):
    """Default merge state for CrewAI"""
    messages = [message.model_dump() for message in messages]

    if len(messages) > 0:
        if "role" in messages[0] and messages[0]["role"] == "system":
            messages = messages[1:]

    actions = [{
        "type": "function",
        "function": {
            **tool.model_dump(),
        }
    } for tool in tools]

    new_state = {
        **state,
        "messages": messages,
        "copilotkit": {
            "actions": actions
        }
    }

    return new_state
