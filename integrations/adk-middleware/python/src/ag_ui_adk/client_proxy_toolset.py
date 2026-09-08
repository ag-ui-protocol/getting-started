# src/ag_ui_adk/client_proxy_toolset.py

"""Dynamic toolset creation for client-side tools."""

import asyncio
from typing import Iterable, List, Optional, Union
import logging

from google.adk.tools import BaseTool
from google.adk.tools.base_toolset import BaseToolset, ToolPredicate
from google.adk.agents.readonly_context import ReadonlyContext
from ag_ui.core import Tool as AGUITool

from .client_proxy_tool import ClientProxyTool
from .config import PredictStateMapping

logger = logging.getLogger(__name__)


class ClientProxyToolset(BaseToolset):
    """Dynamic toolset that creates proxy tools from AG-UI tool definitions.

    This toolset is created for each run based on the tools provided in
    the RunAgentInput, allowing dynamic tool availability per request.
    """

    def __init__(
        self,
        ag_ui_tools: List[AGUITool],
        event_queue: asyncio.Queue,
        tool_filter: Optional[Union[ToolPredicate, List[str]]] = None,
        tool_name_prefix: Optional[str] = None,
        predict_state: Optional[Iterable[PredictStateMapping]] = None,
    ):
        """Initialize the client proxy toolset.

        Args:
            ag_ui_tools: List of AG-UI tool definitions
            event_queue: Queue to emit AG-UI events
            tool_filter: Filter to apply to tools.
            tool_name_prefix: The prefix to prepend to the names of the tools returned by the toolset.
            predict_state: Configuration for predictive state updates. When provided,
                tools will emit PredictState CustomEvents before TOOL_CALL_START.
        """
        super().__init__(tool_filter=tool_filter, tool_name_prefix=tool_name_prefix)
        self.ag_ui_tools = ag_ui_tools
        self.event_queue = event_queue
        self.predict_state = list(predict_state) if predict_state else []
        # Tracking set for PredictState emissions - shared by all tools in this toolset
        # Since toolsets are created per-run, this naturally resets for each run
        self._emitted_predict_state: set[str] = set()
        # Accumulated predictive state values from tool args - merged into final STATE_SNAPSHOT
        # This ensures predictive state survives the final STATE_SNAPSHOT that replaces all state
        self._accumulated_predict_state: dict = {}
        # Track tool call IDs that ClientProxyTool has already emitted events for.
        # Shared with EventTranslator to prevent duplicate TOOL_CALL emissions.
        self._emitted_tool_call_ids: set[str] = set()
        # Set of tool call IDs already emitted by EventTranslator.
        # Assigned externally after EventTranslator is created. Checked by
        # ClientProxyTool before emitting to avoid duplicates.
        self._translator_emitted_tool_call_ids: set[str] = set()
        # Shared set of long-running (HITL) tool call IDs. ClientProxyTool
        # populates this synchronously before emitting TOOL_CALL_START so the
        # consumer can recognize HITL tool calls and persist them to
        # session.state — while skipping persistence (and the
        # DatabaseSessionService stale-marker race) for in-stream backend
        # tool calls. Assigned externally; see issue #1652.
        self._long_running_tool_ids: set[str] = set()
        # The EventTranslator's name→[partial-emitted IDs] ledger. Assigned
        # externally after the translator is created. Under SSE streaming the
        # translator emits a long-running call from the partial event with one
        # ID and ADK then invokes this proxy with a *different* ID (#1168), so
        # the ID-based guard above can't tell they're the same logical call.
        # The proxy matches its invocation to an already-emitted partial by name
        # (positionally) to avoid emitting a duplicate TOOL_CALL trio.
        self._translator_lro_emitted_ids_by_name: dict = {}
        # Per-name count of proxy invocations already matched to a translator
        # partial (shared across this toolset's proxies for the run).
        self._lro_finalized_by_name: dict = {}

        logger.info(f"Initialized ClientProxyToolset with {len(ag_ui_tools)} tools (all long-running)")

    async def get_tools(
        self,
        readonly_context: Optional[ReadonlyContext] = None
    ) -> List[BaseTool]:
        """Get all proxy tools for this toolset.

        Creates fresh ClientProxyTool instances for each AG-UI tool definition
        with the current event queue reference.

        Args:
            readonly_context: Optional context for tool filtering (unused currently)

        Returns:
            List of ClientProxyTool instances
        """
        logger.info(f"[GET_TOOLS] get_tools called with filter={self.tool_filter}")
        logger.info(f"[GET_TOOLS] Available AG-UI tools: {[t.name for t in self.ag_ui_tools]}")

        # Create fresh proxy tools each time to avoid stale queue references
        proxy_tools = []

        for ag_ui_tool in self.ag_ui_tools:
            try:
                proxy_tool = ClientProxyTool(
                    ag_ui_tool=ag_ui_tool,
                    event_queue=self.event_queue,
                    predict_state_mappings=self.predict_state,
                    emitted_predict_state=self._emitted_predict_state,
                    accumulated_predict_state=self._accumulated_predict_state,
                    emitted_tool_call_ids=self._emitted_tool_call_ids,
                    translator_emitted_tool_call_ids=self._translator_emitted_tool_call_ids,
                    long_running_tool_ids=self._long_running_tool_ids,
                    translator_lro_emitted_ids_by_name=self._translator_lro_emitted_ids_by_name,
                    lro_finalized_by_name=self._lro_finalized_by_name,
                )
                proxy_tools.append(proxy_tool)
                logger.info(f"[GET_TOOLS] Created proxy tool for '{ag_ui_tool.name}' (long-running)")

            except Exception as e:
                logger.error(f"Failed to create proxy tool for '{ag_ui_tool.name}': {e}")
                # Continue with other tools rather than failing completely

        # Apply tool filtering if configured
        if self.tool_filter is not None:
            logger.info(f"[GET_TOOLS] Applying tool filter: {self.tool_filter}")
            if callable(self.tool_filter):
                # ToolPredicate - function that takes BaseTool and returns bool
                proxy_tools = [tool for tool in proxy_tools if self.tool_filter(tool)]
            elif isinstance(self.tool_filter, list):
                # List of allowed tool names
                allowed_names = set(self.tool_filter)
                before_filter = [t.name for t in proxy_tools]
                proxy_tools = [
                    tool for tool in proxy_tools if tool.name in allowed_names
                ]
                after_filter = [t.name for t in proxy_tools]
                logger.info(f"[GET_TOOLS] Filter result: {before_filter} -> {after_filter}")

        logger.info(f"[GET_TOOLS] Returning {len(proxy_tools)} tools: {[t.name for t in proxy_tools]}")
        return proxy_tools

    def get_accumulated_predict_state(self) -> dict:
        """Get accumulated predictive state values from tool calls.

        These values are extracted from tool arguments based on predict_state mappings
        and should be merged into the final STATE_SNAPSHOT.

        Returns:
            Dictionary of accumulated state key-value pairs
        """
        return self._accumulated_predict_state.copy()

    async def close(self) -> None:
        """Clean up resources held by the toolset."""
        logger.info("Closing ClientProxyToolset")

    def __repr__(self) -> str:
        """String representation of the toolset."""
        tool_names = [tool.name for tool in self.ag_ui_tools]
        return f"ClientProxyToolset(tools={tool_names}, all_long_running=True)"