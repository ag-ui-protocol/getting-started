"""Utilities for forwarding client-defined tools to the Strands agent at runtime."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any, Mapping, Set

from ag_ui.core import Tool as AgUiTool
from strands import ToolContext
from strands import tool as strands_tool
from strands.tools.registry import ToolRegistry
from strands.tools.tools import PythonAgentTool
from strands.types.tools import AgentTool, ToolResult, ToolSpec, ToolUse

from .frontend_tool_interrupt import (
    FRONTEND_TOOL_INTERRUPT_NAME,
    frontend_tool_reason,
    unwrap_frontend_tool_response,
)

if TYPE_CHECKING:
    from .config import ToolBehavior

logger = logging.getLogger(__name__)

# Attribute set on proxy tools so we can distinguish them from native tools.
_PROXY_MARKER = "_ag_ui_proxy"

# Placeholder result the proxy returns server-side. The real result is produced
# on the client and reconciled back in on the following run.
PROXY_RESULT_PLACEHOLDER = "Forwarded to client"


def _tool_spec(ag_ui_tool: AgUiTool) -> tuple[str, str, ToolSpec]:
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
    return (
        name,
        description,
        {
            "name": name,
            "description": description,
            "inputSchema": {"json": parameters or {}},
        },
    )


def waits_for_frontend_call(behavior: "ToolBehavior | None") -> bool:
    """Return whether a frontend tool parks in a native Strands interrupt.

    Waiting is what a human-in-the-loop tool needs: the agent stops until the
    client answers. A plain frontend action — render something, change the
    background — never answers, so waiting would strand the thread. The server
    cannot tell those apart from the tool definition, so waiting stays an
    explicit ``ToolBehavior(continue_after_frontend_call=False)`` opt-in and
    an unconfigured tool keeps the legacy placeholder path.
    """
    return behavior is not None and behavior.continue_after_frontend_call is False


def create_proxy_tool(
    ag_ui_tool: AgUiTool,
    *,
    continue_after_frontend_call: bool = True,
) -> AgentTool:
    """Convert an AG-UI ``Tool`` into a Strands ``PythonAgentTool``.

    The resulting tool is marked as dynamic so it can be hot-reloaded and is
    distinguishable from tools registered at server startup.

    Args:
        ag_ui_tool: Tool definition received from the client via ``RunAgentInput.tools``.

    Returns:
        A dynamic Strands tool. Waiting proxies pause in Strands; continuation
        proxies retain the existing placeholder result.
    """
    name, description, tool_spec = _tool_spec(ag_ui_tool)

    if not continue_after_frontend_call:

        @strands_tool(
            name=name,
            description=description,
            inputSchema=tool_spec["inputSchema"],
            context=True,
        )
        def _interrupting_proxy(tool_context: ToolContext) -> ToolResult:
            tool_use_id = tool_context.tool_use["toolUseId"]
            response = tool_context.interrupt(
                FRONTEND_TOOL_INTERRUPT_NAME,
                reason=frontend_tool_reason(tool_use_id),
            )
            content, is_error = unwrap_frontend_tool_response(response)
            return {
                "toolUseId": tool_use_id,
                "status": "error" if is_error else "success",
                "content": [{"text": content}],
            }

        interrupting_proxy: AgentTool = _interrupting_proxy
        interrupting_proxy.mark_dynamic()
        setattr(interrupting_proxy, _PROXY_MARKER, True)
        return interrupting_proxy

    def _proxy_func(tool_use: ToolUse, **_kwargs: Any) -> ToolResult:
        return {
            "toolUseId": tool_use["toolUseId"],
            "status": "success",
            "content": [{"text": PROXY_RESULT_PLACEHOLDER}],
        }

    # ToolFunc protocol requires __name__
    _proxy_func.__name__ = name

    tool: AgentTool = PythonAgentTool(
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
    *,
    tool_behaviors: Mapping[str, "ToolBehavior"] | None = None,
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

        behavior = tool_behaviors.get(n) if tool_behaviors is not None else None
        proxy = create_proxy_tool(
            t,
            continue_after_frontend_call=not waits_for_frontend_call(behavior),
        )
        tool_registry.register_tool(proxy)
        current_proxy_names.add(n)
        logger.debug("Registered proxy tool: %s", n)

    return current_proxy_names
