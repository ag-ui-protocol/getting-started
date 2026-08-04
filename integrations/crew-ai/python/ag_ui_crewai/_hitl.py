"""Async human-in-the-loop (interrupt / resume) for the CrewAI AG-UI bridge.

crewai's async HITL (crewai 1.8+): a flow method wrapped with ``@human_feedback``
whose provider RAISES ``HumanFeedbackPending`` pauses the run. The framework
persists the pending state; ``Flow.from_pending(flow_id)`` + ``resume_async``
resume it. This module maps that lifecycle onto AG-UI:

* :class:`AGUIFeedbackProvider`: the provider a HITL flow uses; it emits
  ``HumanFeedbackRequestedEvent`` (carrying a stable ``request_id``) and raises
  ``HumanFeedbackPending`` to pause.
* :func:`build_agui_interrupt`: pause events -> ``AGUIInterrupt``.
* :func:`build_interrupt_tail`: the terminating events for a paused run, with
  the opt-in ``RUN_FINISHED.outcome`` gating.
* :func:`resume_requested` / :func:`feedback_from_resume`: read
  ``RunAgentInput.resume[]``.

A leaf module: imports only the stdlib, ``ag_ui.core`` and ``_capabilities`` (so
``endpoint`` / ``_frames`` can import it without a cycle). ``flow_id`` in crewai
is ``state.id``; the bridge sets that to the AG-UI ``thread_id``, so resume keys
by ``thread_id``.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any

from ag_ui.core import (
    EventType,
    Interrupt as AGUIInterrupt,
    RunFinishedEvent,
    RunFinishedInterruptOutcome,
)
from ag_ui.core.events import CustomEvent

from . import _capabilities as _caps

_LOGGER = logging.getLogger(__name__)

# AG-UI ``Interrupt.reason`` for a crewai async-feedback pause.
_INTERRUPT_REASON = "crewai:human_feedback"
# Legacy CUSTOM event name mirrored from the LangGraph adapter so a client that
# consumes ``on_interrupt`` (CopilotKit < 1.61.2, which breaks on
# RUN_FINISHED.outcome) still surfaces the interrupt.
_ON_INTERRUPT_EVENT_NAME = "on_interrupt"


@dataclass(frozen=True)
class HITLOptions:
    """Per-endpoint interrupt behaviour.

    ``emit_interrupt_outcome`` defaults False: CopilotKit < 1.61.2 breaks on
    ``RUN_FINISHED.outcome``, so the structured outcome stays opt-in (mirrors the
    LangGraph / Mastra precedent). The outcome is emitted anyway whenever the
    legacy ``on_interrupt`` event is disabled, so an interrupt is always
    surfaced by at least one channel.
    """

    emit_interrupt_outcome: bool = False
    enable_legacy_on_interrupt_event: bool = True


class AGUIFeedbackProvider:
    """Async ``HumanFeedbackProvider`` for the AG-UI bridge.

    Structurally implements crewai's ``HumanFeedbackProvider`` protocol. On a
    ``@human_feedback`` method it emits ``HumanFeedbackRequestedEvent`` (stamped
    with a stable ``request_id`` so the bridge can key an AG-UI interrupt to it)
    then raises ``HumanFeedbackPending`` to pause. The framework persists the
    pending state automatically; the bridge terminates the run with an AG-UI
    interrupt and resumes on the next request.
    """

    def request_feedback(self, context: Any, flow: Any) -> str:
        pending_cls = _caps.HumanFeedbackPending
        if pending_cls is None:
            raise RuntimeError(
                "ag-ui-crewai: crewai async human-feedback is unavailable; "
                f"upgrade to crewai>={_caps.HITL_ENABLING_VERSIONS['human_feedback']}."
            )
        request_event_cls = _caps.HumanFeedbackRequestedEvent
        bus = _caps.crewai_event_bus
        if request_event_cls is not None and bus is not None:
            # Emitting the request event is BEST-EFFORT: it only supplies the
            # stable request id. The WHOLE block (reading context attrs, building
            # kwargs, constructing and emitting the event) is guarded, so any
            # attribute / field / signature drift across crewai releases degrades
            # to a warning; the pause must still happen and surfaces via the
            # flow_paused event. Never let this turn a pause into a RUN_ERROR.
            try:
                kwargs: dict[str, Any] = {
                    "type": "human_feedback_requested",
                    "flow_name": getattr(flow, "name", None) or flow.__class__.__name__,
                    "method_name": context.method_name,
                    "output": context.method_output,
                    "message": context.message,
                    "emit": context.emit,
                }
                # The stable id the bridge maps onto AGUIInterrupt.id. crewai
                # leaves request_id unset by default, so stamp it with the flow
                # id (== the AG-UI thread_id) that resume keys by.
                if _caps.CAPABILITIES.human_feedback_request_id_supported:
                    kwargs["request_id"] = context.flow_id
                # Only pass fields this crewai's event model declares, so a field
                # that shifted across releases is dropped rather than raising.
                fields = getattr(request_event_cls, "model_fields", None)
                if fields:
                    kwargs = {k: v for k, v in kwargs.items() if k in fields}
                bus.emit(flow, request_event_cls(**kwargs))
            except Exception as exc:  # noqa: BLE001 - request event is best-effort
                _LOGGER.warning(
                    "ag-ui-crewai: could not emit HumanFeedbackRequestedEvent "
                    "(%s); pausing anyway, interrupt surfaces via flow_paused.",
                    type(exc).__name__,
                )
        # Raise with only the required context: callback_info is never read
        # downstream, and passing it couples us to the pending constructor's
        # signature (a mismatch would turn the pause into a RUN_ERROR).
        raise pending_cls(context=context)


# Module-level singleton so HITL flows can share one provider instance.
agui_feedback_provider = AGUIFeedbackProvider()


def _json_safe(value: Any) -> Any:
    """Best-effort JSON-safe coercion for interrupt metadata / custom values."""
    try:
        json.dumps(value)
        return value
    except (TypeError, ValueError):
        return str(value)


def build_agui_interrupt(
    *,
    request_id: str | None,
    flow_id: str | None,
    message: str | None,
    method_name: str | None,
    output: Any,
    emit: list[str] | None,
) -> AGUIInterrupt | None:
    """Build an ``AGUIInterrupt`` from a crewai pause, or ``None`` if no id.

    The id is non-synthesizable: prefer the event's ``request_id`` (crewai
    1.12.2+), fall back to the ``flow_id`` (== thread_id). Without either we
    cannot route a resume answer back, so return ``None`` and let the caller
    skip the interrupt outcome rather than ship a run the client cannot resume.
    """
    interrupt_id = request_id or flow_id
    if not interrupt_id:
        return None
    response_schema = (
        {"type": "string", "enum": list(emit)} if emit else None
    )
    metadata = {
        "crewai": {
            "flowId": flow_id,
            "methodName": method_name,
            "emit": list(emit) if emit else None,
            "output": _json_safe(output),
        }
    }
    return AGUIInterrupt(
        id=str(interrupt_id),
        reason=_INTERRUPT_REASON,
        message=message,
        response_schema=response_schema,
        metadata=metadata,
    )


def _interrupt_custom_value(interrupt: AGUIInterrupt) -> Any:
    """Payload for the legacy ``on_interrupt`` CUSTOM event."""
    return interrupt.model_dump(by_alias=True, exclude_none=True)


def build_interrupt_tail(
    interrupt: AGUIInterrupt,
    *,
    thread_id: str,
    run_id: str,
    options: HITLOptions,
) -> list[Any]:
    """Terminating events for a paused run.

    Default (``emit_interrupt_outcome=False``, legacy event on):
      ``[CustomEvent(on_interrupt), RunFinishedEvent]``  (plain finish)
    Opt-in (``emit_interrupt_outcome=True``):
      ``[CustomEvent(on_interrupt), RunFinishedEvent(outcome=interrupt)]``

    The structured outcome is also included whenever the legacy event is
    disabled, so the interrupt is always surfaced by at least one channel.
    """
    events: list[Any] = []
    if options.enable_legacy_on_interrupt_event:
        events.append(
            CustomEvent(
                type=EventType.CUSTOM,
                name=_ON_INTERRUPT_EVENT_NAME,
                value=_interrupt_custom_value(interrupt),
            )
        )
    include_outcome = (
        options.emit_interrupt_outcome
        or not options.enable_legacy_on_interrupt_event
    )
    outcome = (
        RunFinishedInterruptOutcome(type="interrupt", interrupts=[interrupt])
        if include_outcome
        else None
    )
    events.append(
        RunFinishedEvent(
            type=EventType.RUN_FINISHED,
            thread_id=thread_id,
            run_id=run_id,
            outcome=outcome,
        )
    )
    return events


def resume_requested(input_data: Any) -> bool:
    """Whether this request carries an AG-UI resume directive."""
    return bool(getattr(input_data, "resume", None))


def feedback_from_resume(input_data: Any) -> tuple[str, str | None]:
    """Map ``RunAgentInput.resume[]`` to ``(feedback, interrupt_id)``.

    crewai persists ONE pending feedback per flow, so a single resume entry is
    expected; extra entries are ignored with a warning. A ``resolved`` entry
    yields its payload as the feedback string (JSON-encoded when non-string).

    A ``cancelled`` entry yields ``""``: crewai's ``resume_async`` documents that
    empty feedback falls back to the pause's ``default_outcome`` (or the first
    ``emit`` option). crewai has no true "abort a pending feedback" primitive, so
    a cancel resumes the flow with that default rather than leaving it stranded.
    """
    entries = list(getattr(input_data, "resume", None) or [])
    if not entries:
        return "", None
    if len(entries) > 1:
        _LOGGER.warning(
            "ag-ui-crewai: resume carried %d entries but crewai persists one "
            "pending feedback per flow; using the first.",
            len(entries),
        )
    entry = entries[0]
    interrupt_id = getattr(entry, "interrupt_id", None)
    if getattr(entry, "status", None) == "cancelled":
        return "", interrupt_id
    payload = getattr(entry, "payload", None)
    if isinstance(payload, str):
        feedback = payload
    elif payload is None:
        feedback = ""
    else:
        feedback = json.dumps(payload, default=str)
    return feedback, interrupt_id
