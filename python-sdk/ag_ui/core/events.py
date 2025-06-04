"""
This module contains the event types for the Agent User Interaction Protocol Python SDK.
"""

from enum import Enum
from typing import Any, List, Literal, Optional, Union, Annotated
from pydantic import Field

from .types import Message, State, ConfiguredBaseModel, Role


class EventType(str, Enum):
    """
    The type of event.
    """
    TEXT_MESSAGE_START = "TEXT_MESSAGE_START"
    TEXT_MESSAGE_CONTENT = "TEXT_MESSAGE_CONTENT"
    TEXT_MESSAGE_END = "TEXT_MESSAGE_END"
    TEXT_MESSAGE_CHUNK = "TEXT_MESSAGE_CHUNK"
    TOOL_CALL_START = "TOOL_CALL_START"
    TOOL_CALL_ARGS = "TOOL_CALL_ARGS"
    TOOL_CALL_END = "TOOL_CALL_END"
    TOOL_CALL_CHUNK = "TOOL_CALL_CHUNK"
    STATE_SNAPSHOT = "STATE_SNAPSHOT"
    STATE_DELTA = "STATE_DELTA"
    MESSAGES_SNAPSHOT = "MESSAGES_SNAPSHOT"
    RAW = "RAW"
    CUSTOM = "CUSTOM"
    RUN_STARTED = "RUN_STARTED"
    RUN_FINISHED = "RUN_FINISHED"
    RUN_ERROR = "RUN_ERROR"
    STEP_STARTED = "STEP_STARTED"
    STEP_FINISHED = "STEP_FINISHED"


class BaseEvent(ConfiguredBaseModel):
    """
    Base event for all events in the Agent User Interaction Protocol.
    """
    type: EventType
    timestamp: Optional[int] = None
    raw_event: Optional[Any] = None


class TextMessageStartEvent(BaseEvent):
    """
    Event indicating the start of a text message.
    """
    type: Literal[EventType.TEXT_MESSAGE_START] = Field(EventType.TEXT_MESSAGE_START, init=False)  # pyright: ignore[reportIncompatibleVariableOverride]
    message_id: str
    role: Literal[Role.ASSISTANT] = Field(Role.ASSISTANT, init=False)


class TextMessageContentEvent(BaseEvent):
    """
    Event containing a piece of text message content.
    """
    type: Literal[EventType.TEXT_MESSAGE_CONTENT] = Field(EventType.TEXT_MESSAGE_CONTENT, init=False)  # pyright: ignore[reportIncompatibleVariableOverride]
    message_id: str
    delta: str = Field(min_length=1)


class TextMessageEndEvent(BaseEvent):
    """
    Event indicating the end of a text message.
    """
    type: Literal[EventType.TEXT_MESSAGE_END] = Field(EventType.TEXT_MESSAGE_END, init=False)  # pyright: ignore[reportIncompatibleVariableOverride]
    message_id: str

class TextMessageChunkEvent(BaseEvent):
    """
    Event containing a chunk of text message content.
    """
    type: Literal[EventType.TEXT_MESSAGE_CHUNK] = Field(EventType.TEXT_MESSAGE_CHUNK, init=False)  # pyright: ignore[reportIncompatibleVariableOverride]
    message_id: Optional[str] = None
    role: Optional[Literal["assistant"]] = None
    delta: Optional[str] = None

class ToolCallStartEvent(BaseEvent):
    """
    Event indicating the start of a tool call.
    """
    type: Literal[EventType.TOOL_CALL_START] = Field(EventType.TOOL_CALL_START, init=False)  # pyright: ignore[reportIncompatibleVariableOverride]
    tool_call_id: str
    tool_call_name: str
    parent_message_id: Optional[str] = None


class ToolCallArgsEvent(BaseEvent):
    """
    Event containing tool call arguments.
    """
    type: Literal[EventType.TOOL_CALL_ARGS] = Field(EventType.TOOL_CALL_ARGS, init=False)  # pyright: ignore[reportIncompatibleVariableOverride]
    tool_call_id: str
    delta: str


class ToolCallEndEvent(BaseEvent):
    """
    Event indicating the end of a tool call.
    """
    type: Literal[EventType.TOOL_CALL_END] = Field(EventType.TOOL_CALL_END, init=False)  # pyright: ignore[reportIncompatibleVariableOverride]
    tool_call_id: str

class ToolCallChunkEvent(BaseEvent):
    """
    Event containing a chunk of tool call content.
    """
    type: Literal[EventType.TOOL_CALL_CHUNK] = Field(EventType.TOOL_CALL_CHUNK, init=False)  # pyright: ignore[reportIncompatibleVariableOverride]
    tool_call_id: Optional[str] = None
    tool_call_name: Optional[str] = None
    parent_message_id: Optional[str] = None
    delta: Optional[str] = None

class StateSnapshotEvent(BaseEvent):
    """
    Event containing a snapshot of the state.
    """
    type: Literal[EventType.STATE_SNAPSHOT] = Field(EventType.STATE_SNAPSHOT, init=False)  # pyright: ignore[reportIncompatibleVariableOverride]
    snapshot: State


class StateDeltaEvent(BaseEvent):
    """
    Event containing a delta of the state.
    """
    type: Literal[EventType.STATE_DELTA] = Field(EventType.STATE_DELTA, init=False)  # pyright: ignore[reportIncompatibleVariableOverride]
    delta: List[Any]  # JSON Patch (RFC 6902)


class MessagesSnapshotEvent(BaseEvent):
    """
    Event containing a snapshot of the messages.
    """
    type: Literal[EventType.MESSAGES_SNAPSHOT] = Field(EventType.MESSAGES_SNAPSHOT, init=False)  # pyright: ignore[reportIncompatibleVariableOverride]
    messages: List[Message]


class RawEvent(BaseEvent):
    """
    Event containing a raw event.
    """
    type: Literal[EventType.RAW] = Field(EventType.RAW, init=False)  # pyright: ignore[reportIncompatibleVariableOverride]
    event: Any
    source: Optional[str] = None


class CustomEvent(BaseEvent):
    """
    Event containing a custom event.
    """
    type: Literal[EventType.CUSTOM] = Field(EventType.CUSTOM, init=False)  # pyright: ignore[reportIncompatibleVariableOverride]
    name: str
    value: Any


class RunStartedEvent(BaseEvent):
    """
    Event indicating that a run has started.
    """
    type: Literal[EventType.RUN_STARTED] = Field(EventType.RUN_STARTED, init=False)  # pyright: ignore[reportIncompatibleVariableOverride]
    thread_id: str
    run_id: str


class RunFinishedEvent(BaseEvent):
    """
    Event indicating that a run has finished.
    """
    type: Literal[EventType.RUN_FINISHED] = Field(EventType.RUN_FINISHED, init=False)  # pyright: ignore[reportIncompatibleVariableOverride]
    thread_id: str
    run_id: str


class RunErrorEvent(BaseEvent):
    """
    Event indicating that a run has encountered an error.
    """
    type: Literal[EventType.RUN_ERROR] = Field(EventType.RUN_ERROR, init=False)  # pyright: ignore[reportIncompatibleVariableOverride]
    message: str
    code: Optional[str] = None


class StepStartedEvent(BaseEvent):
    """
    Event indicating that a step has started.
    """
    type: Literal[EventType.STEP_STARTED] = Field(EventType.STEP_STARTED, init=False)  # pyright: ignore[reportIncompatibleVariableOverride]
    step_name: str


class StepFinishedEvent(BaseEvent):
    """
    Event indicating that a step has finished.
    """
    type: Literal[EventType.STEP_FINISHED] = Field(EventType.STEP_FINISHED, init=False)  # pyright: ignore[reportIncompatibleVariableOverride]
    step_name: str


Event = Annotated[
    Union[
        TextMessageStartEvent,
        TextMessageContentEvent,
        TextMessageEndEvent,
        TextMessageChunkEvent,
        ToolCallStartEvent,
        ToolCallArgsEvent,
        ToolCallEndEvent,
        ToolCallChunkEvent,
        StateSnapshotEvent,
        StateDeltaEvent,
        MessagesSnapshotEvent,
        RawEvent,
        CustomEvent,
        RunStartedEvent,
        RunFinishedEvent,
        RunErrorEvent,
        StepStartedEvent,
        StepFinishedEvent,
    ],
    Field(discriminator="type")
]
