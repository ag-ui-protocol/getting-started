"""Regression test for a bug where a suppressed (None-returning)
``_dispatch_event`` result on ``OnChatModelEnd`` permanently left
``messages_in_process[run_id]`` "in progress", causing every subsequent
*real* streamed message in the same run to skip ``TextMessageStartEvent``.

This mirrors how CopilotKit's ``LangGraphAGUIAgent._dispatch_event`` filters
out ``TEXT_MESSAGE_*`` / ``TOOL_CALL_*`` events by returning ``None`` when the
LangGraph run's metadata carries ``copilotkit:emit-messages=False`` /
``emit-tool-calls=False`` (e.g. for internal, non-user-facing structured
output calls) — a supported and common pattern for suppressing intermediate
LLM calls while still allowing the final, user-facing reply to stream
normally in the same run.
"""
import unittest
from unittest.mock import MagicMock

import pytest

from ag_ui.core import EventType

from ag_ui_langgraph.types import LangGraphEventTypes


class TestSuppressedMessageDoesNotPoisonStream(unittest.IsolatedAsyncioTestCase):
    def _make_agent(self, dispatch_side_effect=None):
        from ag_ui_langgraph.agent import LangGraphAgent

        mock_graph = MagicMock()
        agent = LangGraphAgent(name="test", graph=mock_graph)
        agent.active_run = {
            "id": "run-1",
            "thread_id": "t1",
            "reasoning_process": None,
            "node_name": "agent",
            "has_function_streaming": False,
            "model_made_tool_call": False,
            "state_reliable": True,
            "streamed_messages": [],
            "manually_emitted_state": None,
            "schema_keys": {"input": ["messages", "tools"], "output": ["messages", "tools"], "config": [], "context": []},
        }
        if dispatch_side_effect is not None:
            agent._dispatch_event = MagicMock(side_effect=dispatch_side_effect)
        return agent

    async def _stream_chunk(self, agent, message_id: str, content: str, *, suppress: bool = False):
        """Feed a single OnChatModelStream chunk through _handle_single_event."""
        event = {
            "event": LangGraphEventTypes.OnChatModelStream.value,
            "data": {"chunk": {"id": message_id, "content": content, "tool_call_chunks": []}},
            "metadata": {"copilotkit:emit-messages": not suppress},
        }
        events = []
        async for ev in agent._handle_single_event(event, {}):
            events.append(ev)
        return events

    async def _end_chat_model(self, agent, *, suppress: bool = False):
        event = {
            "event": LangGraphEventTypes.OnChatModelEnd.value,
            "data": {},
            "metadata": {"copilotkit:emit-messages": not suppress},
        }
        events = []
        async for ev in agent._handle_single_event(event, {}):
            events.append(ev)
        return events

    @pytest.mark.asyncio
    async def test_real_message_after_suppressed_message_still_gets_start_event(self):
        """A suppressed internal call (dispatch returns None) must not
        prevent TextMessageStartEvent from firing for the next real message
        in the same run."""

        def dispatch_passthrough(ev):
            # Simulate CopilotKit's LangGraphAGUIAgent._dispatch_event: it
            # inspects raw_event's LangGraph run metadata and suppresses
            # TEXT_MESSAGE_*/TOOL_CALL_* events by returning None when
            # ``copilotkit:emit-messages`` is False (used for internal,
            # non-user-facing structured-output calls).
            if ev.type in (
                EventType.TEXT_MESSAGE_START,
                EventType.TEXT_MESSAGE_CONTENT,
                EventType.TEXT_MESSAGE_END,
            ):
                raw_metadata = (ev.raw_event or {}).get("metadata", {})
                if raw_metadata.get("copilotkit:emit-messages") is False:
                    return None
            return ev

        agent = self._make_agent(dispatch_side_effect=dispatch_passthrough)

        # 1. Internal (suppressed) call streams and ends first, in its own
        # graph node (e.g. a "classify" node in tool-agent's search_subgraph).
        for event in agent.handle_node_change("classify"):
            pass
        await self._stream_chunk(agent, "internal-msg", "internal output", suppress=True)
        await self._end_chat_model(agent, suppress=True)

        # Regardless of suppression, tracking must be cleared after the
        # first call's OnChatModelEnd — this is the core of the fix.
        assert agent.get_message_in_progress("run-1") is None

        # 2. A second, real (non-suppressed) message streams in the same run,
        # from a different node (e.g. the final "model" node) — this clears
        # the pinned text-message id, matching the real multi-node scenario.
        for event in agent.handle_node_change("model"):
            pass
        events = await self._stream_chunk(agent, "real-msg", "Hello there")

        event_types = [e.type for e in events if e is not None]
        assert EventType.TEXT_MESSAGE_START in event_types, (
            "TEXT_MESSAGE_START must be emitted for a genuine message even "
            "when an earlier suppressed message in the same run returned "
            "None from _dispatch_event on OnChatModelEnd."
        )
        assert EventType.TEXT_MESSAGE_CONTENT in event_types
