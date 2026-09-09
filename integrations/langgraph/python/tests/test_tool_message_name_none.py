"""Regression test for GitHub issue #1742.

When a LangGraph tool returns a ``ToolMessage`` with ``name=None`` (the
default in LangChain), the ``OnToolEnd`` handler must patch the name on
the actual message object so that downstream consumers — especially
``langchain_messages_to_agui`` for ``MessagesSnapshotEvent`` — see a
valid string instead of ``None``.

The same applies to ``ToolMessage`` objects inside a ``Command.update``.
"""

import unittest

from langchain_core.messages import ToolMessage
from langgraph.types import Command

from ag_ui.core import EventType
from ag_ui_langgraph.agent import LangGraphAgent, LangGraphEventTypes

from tests._helpers import make_agent, _record_dispatch


def _make_tool_end_event(output, name="my_tool"):
    """Build a minimal OnToolEnd-style event dict."""
    return {
        "event": LangGraphEventTypes.OnToolEnd,
        "name": name,
        "data": {"output": output, "input": {"query": "test"}},
        "run_id": "run-1",
        "metadata": {"langgraph_node": "tools"},
    }


async def _consume_handler(agent, event):
    """Consume the async generator returned by _handle_single_event."""
    results = []
    async for ev in agent._handle_single_event(event, {}):
        results.append(ev)
    return results


class TestToolMessageNameNonePatch(unittest.IsolatedAsyncioTestCase):
    """Issue #1742 — ToolMessage.name=None is patched before processing."""

    async def test_plain_tool_message_name_patched(self):
        """A ToolMessage with name=None gets patched to the event name."""
        agent = make_agent()
        agent.active_run = {
            "id": "run-1",
            "node_name": "tools",
            "has_function_streaming": False,
            "model_made_tool_call": True,
            "state_reliable": False,
        }
        _record_dispatch(agent)

        tool_msg = ToolMessage(content="result", tool_call_id="tc-1", name=None)
        event = _make_tool_end_event(tool_msg, name="search_tool")

        await _consume_handler(agent, event)

        # The ToolMessage object itself should be patched
        self.assertEqual(tool_msg.name, "search_tool")

    async def test_plain_tool_message_name_preserved_when_set(self):
        """A ToolMessage with an explicit name is NOT overwritten."""
        agent = make_agent()
        agent.active_run = {
            "id": "run-1",
            "node_name": "tools",
            "has_function_streaming": False,
            "model_made_tool_call": True,
            "state_reliable": False,
        }
        _record_dispatch(agent)

        tool_msg = ToolMessage(content="result", tool_call_id="tc-1", name="original")
        event = _make_tool_end_event(tool_msg, name="different_name")

        await _consume_handler(agent, event)

        # Should keep the original name
        self.assertEqual(tool_msg.name, "original")

    async def test_command_tool_messages_name_patched(self):
        """ToolMessages inside Command.update with name=None are patched."""
        agent = make_agent()
        agent.active_run = {
            "id": "run-1",
            "node_name": "tools",
            "has_function_streaming": False,
            "model_made_tool_call": True,
            "state_reliable": False,
        }
        _record_dispatch(agent)

        msg1 = ToolMessage(content="r1", tool_call_id="tc-1", name=None)
        msg2 = ToolMessage(content="r2", tool_call_id="tc-2", name="keep_me")
        cmd = Command(update={"messages": [msg1, msg2]})
        event = _make_tool_end_event(cmd, name="multi_tool")

        await _consume_handler(agent, event)

        # msg1 should be patched, msg2 should keep its name
        self.assertEqual(msg1.name, "multi_tool")
        self.assertEqual(msg2.name, "keep_me")

    async def test_tool_call_start_event_has_valid_name(self):
        """The emitted ToolCallStartEvent must have a non-None tool_call_name."""
        agent = make_agent()
        agent.active_run = {
            "id": "run-1",
            "node_name": "tools",
            "has_function_streaming": False,
            "model_made_tool_call": True,
            "state_reliable": False,
        }
        _record_dispatch(agent)

        tool_msg = ToolMessage(content="done", tool_call_id="tc-1", name=None)
        event = _make_tool_end_event(tool_msg, name="calc_tool")

        await _consume_handler(agent, event)

        # Find the ToolCallStartEvent
        start_events = [
            e for e in agent.dispatched
            if getattr(e, "type", None) == EventType.TOOL_CALL_START
        ]
        self.assertEqual(len(start_events), 1)
        self.assertEqual(start_events[0].tool_call_name, "calc_tool")

    async def test_fallback_to_unknown_when_event_name_missing(self):
        """When both ToolMessage.name and event name are None/empty,
        the fallback is 'unknown'."""
        agent = make_agent()
        agent.active_run = {
            "id": "run-1",
            "node_name": "tools",
            "has_function_streaming": False,
            "model_made_tool_call": True,
            "state_reliable": False,
        }
        _record_dispatch(agent)

        tool_msg = ToolMessage(content="x", tool_call_id="tc-1", name=None)
        # No "name" key in event
        event = {
            "event": LangGraphEventTypes.OnToolEnd,
            "data": {"output": tool_msg, "input": {}},
            "run_id": "run-1",
            "metadata": {"langgraph_node": "tools"},
        }

        await _consume_handler(agent, event)

        self.assertEqual(tool_msg.name, "unknown")
