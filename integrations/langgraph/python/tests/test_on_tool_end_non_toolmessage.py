"""Regression test for #1072.

`_handle_single_event` crashed with
``AttributeError: 'list' object has no attribute 'tool_call_id'`` when a
LangGraph ``on_tool_end`` event delivered an ``output`` that was neither a
``Command`` nor a ``ToolMessage`` (e.g. a plain list). The non-Command branch
read ``tool_call_output.tool_call_id`` unconditionally.

The fix guards the non-Command branch with an ``isinstance(..., ToolMessage)``
check, logging and skipping anything else. This test drives an ``on_tool_end``
event whose output is a list and asserts the stream completes without raising
and emits no TOOL_CALL_* events for it.
"""

import asyncio
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from langchain_core.messages import ToolMessage

from ag_ui_langgraph.agent import LangGraphAgent
from ag_ui.core import EventType, RunAgentInput


def _make_agent():
    from langgraph.graph.state import CompiledStateGraph

    graph = MagicMock(spec=CompiledStateGraph)
    graph.config_specs = []
    graph.nodes = {}
    initial_state = MagicMock()
    initial_state.values = {"messages": [], "copilotkit": {}}
    initial_state.tasks = []
    initial_state.next = []
    initial_state.metadata = {"writes": {}}
    graph.aget_state = AsyncMock(return_value=initial_state)
    return LangGraphAgent(name="test", graph=graph)


def _on_tool_end(output, *, tool_name="search", input_args=None):
    return {
        "event": "on_tool_end",
        "run_id": "run1",
        "metadata": {"langgraph_node": "tools"},
        "data": {"output": output, "input": input_args or {}},
        "name": tool_name,
        "parent_ids": [],
        "tags": [],
    }


async def _run_stream(events):
    agent = _make_agent()
    dispatched = []
    original_dispatch = agent._dispatch_event

    def capturing_dispatch(ev):
        result = original_dispatch(ev)
        dispatched.append(ev)
        return result

    agent._dispatch_event = capturing_dispatch

    async def fake_stream():
        for ev in events:
            yield ev

    final_state = MagicMock()
    final_state.values = {"messages": [], "copilotkit": {}}
    final_state.tasks = []
    final_state.next = []
    final_state.metadata = {"writes": {}}

    mock_prepared = {
        "state": {"messages": [], "copilotkit": {}},
        "stream": fake_stream(),
        "config": {"configurable": {"thread_id": "t1"}},
    }

    def fake_snapshot(state):
        if isinstance(state, dict):
            return state
        return getattr(state, "values", {}) or {}

    with patch.object(agent, "prepare_stream", AsyncMock(return_value=mock_prepared)), patch.object(
        agent.graph, "aget_state", AsyncMock(return_value=final_state)
    ), patch.object(agent, "get_state_snapshot", side_effect=fake_snapshot):
        input_data = RunAgentInput(
            thread_id="t1",
            run_id="run1",
            messages=[],
            state={},
            tools=[],
            context=[],
            forwarded_props={},
        )
        async for _ in agent._handle_stream_events(input_data):
            pass

    return dispatched


class TestOnToolEndNonToolMessage(unittest.TestCase):
    def test_list_output_does_not_crash_and_emits_no_tool_events(self):
        # The reported crash: output is a list, not a ToolMessage/Command.
        list_output = [ToolMessage(content="ok", tool_call_id="tc1", name="search")]
        dispatched = asyncio.run(_run_stream([_on_tool_end(list_output)]))

        tool_events = [
            ev
            for ev in dispatched
            if ev.type
            in (
                EventType.TOOL_CALL_START,
                EventType.TOOL_CALL_ARGS,
                EventType.TOOL_CALL_END,
                EventType.TOOL_CALL_RESULT,
            )
        ]
        self.assertEqual(
            tool_events, [], "non-ToolMessage OnToolEnd output must be skipped, not dispatched"
        )

    def test_toolmessage_output_still_emits_tool_events(self):
        # Guard must not regress the normal path.
        msg = ToolMessage(content="ok", tool_call_id="tc1", name="search")
        dispatched = asyncio.run(_run_stream([_on_tool_end(msg)]))

        starts = [ev for ev in dispatched if ev.type == EventType.TOOL_CALL_START]
        results = [ev for ev in dispatched if ev.type == EventType.TOOL_CALL_RESULT]
        self.assertEqual(len(starts), 1)
        self.assertEqual(len(results), 1)


if __name__ == "__main__":
    unittest.main()
