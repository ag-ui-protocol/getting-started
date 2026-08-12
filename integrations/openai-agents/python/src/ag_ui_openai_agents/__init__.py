"""OpenAI Agents SDK × AG-UI Protocol integration.

Compose it yourself (recommended, full control of the agent and server): AGUITranslator, TranslatedInput.
Serve a fixed agent instead (less code, less control): OpenAIAgentsAgent, add_openai_agents_fastapi_endpoint.
Need a custom mapping? Subclass a translator in ag_ui_openai_agents.engine.
"""

from .agent import OpenAIAgentsAgent
from .endpoint import add_openai_agents_fastapi_endpoint
from .engine import TranslatedInput
from .translator import AGUITranslator

__version__ = "0.1.0"

__all__ = [
    "add_openai_agents_fastapi_endpoint",
    "AGUITranslator",
    "OpenAIAgentsAgent",
    "TranslatedInput",
]
