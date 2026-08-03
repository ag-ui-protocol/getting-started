"""AG-UI integration for Claude Managed Agents (Anthropic hosted agent sessions).

Each AG-UI thread maps to one managed session; each run drives one turn of
that session and streams the agent's events back as AG-UI events.

Example:
    from ag_ui_claude_managed_agents import ManagedAgentsAgent, add_managed_agents_fastapi_endpoint

    agent = ManagedAgentsAgent(managed_agent_id="agent_...", environment_id="env_...")
    add_managed_agents_fastapi_endpoint(app=app, agent=agent, path="/my_agent")
"""

from importlib.metadata import PackageNotFoundError, version

from .agent import ManagedAgentsAgent
from .constants import (
    DEFAULT_TURN_TIMEOUT_S,
    IN_MEMORY_SESSION_STORE_MAX_ENTRIES,
    PARKED_RETRY_DELAYS_S,
    SEARCH_RESULT_PREVIEW_CHARS,
    TOOL_DESCRIPTION_MAX_LENGTH,
    TOOL_NAME_MAX_LENGTH,
    TOOL_RESULT_MAX_CHARS,
)
from .endpoint import add_managed_agents_fastapi_endpoint
from .sessions import InMemorySessionStore
from .tools import custom_tool_from, normalize_tool_name
from .turn import run_turn
from .types import (
    BackendTool,
    ErrorHandler,
    SessionRecord,
    SessionStore,
    TurnOutcome,
)

try:
    __version__ = version("ag-ui-claude-managed-agents")
except PackageNotFoundError:
    __version__ = "0.0.0+unknown"

__all__ = [
    "DEFAULT_TURN_TIMEOUT_S",
    "IN_MEMORY_SESSION_STORE_MAX_ENTRIES",
    "PARKED_RETRY_DELAYS_S",
    "SEARCH_RESULT_PREVIEW_CHARS",
    "TOOL_DESCRIPTION_MAX_LENGTH",
    "TOOL_NAME_MAX_LENGTH",
    "TOOL_RESULT_MAX_CHARS",
    "BackendTool",
    "ErrorHandler",
    "InMemorySessionStore",
    "ManagedAgentsAgent",
    "SessionRecord",
    "SessionStore",
    "TurnOutcome",
    "add_managed_agents_fastapi_endpoint",
    "custom_tool_from",
    "normalize_tool_name",
    "run_turn",
]
