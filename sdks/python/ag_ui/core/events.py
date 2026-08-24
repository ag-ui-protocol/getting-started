"""
This module contains the event types for the Agent User Interaction Protocol Python SDK.
"""

from enum import Enum
from typing import Annotated, Any, List, Literal, Optional, Union

from pydantic import Field, field_validator

from .types import (
    ConfiguredBaseModel,
    Interrupt,
    Message,
    MetadataMixin,
    Role,
    RunAgentInput,
    State,
)

# Text messages can have any role except "tool"
TextMessageRole = Literal["developer", "system", "assistant", "user"]


class RunFinishedSuccessOutcome(ConfiguredBaseModel):
    """Outcome variant signalling that a run completed normally."""

    type: Literal["success"] = "success"


class RunFinishedInterruptOutcome(ConfiguredBaseModel):
    """Outcome variant signalling that a run paused on one or more interrupts."""

    type: Literal["interrupt"] = "interrupt"
    interrupts: List[Interrupt]

    @field_validator("interrupts")
    @classmethod
    def _interrupts_nonempty(cls, value: List[Interrupt]) -> List[Interrupt]:
        if not value:
            raise ValueError("outcome 'interrupt' requires at least one interrupt")
        return value


RunFinishedOutcome = Annotated[
    Union[RunFinishedSuccessOutcome, RunFinishedInterruptOutcome],
    Field(discriminator="type"),
]


class TokenUsage(ConfiguredBaseModel):
    """
    Numeric-only, per-(provider, model) token usage summary.

    Deliberately carries no content-bearing or identifying fields (no prompts,
    completions, messages, thread/run/user IDs) — only provider/model labels and
    numeric token counts.
    """
    provider: Optional[str] = None
    model: Optional[str] = None
    # Counts are non-negative integers in every binding. Pydantic already rejects
    # a fractional value for an `int` field, but an explicit bound is needed for
    # the negative case: without it Python could emit a value the TypeScript
    # schema refuses to parse, and because TS consumers validate every incoming
    # event and raise on failure, that would surface as a dead run at the
    # consumer rather than an actionable error at the producer.
    input_tokens: Optional[int] = Field(default=None, ge=0)
    output_tokens: Optional[int] = Field(default=None, ge=0)
    total_tokens: Optional[int] = Field(default=None, ge=0)
    reasoning_tokens: Optional[int] = Field(default=None, ge=0)
    cached_input_tokens: Optional[int] = Field(default=None, ge=0)


class EventType(str, Enum):
    """
    The type of event.
    """
    TEXT_MESSAGE_START = "TEXT_MESSAGE_START"
    TEXT_MESSAGE_CONTENT = "TEXT_MESSAGE_CONTENT"
    TEXT_MESSAGE_END = "TEXT_MESSAGE_END"
    TEXT_MESSAGE_CHUNK = "TEXT_MESSAGE_CHUNK"
    THINKING_TEXT_MESSAGE_START = "THINKING_TEXT_MESSAGE_START"
    THINKING_TEXT_MESSAGE_CONTENT = "THINKING_TEXT_MESSAGE_CONTENT"
    THINKING_TEXT_MESSAGE_END = "THINKING_TEXT_MESSAGE_END"
    TOOL_CALL_START = "TOOL_CALL_START"
    TOOL_CALL_ARGS = "TOOL_CALL_ARGS"
    TOOL_CALL_END = "TOOL_CALL_END"
    TOOL_CALL_CHUNK = "TOOL_CALL_CHUNK" 
    TOOL_CALL_RESULT = "TOOL_CALL_RESULT"
    THINKING_START = "THINKING_START"
    THINKING_END = "THINKING_END"
    STATE_SNAPSHOT = "STATE_SNAPSHOT"
    STATE_DELTA = "STATE_DELTA"
    MESSAGES_SNAPSHOT = "MESSAGES_SNAPSHOT"
    ACTIVITY_SNAPSHOT = "ACTIVITY_SNAPSHOT"
    ACTIVITY_DELTA = "ACTIVITY_DELTA"
    RAW = "RAW"
    CUSTOM = "CUSTOM"
    RUN_STARTED = "RUN_STARTED"
    RUN_FINISHED = "RUN_FINISHED"
    RUN_ERROR = "RUN_ERROR"
    STEP_STARTED = "STEP_STARTED"
    STEP_FINISHED = "STEP_FINISHED"
    REASONING_START = "REASONING_START"
    REASONING_MESSAGE_START = "REASONING_MESSAGE_START"
    REASONING_MESSAGE_CONTENT = "REASONING_MESSAGE_CONTENT"
    REASONING_MESSAGE_END = "REASONING_MESSAGE_END"
    REASONING_MESSAGE_CHUNK = "REASONING_MESSAGE_CHUNK"
    REASONING_END = "REASONING_END"
    REASONING_ENCRYPTED_VALUE = "REASONING_ENCRYPTED_VALUE"


class BaseEvent(MetadataMixin):
    """
    Base event for all events in the Agent User Interaction Protocol.

    ``metadata`` is declared here rather than per event, so every event type
    carries it.
    """
    type: EventType
    timestamp: Optional[int] = None
    raw_event: Optional[Any] = None


class TextMessageStartEvent(BaseEvent):
    """
    Event indicating the start of a text message.
    """
    type: Literal[EventType.TEXT_MESSAGE_START] = EventType.TEXT_MESSAGE_START  # pyright: ignore[reportIncompatibleVariableOverride]
    message_id: str
    role: TextMessageRole = "assistant"
    name: Optional[str] = None


class TextMessageContentEvent(BaseEvent):
    """
    Event containing a piece of text message content.
    """
    type: Literal[EventType.TEXT_MESSAGE_CONTENT] = EventType.TEXT_MESSAGE_CONTENT  # pyright: ignore[reportIncompatibleVariableOverride]
    message_id: str
    delta: str


class TextMessageEndEvent(BaseEvent):
    """
    Event indicating the end of a text message.
    """
    type: Literal[EventType.TEXT_MESSAGE_END] = EventType.TEXT_MESSAGE_END  # pyright: ignore[reportIncompatibleVariableOverride]
    message_id: str

class TextMessageChunkEvent(BaseEvent):
    """
    Event containing a chunk of text message content.
    """
    type: Literal[EventType.TEXT_MESSAGE_CHUNK] = EventType.TEXT_MESSAGE_CHUNK  # pyright: ignore[reportIncompatibleVariableOverride]
    message_id: Optional[str] = None
    role: Optional[TextMessageRole] = None
    delta: Optional[str] = None
    name: Optional[str] = None

class ThinkingTextMessageStartEvent(BaseEvent):
    """
    Event indicating the start of a thinking text message.
    """
    type: Literal[EventType.THINKING_TEXT_MESSAGE_START] = EventType.THINKING_TEXT_MESSAGE_START  # pyright: ignore[reportIncompatibleVariableOverride]

class ThinkingTextMessageContentEvent(BaseEvent):
    """
    Event indicating a piece of a thinking text message.
    """
    type: Literal[EventType.THINKING_TEXT_MESSAGE_CONTENT] = EventType.THINKING_TEXT_MESSAGE_CONTENT  # pyright: ignore[reportIncompatibleVariableOverride]
    delta: str

class ThinkingTextMessageEndEvent(BaseEvent):
    """
    Event indicating the end of a thinking text message.
    """
    type: Literal[EventType.THINKING_TEXT_MESSAGE_END] = EventType.THINKING_TEXT_MESSAGE_END  # pyright: ignore[reportIncompatibleVariableOverride]

class ToolCallStartEvent(BaseEvent):
    """
    Event indicating the start of a tool call.
    """
    type: Literal[EventType.TOOL_CALL_START] = EventType.TOOL_CALL_START  # pyright: ignore[reportIncompatibleVariableOverride]
    tool_call_id: str
    tool_call_name: str
    parent_message_id: Optional[str] = None


class ToolCallArgsEvent(BaseEvent):
    """
    Event containing tool call arguments.
    """
    type: Literal[EventType.TOOL_CALL_ARGS] = EventType.TOOL_CALL_ARGS  # pyright: ignore[reportIncompatibleVariableOverride]
    tool_call_id: str
    delta: str


class ToolCallEndEvent(BaseEvent):
    """
    Event indicating the end of a tool call.
    """
    type: Literal[EventType.TOOL_CALL_END] = EventType.TOOL_CALL_END  # pyright: ignore[reportIncompatibleVariableOverride]
    tool_call_id: str

class ToolCallChunkEvent(BaseEvent):
    """
    Event containing a chunk of tool call content.
    """
    type: Literal[EventType.TOOL_CALL_CHUNK] = EventType.TOOL_CALL_CHUNK  # pyright: ignore[reportIncompatibleVariableOverride]
    tool_call_id: Optional[str] = None
    tool_call_name: Optional[str] = None
    parent_message_id: Optional[str] = None
    delta: Optional[str] = None

class ToolCallResultEvent(BaseEvent):
    """
    Event containing the result of a tool call.
    """
    message_id: str
    type: Literal[EventType.TOOL_CALL_RESULT] = EventType.TOOL_CALL_RESULT  # pyright: ignore[reportIncompatibleVariableOverride]
    tool_call_id: str
    content: str
    role: Optional[Literal["tool"]] = None

class ThinkingStartEvent(BaseEvent):
    """
    Event indicating the start of a thinking step event.
    """
    type: Literal[EventType.THINKING_START] = EventType.THINKING_START  # pyright: ignore[reportIncompatibleVariableOverride]
    title: Optional[str] = None

class ThinkingEndEvent(BaseEvent):
    """
    Event indicating the end of a thinking step event.
    """
    type: Literal[EventType.THINKING_END] = EventType.THINKING_END  # pyright: ignore[reportIncompatibleVariableOverride]

class StateSnapshotEvent(BaseEvent):
    """
    Event containing a snapshot of the state.
    """
    type: Literal[EventType.STATE_SNAPSHOT] = EventType.STATE_SNAPSHOT  # pyright: ignore[reportIncompatibleVariableOverride]
    snapshot: State


class StateDeltaEvent(BaseEvent):
    """
    Event containing a delta of the state.
    """
    type: Literal[EventType.STATE_DELTA] = EventType.STATE_DELTA  # pyright: ignore[reportIncompatibleVariableOverride]
    delta: List[Any]  # JSON Patch (RFC 6902)


class MessagesSnapshotEvent(BaseEvent):
    """
    Event containing a snapshot of the messages.
    """
    type: Literal[EventType.MESSAGES_SNAPSHOT] = EventType.MESSAGES_SNAPSHOT  # pyright: ignore[reportIncompatibleVariableOverride]
    messages: List[Message]


class ActivitySnapshotEvent(BaseEvent):
    """Event containing a snapshot of an activity message."""

    type: Literal[EventType.ACTIVITY_SNAPSHOT] = EventType.ACTIVITY_SNAPSHOT  # pyright: ignore[reportIncompatibleVariableOverride]
    message_id: str
    activity_type: str
    content: Any
    replace: bool = True


class ActivityDeltaEvent(BaseEvent):
    """Event containing a JSON Patch delta for an activity message."""

    type: Literal[EventType.ACTIVITY_DELTA] = EventType.ACTIVITY_DELTA  # pyright: ignore[reportIncompatibleVariableOverride]
    message_id: str
    activity_type: str
    patch: List[Any]


class RawEvent(BaseEvent):
    """
    Event containing a raw event.
    """
    type: Literal[EventType.RAW] = EventType.RAW  # pyright: ignore[reportIncompatibleVariableOverride]
    event: Any
    source: Optional[str] = None


class CustomEvent(BaseEvent):
    """
    Event containing a custom event.
    """
    type: Literal[EventType.CUSTOM] = EventType.CUSTOM  # pyright: ignore[reportIncompatibleVariableOverride]
    name: str
    value: Any


class RunStartedEvent(BaseEvent):
    """
    Event indicating that a run has started.
    """
    type: Literal[EventType.RUN_STARTED] = EventType.RUN_STARTED  # pyright: ignore[reportIncompatibleVariableOverride]
    thread_id: str
    run_id: str
    parent_run_id: Optional[str] = None
    input: Optional[RunAgentInput] = None


class RunFinishedEvent(BaseEvent):
    """
    Event indicating that a run has finished.

    `outcome` is optional. Producers written before the interrupt-aware run
    lifecycle simply omit it (legacy back-compat). Newer producers set it
    explicitly to ``RunFinishedSuccessOutcome`` (``{"type": "success"}``) or
    ``RunFinishedInterruptOutcome`` (``{"type": "interrupt", "interrupts": [...]}``).
    The interrupt list lives inside the outcome so it travels with the variant
    that uses it.
    """
    type: Literal[EventType.RUN_FINISHED] = EventType.RUN_FINISHED  # pyright: ignore[reportIncompatibleVariableOverride]
    thread_id: str
    run_id: str
    result: Optional[Any] = None
    outcome: Optional[RunFinishedOutcome] = None
    # Optional per-(provider, model) token usage for the completed run. A list
    # so runs invoking multiple models keep them separate for downstream
    # display; consumers needing only totals can sum across entries.
    usage: Optional[List[TokenUsage]] = None


class RunErrorEvent(BaseEvent):
    """
    Event indicating that a run has encountered an error.
    """
    type: Literal[EventType.RUN_ERROR] = EventType.RUN_ERROR  # pyright: ignore[reportIncompatibleVariableOverride]
    message: str
    code: Optional[str] = None
    # Optional partial usage for a run that failed after one or more model calls
    # completed. Same numeric-only shape as RUN_FINISHED.
    usage: Optional[List[TokenUsage]] = None


class StepStartedEvent(BaseEvent):
    """
    Event indicating that a step has started.
    """
    type: Literal[EventType.STEP_STARTED] = EventType.STEP_STARTED  # pyright: ignore[reportIncompatibleVariableOverride]
    step_name: str


class StepFinishedEvent(BaseEvent):
    """
    Event indicating that a step has finished.
    """
    type: Literal[EventType.STEP_FINISHED] = EventType.STEP_FINISHED  # pyright: ignore[reportIncompatibleVariableOverride]
    step_name: str


# Text message role for reasoning messages (aligned with ReasoningMessage.role)
ReasoningMessageRole = Literal["reasoning"]

# Subtype for encrypted value
ReasoningEncryptedValueSubtype = Literal["tool-call", "message"]


class ReasoningStartEvent(BaseEvent):
    """
    Event indicating the start of a reasoning phase.
    """
    type: Literal[EventType.REASONING_START] = EventType.REASONING_START  # pyright: ignore[reportIncompatibleVariableOverride]
    message_id: str


class ReasoningMessageStartEvent(BaseEvent):
    """
    Event indicating the start of a reasoning message.
    """
    type: Literal[EventType.REASONING_MESSAGE_START] = EventType.REASONING_MESSAGE_START  # pyright: ignore[reportIncompatibleVariableOverride]
    message_id: str
    role: ReasoningMessageRole


class ReasoningMessageContentEvent(BaseEvent):
    """
    Event containing a piece of reasoning message content.
    """
    type: Literal[EventType.REASONING_MESSAGE_CONTENT] = EventType.REASONING_MESSAGE_CONTENT  # pyright: ignore[reportIncompatibleVariableOverride]
    message_id: str
    delta: str


class ReasoningMessageEndEvent(BaseEvent):
    """
    Event indicating the end of a reasoning message.
    """
    type: Literal[EventType.REASONING_MESSAGE_END] = EventType.REASONING_MESSAGE_END  # pyright: ignore[reportIncompatibleVariableOverride]
    message_id: str


class ReasoningMessageChunkEvent(BaseEvent):
    """
    Event containing a chunk of reasoning message content.
    """
    type: Literal[EventType.REASONING_MESSAGE_CHUNK] = EventType.REASONING_MESSAGE_CHUNK  # pyright: ignore[reportIncompatibleVariableOverride]
    message_id: Optional[str] = None
    delta: Optional[str] = None


class ReasoningEndEvent(BaseEvent):
    """
    Event indicating the end of a reasoning phase.
    """
    type: Literal[EventType.REASONING_END] = EventType.REASONING_END  # pyright: ignore[reportIncompatibleVariableOverride]
    message_id: str


class ReasoningEncryptedValueEvent(BaseEvent):
    """
    Event containing an encrypted value for a message or tool call.
    """
    type: Literal[EventType.REASONING_ENCRYPTED_VALUE] = EventType.REASONING_ENCRYPTED_VALUE  # pyright: ignore[reportIncompatibleVariableOverride]
    subtype: ReasoningEncryptedValueSubtype
    entity_id: str
    encrypted_value: str


Event = Annotated[
    Union[
        TextMessageStartEvent,
        TextMessageContentEvent,
        TextMessageEndEvent,
        TextMessageChunkEvent,
        ThinkingTextMessageStartEvent,
        ThinkingTextMessageContentEvent,
        ThinkingTextMessageEndEvent,
        ToolCallStartEvent,
        ToolCallArgsEvent,
        ToolCallEndEvent,
        ToolCallChunkEvent,
        ToolCallResultEvent,
        ThinkingStartEvent,
        ThinkingEndEvent,
        StateSnapshotEvent,
        StateDeltaEvent,
        MessagesSnapshotEvent,
        ActivitySnapshotEvent,
        ActivityDeltaEvent,
        RawEvent,
        CustomEvent,
        RunStartedEvent,
        RunFinishedEvent,
        RunErrorEvent,
        StepStartedEvent,
        StepFinishedEvent,
        ReasoningStartEvent,
        ReasoningMessageStartEvent,
        ReasoningMessageContentEvent,
        ReasoningMessageEndEvent,
        ReasoningMessageChunkEvent,
        ReasoningEndEvent,
        ReasoningEncryptedValueEvent,
    ],
    Field(discriminator="type")
]
