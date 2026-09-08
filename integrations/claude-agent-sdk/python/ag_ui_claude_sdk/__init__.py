"""
AG-UI integration for Anthropic Claude Agent SDK.

The adapter manages the SDK client lifecycle internally — just call
``adapter.run(input_data)`` and iterate over the resulting AG-UI events.

Example:
    from ag_ui_claude_sdk import ClaudeAgentAdapter, add_claude_fastapi_endpoint
    
    adapter = ClaudeAgentAdapter(name="my_agent", options={"model": "claude-haiku-4-5"})
    add_claude_fastapi_endpoint(app=app, adapter=adapter, path="/my_agent")

For full documentation on ClaudeAgentOptions, see:
https://platform.claude.com/docs/en/agent-sdk/python
"""

from importlib.metadata import version, PackageNotFoundError

from .adapter import ClaudeAgentAdapter
from .endpoint import add_claude_fastapi_endpoint
from .config import (
    ALLOWED_FORWARDED_PROPS,
    STATE_MANAGEMENT_TOOL_NAME,
    AG_UI_MCP_SERVER_NAME,
)

try:
    __version__ = version("ag-ui-claude-sdk")
except PackageNotFoundError:
    __version__ = "0.0.0+unknown"
__all__ = [
    "ClaudeAgentAdapter",
    "add_claude_fastapi_endpoint",
    # Configuration constants
    "ALLOWED_FORWARDED_PROPS",
    "STATE_MANAGEMENT_TOOL_NAME",
    "AG_UI_MCP_SERVER_NAME",
]

