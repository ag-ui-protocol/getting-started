"""
This module contains the types for the Agent User Interaction Protocol Python SDK.
"""

import warnings
from typing import Annotated, Any, Dict, FrozenSet, List, Literal, Optional, Union

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    SerializerFunctionWrapHandler,
    model_serializer,
    model_validator,
)
from pydantic.alias_generators import to_camel

_OMITTABLE_KEYS_CACHE_ATTR = "__agui_omittable_keys__"


class ConfiguredBaseModel(BaseModel):
    """
    A configurable base model.

    Serialization omits every optional field that has no value instead of
    writing it out as JSON ``null``. Pydantic's default is to include it, which
    made this SDK the only AG-UI producer that put ``null`` on the wire where
    TypeScript simply left the key out — and cost the protocol three
    receiving-side tolerance patches (``TOOL_CALL_START.parentMessageId``,
    ``TOOL_CALL_CHUNK.parentMessageId``, ``RUN_FINISHED.outcome``). Omission is
    applied here, in the base model, so it holds on every serialization path
    (``model_dump``, ``model_dump_json``, nesting inside another model, and any
    ``TypeAdapter``) rather than depending on each call site remembering
    ``exclude_none=True``.

    "Has no value" means a field that is declared optional *and* defaults to
    ``None`` — that is exactly the set the contract lets a producer leave out.
    Nulls that carry meaning are untouched: a required field, a ``None`` inside
    a ``dict``/``list`` value (an individual metadata value, say), and any extra
    field all serialize as ``null``.
    """
    model_config = ConfigDict(
        extra="allow",
        alias_generator=to_camel,
        populate_by_name=True,
    )

    @classmethod
    def _omittable_keys(cls) -> FrozenSet[str]:
        """
        The serialized keys that may be dropped when their value is ``None``.

        Both the field name and its alias are included, because the caller
        chooses between them with ``by_alias``. Cached per class in the class's
        own ``__dict__`` so a subclass never inherits its parent's answer.
        """
        cached = cls.__dict__.get(_OMITTABLE_KEYS_CACHE_ATTR)
        if cached is None:
            keys = set()
            for name, field in cls.model_fields.items():
                if not field.is_required() and field.default is None:
                    keys.add(name)
                    if field.alias is not None:
                        keys.add(field.alias)
                    if field.serialization_alias is not None:
                        keys.add(field.serialization_alias)
            cached = frozenset(keys)
            setattr(cls, _OMITTABLE_KEYS_CACHE_ATTR, cached)
        return cached

    @model_serializer(mode="wrap")
    def _omit_fields_without_value(self, handler: SerializerFunctionWrapHandler):
        # Deliberately unannotated return: annotating it (``Dict[str, Any]``, say)
        # makes Pydantic replace the model's serialization JSON schema with a bare
        # ``{"type": "object"}``. Left off, the handler's own schema is kept.
        serialized = handler(self)
        omittable = type(self)._omittable_keys()
        return {
            key: value
            for key, value in serialized.items()
            if value is not None or key not in omittable
        }


Metadata = Dict[str, Any]

AGUI_METADATA_KEY = "ag-ui"
"""
The key reserved for AG-UI's own use inside a metadata object. Every other key
is user space.

Reservation is by convention: nothing rejects a write to this key at runtime,
because metadata is open by key and validating its shape would contradict that.
"""


class MetadataMixin(ConfiguredBaseModel):
    """
    Adds an optional metadata object.

    Open by key — any JSON value is allowed under a key, including ``None``. A
    ``None`` value under a key is meaningful data and is preserved.

    The object itself is absent or a mapping, never ``None``.
    ``ConfiguredBaseModel`` omits an unset optional field on every
    serialization path, so an absent metadata object never reaches the wire as
    ``null`` — no ``exclude_none=True`` needed at any call site. The TypeScript
    client enforces the same contract from the other side and rejects a
    ``null`` metadata object: metadata postdates the omission fix, so unlike
    some older optional fields there is no legacy producer to tolerate.
    """

    metadata: Optional[Metadata] = None


class FunctionCall(ConfiguredBaseModel):
    """
    Name and arguments of a function call.
    """
    name: str
    arguments: str


class ToolCall(MetadataMixin):
    """
    A tool call, modelled after OpenAI tool calls.

    Carries its own metadata rather than folding into the assistant message that
    owns it: several tool calls can share one parent, so merging them all into it
    would make the result depend on their relative order.
    """
    id: str
    type: Literal["function"] = "function"  # pyright: ignore[reportIncompatibleVariableOverride]
    function: FunctionCall
    encrypted_value: Optional[str] = None


class BaseMessage(MetadataMixin):
    """
    A base message, modelled after OpenAI messages.
    """
    id: str
    role: str
    content: Optional[str] = None
    name: Optional[str] = None
    encrypted_value: Optional[str] = None
    subagent_run_id: Optional[str] = None


class DeveloperMessage(BaseMessage):
    """
    A developer message.
    """
    role: Literal["developer"] = "developer"  # pyright: ignore[reportIncompatibleVariableOverride]
    content: str


class SystemMessage(BaseMessage):
    """
    A system message.
    """
    role: Literal["system"] = "system"  # pyright: ignore[reportIncompatibleVariableOverride]
    content: str


class AssistantMessage(BaseMessage):
    """
    An assistant message.
    """
    role: Literal["assistant"] = "assistant"  # pyright: ignore[reportIncompatibleVariableOverride]
    tool_calls: Optional[List[ToolCall]] = None


class TextInputContent(ConfiguredBaseModel):
    """A text fragment in a multimodal user message."""

    type: Literal["text"] = "text"
    text: str


class InputContentDataSource(ConfiguredBaseModel):
    """Inline base64-encoded source."""

    type: Literal["data"] = "data"
    value: str
    mime_type: str


class InputContentUrlSource(ConfiguredBaseModel):
    """URL-referenced source."""

    type: Literal["url"] = "url"
    value: str
    mime_type: Optional[str] = None


InputContentSource = Annotated[
    Union[InputContentDataSource, InputContentUrlSource],
    Field(discriminator="type"),
]


class ImageInputContent(ConfiguredBaseModel):
    """An image input content fragment."""

    type: Literal["image"] = "image"
    source: InputContentSource
    metadata: Optional[Any] = None


class AudioInputContent(ConfiguredBaseModel):
    """An audio input content fragment."""

    type: Literal["audio"] = "audio"
    source: InputContentSource
    metadata: Optional[Any] = None


class VideoInputContent(ConfiguredBaseModel):
    """A video input content fragment."""

    type: Literal["video"] = "video"
    source: InputContentSource
    metadata: Optional[Any] = None


class DocumentInputContent(ConfiguredBaseModel):
    """A document input content fragment."""

    type: Literal["document"] = "document"
    source: InputContentSource
    metadata: Optional[Any] = None


class BinaryInputContent(ConfiguredBaseModel):
    """A deprecated binary payload reference in a multimodal user message."""

    type: Literal["binary"] = "binary"  # pyright: ignore[reportIncompatibleVariableOverride]
    mime_type: str
    id: Optional[str] = None
    url: Optional[str] = None
    data: Optional[str] = None
    filename: Optional[str] = None

    @model_validator(mode="after")
    def validate_source(self) -> "BinaryInputContent":
        """Ensure at least one binary payload source is provided."""
        if not any([self.id, self.url, self.data]):
            raise ValueError("BinaryInputContent requires id, url, or data to be provided.")
        return self

    def model_post_init(self, __context: Any) -> None:
        warnings.warn(
            "BinaryInputContent is deprecated and will be removed in a future release. "
            "Use ImageInputContent/AudioInputContent/VideoInputContent/DocumentInputContent with InputContentSource.",
            DeprecationWarning,
            stacklevel=2,
        )


InputContent = Annotated[
    Union[
        TextInputContent,
        ImageInputContent,
        AudioInputContent,
        VideoInputContent,
        DocumentInputContent,
        BinaryInputContent,
    ],
    Field(discriminator="type"),
]

ImageInputPart = ImageInputContent
AudioInputPart = AudioInputContent
VideoInputPart = VideoInputContent
DocumentInputPart = DocumentInputContent

InputContentPart = InputContent


class UserMessage(BaseMessage):
    """
    A user message supporting text or multimodal content.
    """

    role: Literal["user"] = "user"  # pyright: ignore[reportIncompatibleVariableOverride]
    content: Union[str, List[InputContent]]


class ToolMessage(MetadataMixin):
    """
    A tool result message.
    """
    id: str
    role: Literal["tool"] = "tool"
    content: str
    tool_call_id: str
    name: Optional[str] = None
    error: Optional[str] = None
    encrypted_value: Optional[str] = None
    subagent_run_id: Optional[str] = None


class ActivityMessage(MetadataMixin):
    """
    An activity progress message emitted between chat messages.
    """

    id: str
    role: Literal["activity"] = "activity"  # pyright: ignore[reportIncompatibleVariableOverride]
    activity_type: str
    content: Dict[str, Any]
    subagent_run_id: Optional[str] = None


class ReasoningMessage(MetadataMixin):
    """
    A reasoning message containing the agent's internal reasoning process.
    """

    id: str
    role: Literal["reasoning"] = "reasoning"  # pyright: ignore[reportIncompatibleVariableOverride]
    content: str
    encrypted_value: Optional[str] = None
    subagent_run_id: Optional[str] = None


Message = Annotated[
    Union[
        DeveloperMessage,
        SystemMessage,
        AssistantMessage,
        UserMessage,
        ToolMessage,
        ActivityMessage,
        ReasoningMessage,
    ],
    Field(discriminator="role")
]

Role = Literal["developer", "system", "assistant", "user", "tool", "activity", "reasoning"]


class Context(ConfiguredBaseModel):
    """
    Additional context for the agent.
    """
    description: str
    value: str


class Tool(ConfiguredBaseModel):
    """
    A tool definition.
    """
    name: str
    description: str
    parameters: Optional[Any] = None  # JSON Schema for the tool parameters


class Interrupt(ConfiguredBaseModel):
    """
    A pause carried inside ``RunFinishedEvent.outcome`` when the outcome is
    ``RunFinishedInterruptOutcome``. The client resumes
    by addressing this interrupt in the resume array of the next RunAgentInput.
    """
    id: str
    reason: str
    message: Optional[str] = None
    tool_call_id: Optional[str] = None
    response_schema: Optional[Dict[str, Any]] = None
    expires_at: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None
    # The subagent whose work raised this interrupt, when it was raised inside
    # one — None for a root-raised interrupt. Attribution lives per interrupt
    # rather than on the run outcome because one run can carry interrupts from
    # several subagents.
    subagent_run_id: Optional[str] = None


ResumeStatus = Literal["resolved", "cancelled"]


class ResumeEntry(MetadataMixin):
    """
    A per-interrupt response in the resume array of a RunAgentInput.

    ``metadata`` carries envelope data about the response — signatures, routing
    keys — as opposed to ``payload``, which is the answer the agent asked for
    and will act on.
    """
    interrupt_id: str
    status: ResumeStatus
    payload: Optional[Any] = None


class RunAgentInput(ConfiguredBaseModel):
    """
    Input for running an agent.
    """
    thread_id: str
    run_id: str
    parent_run_id: Optional[str] = None
    # Optional by contract: absent means "no state", and a bare null on the wire
    # reads as absent (every consumer collapses the two, and .NET's representation
    # cannot tell them apart). Defaulting to None makes the base model omit it
    # when unset. Nulls INSIDE a state object are values and survive.
    state: Any = None
    messages: List[Message]
    tools: List[Tool]
    context: List[Context]
    forwarded_props: Any
    resume: Optional[List[ResumeEntry]] = None


# State can be any type
State = Any
