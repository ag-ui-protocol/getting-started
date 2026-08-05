"""Utilities for forwarding client-defined tools to the Strands agent at runtime."""

from __future__ import annotations

import logging
from typing import Any, Set

from ag_ui.core import Tool as AgUiTool
from strands.tools.registry import ToolRegistry
from strands.tools.tools import PythonAgentTool
from strands.types.tools import ToolResult, ToolSpec, ToolUse

logger = logging.getLogger(__name__)

# Attribute set on proxy tools so we can distinguish them from native tools.
_PROXY_MARKER = "_ag_ui_proxy"

# Placeholder result the proxy returns server-side. The real result is produced
# on the client and reconciled back in on the following run.
PROXY_RESULT_PLACEHOLDER = "Forwarded to client"


def create_proxy_tool(ag_ui_tool: AgUiTool) -> PythonAgentTool:
    """Convert an AG-UI ``Tool`` into a Strands ``PythonAgentTool``.

    The resulting tool is marked as dynamic so it can be hot-reloaded and is
    distinguishable from tools registered at server startup.

    Args:
        ag_ui_tool: Tool definition received from the client via ``RunAgentInput.tools``.

    Returns:
        A ``PythonAgentTool`` that the LLM can call.  When invoked server-side
        the proxy returns a placeholder result – the real execution happens on
        the client.
    """
    name: str = ag_ui_tool.name if isinstance(ag_ui_tool, AgUiTool) else ag_ui_tool.get("name", "")  # type: ignore[union-attr]
    description: str = (
        ag_ui_tool.description
        if isinstance(ag_ui_tool, AgUiTool)
        else ag_ui_tool.get("description", "")  # type: ignore[union-attr]
    )
    parameters: Any = (
        ag_ui_tool.parameters
        if isinstance(ag_ui_tool, AgUiTool)
        else ag_ui_tool.get("parameters", {})  # type: ignore[union-attr]
    )

    tool_spec: ToolSpec = {
        "name": name,
        "description": description,
        "inputSchema": {"json": parameters or {}},
    }

    def _proxy_func(tool_use: ToolUse, **_kwargs: Any) -> ToolResult:
        return {
            "toolUseId": tool_use["toolUseId"],
            "status": "success",
            "content": [{"text": PROXY_RESULT_PLACEHOLDER}],
        }

    # ToolFunc protocol requires __name__
    _proxy_func.__name__ = name

    tool = PythonAgentTool(
        tool_name=name,
        tool_spec=tool_spec,
        tool_func=_proxy_func,
    )
    tool.mark_dynamic()
    setattr(tool, _PROXY_MARKER, True)
    return tool


def _is_proxy(tool: Any) -> bool:
    """Return True if *tool* was created by ``create_proxy_tool``."""
    return getattr(tool, _PROXY_MARKER, False) is True


def sync_proxy_tools(
    tool_registry: ToolRegistry,
    ag_ui_tools: list[AgUiTool],
    tracked_names: Set[str],
) -> Set[str]:
    """Synchronise proxy tools in *tool_registry* with *ag_ui_tools*.

    * New tools present in *ag_ui_tools* but absent from the registry are
      registered (unless a native, non-proxy tool with the same name exists).
    * Stale proxy tools that are in *tracked_names* but absent from the
      incoming list are removed.

    Args:
        tool_registry: The Strands ``ToolRegistry`` attached to the agent.
        ag_ui_tools: Tool definitions from the current ``RunAgentInput.tools``.
        tracked_names: Set of proxy tool names registered in previous calls.

    Returns:
        Updated set of proxy tool names currently registered.
    """
    desired_names: Set[str] = set()
    for t in ag_ui_tools:
        n = t.name if isinstance(t, AgUiTool) else t.get("name", "")  # type: ignore[union-attr]
        if n:
            desired_names.add(n)

    # --- Remove stale proxy tools ---
    stale = tracked_names - desired_names
    for name in stale:
        existing = tool_registry.registry.get(name)
        if existing is not None and _is_proxy(existing):
            del tool_registry.registry[name]
            tool_registry.dynamic_tools.pop(name, None)
            logger.debug("Removed stale proxy tool: %s", name)

    # --- Add / update proxy tools ---
    current_proxy_names: Set[str] = set()
    for t in ag_ui_tools:
        n = t.name if isinstance(t, AgUiTool) else t.get("name", "")  # type: ignore[union-attr]
        if not n:
            continue

        existing = tool_registry.registry.get(n)
        if existing is not None and not _is_proxy(existing):
            # Native tool – do not overwrite.
            logger.debug("Skipping proxy for native tool: %s", n)
            continue

        proxy = create_proxy_tool(t)
        tool_registry.register_tool(proxy)
        current_proxy_names.add(n)
        logger.debug("Registered proxy tool: %s", n)

    return current_proxy_names
