"""Translate crewai ``StreamFrame`` envelopes into AG-UI wire events (CPK-7719).

crewai's public streaming contract (``StreamFrame`` / ``AsyncStreamSession``,
landed 1.6.0) emits one ordered frame per event the flow raises, across the
channels ``llm`` / ``flow`` / ``tools`` / ``messages`` / ``lifecycle`` /
``custom``. This module is the SINGLE translation seam that maps the frames the
bridge cares about onto AG-UI events.

Two frame sources feed us on the StreamFrame path (verified against the crewai
1.15.7 wheel):

* Flow-lifecycle frames (channel ``flow``): ``flow_started`` /
  ``method_execution_started`` / ``method_execution_finished`` / ``flow_finished``.
* The bridge's own ``Bridged*`` events (emitted by ``sdk.copilotkit_stream`` &
  friends via ``crewai_event_bus.emit``). Because ``event_bus._prepare_event``
  calls ``publish_stream_event`` synchronously on every ``emit``, these reach the
  scoped stream sink and arrive as ``custom``-channel frames whose ``.type`` is
  the AG-UI ``EventType`` string (e.g. ``"TEXT_MESSAGE_CHUNK"``) and whose
  ``.data`` carries the snake_case field values (``message_id`` / ``delta`` /
  ``tool_call_id`` / ``snapshot`` / ...).

SWAPPABLE EMISSION SHAPE (cross-lane constraint, CPK-7719): CrewAI is currently
the only integration emitting TEXT_MESSAGE_CHUNK / TOOL_CALL_CHUNK (chunks)
rather than the START/CONTENT/END triples the six other integrations emit. That
final choice belongs to a Parity-lane ticket, not this migration. The translator
therefore routes text / tool-call emission through a single ``emission_shape``
strategy that DEFAULTS to ``"chunks"`` so this change is byte-for-byte
behavior-preserving on the wire. The ``"triples"`` strategy is a deliberate
NotImplementedError placeholder — the Parity ticket owns wiring it up and
flipping the default.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from ag_ui.core import (
    EventType,
    RunStartedEvent,
    RunFinishedEvent,
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

from .sdk import litellm_messages_to_ag_ui_messages

# crewai lifecycle-frame ``type`` strings (channel ``flow``). Pinned as
# constants so a rename upstream surfaces here rather than silently producing
# no wire events.
_FLOW_STARTED = "flow_started"
_FLOW_FINISHED = "flow_finished"
_METHOD_STARTED = "method_execution_started"
_METHOD_FINISHED = "method_execution_finished"

# The ONE lifecycle frame that terminates the AG-UI run. Mirrors the legacy
# listener enqueuing the ``None`` end-sentinel right after RUN_FINISHED.
RUN_END_FRAME_TYPES = frozenset({_FLOW_FINISHED})

_SUPPORTED_EMISSION_SHAPES = frozenset({"chunks", "triples"})


class StreamFrameTranslator:
    """Stateless-ish mapper from ``StreamFrame`` to a list of AG-UI events.

    One instance per run (it carries the run correlation ids and a
    ``state_provider`` closure over the live flow copy). ``translate`` returns
    zero or more AG-UI events for a single frame; unrecognised frame types
    return ``[]`` (behavior-preserving: the legacy listener produced nothing
    for crewai's native llm / tools / messages channels or internal frames).
    """

    def __init__(
        self,
        *,
        thread_id: str,
        run_id: str,
        state_provider: Callable[[], Any],
        emission_shape: str = "chunks",
    ) -> None:
        if emission_shape not in _SUPPORTED_EMISSION_SHAPES:
            raise ValueError(
                f"Unknown emission_shape {emission_shape!r}; "
                f"expected one of {sorted(_SUPPORTED_EMISSION_SHAPES)}"
            )
        self._thread_id = thread_id
        self._run_id = run_id
        self._state_provider = state_provider
        self.emission_shape = emission_shape

    # -- public API --------------------------------------------------------

    @staticmethod
    def is_run_end(frame: Any) -> bool:
        """Whether ``frame`` terminates the run (RUN_FINISHED was just emitted)."""
        return getattr(frame, "type", None) in RUN_END_FRAME_TYPES

    def translate(self, frame: Any) -> list[Any]:
        """Map one ``StreamFrame`` to the AG-UI events it should produce."""
        frame_type = getattr(frame, "type", None)
        data = getattr(frame, "data", None) or {}

        if frame_type == _FLOW_STARTED:
            return [
                RunStartedEvent(
                    type=EventType.RUN_STARTED,
                    thread_id=self._thread_id,
                    run_id=self._run_id,
                )
            ]
        if frame_type == _FLOW_FINISHED:
            return [
                RunFinishedEvent(
                    type=EventType.RUN_FINISHED,
                    thread_id=self._thread_id,
                    run_id=self._run_id,
                )
            ]
        if frame_type == _METHOD_STARTED:
            return [
                StepStartedEvent(
                    type=EventType.STEP_STARTED,
                    step_name=data.get("method_name"),
                )
            ]
        if frame_type == _METHOD_FINISHED:
            return self._method_finished_events(data)

        # Bridge-emitted events arrive on the ``custom`` channel with the AG-UI
        # EventType string as ``frame.type``.
        if frame_type == EventType.TEXT_MESSAGE_CHUNK:
            return self._text_events(data)
        if frame_type == EventType.TOOL_CALL_CHUNK:
            return self._tool_events(data)
        if frame_type == EventType.CUSTOM:
            return [
                CustomEvent(
                    type=EventType.CUSTOM,
                    name=data.get("name"),
                    value=data.get("value"),
                )
            ]
        if frame_type == EventType.STATE_SNAPSHOT:
            return [
                StateSnapshotEvent(
                    type=EventType.STATE_SNAPSHOT,
                    snapshot=data.get("snapshot"),
                )
            ]

        # crewai native llm / tools / messages / lifecycle frames and internal
        # frames (e.g. ``cc_env``) are intentionally dropped — the legacy
        # listener never surfaced them, so ignoring them keeps the wire output
        # identical. Surfacing them is a Parity-lane decision.
        return []

    # -- lifecycle --------------------------------------------------------

    def _method_finished_events(self, _data: dict) -> list[Any]:
        """MESSAGES_SNAPSHOT + STATE_SNAPSHOT + STEP_FINISHED, in that order.

        Reads the LIVE flow state via ``state_provider`` — exactly what the
        legacy listener did with ``source.state`` — rather than the serialized
        ``frame.data["state"]``, so message / state shapes round-trip through
        the same ``litellm_messages_to_ag_ui_messages`` path as before.
        """
        state = self._state_provider()
        raw_messages = (
            getattr(state, "messages", None)
            or (state.get("messages") if isinstance(state, dict) else None)
            or []
        )
        messages = litellm_messages_to_ag_ui_messages(raw_messages)
        snapshot = (
            state
            if isinstance(state, dict)
            else state.model_dump()
            if hasattr(state, "model_dump")
            else {}
        )
        # ``method_name`` is carried on the frame data for STEP_FINISHED.
        method_name = _data.get("method_name")
        return [
            MessagesSnapshotEvent(
                type=EventType.MESSAGES_SNAPSHOT,
                messages=messages,
            ),
            StateSnapshotEvent(
                type=EventType.STATE_SNAPSHOT,
                snapshot=snapshot,
            ),
            StepFinishedEvent(
                type=EventType.STEP_FINISHED,
                step_name=method_name,
            ),
        ]

    # -- emission-shape strategy (default "chunks") -----------------------

    def _text_events(self, data: dict) -> list[Any]:
        if self.emission_shape == "chunks":
            return [
                TextMessageChunkEvent(
                    type=EventType.TEXT_MESSAGE_CHUNK,
                    message_id=data.get("message_id"),
                    role=data.get("role"),
                    delta=data.get("delta"),
                )
            ]
        # TODO(CPK Parity lane): emit TEXT_MESSAGE_START / _CONTENT / _END
        # triples here to match the other six integrations. That cross-lane
        # decision is owned by the Parity ticket; do NOT flip the default in
        # this migration (it must stay behavior-preserving on the wire).
        raise NotImplementedError(
            "emission_shape='triples' is a Parity-lane placeholder; "
            "the StreamFrame migration ships the behavior-preserving "
            "'chunks' shape only."
        )

    def _tool_events(self, data: dict) -> list[Any]:
        if self.emission_shape == "chunks":
            return [
                ToolCallChunkEvent(
                    type=EventType.TOOL_CALL_CHUNK,
                    tool_call_id=data.get("tool_call_id"),
                    tool_call_name=data.get("tool_call_name"),
                    delta=data.get("delta"),
                )
            ]
        # TODO(CPK Parity lane): TOOL_CALL_START / _ARGS / _END triples — see
        # the note in ``_text_events``.
        raise NotImplementedError(
            "emission_shape='triples' is a Parity-lane placeholder; "
            "the StreamFrame migration ships the behavior-preserving "
            "'chunks' shape only."
        )
