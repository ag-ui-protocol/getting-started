"""
This module contains the types for the Agent User Interaction Protocol Python SDK.
"""

import warnings
from typing import Annotated, Any, Dict, List, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel


class ConfiguredBaseModel(BaseModel):
    """
    A configurable base model.
    """
    model_config = ConfigDict(
        extra="allow",
        alias_generator=to_camel,
        populate_by_name=True,
    )


class FunctionCall(ConfiguredBaseModel):
    """
    Name and arguments of a function call.
    """
    name: str
    arguments: str


class ToolCall(ConfiguredBaseModel):
    """
    A tool call, modelled after OpenAI tool calls.
    """
    id: str
    type: Literal["function"] = "function"  # pyright: ignore[reportIncompatibleVariableOverride]
    function: FunctionCall
    encrypted_value: Optional[str] = None


class BaseMessage(ConfiguredBaseModel):
    """
    A base message, modelled after OpenAI messages.
    """
    id: str
    role: str
    content: Optional[str] = None
    name: Optional[str] = None
    encrypted_value: Optional[str] = None
    subagent_id: Optional[str] = None


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


class ToolMessage(ConfiguredBaseModel):
    """
    A tool result message.
    """
    id: str
    role: Literal["tool"] = "tool"
    content: str
    tool_call_id: str
    error: Optional[str] = None
    encrypted_value: Optional[str] = None
    subagent_id: Optional[str] = None


class ActivityMessage(ConfiguredBaseModel):
    """
    An activity progress message emitted between chat messages.
    """

    id: str
    role: Literal["activity"] = "activity"  # pyright: ignore[reportIncompatibleVariableOverride]
    activity_type: str
    content: Dict[str, Any]
    subagent_id: Optional[str] = None


class ReasoningMessage(ConfiguredBaseModel):
    """
    A reasoning message containing the agent's internal reasoning process.
    """

    id: str
    role: Literal["reasoning"] = "reasoning"  # pyright: ignore[reportIncompatibleVariableOverride]
    content: str
    encrypted_value: Optional[str] = None
    subagent_id: Optional[str] = None


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


ResumeStatus = Literal["resolved", "cancelled"]


class ResumeEntry(ConfiguredBaseModel):
    """
    A per-interrupt response in the resume array of a RunAgentInput.
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
    state: Any
    messages: List[Message]
    tools: List[Tool]
    context: List[Context]
    forwarded_props: Any
    resume: Optional[List[ResumeEntry]] = None


# State can be any type
State = Any
