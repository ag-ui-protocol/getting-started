"""
This module contains the types for the Agent User Interaction Protocol Python SDK.
"""

from typing import Any, List, Literal, Optional, Union, Annotated
from pydantic import BaseModel, Field, ConfigDict
from pydantic.alias_generators import to_camel

class ConfiguredBaseModel(BaseModel):
    """
    A configurable base model.
    """
    model_config = ConfigDict(
        extra="forbid",
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
    type: Literal["function"]
    function: FunctionCall


class BaseMessage(ConfiguredBaseModel):
    """
    A base message, modelled after OpenAI messages.
    """
    id: str
    role: str
    content: Optional[str] = None
    name: Optional[str] = None


class DeveloperMessage(BaseMessage):
    """
    A developer message.
    """
    role: Literal["developer"]
    content: str


class SystemMessage(BaseMessage):
    """
    A system message.
    """
    role: Literal["system"]
    content: str


class AssistantMessage(BaseMessage):
    """
    An assistant message.
    """
    role: Literal["assistant"]
    tool_calls: Optional[List[ToolCall]] = None


class UserMessage(BaseMessage):
    """
    A user message.
    """
    role: Literal["user"]
    content: str


class ToolMessage(ConfiguredBaseModel):
    """
    A tool result message.
    """
    id: str
    role: Literal["tool"]
    content: str
    tool_call_id: str


Message = Annotated[
    Union[DeveloperMessage, SystemMessage, AssistantMessage, UserMessage, ToolMessage],
    Field(discriminator="role")
]


Role = Literal["developer", "system", "assistant", "user", "tool"]


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
    parameters: Any  # JSON Schema for the tool parameters


class RunAgentInput(ConfiguredBaseModel):
    """
    Input for running an agent.
    """
    thread_id: str
    run_id: str
    state: Any
    messages: List[Message]
    tools: List[Tool]
    context: List[Context]
    forwarded_props: Any


# State can be any type
State = Any
