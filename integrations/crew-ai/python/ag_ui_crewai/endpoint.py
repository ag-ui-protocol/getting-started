"""
AG-UI FastAPI server for CrewAI.
"""
import asyncio
import copy
import logging
import re
import time
import uuid
from typing import Any
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse

from ._env import _parse_env_float
from ._copyutil import safe_deepcopy, rebind_bound_methods

# The flow/method lifecycle events, the event bus, and the listener base moved
# from ``crewai.utilities.events`` (crewai 0.x) to ``crewai.events`` (crewai
# 1.x). ``_capabilities`` resolves whichever location exists and caches the
# crewai capability probe (run once at import).
from ._capabilities import (
    CAPABILITIES,
    FlowStartedEvent,
    FlowFinishedEvent,
    MethodExecutionStartedEvent,
    MethodExecutionFinishedEvent,
    BaseEventListener,
    crewai_event_bus,
    flow_supports_stream_frames,
    flow_supports_human_feedback,
    supported_checkpoint_kwargs,
    add_stream_sink,
    reset_stream_sinks,
    HITL_ENABLING_VERSIONS,
    HumanFeedbackPending,
)
from ._checkpoint import build_checkpoint_kwargs
from ._frames import StreamFrameTranslator, CREW_AGENT_LIFECYCLE_TYPES
from ._config import resolve_emit_raw_events as _resolve_emit_raw_events
from ._frames import (
    is_recognized_event,
    log_raw_loss,
    raw_event_for,
    is_backend_tool_event,
)
from ._hitl import (
    HITLOptions,
    feedback_from_resume,
    resume_requested,
)
from ._reasoning import is_thinking_event
from .mcp import is_mcp_event, register_mcp_listeners, translate_mcp_event
from .attribution import flat_method_attribution
from crewai.flow.flow import Flow

from ag_ui.core import (
    RunAgentInput,
    EventType,
    RunStartedEvent,
    RunFinishedEvent,
    RunErrorEvent,
    Message,
    Tool,
    Context
)
from ag_ui.core.events import (
  TextMessageChunkEvent,
  ToolCallChunkEvent,
  ToolCallResultEvent,
  StepStartedEvent,
  StepFinishedEvent,
  MessagesSnapshotEvent,
  StateSnapshotEvent,
  CustomEvent,
  ReasoningStartEvent,
  ReasoningMessageStartEvent,
  ReasoningMessageContentEvent,
  ReasoningMessageEndEvent,
  ReasoningEndEvent,
  ReasoningEncryptedValueEvent,
)
from ag_ui.encoder import EventEncoder

from .events import (
  BridgedTextMessageChunkEvent,
  BridgedToolCallChunkEvent,
  BridgedToolCallResultEvent,
  BridgedCustomEvent,
  BridgedStateSnapshotEvent,
  BridgedReasoningStartEvent,
  BridgedReasoningMessageStartEvent,
  BridgedReasoningMessageContentEvent,
  BridgedReasoningMessageEndEvent,
  BridgedReasoningEndEvent,
  BridgedReasoningEncryptedValueEvent,
)
from .context import flow_context
from .utils import camel_to_snake, dump_agui_message
# Toolkit split: routes the A2UI component-schema context entry (stamped by
# ``@ag-ui/a2ui-middleware``) into ``state["ag-ui"]`` for the a2ui subagent tool.
from ag_ui_a2ui_toolkit import split_a2ui_schema_context
from .sdk import (
  litellm_messages_to_ag_ui_messages,
  consume_node_exit_snapshot_suppression,
  reset_node_snapshot_suppression,
)
from .crews import ChatWithCrewFlow, CrewBaseInstance

_LOGGER = logging.getLogger(__name__)

# Explicit ``__all__`` so ``from .endpoint import *`` only exposes the public
# surface (the FastAPI helpers + ``crewai_prepare_inputs``). Private helpers
# already have leading underscores and would be excluded from star-imports;
# pinning ``__all__`` makes the public contract explicit.
#
# ``create_queue`` / ``get_queue`` / ``delete_queue`` are intentionally NOT
# exported: they are internal plumbing and exposing them would imply downstream
# code may safely hook the queue lifecycle, which it cannot. Tests that need
# them import via attribute access, which works regardless of ``__all__``.
__all__ = [
    "add_crewai_flow_fastapi_endpoint",
    "add_crewai_crew_fastapi_endpoint",
    "crewai_prepare_inputs",
    "FastAPICrewFlowEventListener",
    "CrewBaseInstance",
]


# ``CrewBaseInstance`` (the structural type for a ``@CrewBase`` crew) lives in
# ``crews.py`` alongside ``ChatWithCrewFlow`` — which also annotates its
# constructor with it — and is imported above. It stays in ``__all__`` so
# downstream callers keep importing it from ``ag_ui_crewai.endpoint``.

# Sentinel to distinguish "no item delivered" from a legitimate ``None`` queue
# payload (the happy-path stream-end sentinel). Used by the cancel-race guard
# in ``_run_flow_event_stream`` where an item may have been delivered to
# ``get_task`` between ``asyncio.wait`` returning and the ``finally`` clause
# cancelling it.
_UNSET = object()


class _NeverRaised(Exception):
    """Placeholder exception type that is never raised.

    Stands in for ``HumanFeedbackPending`` when the installed crewai predates
    async HITL (the resolved symbol is ``None``), so ``except`` clauses that
    catch a pause propagation stay valid without matching anything.
    """


# The pause signal to catch when it PROPAGATES out of astream / resume_async
# (rather than ending the stream cleanly). ``None`` on pre-HITL crewai, so fall
# back to the never-raised sentinel to keep the ``except`` clause well-typed.
_HUMAN_FEEDBACK_PENDING_EXC = HumanFeedbackPending or _NeverRaised


class _KickoffCancelled(Exception):
    """Sentinel raised when the kickoff task is observed in the cancelled
    state via an external path (e.g. a cooperating task cancelled the
    ``kickoff_task`` out from under the generator).

    Raising this from the main-loop fast path lets the error-handling block
    emit ``AGUI_CREWAI_KICKOFF_CANCELLED`` so the client can distinguish "flow
    finished successfully" from "flow was cancelled out from under us" rather
    than seeing the stream close with no ``RUN_ERROR`` event.
    """


class _CeilingExceeded(Exception):
    """Sentinel raised when our configured flow-ceiling deadline fires.

    Distinguishes the ceiling-fired path (our ``asyncio.wait`` / monotonic
    deadline produced the timeout) from an upstream ``TimeoutError`` that
    bubbled out of ``kickoff_async`` (e.g. a LiteLLM/httpx read timeout).
    Downstream consumers treat ``AGUI_CREWAI_FLOW_TIMEOUT`` as "we hit our
    configured ceiling", so upstream failures must not be conflated under that
    code or alerting lies.
    """

# Process-wide global registry of in-flight flow queues, keyed by a per-flow
# ``uuid.uuid4().hex`` stored on the flow as the ``_agui_queue_key`` attribute.
# Writes are serialised via ``QUEUES_LOCK``; reads go through ``get_queue``
# which relies on GIL-atomic ``dict.get`` (see ``get_queue`` for the full
# contract). Between tests this dict is cleared by the autouse
# ``_clear_endpoint_queues`` fixture in ``tests/conftest.py``.
#
# UUID keys rather than ``id(flow)``: CPython reuses ``id`` values once an
# object is garbage-collected, which left a window where a late listener
# callback for a torn-down flow could route its event onto a NEW flow's queue
# whose ``id`` happened to match. A fresh hex key is never reused across the
# process lifetime, eliminating the collision concern entirely.
QUEUES = {}
QUEUES_LOCK = asyncio.Lock()

# crewai 1.x no longer dispatches event-bus handlers inline on the caller's
# thread. Sync handlers (all of ours) are now submitted to a ThreadPoolExecutor;
# only ``LLMStreamChunkEvent`` keeps the inline path. Every ``Bridged*`` handler
# in ``FastAPICrewFlowEventListener.setup_listeners`` therefore runs on a WORKER
# thread and must reach the per-request ``asyncio.Queue`` via
# ``loop.call_soon_threadsafe`` — a bare ``put_nowait`` from off-loop corrupts
# the queue's getter-wakeup. We capture the request's running loop in
# ``create_queue`` (which is awaited on that loop) and stash it here, keyed by
# the same UUID as ``QUEUES``.
#
# The StreamFrame integration removes this listener entirely, so this
# loop-capture + call_soon_threadsafe plumbing is the interim thread-safe fix,
# not the final design.
QUEUE_LOOPS: dict = {}

# Attribute name we set on flow objects to carry their per-request queue
# key. Module-level so tests and the listener callbacks share one
# source of truth.
_QUEUE_KEY_ATTR = "_agui_queue_key"

# Stable namespace for deterministic per-(run, method) step ids on the LEGACY
# bus-listener path. That path is dispatched on an unordered ThreadPoolExecutor,
# so it cannot maintain a stack; instead it stamps FLAT per-method attribution
# whose ``step_id`` must be IDENTICAL on the method's STEP_STARTED and
# STEP_FINISHED. A uuid5 over ``queue_key:method_name`` gives both handlers the
# same id without sharing state.
#
# Collision note: this per-(run, method) id collides if the same method runs
# more than once in a single run. That is acceptable: the legacy path is the
# unordered fallback, whereas the ordered frame path mints a unique id per
# execution.
_LEGACY_STEP_ID_NAMESPACE = uuid.UUID("6f9619ff-8b86-d011-b42d-00cf4fc964ff")


def _legacy_method_step_id(queue_key: object, method_name: str) -> str:
    """Deterministic step id for a legacy-path Flow method.

    ``uuid5`` over ``queue_key:method_name`` so the same (run, method) pair
    yields the same id on STEP_STARTED and STEP_FINISHED (the pairing key a
    topology-aware consumer needs) without the two off-thread handlers sharing
    any mutable state. ``queue_key`` scopes it to the run so two concurrent runs
    of the same method do not collide.
    """
    return uuid.uuid5(
        _LEGACY_STEP_ID_NAMESPACE, f"{queue_key}:{method_name}"
    ).hex

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
# teardown budget: total upper bound on teardown from entry to
# ``_cancel_and_join`` is one ceiling window, not ``grace + join``.
_CANCEL_GRACE_SECONDS = 1.0

# If a cancelled task refuses to terminate within this window, log a warning
# so operators have visibility into stuck cancellations instead of a silent
# swallow. Override-able via ``AGUI_CREWAI_CANCEL_JOIN_TIMEOUT_SECONDS`` so
# operators can tune it under disconnect-heavy load.
_CANCEL_JOIN_TIMEOUT_SECONDS = 10.0

# Caps on the happy-path drain: an ``_DRAIN_MAX_PASSES`` loop with an
# ``asyncio.sleep(0)`` between passes and a wall-clock ``_DRAIN_BUDGET_SECONDS``
# ceiling that short-circuits the loop when the budget is exhausted mid-pass.
# Kept at module scope alongside the other tuning constants so operators
# grepping for tunables find them all in one place.

# Cap on both RAW buffers in ``_run_flow_frame_stream``. At the cap the oldest entry
# is evicted (and logged) so the buffer self-heals: crewai raises some events that
# never produce a frame, and refusing new entries would wedge it for the whole run.
_FOREIGN_EVENT_BUFFER_MAX = 512

# One-shot guard for the "emit_raw_events on the legacy transport" warning. A module
# global, so the latch is per-process: a process serving several endpoints warns only
# for the first one that asks. Deliberate trade against per-request log spam, since
# the message names a transport limitation rather than a per-endpoint defect.
_LEGACY_RAW_WARNING_EMITTED = False
# Same once-per-process discipline for the backend-tool-rendering gap: the legacy
# listener registers no ToolUsage handler, so a backend tool call is invisible on
# crewai 1.0-1.5. Warn once so a missing tool card there is diagnosable.
_LEGACY_BACKEND_TOOL_WARNING_EMITTED = False

_DRAIN_MAX_PASSES = 10
_DRAIN_BUDGET_SECONDS = 0.050

# Regex to sanitize exception class names before embedding them in a ``code``
# field. Peer events' codes match ``^[A-Z][A-Z0-9_]+$``; a custom exception
# with a dynamically-generated or unicode name (e.g.
# ``class WeirdError42(Exception): pass``) must be forced into that shape
# before going on the wire.
_CODE_SANITIZE_RE = re.compile(r"[^A-Z0-9_]")


def _sanitize_exception_code(name: str) -> str:
    """Sanitize an exception class name for the ``code`` field.

    Peer events on this wire use ``^[A-Z][A-Z0-9_]+$`` codes. Exception
    class names may contain lowercase letters, digits, or even unicode
    (custom exceptions with dynamically-generated names are legal in
    Python). Upper-case the name and replace any character that is not
    an ASCII uppercase letter, digit, or underscore with ``_`` so the
    composed code stays greppable and regex-matchable by downstream
    alerting.
    """
    sanitized = _CODE_SANITIZE_RE.sub("_", name.upper())
    # Collapse runs of underscores into a single underscore and strip
    # leading/trailing underscores so the result respects the peer
    # convention (e.g. a unicode name like ``ErrorXé`` sanitizes to
    # ``ERRORX_``, and ``Error__X`` to ``ERROR__X``). If the
    # sanitized-and-stripped result is empty or does NOT start with
    # ``[A-Z]`` (e.g. the class name was digits-only or all-unicode)
    # prefix ``E_`` so the composed code still matches ``^[A-Z][A-Z0-9_]+$``.
    sanitized = re.sub(r"_+", "_", sanitized).strip("_")
    if not sanitized or not sanitized[0].isascii() or not sanitized[0].isalpha():
        sanitized = f"E_{sanitized}" if sanitized else "E"
    return sanitized


def _stamp_correlation_ids(event: object, *, thread_id: str, run_id: str) -> None:
    """Stamp ``thread_id`` / ``run_id`` on ``event`` if the fields exist.

    Probe attributes with ``hasattr`` rather than enumerate event types so any
    event carrying thread/run correlation (RUN_STARTED / RUN_FINISHED today,
    plus any future correlated event) is covered automatically and does not
    ship the listener's ``"?"`` placeholders. Events without these fields
    (StepStartedEvent, MessagesSnapshotEvent, etc.) are left untouched. Model
    ``__setattr__`` on Pydantic events is allowed by ``model_config`` (no
    frozen).
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
    otherwise silently disable the ceiling.
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
    ``AGUI_CREWAI_CANCEL_JOIN_TIMEOUT_SECONDS`` without redeploying code.
    Non-finite or non-positive values fall back to the conservative default
    so a fat-fingered env var cannot disable the ceiling entirely.

    Intentional divergence from the flow-timeout / LLM-timeout helpers: those
    treat ``<=0`` as "disable the ceiling" and return ``None``. Cancel-join
    MUST always have a bounded positive value — disabling it would let
    teardown block indefinitely and break client-disconnect semantics, so the
    safer fallback here is to silently use the default rather than surface a
    ``None`` that the caller would then have to defend against everywhere.
    """
    result = _parse_env_float(
        "AGUI_CREWAI_CANCEL_JOIN_TIMEOUT_SECONDS",
        _CANCEL_JOIN_TIMEOUT_SECONDS,
        allow_disable=False,
    )
    # ``allow_disable=False`` guarantees a non-None return today, but the
    # signature of ``_parse_env_float`` is ``float | None``. This defensive
    # guard (rather than an ``assert``, which is stripped under ``python -O``)
    # narrows the type and keeps callers safe if a future refactor widens the
    # contract to return ``None``.
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
      teardown, not three.
    - If ``allow_grace`` and the task is mid-flight on a happy path, wait up
      to ``min(_CANCEL_GRACE_SECONDS, remaining-budget)`` for it to finish
      on its own (the FlowFinishedEvent listener enqueues ``None``
      microseconds before ``kickoff_async`` actually returns). A quick
      ``sleep(0)`` + ``task.done()`` probe fast-paths the common case where
      the task is microseconds from returning, so happy-path requests do
      NOT systematically pay the 1s grace latency tax.
    - The grace wait is SHIELDED and protected by the same outer-cancel
      recovery pattern used post-grace. If the caller is cancelled during
      the grace wait, ``task.cancel()`` still fires via the ``finally`` and
      the task is cleanly unwound within the remaining budget; we don't
      leave a cancelled-but-unjoined task behind.
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
        # If the task is already done with a stored exception (e.g. kickoff
        # raised before the generator reached this teardown path),
        # defensively call ``.exception()`` so it is marked retrieved and
        # does NOT surface as a "Task exception was never retrieved" GC
        # warning. ``.exception()`` is only safe on a non-cancelled done task.
        if not task.cancelled():
            try:
                task.exception()
            except Exception:  # noqa: BLE001 - defensive
                pass
        return

    # Shared monotonic deadline covering the ENTIRE teardown — grace
    # window, force-cancel join, and outer-cancel recovery.
    ceiling = _cancel_join_timeout_seconds()
    deadline = time.monotonic() + ceiling

    def _remaining() -> float:
        return max(0.0, deadline - time.monotonic())

    try:
        if allow_grace:
            # Fast-path probe: let the task advance a tick before paying the
            # 1s grace wait. The common case is that ``kickoff_async`` is
            # microseconds from returning once the listener has enqueued the
            # ``None`` sentinel; yielding once usually lets the task complete
            # without blocking.
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
                    # Happy path did not complete in time; log at the
                    # grace-expired boundary so operators diagnosing stuck
                    # teardown see a signal, then fall through to
                    # force-cancel below.
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
                    # post-grace recovery pattern: ensure task.cancel() fires
                    # within the remaining budget and await its unwind so we
                    # do not leave a cancelled-but-unjoined task behind.
                    #
                    # Capture the CancelledError *instance* so we can re-raise
                    # it with ``.args`` and traceback intact; raising the bare
                    # class would lose the message and chained traceback of
                    # the original cancel.
                    current = asyncio.current_task()
                    uncancel = getattr(current, "uncancel", None)
                    if callable(uncancel):
                        uncancel()
                    grace_teardown: asyncio.Future | None = None
                    # If the task happened to complete during the grace wait
                    # we skip the teardown/drain path entirely; defensively
                    # call ``task.exception()`` so a stored exception is
                    # marked retrieved and does NOT surface as a GC "Task
                    # exception was never retrieved" warning when we re-raise
                    # below. ``exception()`` is only safe on a non-cancelled
                    # done task.
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
                        # If the recovery wait below times out and we
                        # re-raise ``grace_outer_cancel``, the stored
                        # ``TimeoutError`` on ``grace_teardown`` would never
                        # be retrieved and the GC logs ``Task exception was
                        # never retrieved``. Attach a done-callback that
                        # drains the stored exception so the future is left
                        # clean regardless of the code path we exit through.
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
                            # already swallows any task exception into its
                            # result list, so there is nothing to drain from
                            # ``grace_teardown.exception()``. Just propagate
                            # the outer cancel.
                            raise
                        # No exception-drain on normal completion either —
                        # ``gather(return_exceptions=True)`` has already
                        # retrieved any task exception into its result list,
                        # so ``grace_teardown.exception()`` here is always
                        # ``None`` / a bare TimeoutError from ``wait_for``
                        # (already handled above).
                    # Re-raise the ORIGINAL outer cancel instance so args
                    # and traceback propagate intact.
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
        # If the recovery wait below times out and we re-raise
        # ``outer_cancel``, the stored ``TimeoutError`` on ``teardown`` would
        # never be retrieved and the GC logs ``Task exception was never
        # retrieved``. Attach a done-callback that drains the stored exception
        # so the future is left clean regardless of the code path we exit
        # through.
        teardown.add_done_callback(
            lambda f: f.exception() if not f.cancelled() else None
        )
        try:
            await asyncio.shield(teardown)
        except asyncio.CancelledError as outer_cancel:
            # Outer scope was cancelled. On Python 3.11+, we must uncancel
            # the current task before issuing another ``await`` — otherwise
            # the next ``await`` re-raises CancelledError immediately and
            # the bounded recovery wait is a no-op.
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
                # swallowing silently.
                _LOGGER.debug(
                    "CrewAI cancel-recovery wait swallowed %s "
                    "(thread=%s run=%s)",
                    type(recov_exc).__name__,
                    thread_id,
                    run_id,
                )
            # ``asyncio.gather(task, return_exceptions=True)`` already
            # swallows ``task``'s exception into its result list, so
            # ``teardown.exception()`` here only surfaces a ``TimeoutError``
            # from ``wait_for`` (already handled above) or ``None`` — nothing
            # to drain. Re-raise the original CancelledError (via the captured
            # name, for explicitness) so traceback and ``.args`` context
            # propagate intact to the outer scope.
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
        # idempotent on a done task.
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

    ``ceiling`` is passed explicitly rather than re-read from the env so the
    logged value matches the deadline that actually governed this teardown —
    an operator who flips ``AGUI_CREWAI_CANCEL_JOIN_TIMEOUT_SECONDS``
    mid-request will still see the ceiling that was in effect for the stuck
    task.
    """
    suffix = " (after outer cancel)" if after_outer_cancel else ""
    # %g matches _format_timeout_message so grep/alerting patterns that
    # compare the two numeric formats don't have to special-case trailing
    # zeros.
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

    Keys are ``uuid.uuid4().hex`` rather than ``id(flow)`` so the registry
    cannot suffer from id-reuse collisions after a flow is garbage-collected.
    The key is stored on the flow as ``_agui_queue_key`` so listener callbacks
    that receive a flow via the event bus can look up the queue without
    threading the key through another side channel.
    """
    queue_key = uuid.uuid4().hex
    # Register the queue in the module-level mapping BEFORE stamping the key on
    # the flow. Stamping first would leave a window where ``get_queue(flow)``
    # could observe the attribute yet miss the not-yet-inserted key in
    # ``QUEUES``, returning ``None`` and silently dropping an event. The flow
    # is not visible as "has a queue key" until there is a queue to look up.
    # Capture the request's running loop so off-thread listener callbacks can
    # enqueue via ``loop.call_soon_threadsafe``. ``create_queue`` is always
    # awaited on the request loop, so this is that loop.
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:  # pragma: no cover - create_queue is always awaited
        loop = None
    async with QUEUES_LOCK:
        queue = asyncio.Queue()
        QUEUES[queue_key] = queue
        QUEUE_LOOPS[queue_key] = loop
        # Stamp only AFTER the queue is registered under its key so a
        # concurrent ``get_queue(flow)`` never observes the attr pointing at a
        # not-yet-present entry.
        #
        # crewai 1.13+ made ``Flow`` a Pydantic ``BaseModel``. Try a normal
        # ``setattr`` first (it honours any custom ``__setattr__`` — some
        # callers/tests instrument the write — and works on crewai 1.15.x,
        # which accepts our underscore-prefixed key); if a stricter Pydantic
        # ``Flow`` rejects the undeclared attribute, fall back to
        # ``object.__setattr__`` which bypasses Pydantic entirely. Either way
        # the key lands in the instance ``__dict__`` and reads back via plain
        # ``getattr`` (see ``get_queue``).
        try:
            setattr(flow, _QUEUE_KEY_ATTR, queue_key)
        except (ValueError, AttributeError, TypeError):
            object.__setattr__(flow, _QUEUE_KEY_ATTR, queue_key)
        return queue


def get_queue(flow: object) -> asyncio.Queue | None:
    """Get the queue for a flow.

    ``QUEUES_LOCK`` is intentionally NOT taken here.

    Contract:
    * ``QUEUES`` is a plain ``dict`` keyed by the per-flow UUID hex stored on
      the flow as ``_agui_queue_key``. CPython's GIL makes ``dict.get(k)``
      atomic at the bytecode level — we cannot observe a half-constructed
      mapping. This assumes a CPython-with-GIL interpreter; free-threaded
      CPython 3.13+ (PEP 703, opt-in ``--disable-gil``) removes that
      bytecode-atomicity guarantee and would require wrapping the read in a
      ``threading.Lock`` (or a thread-safe mapping). Forward-compat note only —
      the module does not ship free-thread support today.
    * Threading model: crewai's ``CrewAIEventsBus`` emits listener callbacks
      synchronously from whatever call stack raised the event. Our events are
      raised from within ``kickoff_async`` — which we ``await`` on the event
      loop — so in practice every listener callback fires on the loop thread
      and ``put_nowait`` is the right primitive. If crewai ever invokes the
      bus from a worker thread (a future background-executor feature), every
      ``put_nowait`` call site in
      ``FastAPICrewFlowEventListener.setup_listeners`` must be revisited and
      converted to ``loop.call_soon_threadsafe``.
    * This function is called from TWO contexts:
      (a) Synchronous crewai event-listener callbacks. Those run on the event
          loop thread but via synchronous call stacks where we cannot
          ``await`` — hence no ``QUEUES_LOCK`` acquisition.
      (b) The async endpoint code paths, which always take ``QUEUES_LOCK`` for
          writes (``create_queue``, ``delete_queue``) but not reads.
    * The one race that remains is SEMANTIC rather than data-structural: a
      late listener callback that fires after ``delete_queue`` removed the
      entry observes ``None`` and silently no-ops. This is intended — an event
      for a torn-down flow has nowhere to land. ``_cancel_and_join`` teardown
      widens the window during which late callbacks can arrive after delete
      but does not change the semantics.
    * A flow that was never registered with ``create_queue`` will not carry
      the ``_agui_queue_key`` attribute; we default to ``None`` and the
      ``get`` returns ``None`` as intended.
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

    crewai 1.x dispatches our sync bus handlers on a ThreadPoolExecutor worker
    thread, so a bare ``queue.put_nowait`` would run off the queue's owning
    loop and corrupt the getter-wakeup. We hop back onto the captured request
    loop via ``call_soon_threadsafe``. If we happen to
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
    ``Flow`` deep-copy bug (found by running the suite on the 1.15.7 wheel).
    Isolation of the per-request conversation state is preserved either way.

    When the pin-and-share fallback runs, the copy SHARES the original's
    ``_methods`` dict (its bound ``@start`` / ``@listen`` methods
    trial-deep-copy-fail because they reference the uncopyable ``memory`` via
    ``__self__``, so the dict is pinned by reference). crewai 1.x executes
    ``self._methods[name]`` — still bound to the ORIGINAL — so
    ``kickoff_async``/``astream`` on the copy seeds the COPY's ``self._state``
    while ``@start`` runs against the ORIGINAL's un-seeded state
    (``KeyError: 'messages'`` at ``crews.py`` ``*self.state["messages"]``, and a
    total loss of per-request isolation). Rebind the copy's flow methods to the
    copy so state seeding and isolation both hold. No-op on healthy deep-copy
    builds (already rebound) and on non-flow copies (no ``_methods``).
    """
    flow_copy = safe_deepcopy(flow, what="flow")
    rebind_bound_methods(flow_copy)
    return flow_copy


async def _flush_event_bus() -> None:
    """Best-effort run-end flush of the crewai event bus.

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

# Whether the most recent node withheld its STATE_SNAPSHOT, so FlowFinished
# knows whether a terminal snapshot is still owed.
_LAST_NODE_SUPPRESSED_ATTR = "_ag_ui_last_node_suppressed"

# Process-wide warn-once guard for the "MCP event with no active flow in
# context" legacy-path drop (see ``_on_mcp_event`` in ``setup_listeners``).
_MCP_NO_FLOW_WARNED = False


def _flow_state_snapshot(state: object) -> dict:
    """Point-in-time snapshot dict from a flow's state (Pydantic model or dict).

    A deep copy so a later node mutating the live state cannot corrupt an
    already-queued snapshot; ``model_dump`` already returns a fresh dict.
    """
    if isinstance(state, dict):
        return copy.deepcopy(state)
    if hasattr(state, "model_dump"):
        return state.model_dump()
    return {}


# When crewai's events package doesn't resolve, ``BaseEventListener`` is None;
# subclassing None crashes at import time. Fall back to a plain ``object`` so the
# package still imports (as an inert listener) and the capability warning surfaces.
_EventListenerBase = BaseEventListener if BaseEventListener is not None else object


class FastAPICrewFlowEventListener(_EventListenerBase):
    """FastAPI CrewFlow event listener.

    WARNING: do NOT construct this class directly in application code.
    ``add_crewai_flow_fastapi_endpoint`` and
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

        Every callback below runs on a ThreadPoolExecutor WORKER thread under
        crewai 1.x (sync handlers are no longer dispatched inline on the
        caller's thread). All queue writes therefore go through ``_enqueue``,
        which hops back onto the request loop via ``call_soon_threadsafe``. The
        ``None`` happy-path sentinel is enqueued the same way so it stays
        ordered behind the ``RUN_FINISHED`` event on the loop.

        crewai 1.x dispatch is now EXACT-TYPE (keyed on ``type(event)``), not
        ``isinstance`` — a handler registered on a base class silently stops
        receiving subclasses. Every ``.on(...)`` below is registered on the
        EXACT event type we emit / crewai emits, so exact-type dispatch
        delivers to each handler as before. No handler is registered on a
        shared base class.
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
            if get_queue(source) is None:
                return
            # Terminal snapshot only when the last node withheld its own: it
            # delivers the authoritative flow.state the client is still missing.
            # Otherwise it would just duplicate the last node's snapshot.
            if getattr(source, _LAST_NODE_SUPPRESSED_ATTR, False):
                _enqueue(
                    source,
                    StateSnapshotEvent(
                        type=EventType.STATE_SNAPSHOT,
                        snapshot=_flow_state_snapshot(source.state),
                    ),
                )
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
            # Clear stale suppression flags from a prior node that raised.
            reset_node_snapshot_suppression(source)
            # Flat per-method attribution. The legacy bus path is dispatched on
            # an unordered thread pool, so it cannot maintain a stack (see
            # attribution.py); it stamps flow ownership + a stable per-(run,
            # method) step_id only. Crew/Agent nesting is a StreamFrame-path
            # feature, so no crew/agent handlers are registered here.
            queue_key = getattr(source, _QUEUE_KEY_ATTR, None)
            method_name = str(getattr(event, "method_name", None) or "method")
            step_id = _legacy_method_step_id(queue_key, method_name)
            _enqueue(
                source,
                StepStartedEvent(
                    type=EventType.STEP_STARTED,
                    step_name=method_name,
                    raw_event=flat_method_attribution(
                        method_name,
                        flow_name=getattr(event, "flow_name", None),
                        fingerprint=getattr(event, "source_fingerprint", None),
                        step_id=step_id,
                    ),
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
            # Suppress the node-exit snapshot when a prediction or manual emit
            # is in flight, so the rebuild from source.state doesn't wipe what
            # the client already holds. Record it for the FlowFinished handler.
            suppress_state_snapshot = consume_node_exit_snapshot_suppression(source)
            setattr(source, _LAST_NODE_SUPPRESSED_ATTR, suppress_state_snapshot)
            if not suppress_state_snapshot:
                _enqueue(
                    source,
                    StateSnapshotEvent(
                        type=EventType.STATE_SNAPSHOT,
                        snapshot=_flow_state_snapshot(state),
                    ),
                )
            # The finish reuses the same step_id as the matching start (same
            # (queue_key, method_name)) so a consumer can pair them.
            queue_key = getattr(source, _QUEUE_KEY_ATTR, None)
            method_name = str(getattr(event, "method_name", None) or "method")
            step_id = _legacy_method_step_id(queue_key, method_name)
            _enqueue(
                source,
                StepFinishedEvent(
                    type=EventType.STEP_FINISHED,
                    step_name=method_name,
                    raw_event=flat_method_attribution(
                        method_name,
                        flow_name=getattr(event, "flow_name", None),
                        fingerprint=getattr(event, "source_fingerprint", None),
                        step_id=step_id,
                    ),
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
                    parent_message_id=getattr(event, "parent_message_id", None),
                    delta=event.delta,
                )
            )
        @crewai_event_bus.on(BridgedToolCallResultEvent)
        def _(source, event):
            _enqueue(
                source,
                ToolCallResultEvent(
                    type=EventType.TOOL_CALL_RESULT,
                    message_id=event.message_id,
                    tool_call_id=event.tool_call_id,
                    content=event.content,
                    role="tool",
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

        # Reasoning lifecycle emitted by ``sdk.copilotkit_stream`` off the
        # litellm delta. Mapped 1:1 like the text / tool-call chunks above.
        @crewai_event_bus.on(BridgedReasoningStartEvent)
        def _(source, event):
            _enqueue(
                source,
                ReasoningStartEvent(
                    type=EventType.REASONING_START,
                    message_id=event.message_id,
                )
            )
        @crewai_event_bus.on(BridgedReasoningMessageStartEvent)
        def _(source, event):
            _enqueue(
                source,
                ReasoningMessageStartEvent(
                    type=EventType.REASONING_MESSAGE_START,
                    message_id=event.message_id,
                    role=event.role,
                )
            )
        @crewai_event_bus.on(BridgedReasoningMessageContentEvent)
        def _(source, event):
            _enqueue(
                source,
                ReasoningMessageContentEvent(
                    type=EventType.REASONING_MESSAGE_CONTENT,
                    message_id=event.message_id,
                    delta=event.delta,
                )
            )
        @crewai_event_bus.on(BridgedReasoningMessageEndEvent)
        def _(source, event):
            _enqueue(
                source,
                ReasoningMessageEndEvent(
                    type=EventType.REASONING_MESSAGE_END,
                    message_id=event.message_id,
                )
            )
        @crewai_event_bus.on(BridgedReasoningEndEvent)
        def _(source, event):
            _enqueue(
                source,
                ReasoningEndEvent(
                    type=EventType.REASONING_END,
                    message_id=event.message_id,
                )
            )
        @crewai_event_bus.on(BridgedReasoningEncryptedValueEvent)
        def _(source, event):
            _enqueue(
                source,
                ReasoningEncryptedValueEvent(
                    type=EventType.REASONING_ENCRYPTED_VALUE,
                    subtype=event.subtype,
                    entity_id=event.entity_id,
                    encrypted_value=event.encrypted_value,
                )
            )

        # Surface crewai's first-class MCP events (crewai >= 1.4) on the LEGACY
        # bus-listener transport (crewai 1.4-1.5, StreamFrame absent). crewai
        # emits MCP events with the agent/crew as ``source`` (NOT the Flow), so
        # we resolve the active run via ``flow_context`` -- the same contextvar
        # the run driver sets -- and enqueue thread-safely through ``_enqueue``
        # (handlers run on a ThreadPoolExecutor worker thread under crewai 1.x).
        # On the StreamFrame path (crewai >= 1.6) no per-run queue is created,
        # so ``_enqueue`` finds no queue and this is an inert no-op there; that
        # path surfaces MCP events via the frame sink + StreamFrameTranslator
        # instead. Below 1.4 (no ``crewai.mcp``) this logs one warning and
        # registers nothing.
        def _on_mcp_event(event):
            # Receives the RAW crewai MCP event. Resolve the active run via
            # ``flow_context`` (crewai copies the emitting context -- incl. this
            # package's ``flow_context``, set by the run driver before the
            # kickoff task -- into the handler's worker thread) and enqueue only
            # when that run has a live queue.
            flow = flow_context.get(None)
            if flow is None:
                # crewai's context copy makes this unexpected under the FastAPI
                # bridge; a genuinely context-less emit (a stray event outside a
                # run, or a future propagation regression) would otherwise vanish
                # silently. Warn ONCE (naming the raw crewai type), not per event.
                global _MCP_NO_FLOW_WARNED  # pylint: disable=global-statement
                if not _MCP_NO_FLOW_WARNED:
                    _MCP_NO_FLOW_WARNED = True
                    _LOGGER.warning(
                        "ag-ui-crewai: crewai MCP event %s emitted with no active "
                        "flow in context; dropping. MCP tool calls will not "
                        "surface on the legacy transport if this recurs.",
                        getattr(event, "type", None),
                    )
                return
            # On the StreamFrame path (crewai >= 1.6) no per-run queue exists --
            # MCP is surfaced via the frame sink there -- so skip translation
            # entirely rather than translate-and-discard.
            if get_queue(flow) is None:
                return
            for agui_event in translate_mcp_event(event):
                _enqueue(flow, agui_event)

        register_mcp_listeners(crewai_event_bus, _on_mcp_event)


def _format_timeout_message(timeout: float | None) -> str:
    """Build the ``TimeoutError`` message for the flow-ceiling path.

    Extracted so the two TimeoutError construction sites and the client-facing
    error message derive from a single source of truth.

    ``timeout`` is always a finite positive value here — the flow-ceiling code
    paths that raise ``TimeoutError`` are guarded by ``timeout is not None``.
    Using ``%g`` (up to 6 significant digits, no trailing zeros) avoids the
    truncation of sub-decisecond values that ``%.1f`` produces. For ``0.2``,
    ``%g`` renders ``0.2``; for ``0.25``, ``0.25``; for ``600``, ``600``.
    """
    return f"CrewAI flow exceeded {timeout:g}s ceiling"


# Per-alias WARN dedup: track ``(model_name, field_name)`` tuples that have
# already warned so ``_field_alias`` logs one line per divergence rather than
# per-event spam under a misconfigured ag-ui.core upgrade.
_ALIAS_WARN_SEEN: set[tuple[str, str]] = set()


def _field_alias(model_cls, field_name: str, default: str) -> str:
    """Return the serialization alias for ``field_name`` on ``model_cls``.

    Pydantic models in ag-ui.core set camelCase aliases via an alias
    generator; we derive the wire name here so a future rename of the alias
    policy propagates automatically instead of silently diverging from this
    module's hardcoded camelCase literals. Falls back to ``default`` if the
    model does not declare the field (keeps the code path stable under library
    upgrades).

    If BOTH ``serialization_alias`` and ``alias`` are ``None`` on an existing
    field, that almost certainly means Pydantic internals changed and our
    alias inference is silently wrong. Emit ONE WARN per (model, field) tuple
    (tracked in ``_ALIAS_WARN_SEEN``) so the divergence is visible without
    spamming a line per request / per event.
    """
    try:
        field = model_cls.model_fields[field_name]
    except (AttributeError, KeyError):
        return default
    # Pydantic v2 exposes the alias either as ``alias`` (explicit) or via
    # ``serialization_alias``; prefer the latter if set.
    serialization_alias = getattr(field, "serialization_alias", None)
    basic_alias = getattr(field, "alias", None)
    # Use an explicit None check rather than ``or`` so an empty string (legal,
    # if unusual) on ``serialization_alias`` does not silently fall through to
    # ``basic_alias``.
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

    ``ConfiguredBaseModel`` uses ``extra="allow"`` — extras bypass the alias
    generator, so pre-camelCased keys are required to line up with
    declared-field peers (``RunStartedEvent.thread_id`` / ``run_id`` emit as
    ``threadId`` / ``runId`` via the alias generator). The alias names are
    derived from ``RunStartedEvent.model_fields`` so a rename of the alias
    policy in ag-ui.core does not silently regress this module.

    LOAD-BEARING ASSUMPTION: ``RunStartedEvent`` and ``RunErrorEvent`` share
    the same alias-generator policy (both derive from ``ConfiguredBaseModel``).
    We derive the alias names from ``RunStartedEvent.model_fields`` and apply
    them to ``RunErrorEvent`` extras on the premise that the wire name for
    ``thread_id`` / ``run_id`` is IDENTICAL across the two models. If ag-ui.core
    ever splits the alias policy per-model, this derivation silently diverges
    (extras camelCased while declared fields are not). The failure mode is
    subtle (wire format mismatch, not a crash), so verifying the shared policy
    at test time is the right escalation point rather than asserting it
    dynamically here.
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
    checkpoint_kwargs: dict | None = None,
    emit_raw_events: bool = False,
):
    """Drive a single flow kickoff and yield encoded AG-UI events.

    Extracted from the flow and crew endpoints so they share identical
    cancellation, timeout, and error-reporting semantics. The generator:

    * spawns ``kickoff_async`` as a task (kept in scope so it can be torn
      down on client disconnect);
    * reads from the per-flow queue with a wall-clock deadline;
    * surfaces timeouts and other exceptions as a ``RunErrorEvent`` whose
      ``message`` carries thread/run correlation AND whose event-level
      extras (``threadId`` / ``runId``) mirror the peer events' wire format;
    * on exit, cancels the kickoff task, drops the queue, and resets the
      context var — unconditionally, even if the outer scope is cancelled.
    """
    global _LEGACY_RAW_WARNING_EMITTED  # pylint: disable=global-statement
    if emit_raw_events and not _LEGACY_RAW_WARNING_EMITTED:
        # This listener only receives the event types it registers, so there is
        # nothing unmapped here to mirror. Say so rather than ignoring the flag,
        # once per process since the condition never changes between requests.
        _LEGACY_RAW_WARNING_EMITTED = True
        _LOGGER.warning(
            "ag-ui-crewai ignored emit_raw_events=True: RAW passthrough requires the "
            "crewai StreamFrame transport (crewai >= 1.6 and a flow exposing "
            "astream); this run is on the legacy event-bus listener, which never sees "
            "the unmapped events"
        )

    global _LEGACY_BACKEND_TOOL_WARNING_EMITTED  # pylint: disable=global-statement
    if not _LEGACY_BACKEND_TOOL_WARNING_EMITTED:
        # Backend tool rendering lives only on the StreamFrame path; the legacy
        # listener registers no ToolUsage handler, so a backend tool runs without
        # emitting TOOL_CALL_* / TOOL_CALL_RESULT. Say so once so the missing card
        # is diagnosable rather than silent.
        _LEGACY_BACKEND_TOOL_WARNING_EMITTED = True
        _LOGGER.warning(
            "ag-ui-crewai: backend tool rendering requires the crewai StreamFrame "
            "transport (crewai >= 1.6 and a flow exposing astream); this run is on "
            "the legacy event-bus listener, so any Agent/Crew backend tool call will "
            "run WITHOUT emitting TOOL_CALL_* / TOOL_CALL_RESULT"
        )

    # ``create_queue`` registers an entry in the module-level ``QUEUES``
    # mapping. If ``flow_context.set`` raises between ``create_queue`` and the
    # main ``try:`` block, the registered queue is orphaned — nothing deletes
    # it. Wrap both in a narrow ``try/except`` that ``delete_queue``'s on
    # failure so the registration is symmetric.
    queue = await create_queue(flow_copy)
    try:
        token = flow_context.set(flow_copy)
    except BaseException as exc:
        # ``flow_context.set`` is ``contextvars.ContextVar.set`` which does not
        # raise in normal paths, but we defend against a future refactor /
        # wrapper that could. On failure the queue entry is now orphaned —
        # drop it before propagating so we do not leak.
        #
        # If the caught BaseException is a CancelledError on Python 3.11+, a
        # bare ``await delete_queue(flow_copy)`` would re-raise CancelledError
        # on entry (``Task.cancelling()`` is still non-zero), the cleanup never
        # runs, and the queue leaks. Mirror the ``_cancel_and_join`` pattern:
        # call ``asyncio.current_task().uncancel()`` via ``getattr``
        # (3.10-compat) before the cleanup await so teardown completes before
        # we re-raise.
        #
        # Gate the uncancel on the exception ACTUALLY being a CancelledError. A
        # non-cancel BaseException leaves ``Task.cancelling()`` at whatever a
        # genuine concurrent cancel set it to; unconditionally uncancelling
        # would consume a cancellation level that isn't ours, so a real pending
        # cancel would need an extra ``cancel()`` to take hold. Only the
        # CancelledError path is entitled to consume the level.
        current = asyncio.current_task()
        uncancel = getattr(current, "uncancel", None)
        if isinstance(exc, asyncio.CancelledError) and callable(uncancel):
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
            # Only pass checkpoint kwargs this flow's kickoff_async declares, so
            # a flow that predates them is called exactly as before.
            _ckpt = supported_checkpoint_kwargs(
                flow_copy.kickoff_async, checkpoint_kwargs or {}  # type: ignore[attr-defined]
            )
            if checkpoint_kwargs and not _ckpt:
                # Checkpointing was enabled and a config was built, but this
                # flow's kickoff_async does not accept it: warn so the no-op is
                # visible rather than silently persisting nothing.
                _LOGGER.warning(
                    "ag-ui-crewai: checkpointing is enabled but "
                    "flow.kickoff_async does not accept from_checkpoint; "
                    "nothing will be persisted for this run."
                )
            kickoff_task = asyncio.create_task(
                flow_copy.kickoff_async(inputs=inputs, **_ckpt)  # type: ignore[attr-defined]
            )

            deadline = (
                time.monotonic() + timeout
                if timeout is not None
                else None
            )

            # ``_DRAIN_MAX_PASSES`` / ``_DRAIN_BUDGET_SECONDS`` are
            # module-level constants so the tuning surface is grouped with the
            # other env-var-backed ceilings above.
            async def _drain_queue_until_sentinel_or_empty():
                """Async-generator: drain queued items until sentinel or quiet.

                This is an ``async def`` generator (``yield``s encoded
                frames); it does NOT return a boolean. Callers iterate with
                ``async for`` and rely on their outer control flow to decide
                what happens after the drain. An empty iteration means either
                (a) the ``None`` sentinel was consumed or (b) the queue
                quiesced within the drain budget.

                Algorithm:
                * Each pass drains any currently-queued items via non-blocking
                  ``get_nowait``. If the ``None`` sentinel appears we stop
                  immediately.
                * After each pass we yield one scheduler tick
                  (``asyncio.sleep(0)``) — UNCONDITIONALLY, regardless of
                  whether the pass drained anything — so any ``call_soon`` /
                  ``call_later(0)`` chained by a listener has a chance to run
                  before we probe again.
                * We loop up to ``_DRAIN_MAX_PASSES`` passes or until the
                  cumulative ``_DRAIN_BUDGET_SECONDS`` wall clock is exhausted
                  — whichever comes first. This covers listener chains that
                  need multiple scheduler ticks to materialise their enqueue
                  (e.g. a listener callback that itself schedules another
                  ``call_soon``). A single-tick early-return would drop
                  late-arriving items needing more than one ``sleep(0)`` tick.
                * Budget-exhaustion mid-pass is logged at DEBUG so operators
                  can correlate dropped events; the hard pass cap is likewise
                  logged so a pathological listener that keeps enqueueing
                  forever is visible.
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
                        # Stamp thread/run correlation on ANY event whose
                        # schema carries those fields. The listener enqueues
                        # ``"?"`` placeholders for the events it constructs
                        # (RunStarted/Finished); a future ag-ui.core event that
                        # also carries correlation would otherwise ship the
                        # stale ``"?"``s. ``_stamp_correlation_ids`` is a no-op
                        # for today's extras events (StepStarted,
                        # MessagesSnapshot, ...) since they don't declare the
                        # fields.
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
                    # Unconditionally continue up to ``_DRAIN_MAX_PASSES``
                    # (regardless of whether this pass drained anything) so a
                    # listener that needs >1 scheduler tick to enqueue — e.g.
                    # one that itself schedules another ``call_soon`` — is not
                    # silently dropped.
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
                # ``raise kickoff_task.exception()``) so the original traceback
                # is preserved — re-raising the stored exception starts a new
                # traceback chain whose innermost frame is the ``raise`` line,
                # hiding the real origin.
                if kickoff_task.done():
                    # If the task was cancelled externally, surface it as a
                    # categorised RUN_ERROR so the client can distinguish
                    # "completed successfully" from "cancelled out from under
                    # us" rather than closing the stream with no error event.
                    if kickoff_task.cancelled():
                        raise _KickoffCancelled(
                            "CrewAI kickoff task was cancelled"
                        )
                    # Guard against ``.exception()`` raising CancelledError if
                    # the task was cancelled externally: only read
                    # ``.exception()`` on a non-cancelled task.
                    if kickoff_task.exception() is not None:
                        # ``await`` re-raises the stored exception WITH its
                        # original traceback intact.
                        await kickoff_task
                    # Happy path: task finished without error. Drain any
                    # remaining queue items (e.g. the ``None`` sentinel
                    # enqueued by the FlowFinishedEvent listener), then break.
                    # Critically we do NOT fall through to
                    # ``asyncio.wait({get_task, kickoff_task}, ...)`` below,
                    # because that wait would return immediately (kickoff_task
                    # is already done) and cause a CPU spin.
                    async for encoded in _drain_queue_until_sentinel_or_empty():
                        yield encoded
                    # ``allow_grace`` only matters while the task is in flight
                    # (``_cancel_and_join`` short-circuits if the task is
                    # already done), so the default False is left here; the
                    # value is dead either way and an explicit False is less
                    # misleading.
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

                    # Prefer propagating the kickoff exception (if any) over
                    # consuming a queued event — the exception is the real
                    # story. Guard against CancelledError.
                    if (
                        kickoff_task in done
                        and not kickoff_task.cancelled()
                        and kickoff_task.exception() is not None
                    ):
                        await kickoff_task

                    if get_task in done:
                        # Narrow guard against CancelledError on
                        # ``get_task.result()``. The ``done`` membership check
                        # normally implies the task completed normally, but a
                        # concurrent outer-cancel that propagated into
                        # ``get_task`` after ``asyncio.wait`` returned can
                        # leave it ``done()`` AND ``cancelled()`` — reading
                        # ``.result()`` then raises CancelledError, bypassing
                        # the ``except`` handlers below. Fall back to the
                        # ``_UNSET`` sentinel so the next loop iteration hits
                        # the ``kickoff_task.done()`` fast path.
                        try:
                            item = get_task.result()
                        except asyncio.CancelledError:
                            item = _UNSET
                    else:
                        # kickoff finished without error but no item was
                        # enqueued yet; the top-of-loop guard on the next
                        # iteration will observe ``kickoff_task.done()`` and
                        # drain via the fast path above (no spin).
                        pass
                finally:
                    # Cancel-race guard: between ``asyncio.wait`` returning and
                    # us cancelling ``get_task``, the queue may have delivered
                    # an item to the getter. If we blindly cancel, that item is
                    # dropped. Check ``get_task.done()`` first and, if so,
                    # harvest the result (even when the primary branch above
                    # did not because ``get_task`` was not in ``done`` — e.g.
                    # it completed between ``asyncio.wait`` returning and this
                    # ``finally``).
                    if not get_task.done():
                        get_task.cancel()
                    elif item is _UNSET and not get_task.cancelled():
                        try:
                            pending_item = get_task.result()
                        except Exception:  # noqa: BLE001
                            # Narrow from BaseException. ``queue.get()`` cannot
                            # produce SystemExit / KeyboardInterrupt /
                            # CancelledError through its result path in
                            # practice; if anything does it is a runtime bug we
                            # should not swallow. ``Exception`` keeps the
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

                # Stamp correlation on any event whose schema declares the
                # fields (see _stamp_correlation_ids). RUN_STARTED /
                # RUN_FINISHED always do; future correlated events are covered
                # automatically.
                _stamp_correlation_ids(
                    item,
                    thread_id=input_data.thread_id,
                    run_id=input_data.run_id,
                )

                yield encoder.encode(item)

        except _KickoffCancelled:
            # Kickoff task was cancelled externally (not by our teardown path,
            # which propagates CancelledError through to the outer scope).
            # Emit a categorised RUN_ERROR so the client can distinguish an
            # external cancel from a clean finish.
            _LOGGER.warning(
                "CrewAI kickoff cancelled externally thread=%s run=%s",
                input_data.thread_id,
                input_data.run_id,
            )
            message = (
                f"thread={input_data.thread_id} run={input_data.run_id}: "
                # Align wording with the internal sentinel message so the code
                # (``AGUI_CREWAI_KICKOFF_CANCELLED``), the server-side log, and
                # the client-facing message all agree on "kickoff".
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
            # Ceiling-fired path: our configured flow deadline tripped. Message
            # / code must advertise the ceiling actually in force so downstream
            # alerting can trust the signal. ``timeout`` is guaranteed finite
            # positive here — the only sites that raise ``_CeilingExceeded``
            # are guarded by a deadline that requires a positive ``timeout``.
            ceiling_display = f"{timeout:g}s"
            _LOGGER.warning(
                "CrewAI flow exceeded ceiling thread=%s run=%s ceiling=%s detail=%s",
                input_data.thread_id,
                input_data.run_id,
                ceiling_display,
                # Include the helper's descriptive message in the server-side
                # log so traceback / grep lines carry the human-readable form
                # without the client round-tripping through the exception repr.
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
            # Upstream timeout path: a ``TimeoutError`` bubbled out of
            # ``kickoff_async`` itself — typically a LiteLLM/httpx read
            # timeout. Our ceiling did NOT fire; we MUST NOT advertise
            # ``AGUI_CREWAI_FLOW_TIMEOUT``, which downstream consumers treat as
            # "we hit the configured ceiling". Use a distinct code + message so
            # alerting can distinguish the two failure modes.
            #
            # ``timeout`` here can be anything (finite ceiling or ``None`` when
            # disabled). We surface it for operator context but make clear the
            # ceiling did not fire.
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
            # Tight message: the exception class name already lives in
            # ``code`` (AGUI_CREWAI_FLOW_ERROR_<Class>) and the run_id already
            # appears once as a prefix — do not duplicate.
            message = (
                f"thread={input_data.thread_id} run={input_data.run_id}: "
                f"CrewAI flow failed; see server logs"
            )
            # Sanitize the exception class name before embedding it in the
            # ``code`` field. Python exception classes can have
            # dynamically-generated or unicode names, which would violate the
            # ``^[A-Z][A-Z0-9_]+$`` convention peer events follow and break
            # downstream regex-matchers.
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
            # Flush the crewai event bus at run end so in-flight off-thread
            # handlers settle before we drop the queue / reset the context var
            # (crewai 1.x can otherwise drop them). Best-effort and a no-op on
            # crewai builds without ``flush``.
            try:
                await _flush_event_bus()
            finally:
                try:
                    await delete_queue(flow_copy)
                finally:
                    flow_context.reset(token)


async def _aclose_stream_session(
    session: object,
    *,
    thread_id: str | None,
    run_id: str | None,
) -> None:
    """Best-effort ``aclose()`` teardown for a crewai ``AsyncStreamSession``.

    ``aclose()`` replaces the legacy ``_cancel_and_join`` machinery on the
    StreamFrame path — it cancels the background kickoff task crewai spawns
    inside ``astream`` and closes the frame iterator. The OBSERVABLE behavior
    (client-disconnect tears the run down, no leaked kickoff) must not regress.

    Mirrors the ``_cancel_and_join`` uncancel dance: on Python 3.11+ a bare
    ``await session.aclose()`` in a ``finally`` reached via outer cancellation
    would re-raise ``CancelledError`` on entry (``Task.cancelling()`` is still
    non-zero), so ``aclose`` would never run and the kickoff task would leak.
    We ``uncancel`` (via ``getattr`` for 3.10 compat) so the teardown
    completes; the original in-flight cancellation resumes propagating once the
    generator's ``finally`` unwinds.
    """
    aclose = getattr(session, "aclose", None)
    if not callable(aclose):
        return
    # Uncancel ONLY when a cancellation is actually pending on this task. An
    # unconditional ``uncancel()`` would consume a cancellation LEVEL even on
    # the happy-path teardown (``aclose`` reached with no outer cancel) — a
    # level that isn't ours to consume, so a later legitimate cancel would then
    # need one extra ``cancel()`` to take effect. The uncancel dance exists
    # only to let the ``await aclose()`` below run when we were reached VIA an
    # outer cancel (on 3.11+ a bare await in that state re-raises on entry).
    # ``cancelling()`` is 3.11+; on 3.10 it's absent and ``uncancel`` is too,
    # so the guard is a no-op there (the bare await works on 3.10 regardless).
    current = asyncio.current_task()
    uncancel = getattr(current, "uncancel", None)
    cancelling = getattr(current, "cancelling", None)
    if callable(uncancel) and callable(cancelling) and cancelling() > 0:
        uncancel()
    try:
        await aclose()
    except asyncio.CancelledError:
        # aclose itself was cancelled; re-raise so the cancellation is not
        # silently swallowed (mirrors _cancel_and_join re-raise semantics).
        raise
    except Exception as exc:  # pylint: disable=broad-exception-caught
        _LOGGER.debug(
            "CrewAI astream aclose failed thread=%s run=%s cause=%s",
            thread_id,
            run_id,
            type(exc).__name__,
        )


async def _drain_frames_after_finish(aiter: Any) -> None:
    """Drain the terminal tail of a frame stream after RUN_FINISHED.

    crewai enqueues its end sentinel only AFTER ``kickoff_async`` fully returns —
    result recorded, trace batch finalized — see ``create_async_frame_generator``
    in crewai's ``utilities/streaming.py``: the ``flow_finished`` FRAME is emitted
    from inside ``kickoff_async``, but the ``None`` that ends the iterator lands
    only in the run task's ``finally``, one or more loop turns later.

    If the driver ``break``s the instant RUN_FINISHED is emitted and lets the
    ``finally`` ``aclose()`` the session, crewai's frame generator is
    ``GeneratorExit``-ed at its ``yield`` and its OWN ``finally`` ``task.cancel()``s
    the still-finalizing kickoff task — on EVERY happy-path run (verified against
    the 1.15.7 wheel: the session ends ``is_cancelled=True`` with no ``result``).
    Draining to natural ``StopAsyncIteration`` instead lets the run task reach its
    end sentinel, so the subsequent ``aclose()`` is a no-op and the kickoff is
    never cancelled mid-finalization. This is the frame-path analogue of the
    legacy path's ``_cancel_and_join(allow_grace=True)`` happy-path window.

    Bounded by ``_CANCEL_GRACE_SECONDS`` so a pathological finalization cannot
    stall teardown — on grace expiry we return and the ``finally``'s ``aclose()``
    force-cancels the tail (today's behavior, but only after the grace). Trailing
    frames are DISCARDED: emitting any wire event after RUN_FINISHED would violate
    the AG-UI run lifecycle, and a late upstream error can no longer become a
    RUN_ERROR, so it is swallowed here rather than surfaced.
    """
    grace_deadline = time.monotonic() + _CANCEL_GRACE_SECONDS
    while True:
        remaining = grace_deadline - time.monotonic()
        if remaining <= 0:
            return
        try:
            await asyncio.wait_for(aiter.__anext__(), timeout=remaining)
        except StopAsyncIteration:
            # Run task reached its end sentinel: finalization completed.
            return
        except (asyncio.TimeoutError, TimeoutError):
            # Grace window elapsed; fall back to the aclose() cancel.
            return
        except Exception:  # pylint: disable=broad-exception-caught
            # Post-terminal: a late error cannot become a RUN_ERROR now.
            return
        # A trailing frame arrived before exhaustion — discard it (no
        # post-RUN_FINISHED wire events) and keep draining.


async def _run_flow_frame_stream(
    *,
    flow_copy: object,
    encoder: EventEncoder,
    input_data: RunAgentInput,
    inputs: dict,
    timeout: float | None,
    checkpoint_kwargs: dict | None = None,
    hitl_options: HITLOptions | None = None,
    emit_raw_events: bool = False,
):
    """StreamFrame-path driver: drive ``flow.astream`` and yield encoded AG-UI
    events.

    The behavior-preserving replacement for ``_run_flow_event_stream`` on crewai
    >= 1.6. Instead of a process-global bus listener enqueuing onto a per-flow
    ``asyncio.Queue`` (keyed by a uuid stamped on the Flow), we consume the
    ordered ``StreamFrame`` envelopes crewai's scoped stream sink produces and
    map them through the single ``StreamFrameTranslator`` seam.

    Every must-survive behavior of the legacy path is preserved by REUSING the
    same helpers:

    * the four-code RUN_ERROR taxonomy (``AGUI_CREWAI_FLOW_TIMEOUT`` /
      ``AGUI_CREWAI_UPSTREAM_TIMEOUT`` / ``AGUI_CREWAI_FLOW_ERROR_<Class>``) via
      ``_CeilingExceeded`` / ``_format_timeout_message`` / ``_sanitize_exception_code``;
    * the wall-clock ceiling + env knobs (``timeout`` is ``_flow_timeout_seconds()``);
    * ``_stamp_correlation_ids`` on every emitted event and
      ``_run_error_extras`` (camelCase wire aliases) on every RUN_ERROR;
    * client-disconnect teardown via ``aclose()`` (see ``_aclose_stream_session``).

    ``flow_context`` is set so the ``sdk.copilotkit_*`` helpers can emit their
    ``Bridged*`` events; those reach the scoped sink synchronously because
    ``event_bus._prepare_event`` calls ``publish_stream_event`` on every
    ``emit``.

    Payload + identity come from the RAW event, not ``frame.data``. We register
    our OWN scoped sink that parks the raw event object keyed by
    ``event.event_id``. Outer-flow lifecycle/method events are parked only when
    ``source is flow_copy`` (so a nested ``crew.kickoff``'s own flow's
    lifecycle/method events, which leak onto this same sink via the copied
    contextvars, are excluded); Crew/Agent lifecycle events are parked
    regardless of source (they are run-scoped and arrive with a non-outer
    source) so the translator can attribute the crew/agent hierarchy. The frame
    stream then supplies ORDERING; for each frame we look
    up the parked raw event by ``frame.id`` and translate it. A frame with no
    parked event is skipped.

    Because ``publish_stream_event`` runs the sink synchronously on ``emit``
    and crewai enqueues the frame via ``loop.call_soon_threadsafe`` (a later
    loop turn), the raw event is ALWAYS parked before its frame is dequeued.
    """
    token = flow_context.set(flow_copy)
    translator = StreamFrameTranslator(
        thread_id=input_data.thread_id,
        run_id=input_data.run_id,
        state_provider=lambda: getattr(flow_copy, "state", {}),
        hitl_options=hitl_options,
    )

    def _closing_reasoning_frames():
        """Encoded REASONING_* END events for any reasoning left open at error.

        Emitted before a RUN_ERROR so a run that fails mid-reasoning does not
        leave a half-open lifecycle on the wire. A no-op when nothing is open.
        """
        for reasoning_event in translator.flush_open_reasoning():
            _stamp_correlation_ids(
                reasoning_event,
                thread_id=input_data.thread_id,
                run_id=input_data.run_id,
            )
            yield encoder.encode(reasoning_event)
    # Raw-event lookup buffer, populated by our scoped sink below. Keyed by
    # ``event.event_id`` (== ``StreamFrame.id``). Only OUTER-flow events land
    # here (source gate), which is exactly the nested-flow filter: nested
    # frames find nothing here and are dropped.
    raw_events: dict[str, Any] = {}
    # Second buffer for foreign-source events, populated only when RAW is enabled.
    # crewai emits its llm / agent / task / tool events with the EMITTER as source
    # (``crewai_event_bus.emit(self, event=...)``), never the flow, so the outer-flow
    # gate below drops all of them - including ``llm_thinking_chunk``. Parking them
    # separately keeps the translation gate intact, so a foreign event can never
    # synthesize a run lifecycle event or a state snapshot.
    foreign_events: dict[str, Any] = {}
    # RAW mirrors that arrived BEFORE RUN_STARTED, from either source. Released in
    # order right after the run opens: crewai raises some events before the flow
    # starts, and a RAW first event makes @ag-ui/client's verifyEvents throw
    # "First event must be 'RUN_STARTED'".
    pending_raw: list[Any] = []

    def _hold_pending_raw(raw_mirror: Any) -> None:
        """Park a RAW mirror until the run has opened, logging an overflow drop."""
        if len(pending_raw) >= _FOREIGN_EVENT_BUFFER_MAX:
            log_raw_loss(
                "ag-ui-crewai RAW passthrough dropped a pre-RUN_STARTED mirror (hold "
                "buffer full at %d) thread=%s run=%s",
                _FOREIGN_EVENT_BUFFER_MAX,
                input_data.thread_id,
                input_data.run_id,
            )
            return
        pending_raw.append(raw_mirror)

    def _emit_raw(raw_mirror: Any) -> Any:
        """Correlate and encode a RAW mirror for the wire."""
        _stamp_correlation_ids(
            raw_mirror,
            thread_id=input_data.thread_id,
            run_id=input_data.run_id,
        )
        return encoder.encode(raw_mirror)

    def _sink(source: Any, event: Any) -> None:
        # source is flow_copy isolates the outer run: its own lifecycle/method
        # events and our Bridged* events carry flow_copy as source, while a
        # nested crew.kickoff's own flow's lifecycle/method events leak here
        # with a different source and must stay dropped (no double RUN_STARTED,
        # no mis-nested method). MCP, backend tool (ToolUsage), Crew/Agent
        # lifecycle, and native thinking-chunk events are parked regardless of
        # source because this sink is scoped to the run's context (no cross-run
        # leak); crew/agent events let the translator attribute the hierarchy.
        # crewai's native LLMThinkingChunkEvent (Gemini provider) is emitted with
        # the LLM as source (not flow_copy): park it in raw_events so it is
        # TRANSLATED to REASONING_* -- it therefore never also lands in
        # foreign_events, so RAW passthrough cannot double-emit it. Any other
        # foreign event is parked for RAW passthrough only when opt-in is on
        # (bounded buffer, oldest evicted with a log).
        event_id = getattr(event, "event_id", None)
        if event_id is None:
            return
        if (
            source is flow_copy
            or is_mcp_event(event)
            or is_backend_tool_event(event)
            or is_thinking_event(event)
            or getattr(event, "type", None) in CREW_AGENT_LIFECYCLE_TYPES
        ):
            raw_events[event_id] = event
        elif emit_raw_events:
            if len(foreign_events) >= _FOREIGN_EVENT_BUFFER_MAX:
                evicted = next(iter(foreign_events), None)
                if evicted is None:
                    log_raw_loss(
                        "ag-ui-crewai RAW passthrough is disabled by a buffer cap of "
                        "%d thread=%s run=%s",
                        _FOREIGN_EVENT_BUFFER_MAX,
                        input_data.thread_id,
                        input_data.run_id,
                    )
                    return
                del foreign_events[evicted]
                log_raw_loss(
                    "ag-ui-crewai RAW passthrough evicted the oldest parked foreign "
                    "event (buffer full at %d) thread=%s run=%s; its RAW mirror is lost",
                    _FOREIGN_EVENT_BUFFER_MAX,
                    input_data.thread_id,
                    input_data.run_id,
                )
            foreign_events[event_id] = event

    # Predeclared before the ``try`` so the ``finally`` teardown is always safe
    # to reference even if sink registration or ``astream``/``__aiter__`` raises
    # before assignment. ``flow_context`` is set ABOVE and reset in the
    # ``finally`` — mirroring the legacy path's token-then-finally discipline.
    sink_token = None
    session = None
    try:
        try:
            # Register the sink and open the stream INSIDE the ``try`` so a
            # raising ``astream``/``__aiter__`` (a) is caught and mapped through
            # the RUN_ERROR taxonomy below instead of escaping the generator with
            # no terminal event, and (b) never leaks the ``flow_context`` token.
            # Register BEFORE the first ``__anext__``: crewai's astream spawns
            # the flow-running task
            # on first iteration and copies the CURRENT context, so the sink must
            # already be in scope to reach the flow's emits. Guarded so a partial
            # install (no sink API) degrades rather than crashing.
            sink_token = add_stream_sink(_sink) if callable(add_stream_sink) else None
            # ``astream`` returns an AsyncStreamSession; iterating it spawns
            # crewai's background kickoff task and streams ordered frames.
            # Filter against astream's own signature so an unsupported kwarg
            # degrades cleanly instead of raising.
            _ckpt = supported_checkpoint_kwargs(
                flow_copy.astream, checkpoint_kwargs or {}  # type: ignore[attr-defined]
            )
            if checkpoint_kwargs and not _ckpt:
                # Checkpointing enabled but this flow's astream does not accept
                # it: warn so the no-op is visible.
                _LOGGER.warning(
                    "ag-ui-crewai: checkpointing is enabled but flow.astream "
                    "does not accept from_checkpoint; nothing will be persisted "
                    "for this run."
                )
            session = flow_copy.astream(inputs=inputs, **_ckpt)  # type: ignore[attr-defined]
            aiter = session.__aiter__()
            deadline = (
                time.monotonic() + timeout if timeout is not None else None
            )
            while True:
                # Enforce the wall-clock ceiling per frame read via
                # ``asyncio.wait_for``: on timeout it cancels the in-flight
                # ``__anext__`` AND awaits its unwind before raising, so crewai's
                # scoped stream sink / background kickoff task tear down cleanly;
                # ``aclose()`` in the ``finally`` then fully drains the task.
                #
                # Cross-version note (``requires-python`` floor is 3.10):
                # ``wait_for`` internals differ. On 3.12+ it awaits the
                # coroutine inline (no Task wrap, no context copy); on 3.10/3.11
                # it unconditionally does ``fut = ensure_future(fut)``, wrapping
                # ``__anext__`` in a Task and copying the current context per
                # read. The per-read context copy on 3.10/3.11 is HARMLESS here:
                # our ``_sink`` is registered (above) BEFORE this loop, so every
                # per-read context copy inherits it and crewai's
                # ``publish_stream_event`` still reaches it; and both our own and
                # crewai's sink-token ``reset``s happen OUTSIDE the wrapped
                # ``__anext__`` boundary, so no token is reset in a foreign
                # context. Do NOT swap this for a hand-rolled ``ensure_future``
                # + ``asyncio.wait``: that would lose the cancel-and-await-unwind
                # semantics ``wait_for`` gives us on timeout.
                if deadline is not None:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise _CeilingExceeded(_format_timeout_message(timeout))
                    try:
                        frame = await asyncio.wait_for(
                            aiter.__anext__(), timeout=remaining
                        )
                    except StopAsyncIteration:
                        break
                    except (asyncio.TimeoutError, TimeoutError) as te:
                        # ``wait_for``'s own timeout fires only once the
                        # deadline is reached; an upstream ``TimeoutError``
                        # raised by the flow propagates BEFORE that. Use the
                        # wall clock to disambiguate: at/past the deadline =>
                        # our ceiling; earlier => an upstream read timeout that
                        # must NOT masquerade as AGUI_CREWAI_FLOW_TIMEOUT.
                        if time.monotonic() >= deadline:
                            raise _CeilingExceeded(
                                _format_timeout_message(timeout)
                            ) from te
                        raise
                else:
                    try:
                        frame = await aiter.__anext__()
                    except StopAsyncIteration:
                        break

                # Look up the RAW event this frame carries (parked by our sink).
                # Missing => a nested-flow / crewai-internal frame we drop, so
                # the outer run's wire shape stays identical to the legacy path.
                raw_event = raw_events.pop(frame.id, None)
                if raw_event is None:
                    # Not an outer-flow (or MCP) event. With RAW passthrough on, mirror
                    # it if we parked it: crewai's llm / agent / task / tool channels
                    # and nested-flow lifecycle events all land here.
                    foreign_event = foreign_events.pop(frame.id, None)
                    if foreign_event is None:
                        continue
                    raw_mirror = raw_event_for(foreign_event)
                    if raw_mirror is None:
                        continue
                    if not translator.run_started:
                        _hold_pending_raw(raw_mirror)
                        continue
                    yield _emit_raw(raw_mirror)
                    continue

                if emit_raw_events and not is_recognized_event(raw_event):
                    # An OUTER-flow event the translator does not map. Mirrored here
                    # rather than through ``translate`` so the translator keeps one
                    # responsibility, and gated the same way as the foreign path.
                    raw_mirror = raw_event_for(raw_event)
                    if raw_mirror is not None:
                        if translator.run_started:
                            yield _emit_raw(raw_mirror)
                        else:
                            _hold_pending_raw(raw_mirror)

                for event in translator.translate(raw_event):
                    _stamp_correlation_ids(
                        event,
                        thread_id=input_data.thread_id,
                        run_id=input_data.run_id,
                    )
                    yield encoder.encode(event)

                if pending_raw and translator.run_started:
                    # The run just opened: flush the mirrors held back so they land
                    # AFTER RUN_STARTED, in arrival order.
                    held, pending_raw = pending_raw, []
                    for raw_mirror in held:
                        yield _emit_raw(raw_mirror)

                if translator.run_finished:
                    # RUN_FINISHED just emitted. Do NOT break-then-aclose(): that
                    # cancels crewai's still-finalizing kickoff task on every
                    # happy-path run. Drain the terminal tail to
                    # natural exhaustion (bounded by the cancel grace) so the run
                    # task completes and the ``finally`` aclose() is a no-op.
                    await _drain_frames_after_finish(aiter)
                    break

            # Belt-and-braces terminal: the stream can exhaust with the run
            # open but no outer ``flow_finished`` — e.g. the
            # outer method caught a nested-flow error and returned, or a flow
            # paused for human feedback. Emit the missing RUN_FINISHED so the
            # client never sees a run that never ends. The RUN_ERROR paths below
            # are the terminator for the errored case and never reach here.
            #
            # Open the run first when a pause was captured but RUN_STARTED never
            # went out (no flow_started frame): otherwise finalize() would
            # short-circuit and strand the paused run with an empty stream.
            interrupt_open = (
                translator.ensure_run_started() if translator.interrupted else []
            )
            for event in (*interrupt_open, *translator.finalize()):
                _stamp_correlation_ids(
                    event,
                    thread_id=input_data.thread_id,
                    run_id=input_data.run_id,
                )
                yield encoder.encode(event)

        except _HUMAN_FEEDBACK_PENDING_EXC as pending_exc:
            # The pause PROPAGATED out of astream instead of ending the stream
            # cleanly. Seed the pause from the exception context (in case the
            # frames never arrived) and emit the interrupt tail, NOT a
            # RUN_ERROR, which would misreport a paused run as failed. Open the
            # run first: if the pause propagated before a flow_started frame was
            # translated, finalize() would otherwise short-circuit and emit
            # nothing (empty, unresumable stream).
            translator.note_pause_from_context(getattr(pending_exc, "context", None))
            for event in (*translator.ensure_run_started(), *translator.finalize()):
                _stamp_correlation_ids(
                    event,
                    thread_id=input_data.thread_id,
                    run_id=input_data.run_id,
                )
                yield encoder.encode(event)
        except _CeilingExceeded as ceiling_exc:
            ceiling_display = f"{timeout:g}s"
            _LOGGER.warning(
                "CrewAI flow exceeded ceiling thread=%s run=%s ceiling=%s detail=%s",
                input_data.thread_id,
                input_data.run_id,
                ceiling_display,
                ceiling_exc.args[0] if ceiling_exc.args else "",
            )
            message = (
                f"thread={input_data.thread_id} run={input_data.run_id}: "
                f"CrewAI flow exceeded ceiling={ceiling_display}"
            )
            for reasoning_frame in _closing_reasoning_frames():
                yield reasoning_frame
            yield encoder.encode(
                RunErrorEvent(
                    message=message,
                    code="AGUI_CREWAI_FLOW_TIMEOUT",
                    **_run_error_extras(input_data),
                )
            )
        except (asyncio.TimeoutError, TimeoutError) as upstream_exc:
            # An upstream ``TimeoutError`` bubbled out of the flow (e.g. a
            # LiteLLM/httpx read timeout) — NOT our ceiling. Distinct code so
            # alerting can tell the two apart.
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
            for reasoning_frame in _closing_reasoning_frames():
                yield reasoning_frame
            yield encoder.encode(
                RunErrorEvent(
                    message=message,
                    code="AGUI_CREWAI_UPSTREAM_TIMEOUT",
                    **_run_error_extras(input_data),
                )
            )
        except Exception as e:  # pylint: disable=broad-exception-caught
            _LOGGER.exception(
                "CrewAI flow failed thread=%s run=%s cause=%s",
                input_data.thread_id,
                input_data.run_id,
                type(e).__name__,
            )
            message = (
                f"thread={input_data.thread_id} run={input_data.run_id}: "
                f"CrewAI flow failed; see server logs"
            )
            sanitized_name = _sanitize_exception_code(type(e).__name__)
            for reasoning_frame in _closing_reasoning_frames():
                yield reasoning_frame
            yield encoder.encode(
                RunErrorEvent(
                    message=message,
                    code=f"AGUI_CREWAI_FLOW_ERROR_{sanitized_name}",
                    **_run_error_extras(input_data),
                )
            )
    finally:
        # aclose() replaces _cancel_and_join on this path; run it
        # unconditionally (including under outer cancellation) so the kickoff
        # task never leaks, then unregister the sink and reset the context var.
        try:
            await _aclose_stream_session(
                session,
                thread_id=input_data.thread_id,
                run_id=input_data.run_id,
            )
        finally:
            try:
                if sink_token is not None and callable(reset_stream_sinks):
                    reset_stream_sinks(sink_token)
            finally:
                flow_context.reset(token)


def _run_flow_stream(
    *,
    flow_copy: object,
    encoder: EventEncoder,
    input_data: RunAgentInput,
    inputs: dict,
    timeout: float | None,
    checkpoint_kwargs: dict | None = None,
    hitl_options: HITLOptions | None = None,
    emit_raw_events: bool = False,
):
    """Select the StreamFrame path (crewai >= 1.6 + a real ``astream`` flow) or
    the legacy bus-listener path, returning the chosen async generator.

    The probe is per-flow (``flow_supports_stream_frames``): the test doubles in
    ``tests/test_task_cancellation.py`` implement only ``kickoff_async`` and so
    transparently keep the legacy path (and its 27 cancellation tests). Real
    crewai 1.6+ Flows take the StreamFrame path; crewai 1.0-1.5 falls back.

    ``checkpoint_kwargs`` is forwarded to whichever driver is chosen; each
    driver filters it against the exact method it invokes.
    """
    if flow_supports_stream_frames(flow_copy):
        return _run_flow_frame_stream(
            flow_copy=flow_copy,
            encoder=encoder,
            input_data=input_data,
            inputs=inputs,
            timeout=timeout,
            checkpoint_kwargs=checkpoint_kwargs,
            hitl_options=hitl_options,
            emit_raw_events=emit_raw_events,
        )
    return _run_flow_event_stream(
        flow_copy=flow_copy,
        encoder=encoder,
        input_data=input_data,
        inputs=inputs,
        timeout=timeout,
        checkpoint_kwargs=checkpoint_kwargs,
        emit_raw_events=emit_raw_events,
    )


# Sentinel enqueued by the resume task's done-callback so the consume loop knows
# the resumed coroutine returned (vs a raw crewai event).
_RESUME_DONE = object()


async def _reject_unsupported_resume(input_data: RunAgentInput, encoder: EventEncoder):
    """Emit a single RUN_ERROR for a resume the installed crewai cannot honour.

    A resume request arrived but the async-HITL API is unavailable (crewai too
    old, or a flow that cannot pause/resume). Fail loudly and correlated rather
    than silently starting a fresh run.
    """
    _LOGGER.warning(
        "CrewAI resume requested but async human-feedback is unsupported "
        "thread=%s run=%s (need crewai>=%s + StreamFrame)",
        input_data.thread_id,
        input_data.run_id,
        HITL_ENABLING_VERSIONS["human_feedback"],
    )
    yield encoder.encode(
        RunErrorEvent(
            message=(
                f"thread={input_data.thread_id} run={input_data.run_id}: CrewAI "
                f"resume is unsupported by this deployment; async human-feedback "
                f"needs crewai>={HITL_ENABLING_VERSIONS['human_feedback']} with "
                f"the StreamFrame transport"
            ),
            code="AGUI_CREWAI_RESUME_UNSUPPORTED",
            **_run_error_extras(input_data),
        )
    )


async def _run_flow_resume_stream(
    *,
    flow: object,
    encoder: EventEncoder,
    input_data: RunAgentInput,
    timeout: float | None,
    hitl_options: HITLOptions | None = None,
    emit_raw_events: bool = False,
):
    """Resume a flow paused for async human feedback and yield AG-UI events.

    Reloads the pending flow via ``Flow.from_pending(thread_id)`` (crewai's own
    persistence, NOT a per-request copy, since only the persisted pending
    state carries the resume point), drives ``resume_async(feedback)``, and maps
    the resumed run's events through the same ``StreamFrameTranslator`` as a
    kickoff. Events are captured via a scoped stream sink (``resume_async`` has
    no ``astream`` session), so ``publish_stream_event`` delivers each raw event
    synchronously on emit; ordering is preserved by the queue.

    Reuses the kickoff drivers' RUN_ERROR taxonomy, wall-clock ceiling, and
    ``_cancel_and_join`` teardown so cancellation / disconnect behaviour does not
    diverge across the two paths.
    """
    thread_id = input_data.thread_id
    run_id = input_data.run_id
    feedback, _interrupt_id = feedback_from_resume(input_data)

    # Reload the pending flow. ``from_pending`` builds its own instance from the
    # class + crewai persistence; a missing pending state (unknown / already
    # resumed thread) is a client-correlated 4xx-style condition, distinct from
    # an internal failure.
    try:
        resumed_flow = type(flow).from_pending(thread_id)  # type: ignore[attr-defined]
    except ValueError as exc:
        _LOGGER.warning(
            "CrewAI resume found no pending feedback thread=%s run=%s cause=%s",
            thread_id,
            run_id,
            exc,
        )
        yield encoder.encode(
            RunErrorEvent(
                message=(
                    f"thread={thread_id} run={run_id}: no paused CrewAI flow to "
                    f"resume (unknown or already-resumed thread)"
                ),
                code="AGUI_CREWAI_NO_PENDING_FEEDBACK",
                **_run_error_extras(input_data),
            )
        )
        return
    except Exception as exc:  # pylint: disable=broad-exception-caught
        _LOGGER.exception(
            "CrewAI resume reload failed thread=%s run=%s cause=%s",
            thread_id,
            run_id,
            type(exc).__name__,
        )
        yield encoder.encode(
            RunErrorEvent(
                message=(
                    f"thread={thread_id} run={run_id}: CrewAI resume reload "
                    f"failed; see server logs"
                ),
                code=f"AGUI_CREWAI_FLOW_ERROR_{_sanitize_exception_code(type(exc).__name__)}",
                **_run_error_extras(input_data),
            )
        )
        return

    token = flow_context.set(resumed_flow)
    translator = StreamFrameTranslator(
        thread_id=thread_id,
        run_id=run_id,
        state_provider=lambda: getattr(resumed_flow, "state", {}),
        hitl_options=hitl_options,
        resumed=True,
    )
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue()

    def _sink(source: Any, event: Any) -> None:
        # Outer-run isolation identical to the kickoff frame driver: only this
        # flow's own events (plus MCP events, emitted with the agent as source).
        if source is resumed_flow or is_mcp_event(event):
            loop.call_soon_threadsafe(queue.put_nowait, event)

    # Predeclared before the try so the finally teardown is always safe to
    # reference even if sink registration raises; the actual registration runs
    # INSIDE the try (mirroring the kickoff frame driver) so a failure is mapped
    # through the RUN_ERROR taxonomy AND the flow_context token never leaks.
    sink_token = None
    resume_task: asyncio.Task | None = None
    allow_grace = False
    try:
        try:
            sink_token = add_stream_sink(_sink) if callable(add_stream_sink) else None
            resume_task = asyncio.create_task(
                resumed_flow.resume_async(feedback)  # type: ignore[attr-defined]
            )
            resume_task.add_done_callback(
                lambda _t: loop.call_soon_threadsafe(queue.put_nowait, _RESUME_DONE)
            )
            # Open the run BEFORE consuming so RUN_STARTED is always the first
            # wire event, even if resume_async emits no flow_started. A later
            # flow_started is suppressed by the same idempotency flag, so this
            # never doubles RUN_STARTED.
            for event in translator.ensure_run_started():
                _stamp_correlation_ids(event, thread_id=thread_id, run_id=run_id)
                yield encoder.encode(event)
            deadline = (
                time.monotonic() + timeout if timeout is not None else None
            )
            while True:
                if deadline is not None:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise _CeilingExceeded(_format_timeout_message(timeout))
                    try:
                        item = await asyncio.wait_for(queue.get(), timeout=remaining)
                    except (asyncio.TimeoutError, TimeoutError) as te:
                        # Same disambiguation as the kickoff driver: a wait_for
                        # timeout at/past the deadline is OUR ceiling firing
                        # (AGUI_CREWAI_FLOW_TIMEOUT), not an upstream read
                        # timeout. Re-raise anything earlier unchanged.
                        if time.monotonic() >= deadline:
                            raise _CeilingExceeded(
                                _format_timeout_message(timeout)
                            ) from te
                        raise
                else:
                    item = await queue.get()

                if item is _RESUME_DONE:
                    # resume_async returned. A trailing event emitted on a crewai
                    # worker thread can be call_soon_threadsafe-scheduled AFTER
                    # the done-callback, so a single pass could miss it. Drain
                    # across bounded scheduler ticks (mirrors the kickoff driver's
                    # multi-pass drain) so late puts still land before terminate.
                    drain_deadline = time.monotonic() + _DRAIN_BUDGET_SECONDS
                    for _ in range(_DRAIN_MAX_PASSES):
                        while not queue.empty():
                            pending_item = queue.get_nowait()
                            if pending_item is _RESUME_DONE:
                                continue
                            for event in translator.translate(pending_item):
                                _stamp_correlation_ids(
                                    event, thread_id=thread_id, run_id=run_id
                                )
                                yield encoder.encode(event)
                        if time.monotonic() >= drain_deadline:
                            break
                        await asyncio.sleep(0)
                    allow_grace = True
                    break

                if emit_raw_events and not is_recognized_event(item):
                    # Same RAW passthrough as the kickoff driver: mirror an event
                    # the translator does not map. RUN_STARTED is already out
                    # (opened before the loop), so no hold-until-started buffer
                    # is needed here.
                    raw_mirror = raw_event_for(item)
                    if raw_mirror is not None:
                        _stamp_correlation_ids(
                            raw_mirror, thread_id=thread_id, run_id=run_id
                        )
                        yield encoder.encode(raw_mirror)

                for event in translator.translate(item):
                    _stamp_correlation_ids(event, thread_id=thread_id, run_id=run_id)
                    yield encoder.encode(event)
                if translator.run_finished:
                    allow_grace = True
                    break

            # Surface a resume_async failure through the RUN_ERROR taxonomy
            # rather than a swallowed traceback (the done-callback fires for
            # both return and raise).
            if resume_task.done() and not resume_task.cancelled():
                exc = resume_task.exception()
                if exc is not None:
                    raise exc

            # Terminal: RUN_STARTED was already emitted above. FlowFinished
            # closes the run with RUN_FINISHED; a re-pause closes it with the
            # interrupt tail; a clean return with neither is closed by the
            # belt-and-braces RUN_FINISHED. All three flow through finalize().
            for event in translator.finalize():
                _stamp_correlation_ids(event, thread_id=thread_id, run_id=run_id)
                yield encoder.encode(event)

        except _HUMAN_FEEDBACK_PENDING_EXC as pending_exc:
            # A re-pause that PROPAGATED (rather than being returned) out of
            # resume_async. Seed from context and emit the interrupt tail so the
            # client can resume again, instead of a RUN_ERROR.
            translator.note_pause_from_context(getattr(pending_exc, "context", None))
            for event in translator.finalize():
                _stamp_correlation_ids(event, thread_id=thread_id, run_id=run_id)
                yield encoder.encode(event)
        except _CeilingExceeded as ceiling_exc:
            ceiling_display = f"{timeout:g}s"
            _LOGGER.warning(
                "CrewAI resume exceeded ceiling thread=%s run=%s ceiling=%s detail=%s",
                thread_id,
                run_id,
                ceiling_display,
                ceiling_exc.args[0] if ceiling_exc.args else "",
            )
            yield encoder.encode(
                RunErrorEvent(
                    message=(
                        f"thread={thread_id} run={run_id}: CrewAI flow exceeded "
                        f"ceiling={ceiling_display}"
                    ),
                    code="AGUI_CREWAI_FLOW_TIMEOUT",
                    **_run_error_extras(input_data),
                )
            )
        except (asyncio.TimeoutError, TimeoutError) as upstream_exc:
            ceiling_display = "disabled" if timeout is None else f"{timeout:g}s"
            _LOGGER.warning(
                "CrewAI upstream timeout during resume thread=%s run=%s "
                "ceiling=%s cause=%s",
                thread_id,
                run_id,
                ceiling_display,
                type(upstream_exc).__name__,
            )
            yield encoder.encode(
                RunErrorEvent(
                    message=(
                        f"thread={thread_id} run={run_id}: CrewAI upstream "
                        f"timeout during resume (ceiling={ceiling_display} did "
                        f"not fire)"
                    ),
                    code="AGUI_CREWAI_UPSTREAM_TIMEOUT",
                    **_run_error_extras(input_data),
                )
            )
        except Exception as e:  # pylint: disable=broad-exception-caught
            _LOGGER.exception(
                "CrewAI resume failed thread=%s run=%s cause=%s",
                thread_id,
                run_id,
                type(e).__name__,
            )
            yield encoder.encode(
                RunErrorEvent(
                    message=(
                        f"thread={thread_id} run={run_id}: CrewAI resume failed; "
                        f"see server logs"
                    ),
                    code=f"AGUI_CREWAI_FLOW_ERROR_{_sanitize_exception_code(type(e).__name__)}",
                    **_run_error_extras(input_data),
                )
            )
    finally:
        try:
            await _cancel_and_join(
                resume_task,
                thread_id=thread_id,
                run_id=run_id,
                allow_grace=allow_grace,
            )
        finally:
            try:
                await _flush_event_bus()
            finally:
                try:
                    if sink_token is not None and callable(reset_stream_sinks):
                        reset_stream_sinks(sink_token)
                finally:
                    flow_context.reset(token)


def add_crewai_flow_fastapi_endpoint(
    app: FastAPI,
    flow: Flow,
    path: str = "/",
    *,
    emit_interrupt_outcome: bool = False,
    enable_legacy_on_interrupt_event: bool = True,
    emit_raw_events: bool | None = None,
):
    """Adds a CrewAI endpoint to the FastAPI app.

    ``emit_raw_events`` opts into RAW passthrough: the crewai events this bridge does
    not map (its llm / agent / task / tool channels, nested-flow lifecycle, internals)
    are mirrored onto AG-UI ``RAW`` events. Off by default. Resolved at registration,
    so a non-bool raises here rather than per request; ``None`` reads
    ``AGUI_CREWAI_EMIT_RAW_EVENTS``.

    Async human-in-the-loop: when the flow pauses on an ``@human_feedback``
    method whose provider raises ``HumanFeedbackPending`` (see
    :data:`ag_ui_crewai.agui_feedback_provider`), the run terminates with an
    AG-UI interrupt and the next request carrying ``RunAgentInput.resume[]``
    resumes it via ``Flow.from_pending`` + ``resume_async``.

    ``emit_interrupt_outcome`` (default False) opts into the structured
    ``RUN_FINISHED.outcome``. CopilotKit < 1.61.2 breaks on it, so it stays off
    by default and the interrupt is surfaced via the legacy ``on_interrupt``
    CUSTOM event. Disabling ``enable_legacy_on_interrupt_event`` forces the
    outcome on so the interrupt is always surfaced by at least one channel.

    IMPORTANT for CopilotKit >= 1.61.2 (``useInterrupt``): resume works only via
    the structured outcome. The legacy ``on_interrupt`` channel renders the
    interrupt but its ``resolve()`` does not send a ``RunAgentInput.resume[]``
    back, so the run re-kicks off and re-pauses in a loop. Pass
    ``emit_interrupt_outcome=True`` (or ``enable_legacy_on_interrupt_event=False``)
    for those clients.
    """
    global GLOBAL_EVENT_LISTENER # pylint: disable=global-statement
    hitl_options = HITLOptions(
        emit_interrupt_outcome=emit_interrupt_outcome,
        enable_legacy_on_interrupt_event=enable_legacy_on_interrupt_event,
    )

    # Set up the global event listener singleton
    # we are doing this here because calling add_crewai_flow_fastapi_endpoint is a clear indicator
    # that we are not running on CrewAI enterprise
    #
    # On the StreamFrame path (crewai >= 1.6) the driver consumes ordered
    # frames via its own scoped sink and never creates a per-flow queue, so
    # every event this listener bridges would dispatch on crewai's
    # ThreadPoolExecutor only to hit ``get_queue(source) -> None`` and no-op —
    # pure wasted dispatch. Skip registering it when the StreamFrame contract is
    # available. The legacy bus-listener path is still selected PER-FLOW by
    # ``flow_supports_stream_frames`` for a flow lacking ``astream`` (e.g. the
    # kickoff_async-only test doubles) — those doubles emit no crewai bus
    # events, so the listener produces nothing for them regardless; when a real
    # legacy deployment needs it, ``stream_frame_available`` is False and it is
    # registered as before.
    if GLOBAL_EVENT_LISTENER is None and not CAPABILITIES.stream_frame_available:
        GLOBAL_EVENT_LISTENER = FastAPICrewFlowEventListener()

    # Resolved HERE, not per request: a wrong-typed argument should fail once at
    # startup rather than on every call.
    resolved_emit_raw_events = _resolve_emit_raw_events(emit_raw_events)

    @app.post(path)
    async def agentic_chat_endpoint(input_data: RunAgentInput, request: Request):
        """Agentic chat endpoint"""

        # Get the accept header from the request
        accept_header = request.headers.get("accept")

        # Create an event encoder to properly format SSE events
        encoder = EventEncoder(accept=accept_header)

        timeout = _flow_timeout_seconds()

        # Resume a paused flow. ``from_pending`` reloads persisted pending state
        # (not a per-request copy), so the resume driver takes the ORIGINAL flow
        # (for its class) rather than a fresh ``_copy_flow``.
        if resume_requested(input_data):
            if not flow_supports_human_feedback(flow):
                return StreamingResponse(
                    _reject_unsupported_resume(input_data, encoder),
                    media_type=encoder.get_content_type(),
                )
            return StreamingResponse(
                _run_flow_resume_stream(
                    flow=flow,
                    encoder=encoder,
                    input_data=input_data,
                    timeout=timeout,
                    hitl_options=hitl_options,
                    emit_raw_events=resolved_emit_raw_events,
                ),
                media_type=encoder.get_content_type(),
            )

        flow_copy = _copy_flow(flow)

        inputs = crewai_prepare_inputs(
            state=input_data.state,
            messages=input_data.messages,
            tools=input_data.tools,
            context=input_data.context,
            forwarded_props=input_data.forwarded_props,
        )
        # Keep the thread linkage crewai has always used; checkpointing layers
        # on top and is off unless CREWAI_CHECKPOINT is set.
        inputs["id"] = input_data.thread_id

        checkpoint_kwargs = build_checkpoint_kwargs(flow_copy, input_data)

        return StreamingResponse(
            _run_flow_stream(
                flow_copy=flow_copy,
                encoder=encoder,
                input_data=input_data,
                inputs=inputs,
                timeout=timeout,
                checkpoint_kwargs=checkpoint_kwargs,
                hitl_options=hitl_options,
                emit_raw_events=resolved_emit_raw_events,
            ),
            media_type=encoder.get_content_type(),
        )


def add_crewai_crew_fastapi_endpoint(
    app: FastAPI,
    crew: CrewBaseInstance,
    path: str = "/",
    *,
    emit_raw_events: bool | None = None,
):
    """Adds a CrewAI crew endpoint to the FastAPI app.

    ``crew`` must be a crew wrapper exposing a ``crew()`` factory (see
    :class:`CrewBaseInstance`) — a ``@CrewBase``-decorated instance or an
    equivalent wrapper — NOT a bare :class:`crewai.Crew`. The deferred
    ``ChatWithCrewFlow`` construction calls ``crew.crew()`` and reads the
    crew name via ``_read_crew_name`` (which accepts either a
    ``@CrewBase``'s ``_crew_name`` or a hand-rolled ``.name``).

    ChatWithCrewFlow construction is deferred to first request because the
    constructor calls crew_chat_generate_crew_chat_inputs which makes an LLM
    call. At import time the LLM mock server may not be running yet.
    """
    global GLOBAL_EVENT_LISTENER # pylint: disable=global-statement
    # Skip the legacy bus listener on the StreamFrame path (see the rationale
    # in ``add_crewai_flow_fastapi_endpoint``).
    if GLOBAL_EVENT_LISTENER is None and not CAPABILITIES.stream_frame_available:
        GLOBAL_EVENT_LISTENER = FastAPICrewFlowEventListener()

    resolved_emit_raw_events = _resolve_emit_raw_events(emit_raw_events)

    _cached_flow = None
    # Dedicated per-endpoint lock so two concurrent first-requests cannot
    # both call ``ChatWithCrewFlow(crew=crew)`` — which issues a real LLM
    # call — and waste API budget / memory. Not sharing QUEUES_LOCK: the
    # flow-construction critical section is independent of queue lifecycle
    # and should not serialise per-request queue teardown.
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
        accept_header = request.headers.get("accept")
        encoder = EventEncoder(accept=accept_header)

        # The crew endpoint wraps its crew in a ``ChatWithCrewFlow`` that cannot
        # be rebuilt via ``from_pending`` (its constructor needs the crew), and a
        # crew never pauses for async feedback. Reject a resume directive
        # explicitly rather than silently starting a fresh run.
        if resume_requested(input_data):
            return StreamingResponse(
                _reject_unsupported_resume(input_data, encoder),
                media_type=encoder.get_content_type(),
            )

        flow = await _get_flow()
        flow_copy = _copy_flow(flow)

        inputs = crewai_prepare_inputs(
            state=input_data.state,
            messages=input_data.messages,
            tools=input_data.tools,
            context=input_data.context,
            forwarded_props=input_data.forwarded_props,
        )
        # Keep the thread linkage; layer opt-in checkpointing on top.
        inputs["id"] = input_data.thread_id

        checkpoint_kwargs = build_checkpoint_kwargs(flow_copy, input_data)

        timeout = _flow_timeout_seconds()

        return StreamingResponse(
            _run_flow_stream(
                flow_copy=flow_copy,
                encoder=encoder,
                input_data=input_data,
                inputs=inputs,
                timeout=timeout,
                checkpoint_kwargs=checkpoint_kwargs,
                emit_raw_events=resolved_emit_raw_events,
            ),
            media_type=encoder.get_content_type(),
        )


def crewai_prepare_inputs(  # pylint: disable=unused-argument, too-many-arguments
    *,
    state: dict,
    messages: list[Message],
    tools: list[Tool],
    context: list[Context] | None = None,
    forwarded_props: Any = None,
):
    """Default merge state for CrewAI"""
    # ``RunAgentInput.state`` is typed ``Any`` and required, so a client may
    # legally send ``state: null`` or a non-mapping value. The ``{**state}``
    # spread below would raise ``TypeError`` on such input, and because this
    # helper runs in the endpoint body BEFORE the ``StreamingResponse`` is
    # constructed, that crash escapes the RUN_ERROR taxonomy as an uncorrelated
    # 500. Coerce a non-mapping state to an empty dict so the run proceeds
    # instead of dying opaquely.
    if not isinstance(state, dict):
        state = {}

    # Serialize messages, converting multimodal parts to LiteLLM's image_url
    # shape so litellm.acompletion does not fail on them.
    messages = [dump_agui_message(message) for message in messages]

    if len(messages) > 0:
        if "role" in messages[0] and messages[0]["role"] == "system":
            messages = messages[1:]

    actions = [{
        "type": "function",
        "function": {
            **tool.model_dump(),
        }
    } for tool in tools]

    # Thread ``forwardedProps`` into the run.
    #
    # Frontend callers send these keys in camelCase; downstream flow / tool
    # code reads snake_case, so normalize before merging (parity with the
    # LangGraph adapter's ``camel_to_snake`` pass). These are transient
    # per-request streaming hints, so they carry the LOWEST precedence: spread
    # FIRST, so both the agent's persisted ``state`` and the reserved keys
    # below (``messages`` / ``tools`` / ``context`` / ``copilotkit``) win on a
    # name collision. This mirrors the LangGraph adapter, where the run payload
    # is spread AFTER forwarded_props (``{**forwarded_props, **payload_input}``)
    # so a forwarded key can never silently overwrite persisted agent state.
    normalized_forwarded_props: dict = {}
    if isinstance(forwarded_props, dict):
        normalized_forwarded_props = {
            camel_to_snake(k): v for k, v in forwarded_props.items()
        }

    # Thread ``input.context`` into the run so agent code and tools can read it
    # from state. Serialize each entry to a plain dict so the flow
    # state stays JSON-safe and tools can read ``entry["value"]`` directly.
    context_list = [entry.model_dump() for entry in context] if context else []

    new_state = {
        # Lowest precedence first: transient forwarded hints, then persisted
        # state, then the reserved AG-UI keys (spread last, always win).
        **normalized_forwarded_props,
        **state,
        "messages": messages,
        # Expose frontend tools at a top-level ``tools`` key too. crewai has
        # historically only surfaced them under ``copilotkit.actions``; the
        # top-level key gives framework-neutral
        # agent code a stable place to read them (parity with LangGraph's
        # ``ag_ui_state["tools"]``). ``copilotkit.actions`` is kept for
        # backward compatibility.
        "tools": actions,
        "context": context_list,
        "copilotkit": {
            "actions": actions
        }
    }

    # A2UI: route the component-schema context entry and the ``injectA2UITool``
    # runtime flag into the canonical ``state["ag-ui"]`` namespace the a2ui
    # subagent tool reads (matching the LangGraph / Strands adapters). Added
    # ONLY when A2UI is actually in play so non-A2UI runs see no state change.
    inject_flag = (
        forwarded_props.get("injectA2UITool")
        if isinstance(forwarded_props, dict)
        else None
    )
    a2ui_schema_value, a2ui_regular_context = split_a2ui_schema_context(context_list)
    if a2ui_schema_value is not None or inject_flag is not None:
        ag_ui_ns: dict = {"context": a2ui_regular_context}
        if a2ui_schema_value is not None:
            ag_ui_ns["a2ui_schema"] = a2ui_schema_value
            # Route the (large) A2UI component-schema entry into ``ag-ui`` only:
            # drop it from the top-level ``context`` so framework-neutral agent
            # code does not receive the schema blob as if it were user context
            # (and it does not round-trip via STATE_SNAPSHOT twice).
            new_state["context"] = a2ui_regular_context
        if inject_flag is not None:
            ag_ui_ns["inject_a2ui_tool"] = inject_flag
        new_state["ag-ui"] = ag_ui_ns
    else:
        # ``ag-ui`` is an adapter-owned namespace, and it round-trips to the
        # client via STATE_SNAPSHOT. A prior turn's ``inject_a2ui_tool`` /
        # ``a2ui_schema`` echoed back in ``state`` would otherwise survive the
        # ``**state`` spread and silently re-enable injection on a turn the
        # frontend left A2UI off. Own it authoritatively: drop the stale entry
        # when A2UI is not in play this turn.
        new_state.pop("ag-ui", None)

    return new_state
