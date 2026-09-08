"""API modules for ADK middleware examples."""

from .agentic_chat import app as agentic_chat_app
from .agentic_generative_ui import app as agentic_generative_ui_app
from .tool_based_generative_ui import app as tool_based_generative_ui_app
from .human_in_the_loop import app as human_in_the_loop_app
from .shared_state import app as shared_state_app
from .predictive_state_updates import app as predictive_state_updates_app
from .backend_tool_rendering import app as backend_tool_rendering_app
from .agentic_chat_reasoning import app as agentic_chat_reasoning_app
from .a2ui_dynamic_schema import app as a2ui_dynamic_schema_app
from .a2ui_fixed_schema import app as a2ui_fixed_schema_app
from .a2ui_recovery import app as a2ui_recovery_app

__all__ = [
    "agentic_chat_app",
    "agentic_chat_reasoning_app",
    "agentic_generative_ui_app",
    "tool_based_generative_ui_app",
    "human_in_the_loop_app",
    "shared_state_app",
    "predictive_state_updates_app",
    "backend_tool_rendering_app",
    "a2ui_dynamic_schema_app",
    "a2ui_fixed_schema_app",
    "a2ui_recovery_app",
]
