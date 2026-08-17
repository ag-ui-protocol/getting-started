"""Conversational variants of the regular CrewAI dojo Flows."""

from __future__ import annotations

from collections.abc import Iterator, Mapping
from typing import Any, TypeVar

from crewai.experimental.conversational import (
    ConversationConfig,
    message_to_llm_dict,
)
from crewai.flow.flow import listen
from pydantic import BaseModel, ConfigDict

from ag_ui_crewai.sdk import CopilotKitState
from .a2ui_dynamic_schema import A2UIDynamicSchemaFlow
from .a2ui_fixed_schema import A2UIFixedSchemaFlow
from .a2ui_recovery import A2UIRecoveryFlow
from .agentic_chat import AgenticChatFlow
from .agentic_chat_multimodal import AgenticChatMultimodalFlow
from .agentic_chat_reasoning import AgenticChatReasoningFlow
from .agentic_generative_ui import AgenticGenerativeUIFlow
from .backend_tool_rendering import BackendToolRenderingFlow
from .human_in_the_loop import HumanInTheLoopFlow
from .interrupt_flow import InterruptFlow
from .predictive_state_updates import PredictiveStateUpdatesFlow
from .shared_state import SharedStateFlow
from .tool_based_generative_ui import ToolBasedGenerativeUIFlow


class _AGUIMappingState(CopilotKitState, Mapping[str, Any]):
    """Typed conversational fields with the dict API used by untyped Flows."""

    model_config = ConfigDict(extra="allow")

    def get(self, key: str, default: Any = None) -> Any:
        value = getattr(self, key, default)
        return value.model_dump() if isinstance(value, BaseModel) else value

    def __getitem__(self, key: str) -> Any:
        return getattr(self, key)

    def __setitem__(self, key: str, value: Any) -> None:
        setattr(self, key, value)

    def __iter__(self) -> Iterator[str]:
        return iter(self.model_dump())

    def __len__(self) -> int:
        return len(self.model_dump())


class _AGUIConversationalBehavior:
    """Route each public turn through the regular Flow's existing starts."""

    def receive_user_message(self, *args: Any, **kwargs: Any) -> Any:
        result = super().receive_user_message(*args, **kwargs)
        messages = getattr(self.state, "messages", None)
        if messages and isinstance(messages[-1], BaseModel):
            messages[-1] = message_to_llm_dict(messages[-1])
        return result

    def route_turn(self, _context: Any) -> str:
        return "ag_ui_complete"

    @listen("__ag_ui_disable_builtin_end__")
    def end_conversation(self) -> None:
        """Keep a regular method named ``end`` from firing CrewAI's terminator."""
        return None

    @listen("ag_ui_complete")
    def finish_ag_ui_turn(self) -> None:
        return None


def _conversational_type(base: type[Any]) -> type[Any]:
    flow_methods = {
        name: value
        for owner in (base, _AGUIConversationalBehavior)
        for name, value in owner.__dict__.items()
        if not name.startswith("_") and hasattr(value, "__flow_method_definition__")
    }
    initial_state_type = getattr(base, "_initial_state_t", None)
    flow_type = type(
        f"Conversational{base.__name__}",
        (_AGUIConversationalBehavior, base),
        {
            **flow_methods,
            "__module__": __name__,
            "conversational": True,
            "conversational_config": ConversationConfig(defer_trace_finalization=False),
        },
    )
    if isinstance(initial_state_type, TypeVar):
        flow_type._initial_state_t = _AGUIMappingState
    return flow_type


CONVERSATIONAL_FLOW_TYPES = {
    "agentic_chat": _conversational_type(AgenticChatFlow),
    "agentic_chat_reasoning": _conversational_type(AgenticChatReasoningFlow),
    "agentic_chat_multimodal": _conversational_type(AgenticChatMultimodalFlow),
    "backend_tool_rendering": _conversational_type(BackendToolRenderingFlow),
    "interrupt": _conversational_type(InterruptFlow),
    "human_in_the_loop": _conversational_type(HumanInTheLoopFlow),
    "agentic_generative_ui": _conversational_type(AgenticGenerativeUIFlow),
    "predictive_state_updates": _conversational_type(PredictiveStateUpdatesFlow),
    "shared_state": _conversational_type(SharedStateFlow),
    "tool_based_generative_ui": _conversational_type(ToolBasedGenerativeUIFlow),
    "a2ui_dynamic_schema": _conversational_type(A2UIDynamicSchemaFlow),
    "a2ui_recovery": _conversational_type(A2UIRecoveryFlow),
    "a2ui_fixed_schema": _conversational_type(A2UIFixedSchemaFlow),
}
