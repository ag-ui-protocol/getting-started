"""
This module contains the types for the Agent User Interaction Protocol.

Since PNI-213 it is a compatibility surface: every protocol shape is
re-exported from the generated models (``ag_ui._generated.models``, emitted
from ``spec/draft/schema.json`` — regenerate with
``pnpm --filter @ag-ui/spec generate``). Only the package's own non-protocol
pieces (the reserved metadata key, historic aliases) are declared here.

The legacy ``BinaryInputContent`` part left the protocol in 1.0 (see
DEPRECATIONS.md): producers send the media parts (image, audio, video,
document) with a ``source``. Two TypeScript shims cover it, and both move in
the SAME direction — legacy to modern. The always-on inbound compatibility
boundary (``CompatibilityBoundary``) upgrades a legacy part arriving inside a
message, and the version-gated ``BackwardCompatibility_0_0_47`` middleware
upgrades one on the way out, rewriting ``RunAgentInput.messages`` through
``convertBinaryToNewFormat`` before the request is sent. Nothing converts a
modern media part back to ``{"type": "binary"}``. The version gate is about
the CALLER rather than the payload: an application still assembling messages
the pre-0.0.48 way is the only place a legacy part can still enter, so the
upgrade is installed for exactly those peers and skipped for everyone else.
"""

from typing import Literal

from ag_ui._generated.models import (
    GeneratedBaseModel,
    Attributable,
    Metadata,
    SubagentRunId,
    FunctionCall,
    ToolCall,
    BaseMessage,
    DeveloperMessage,
    SystemMessage,
    AssistantMessage,
    UserMessage,
    ToolMessage,
    ActivityMessage,
    ReasoningMessage,
    Message,
    Role,
    Context,
    Tool,
    Interrupt,
    ResumeEntry,
    RunAgentInput,
    State,
    TextInputContent,
    InputContentDataSource,
    InputContentUrlSource,
    InputContentSource,
    ImageInputContent,
    AudioInputContent,
    VideoInputContent,
    DocumentInputContent,
    InputContent,
)

AGUI_METADATA_KEY = "ag-ui"
"""
The key reserved for AG-UI's own use inside a metadata object. Every other key
is user space.

Reservation is by convention: nothing rejects a write to this key at runtime,
because metadata is open by key and validating its shape would contradict that.
"""

ConfiguredBaseModel = GeneratedBaseModel
"""
Historic name for the configured pydantic base every model shares. The
configuration itself now lives on the generated base (camelCase aliases,
populate by name, unknown fields kept).
"""

MetadataMixin = GeneratedBaseModel
"""
Historic name for the base that carried the ``metadata`` field. The generated
hierarchy declares ``metadata`` on ``BaseEvent`` and ``BaseMessage`` (and each
standalone message) directly; every model still passes an
``isinstance(x, MetadataMixin)`` check through this alias.
"""

ResumeStatus = Literal["resolved", "cancelled"]
"""Whether the interrupt was answered or abandoned (ResumeEntry.status)."""

# Historic aliases for the media input parts: the schema names them
# ...InputContent, and this package has always also exported them as
# ...InputPart.
ImageInputPart = ImageInputContent
AudioInputPart = AudioInputContent
VideoInputPart = VideoInputContent
DocumentInputPart = DocumentInputContent

InputContentPart = InputContent
"""Historic alias: a content part of a user message."""

__all__ = [
    "AGUI_METADATA_KEY",
    "Metadata",
    "SubagentRunId",
    "ConfiguredBaseModel",
    "GeneratedBaseModel",
    "MetadataMixin",
    "Attributable",
    "FunctionCall",
    "ToolCall",
    "BaseMessage",
    "DeveloperMessage",
    "SystemMessage",
    "AssistantMessage",
    "UserMessage",
    "ToolMessage",
    "ActivityMessage",
    "ReasoningMessage",
    "Message",
    "Role",
    "Context",
    "Tool",
    "Interrupt",
    "ResumeEntry",
    "ResumeStatus",
    "RunAgentInput",
    "State",
    "TextInputContent",
    "InputContentDataSource",
    "InputContentUrlSource",
    "InputContentSource",
    "ImageInputContent",
    "AudioInputContent",
    "VideoInputContent",
    "DocumentInputContent",
    "ImageInputPart",
    "AudioInputPart",
    "VideoInputPart",
    "DocumentInputPart",
    "InputContent",
    "InputContentPart",
]
