"""
Event sequence validation for the AG-UI protocol.

Validates that event streams conform to the AG-UI protocol state machine rules.
"""

import logging
from typing import Iterable, Iterator

from ag_ui.core import BaseEvent, EventType

logger = logging.getLogger("ag_ui.verify")


class EventSequenceError(Exception):
    """Raised when an event violates AG-UI protocol sequence rules."""

    pass


class EventSequenceValidator:
    """Stateful validator that enforces AG-UI protocol event ordering rules.

    Tracks the state machine across calls to validate_event(), allowing both
    batch and streaming validation patterns.
    """

    def __init__(self, debug: bool = False) -> None:
        self._debug = debug
        self.reset()

    def reset(self) -> None:
        """Reset all state for a new validation session."""
        self._active_messages: set[str] = set()
        self._active_tool_calls: set[str] = set()
        self._active_steps: set[str] = set()
        self._active_reasoning_messages: set[str] = set()
        self._active_thinking_step: bool = False
        self._active_thinking_step_message: bool = False
        self._run_started: bool = False
        self._run_finished: bool = False
        self._run_error: bool = False
        self._first_event_received: bool = False

    def _reset_run_state(self) -> None:
        """Reset state for a new run (called on RUN_STARTED after RUN_FINISHED)."""
        self._active_messages.clear()
        self._active_tool_calls.clear()
        self._active_steps.clear()
        self._active_reasoning_messages.clear()
        self._active_thinking_step = False
        self._active_thinking_step_message = False
        self._run_finished = False
        self._run_error = False
        self._run_started = True

    def validate_event(self, event: BaseEvent) -> None:
        """Validate a single event against the current state machine.

        Args:
            event: The event to validate.

        Raises:
            EventSequenceError: If the event violates protocol sequence rules.
        """
        event_type = event.type

        if self._debug:
            logger.debug("[VERIFY]: %s", event.model_dump_json(by_alias=True, exclude_none=True))

        # Global pre-check 1: run errored
        if self._run_error:
            raise EventSequenceError(
                f"Cannot send event type '{event_type.value}': The run has already "
                f"errored with 'RUN_ERROR'. No further events can be sent."
            )

        # Global pre-check 2: run finished
        if self._run_finished and event_type not in (
            EventType.RUN_STARTED,
            EventType.RUN_ERROR,
        ):
            raise EventSequenceError(
                f"Cannot send event type '{event_type.value}': The run has already "
                f"finished with 'RUN_FINISHED'. Start a new run with 'RUN_STARTED'."
            )

        # Global pre-check 3: first event
        if not self._first_event_received:
            self._first_event_received = True
            if event_type not in (EventType.RUN_STARTED, EventType.RUN_ERROR):
                raise EventSequenceError("First event must be 'RUN_STARTED'.")
        elif event_type == EventType.RUN_STARTED:
            if self._run_started and not self._run_finished:
                raise EventSequenceError(
                    "Cannot send 'RUN_STARTED' while a run is still active. "
                    "The previous run must be finished with 'RUN_FINISHED' before "
                    "starting a new run."
                )
            if self._run_finished:
                self._reset_run_state()

        # Per-event validation
        if event_type == EventType.RUN_STARTED:
            self._run_started = True

        elif event_type == EventType.RUN_FINISHED:
            if self._active_steps:
                names = ", ".join(sorted(self._active_steps))
                raise EventSequenceError(
                    f"Cannot send 'RUN_FINISHED' while steps are still active: {names}"
                )
            if self._active_messages:
                ids = ", ".join(sorted(self._active_messages))
                raise EventSequenceError(
                    f"Cannot send 'RUN_FINISHED' while text messages are still active: {ids}"
                )
            if self._active_tool_calls:
                ids = ", ".join(sorted(self._active_tool_calls))
                raise EventSequenceError(
                    f"Cannot send 'RUN_FINISHED' while tool calls are still active: {ids}"
                )
            self._run_finished = True

        elif event_type == EventType.RUN_ERROR:
            self._run_error = True

        # Text message lifecycle
        elif event_type == EventType.TEXT_MESSAGE_START:
            message_id = event.message_id  # type: ignore[attr-defined]
            if message_id in self._active_messages:
                raise EventSequenceError(
                    f"Cannot send 'TEXT_MESSAGE_START' event: A text message with "
                    f"ID '{message_id}' is already in progress. Complete it with "
                    f"'TEXT_MESSAGE_END' first."
                )
            self._active_messages.add(message_id)

        elif event_type == EventType.TEXT_MESSAGE_CONTENT:
            message_id = event.message_id  # type: ignore[attr-defined]
            if message_id not in self._active_messages:
                raise EventSequenceError(
                    f"Cannot send 'TEXT_MESSAGE_CONTENT' event: No active text message "
                    f"found with ID '{message_id}'. Start a text message with "
                    f"'TEXT_MESSAGE_START' first."
                )

        elif event_type == EventType.TEXT_MESSAGE_END:
            message_id = event.message_id  # type: ignore[attr-defined]
            if message_id not in self._active_messages:
                raise EventSequenceError(
                    f"Cannot send 'TEXT_MESSAGE_END' event: No active text message "
                    f"found with ID '{message_id}'. A 'TEXT_MESSAGE_START' event must "
                    f"be sent first."
                )
            self._active_messages.discard(message_id)

        # Tool call lifecycle
        elif event_type == EventType.TOOL_CALL_START:
            tool_call_id = event.tool_call_id  # type: ignore[attr-defined]
            if tool_call_id in self._active_tool_calls:
                raise EventSequenceError(
                    f"Cannot send 'TOOL_CALL_START' event: A tool call with "
                    f"ID '{tool_call_id}' is already in progress. Complete it with "
                    f"'TOOL_CALL_END' first."
                )
            self._active_tool_calls.add(tool_call_id)

        elif event_type == EventType.TOOL_CALL_ARGS:
            tool_call_id = event.tool_call_id  # type: ignore[attr-defined]
            if tool_call_id not in self._active_tool_calls:
                raise EventSequenceError(
                    f"Cannot send 'TOOL_CALL_ARGS' event: No active tool call found "
                    f"with ID '{tool_call_id}'. Start a tool call with "
                    f"'TOOL_CALL_START' first."
                )

        elif event_type == EventType.TOOL_CALL_END:
            tool_call_id = event.tool_call_id  # type: ignore[attr-defined]
            if tool_call_id not in self._active_tool_calls:
                raise EventSequenceError(
                    f"Cannot send 'TOOL_CALL_END' event: No active tool call found "
                    f"with ID '{tool_call_id}'. A 'TOOL_CALL_START' event must be "
                    f"sent first."
                )
            self._active_tool_calls.discard(tool_call_id)

        # Step lifecycle
        elif event_type == EventType.STEP_STARTED:
            step_name = event.step_name  # type: ignore[attr-defined]
            if step_name in self._active_steps:
                raise EventSequenceError(
                    f"Step \"{step_name}\" is already active for 'STEP_STARTED'."
                )
            self._active_steps.add(step_name)

        elif event_type == EventType.STEP_FINISHED:
            step_name = event.step_name  # type: ignore[attr-defined]
            if step_name not in self._active_steps:
                raise EventSequenceError(
                    f"Cannot send 'STEP_FINISHED' for step \"{step_name}\" that was "
                    f"not started."
                )
            self._active_steps.discard(step_name)

        # Thinking lifecycle
        elif event_type == EventType.THINKING_START:
            if self._active_thinking_step:
                raise EventSequenceError(
                    "Cannot send 'THINKING_START' event: A thinking step is already "
                    "in progress. End it with 'THINKING_END' first."
                )
            self._active_thinking_step = True

        elif event_type == EventType.THINKING_END:
            if not self._active_thinking_step:
                raise EventSequenceError(
                    "Cannot send 'THINKING_END' event: No active thinking step found. "
                    "A 'THINKING_START' event must be sent first."
                )
            self._active_thinking_step = False

        elif event_type == EventType.THINKING_TEXT_MESSAGE_START:
            if not self._active_thinking_step:
                raise EventSequenceError(
                    "Cannot send 'THINKING_TEXT_MESSAGE_START' event: A thinking step "
                    "is not in progress. Create one with 'THINKING_START' first."
                )
            if self._active_thinking_step_message:
                raise EventSequenceError(
                    "Cannot send 'THINKING_TEXT_MESSAGE_START' event: A thinking "
                    "message is already in progress. Complete it with "
                    "'THINKING_TEXT_MESSAGE_END' first."
                )
            self._active_thinking_step_message = True

        elif event_type == EventType.THINKING_TEXT_MESSAGE_CONTENT:
            if not self._active_thinking_step_message:
                raise EventSequenceError(
                    "Cannot send 'THINKING_TEXT_MESSAGE_CONTENT' event: No active "
                    "thinking message found. Start a message with "
                    "'THINKING_TEXT_MESSAGE_START' first."
                )

        elif event_type == EventType.THINKING_TEXT_MESSAGE_END:
            if not self._active_thinking_step_message:
                raise EventSequenceError(
                    "Cannot send 'THINKING_TEXT_MESSAGE_END' event: No active thinking "
                    "message found. A 'THINKING_TEXT_MESSAGE_START' event must be "
                    "sent first."
                )
            self._active_thinking_step_message = False

        # Reasoning message lifecycle
        elif event_type == EventType.REASONING_MESSAGE_START:
            message_id = event.message_id  # type: ignore[attr-defined]
            if message_id in self._active_reasoning_messages:
                raise EventSequenceError(
                    f"Cannot send 'REASONING_MESSAGE_START' event: A reasoning message "
                    f"with ID '{message_id}' is already in progress. Complete it with "
                    f"'REASONING_MESSAGE_END' first."
                )
            self._active_reasoning_messages.add(message_id)

        elif event_type == EventType.REASONING_MESSAGE_CONTENT:
            message_id = event.message_id  # type: ignore[attr-defined]
            if message_id not in self._active_reasoning_messages:
                raise EventSequenceError(
                    f"Cannot send 'REASONING_MESSAGE_CONTENT' event: No active "
                    f"reasoning message found with ID '{message_id}'. Start a "
                    f"reasoning message with 'REASONING_MESSAGE_START' first."
                )

        elif event_type == EventType.REASONING_MESSAGE_END:
            message_id = event.message_id  # type: ignore[attr-defined]
            if message_id not in self._active_reasoning_messages:
                raise EventSequenceError(
                    f"Cannot send 'REASONING_MESSAGE_END' event: No active reasoning "
                    f"message found with ID '{message_id}'. A 'REASONING_MESSAGE_START' "
                    f"event must be sent first."
                )
            self._active_reasoning_messages.discard(message_id)

        # All other event types pass through without validation


def validate_sequence(events: Iterable[BaseEvent], debug: bool = False) -> None:
    """Validate a sequence of events against AG-UI protocol rules.

    Args:
        events: The events to validate.
        debug: If True, log each event via the ag_ui.verify logger.

    Raises:
        EventSequenceError: On the first protocol violation encountered.
    """
    validator = EventSequenceValidator(debug=debug)
    for event in events:
        validator.validate_event(event)


def verify_events(
    events: Iterable[BaseEvent], debug: bool = False
) -> Iterator[BaseEvent]:
    """Validate and yield events one at a time.

    Acts as a pass-through iterator that raises on the first protocol violation.

    Args:
        events: The events to validate and yield.
        debug: If True, log each event via the ag_ui.verify logger.

    Yields:
        Each event after successful validation.

    Raises:
        EventSequenceError: On the first protocol violation encountered.
    """
    validator = EventSequenceValidator(debug=debug)
    for event in events:
        validator.validate_event(event)
        yield event
