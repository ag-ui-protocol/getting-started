"""Tests for custom emit event dispatch.

AG-UI LangGraph uses un-prefixed event names ("manually_emit_message" etc.).
Downstream subclasses may override CustomEventNames to add their own prefix.
"""
import unittest
import pytest
from unittest.mock import MagicMock

from ag_ui.core import EventType

from ag_ui_langgraph.types import CustomEventNames, LangGraphEventTypes


class TestCustomEventNamesValues(unittest.TestCase):
    """Verify CustomEventNames enum values match what the ag-ui LangGraph handler emits."""

    def test_manually_emit_message_name(self):
        assert CustomEventNames.ManuallyEmitMessage == "manually_emit_message"

    def test_manually_emit_tool_call_name(self):
        assert CustomEventNames.ManuallyEmitToolCall == "manually_emit_tool_call"

    def test_manually_emit_state_name(self):
        assert CustomEventNames.ManuallyEmitState == "manually_emit_state"

    def test_exit_name(self):
        assert CustomEventNames.Exit == "exit"


class TestHandleSingleEventCustomEvents(unittest.IsolatedAsyncioTestCase):
    """Test that _handle_single_event correctly processes custom emit events.

    These tests use a minimal LangGraphAgent with mock graph, exercising
    the OnCustomEvent branch of _handle_single_event.
    """

    def _make_agent(self):
        from ag_ui_langgraph.agent import LangGraphAgent

        mock_graph = MagicMock()
        agent = LangGraphAgent(name="test", graph=mock_graph)
        # Minimal active_run state required by _handle_single_event.
        # Each key is needed for a specific code path:
        #   id              — used as key in messages_in_process dict
        #   thread_id       — used in event metadata
        #   reasoning_process — checked before emitting reasoning events
        #   node_name       — used in step tracking
        #   has_function_streaming — distinguishes streamed vs non-streamed tool calls
        #   model_made_tool_call — controls state snapshot suppression
        #   state_reliable  — controls state snapshot suppression
        #   streamed_messages — accumulates completed messages during streaming
        #   manually_emitted_state — set by ManuallyEmitState events
        #   schema_keys     — used by get_state_snapshot to filter output keys
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
        return agent

    @pytest.mark.asyncio
    async def test_manually_emit_message(self):
        agent = self._make_agent()
        event = {
            "event": LangGraphEventTypes.OnCustomEvent.value,
            "name": CustomEventNames.ManuallyEmitMessage.value,
            "data": {"message_id": "msg-1", "message": "Hello from agent"},
        }
        events = []
        async for ev in agent._handle_single_event(event, {}):
            events.append(ev)

        event_types = [e.type for e in events]
        assert EventType.TEXT_MESSAGE_START in event_types
        assert EventType.TEXT_MESSAGE_CONTENT in event_types
        assert EventType.TEXT_MESSAGE_END in event_types

    @pytest.mark.asyncio
    async def test_manually_emit_tool_call(self):
        agent = self._make_agent()
        event = {
            "event": LangGraphEventTypes.OnCustomEvent.value,
            "name": CustomEventNames.ManuallyEmitToolCall.value,
            "data": {"id": "tc-1", "name": "search", "args": {"q": "test"}},
        }
        events = []
        async for ev in agent._handle_single_event(event, {}):
            events.append(ev)

        event_types = [e.type for e in events]
        assert EventType.TOOL_CALL_START in event_types
        assert EventType.TOOL_CALL_ARGS in event_types
        assert EventType.TOOL_CALL_END in event_types

    @pytest.mark.asyncio
    async def test_manually_emit_state(self):
        agent = self._make_agent()
        event = {
            "event": LangGraphEventTypes.OnCustomEvent.value,
            "name": CustomEventNames.ManuallyEmitState.value,
            "data": {"counter": 42},
        }
        events = []
        async for ev in agent._handle_single_event(event, {}):
            events.append(ev)

        event_types = [e.type for e in events]
        assert EventType.STATE_SNAPSHOT in event_types
        assert agent.active_run["manually_emitted_state"] == {"counter": 42}

    @pytest.mark.asyncio
    async def test_exit_event_produces_custom(self):
        """The exit event always produces a CUSTOM event (line 915 in agent.py
        yields a CustomEvent unconditionally for all OnCustomEvent types)."""
        agent = self._make_agent()
        event = {
            "event": LangGraphEventTypes.OnCustomEvent.value,
            "name": CustomEventNames.Exit.value,
            "data": {},
        }
        events = []
        async for ev in agent._handle_single_event(event, {}):
            events.append(ev)

        event_types = [e.type for e in events]
        assert EventType.CUSTOM in event_types

    @pytest.mark.asyncio
    async def test_unknown_event_name_produces_custom_with_data(self):
        """Unknown custom event names should produce a CUSTOM event that carries the original data."""
        agent = self._make_agent()
        payload = {"key": "value", "count": 42}
        event = {
            "event": LangGraphEventTypes.OnCustomEvent.value,
            "name": "some_unknown_event",
            "data": payload,
        }
        events = []
        async for ev in agent._handle_single_event(event, {}):
            events.append(ev)

        custom_events = [e for e in events if e.type == EventType.CUSTOM]
        assert len(custom_events) == 1
        assert custom_events[0].name == "some_unknown_event"
        assert custom_events[0].value == payload

    @pytest.mark.asyncio
    async def test_manually_emit_state_with_nested_data(self):
        """ManuallyEmitState should handle nested/complex data without crashing."""
        agent = self._make_agent()
        nested_state = {"level1": {"level2": [1, 2, 3]}, "count": 5}
        event = {
            "event": LangGraphEventTypes.OnCustomEvent.value,
            "name": CustomEventNames.ManuallyEmitState.value,
            "data": nested_state,
        }
        events = []
        async for ev in agent._handle_single_event(event, {}):
            events.append(ev)

        assert agent.active_run["manually_emitted_state"] == nested_state
        assert any(e.type == EventType.STATE_SNAPSHOT for e in events)

    @pytest.mark.asyncio
    async def test_manually_emit_state_with_empty_payload(self):
        """ManuallyEmitState with empty dict should not crash."""
        agent = self._make_agent()
        event = {
            "event": LangGraphEventTypes.OnCustomEvent.value,
            "name": CustomEventNames.ManuallyEmitState.value,
            "data": {},
        }
        events = []
        async for ev in agent._handle_single_event(event, {}):
            events.append(ev)

        assert any(e.type == EventType.STATE_SNAPSHOT for e in events)
