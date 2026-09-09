"""
Event types for the Agent User Interaction Protocol.

Since PNI-213 this module is a compatibility surface: every protocol shape is
re-exported from the generated models (``ag_ui._generated.models``, emitted
from ``spec/draft/schema.json`` — regenerate with
``pnpm --filter @ag-ui/spec generate``). Nothing protocol-shaped is declared
by hand here; edit the schema, not this file.

The deprecated ``THINKING_*`` events and their classes left the protocol in
1.0 (see DEPRECATIONS.md): producers emit the ``REASONING_*`` events instead,
and the TypeScript client's inbound compatibility boundary keeps translating
old streams for consumers.
"""

from typing import Literal

from ag_ui._generated.models import (
    EventType,
    BaseEvent,
    TextMessageStartEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    TextMessageChunkEvent,
    ToolCallStartEvent,
    ToolCallArgsEvent,
    ToolCallEndEvent,
    ToolCallChunkEvent,
    ToolCallResultEvent,
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
    ReasoningEncryptedValueSubtype,
    SubagentStartedEvent,
    SubagentFinishedEvent,
    SubagentErrorEvent,
    SubagentFinishedOutcome,
    SubagentFinishedSuccessOutcome,
    SubagentFinishedSuspendedOutcome,
    RunFinishedOutcome,
    RunFinishedSuccessOutcome,
    RunFinishedInterruptOutcome,
    TokenUsage,
    TextMessageRole,
    Event,
)

ReasoningMessageRole = Literal["reasoning"]
"""Historic alias: the one role a reasoning message start may carry."""

# The hand-written module had no __all__, so names it merely imported were
# importable from it too; that accidental-but-public surface is kept.
from ag_ui._generated.models import (
    GeneratedBaseModel as ConfiguredBaseModel,
    GeneratedBaseModel as MetadataMixin,
    Interrupt,
    Message,
    Role,
    RunAgentInput,
    State,
)

__all__ = [
    "EventType",
    "BaseEvent",
    "TextMessageStartEvent",
    "TextMessageContentEvent",
    "TextMessageEndEvent",
    "TextMessageChunkEvent",
    "ToolCallStartEvent",
    "ToolCallArgsEvent",
    "ToolCallEndEvent",
    "ToolCallChunkEvent",
    "ToolCallResultEvent",
    "StateSnapshotEvent",
    "StateDeltaEvent",
    "MessagesSnapshotEvent",
    "ActivitySnapshotEvent",
    "ActivityDeltaEvent",
    "RawEvent",
    "CustomEvent",
    "RunStartedEvent",
    "RunFinishedEvent",
    "RunErrorEvent",
    "StepStartedEvent",
    "StepFinishedEvent",
    "ReasoningStartEvent",
    "ReasoningMessageStartEvent",
    "ReasoningMessageContentEvent",
    "ReasoningMessageEndEvent",
    "ReasoningMessageChunkEvent",
    "ReasoningEndEvent",
    "ReasoningEncryptedValueEvent",
    "ReasoningEncryptedValueSubtype",
    "ReasoningMessageRole",
    "SubagentStartedEvent",
    "SubagentFinishedEvent",
    "SubagentErrorEvent",
    "SubagentFinishedOutcome",
    "SubagentFinishedSuccessOutcome",
    "SubagentFinishedSuspendedOutcome",
    "RunFinishedOutcome",
    "RunFinishedSuccessOutcome",
    "RunFinishedInterruptOutcome",
    "TokenUsage",
    "TextMessageRole",
    "Event",
    "ConfiguredBaseModel",
    "MetadataMixin",
    "Interrupt",
    "Message",
    "Role",
    "RunAgentInput",
    "State",
]
