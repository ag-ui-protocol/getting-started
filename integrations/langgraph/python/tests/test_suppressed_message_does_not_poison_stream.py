"""Regression tests: OnChatModelEnd clearing the wrong message.

``messages_in_process`` has one slot per client run_id. LangGraph
interleaves ``on_chat_model_end`` across parallel branches/subgraphs, and
subclasses (e.g. CopilotKit's LangGraphAGUIAgent) suppress events by
returning ``None`` from ``_dispatch_event``. Two bugs come out of that:

1. Clearing the slot only when dispatch returned truthy left it stuck
   "in progress" forever after the first suppressed call, so every later
   real message skipped TEXT_MESSAGE_START.
2. Clearing it unconditionally fixed that but could close a *different*
   message's slot if a suppressed call's end event arrived while a real
   message was still mid-stream. The fix tags each in-progress entry with
   the LangGraph run_id that created it and only closes/clears on a match.
"""
import unittest
from unittest.mock import MagicMock

import pytest
from langchain_core.messages import AIMessageChunk

from ag_ui.core import EventType

from ag_ui_langgraph.types import LangGraphEventTypes
from tests._helpers import make_agent


def _text_chunk(content: str, *, chunk_id: str) -> AIMessageChunk:
    chunk = AIMessageChunk(content=content, id=chunk_id)
    chunk.response_metadata = {}
    chunk.tool_call_chunks = []
    return chunk


def _tool_call_chunk(*, name: str, tool_call_id: str, chunk_id: str) -> AIMessageChunk:
    chunk = AIMessageChunk(content="", id=chunk_id)
    chunk.response_metadata = {}
    chunk.tool_call_chunks = [{"name": name, "args": "", "id": tool_call_id, "index": 0}]
    return chunk


class TestSuppressedMessageDoesNotPoisonStream(unittest.IsolatedAsyncioTestCase):
    def _make_agent(self, dispatch_side_effect=None):
        agent = make_agent()
        agent.active_run = {
            "id": "run-1",
            "thread_id": "t1",
            "mode": "continue",
            "reasoning_process": None,
            "node_name": "agent",
            "has_function_streaming": False,
            "streamed_tool_call_ids": set(),
            "model_made_tool_call": False,
            "state_reliable": True,
        }
        if dispatch_side_effect is not None:
            agent._dispatch_event = MagicMock(side_effect=dispatch_side_effect)
        return agent

    async def _stream_chunk(self, agent, chunk, *, run_id: str, suppress: bool = False):
        event = {
            "event": LangGraphEventTypes.OnChatModelStream.value,
            "run_id": run_id,
            "data": {"chunk": chunk},
            "metadata": {"copilotkit:emit-messages": not suppress},
        }
        events = []
        async for ev in agent._handle_single_event(event, {}):
            events.append(ev)
        return events

    async def _end_chat_model(self, agent, *, run_id: str, suppress: bool = False):
        event = {
            "event": LangGraphEventTypes.OnChatModelEnd.value,
            "run_id": run_id,
            "data": {},
            "metadata": {"copilotkit:emit-messages": not suppress, "copilotkit:emit-tool-calls": not suppress},
        }
        events = []
        async for ev in agent._handle_single_event(event, {}):
            events.append(ev)
        return events

    @staticmethod
    def _copilotkit_passthrough(ev):
        """Mimic CopilotKit's dispatcher: return None for TEXT_MESSAGE_*/
        TOOL_CALL_* events when the raw event's metadata says to suppress."""
        if ev.type in (
            EventType.TEXT_MESSAGE_START,
            EventType.TEXT_MESSAGE_CONTENT,
            EventType.TEXT_MESSAGE_END,
        ):
            raw_metadata = (ev.raw_event or {}).get("metadata", {})
            if raw_metadata.get("copilotkit:emit-messages") is False:
                return None
        if ev.type in (EventType.TOOL_CALL_START, EventType.TOOL_CALL_ARGS, EventType.TOOL_CALL_END):
            raw_metadata = (ev.raw_event or {}).get("metadata", {})
            if raw_metadata.get("copilotkit:emit-tool-calls") is False:
                return None
        return ev

    @pytest.mark.asyncio
    async def test_real_message_after_suppressed_message_still_gets_start_event(self):
        agent = self._make_agent(dispatch_side_effect=self._copilotkit_passthrough)

        # Suppressed internal call, its own invocation, streams and ends.
        await self._stream_chunk(
            agent,
            _text_chunk("internal output", chunk_id="internal-msg"),
            run_id="run-internal",
            suppress=True,
        )
        await self._end_chat_model(agent, run_id="run-internal", suppress=True)
        self.assertIsNone(agent.get_message_in_progress("run-1"))

        # A real message streams as a separate invocation in the same run.
        events = await self._stream_chunk(
            agent,
            _text_chunk("Hello there", chunk_id="real-msg"),
            run_id="run-real",
        )

        event_types = [e.type for e in events if e is not None]
        self.assertIn(EventType.TEXT_MESSAGE_START, event_types)
        self.assertIn(EventType.TEXT_MESSAGE_CONTENT, event_types)

    @pytest.mark.asyncio
    async def test_unrelated_call_ending_does_not_close_a_different_mid_stream_message(self):
        agent = self._make_agent(dispatch_side_effect=self._copilotkit_passthrough)

        # A real message starts streaming and is still mid-stream (no end yet).
        await self._stream_chunk(
            agent,
            _text_chunk("partial", chunk_id="real-msg"),
            run_id="run-real",
        )
        in_progress = agent.get_message_in_progress("run-1")
        self.assertIsNotNone(in_progress)
        self.assertEqual(in_progress["id"], "real-msg")

        # A different (suppressed) invocation ends while the real message
        # is still open.
        events = await self._end_chat_model(agent, run_id="run-internal", suppress=True)

        event_types = [e.type for e in events if e is not None]
        self.assertNotIn(EventType.TEXT_MESSAGE_END, event_types)
        still_in_progress = agent.get_message_in_progress("run-1")
        self.assertIsNotNone(still_in_progress)
        self.assertEqual(still_in_progress["id"], "real-msg")

        # The real invocation's own end event closes it normally.
        events = await self._end_chat_model(agent, run_id="run-real")
        event_types = [e.type for e in events if e is not None]
        self.assertIn(EventType.TEXT_MESSAGE_END, event_types)
        self.assertIsNone(agent.get_message_in_progress("run-1"))

    @pytest.mark.asyncio
    async def test_real_tool_call_after_suppressed_tool_call_still_gets_end_event(self):
        agent = self._make_agent(dispatch_side_effect=self._copilotkit_passthrough)

        # Suppressed internal tool call, its own invocation.
        await self._stream_chunk(
            agent,
            _tool_call_chunk(name="internal_tool", tool_call_id="tc-internal", chunk_id="internal-msg"),
            run_id="run-internal",
            suppress=True,
        )
        await self._end_chat_model(agent, run_id="run-internal", suppress=True)
        self.assertIsNone(agent.get_message_in_progress("run-1"))

        # A real tool call streams and ends as a separate invocation.
        await self._stream_chunk(
            agent,
            _tool_call_chunk(name="real_tool", tool_call_id="tc-real", chunk_id="real-msg"),
            run_id="run-real",
        )
        events = await self._end_chat_model(agent, run_id="run-real")

        event_types = [e.type for e in events if e is not None]
        self.assertIn(EventType.TOOL_CALL_END, event_types)
