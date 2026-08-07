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
    async def test_manually_emit_state_suppressed_inside_subagent(self):
        """State belongs to the parent, so a subagent must not emit STATE_SNAPSHOT.

        The two automatic paths (node-exit and checkpoint snapshots) already gate
        on current_subagent_id. This manual path did not, and because
        STATE_SNAPSHOT is in _SUBAGENT_ATTRIBUTABLE_EVENT_TYPES the dispatch
        chokepoint would then stamp the subagent's id onto it — producing exactly
        the event the design forbids. The client applies STATE_SNAPSHOT to the
        shared state without consulting subagent_id, so a subagent calling the
        manual helper would overwrite the parent's state with its own.
        """
        agent = self._make_agent()
        agent.active_run["current_subagent_id"] = "tools:s1"
        agent.active_run["active_subagents"] = {}
        event = {
            "event": LangGraphEventTypes.OnCustomEvent.value,
            "name": CustomEventNames.ManuallyEmitState.value,
            "data": {"counter": 42},
        }
        events = []
        async for ev in agent._handle_single_event(event, {}):
            events.append(ev)

        event_types = [e.type for e in events]
        assert EventType.STATE_SNAPSHOT not in event_types
        # The CUSTOM passthrough still goes out, so the subagent's signal is not
        # swallowed — only the state application is withheld.
        assert EventType.CUSTOM in event_types

    @pytest.mark.asyncio
    async def test_manually_emit_state_inside_subagent_does_not_leak_into_parent_state(self):
        """Suppressing the snapshot is not enough — the value must not be recorded.

        Withholding the immediate STATE_SNAPSHOT while still storing the payload in
        the run-global `manually_emitted_state` only defers the violation: the
        stream loop reads that key back as `updated_state` on the next parent node
        exit and emits it as an UNATTRIBUTED snapshot, so the consumer applies the
        subagent's partial state as the parent's. The suppression has to drop the
        value, not just delay it.
        """
        agent = self._make_agent()
        agent.active_run["current_subagent_id"] = "tools:s1"
        agent.active_run["active_subagents"] = {}
        event = {
            "event": LangGraphEventTypes.OnCustomEvent.value,
            "name": CustomEventNames.ManuallyEmitState.value,
            "data": {"counter": 42},
        }
        async for _ in agent._handle_single_event(event, {}):
            pass

        assert agent.active_run["manually_emitted_state"] is None, (
            "a subagent's manually-emitted state must not be recorded; the stream "
            "loop would re-emit it as the parent's state on the next node exit"
        )

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
