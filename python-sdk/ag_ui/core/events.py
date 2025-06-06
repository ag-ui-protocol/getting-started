"""
This module contains the event types for the Agent User Interaction Protocol Python SDK.
"""

from __future__ import annotations

from enum import Enum
from typing import Any, List, Literal, Optional, Annotated
from pydantic import Field

from .types import Message, State, ConfiguredBaseModel


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
    timestamp: int | None = None
    raw_event: Any = None


class TextMessageStartEvent(BaseEvent):
    """
    Event indicating the start of a text message.
    """
    type: Literal[EventType.TEXT_MESSAGE_START]
    message_id: str
    role: Literal["assistant"]


class TextMessageContentEvent(BaseEvent):
    """
    Event containing a piece of text message content.
    """
    type: Literal[EventType.TEXT_MESSAGE_CONTENT]
    message_id: str
    delta: str  # This should not be an empty string

    def model_post_init(self, __context):
        if len(self.delta) == 0:
            raise ValueError("Delta must not be an empty string")


class TextMessageEndEvent(BaseEvent):
    """
    Event indicating the end of a text message.
    """
    type: Literal[EventType.TEXT_MESSAGE_END]
    message_id: str

class TextMessageChunkEvent(BaseEvent):
    """
    Event containing a chunk of text message content.
    """
    type: Literal[EventType.TEXT_MESSAGE_CHUNK]
    message_id: str | None = None
    role: Optional[Literal["assistant"]] = None
    delta: str | None = None

class ToolCallStartEvent(BaseEvent):
    """
    Event indicating the start of a tool call.
    """
    type: Literal[EventType.TOOL_CALL_START]
    tool_call_id: str
    tool_call_name: str
    parent_message_id: str | None = None


class ToolCallArgsEvent(BaseEvent):
    """
    Event containing tool call arguments.
    """
    type: Literal[EventType.TOOL_CALL_ARGS]
    tool_call_id: str
    delta: str


class ToolCallEndEvent(BaseEvent):
    """
    Event indicating the end of a tool call.
    """
    type: Literal[EventType.TOOL_CALL_END]
    tool_call_id: str

class ToolCallChunkEvent(BaseEvent):
    """
    Event containing a chunk of tool call content.
    """
    type: Literal[EventType.TOOL_CALL_CHUNK]
    tool_call_id: str | None = None
    tool_call_name: str | None = None
    parent_message_id: str | None = None
    delta: str | None = None

class StateSnapshotEvent(BaseEvent):
    """
    Event containing a snapshot of the state.
    """
    type: Literal[EventType.STATE_SNAPSHOT]
    snapshot: State


class StateDeltaEvent(BaseEvent):
    """
    Event containing a delta of the state.
    """
    type: Literal[EventType.STATE_DELTA]
    delta: List[Any]  # JSON Patch (RFC 6902)


class MessagesSnapshotEvent(BaseEvent):
    """
    Event containing a snapshot of the messages.
    """
    type: Literal[EventType.MESSAGES_SNAPSHOT]
    messages: List[Message]


class RawEvent(BaseEvent):
    """
    Event containing a raw event.
    """
    type: Literal[EventType.RAW]
    event: Any
    source: str | None = None


class CustomEvent(BaseEvent):
    """
    Event containing a custom event.
    """
    type: Literal[EventType.CUSTOM]
    name: str
    value: Any


class RunStartedEvent(BaseEvent):
    """
    Event indicating that a run has started.
    """
    type: Literal[EventType.RUN_STARTED]
    thread_id: str
    run_id: str


class RunFinishedEvent(BaseEvent):
    """
    Event indicating that a run has finished.
    """
    type: Literal[EventType.RUN_FINISHED]
    thread_id: str
    run_id: str


class RunErrorEvent(BaseEvent):
    """
    Event indicating that a run has encountered an error.
    """
    type: Literal[EventType.RUN_ERROR]
    message: str
    code: str | None = None


class StepStartedEvent(BaseEvent):
    """
    Event indicating that a step has started.
    """
    type: Literal[EventType.STEP_STARTED]
    step_name: str


class StepFinishedEvent(BaseEvent):
    """
    Event indicating that a step has finished.
    """
    type: Literal[EventType.STEP_FINISHED]
    step_name: str


Event = Annotated[
    TextMessageStartEvent |
    TextMessageContentEvent |
    TextMessageEndEvent |
    TextMessageChunkEvent |
    ToolCallStartEvent |
    ToolCallArgsEvent |
    ToolCallEndEvent |
    ToolCallChunkEvent |
    StateSnapshotEvent |
    StateDeltaEvent |
    MessagesSnapshotEvent |
    RawEvent |
    CustomEvent |
    RunStartedEvent |
    RunFinishedEvent |
    RunErrorEvent |
    StepStartedEvent |
    StepFinishedEvent,
    Field(discriminator="type")
]
