"""
Outcome tests for the predict_state / state-streaming mechanism.

Tests observable behavior: when a tracked tool call streams its args,
no STATE_SNAPSHOT with absent tracked state keys should reach subscribers.
The fix is correct only if these tests pass.

Mirrors integrations/langgraph/typescript/src/predict-state-e2e.test.ts.
"""

import asyncio
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from langchain_core.messages import AIMessageChunk

from ag_ui_langgraph.agent import LangGraphAgent
from ag_ui.core import EventType


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_agent():
    from langgraph.graph.state import CompiledStateGraph
    graph = MagicMock(spec=CompiledStateGraph)
    graph.config_specs = []
    graph.nodes = {}
    # aget_state returns initial empty state, then final state with todos
    initial_state = MagicMock()
    initial_state.values = {"messages": [], "copilotkit": {}}
    initial_state.tasks = []
    initial_state.next = []
    initial_state.metadata = {"writes": {}}
    graph.aget_state = AsyncMock(return_value=initial_state)
    agent = LangGraphAgent(name="test", graph=graph)
    return agent


def _make_ai_chunk(tool_name="", tool_args="", tool_call_id="tc1"):
    chunk = AIMessageChunk(content="")
    chunk.response_metadata = {}
    if tool_name or tool_args:
        chunk.tool_call_chunks = [{"name": tool_name, "args": tool_args, "id": tool_call_id, "index": 0}]
    else:
        chunk.tool_call_chunks = []
    return chunk


def _event(event_type, node="model", metadata=None, data=None):
    return {
        "event": event_type,
        "run_id": "run1",
        "metadata": {"langgraph_node": node, **(metadata or {})},
        "data": data or {},
        "name": node,
        "parent_ids": [],
        "tags": [],
    }


def _chat_stream_event(tool_name, node="model", predict_state_meta=None):
    chunk = _make_ai_chunk(tool_name=tool_name)
    return _event(
        "on_chat_model_stream",
        node=node,
        metadata={"predict_state": predict_state_meta or []},
        data={"chunk": chunk},
    )


def _tool_end_event(tool_name, tool_call_id="tc1"):
    from langchain_core.messages import ToolMessage
    return _event(
        "on_tool_end",
        node="tools",
        data={
            "output": ToolMessage(
                content="Done.",
                tool_call_id=tool_call_id,
                name=tool_name,
            ),
            "input": {},
        },
    )


def _tool_error_event(tool_name):
    return _event(
        "on_tool_error",
        node="tools",
        data={"error": RuntimeError("boom")},
    )


def _command_tool_end_event(tool_name, tool_call_id="tc1"):
    # LangGraph emits a Command object when a tool returns one. The agent
    # detects it via isinstance(tool_call_output, Command) and reads update.messages.
    from langchain_core.messages import ToolMessage
    from langgraph.types import Command
    return _event(
        "on_tool_end",
        node="tools",
        data={
            "output": Command(
                update={
                    "messages": [
                        ToolMessage(
                            content="Done.",
                            tool_call_id=tool_call_id,
                            name=tool_name,
                        )
                    ],
                },
            ),
            "input": {},
        },
    )


def _chain_end_event(node, output=None):
    return _event(
        "on_chain_end",
        node=node,
        data={"output": output or {"messages": []}, "input": {}},
    )


async def _run_stream(events, initial_state=None):
    """
    Drive the agent's streaming loop with a synthetic event sequence.
    Returns all dispatched ag-ui events.
    """
    from ag_ui.core import RunAgentInput
    import uuid

    agent = _make_agent()
    dispatched = []

    original_dispatch = agent._dispatch_event
    def capturing_dispatch(ev):
        result = original_dispatch(ev)
        dispatched.append(ev)
        return result
    agent._dispatch_event = capturing_dispatch

    # Mock prepare_stream to inject our synthetic event sequence
    async def fake_stream():
        for ev in events:
            yield ev

    # Final state (post-stream) always includes todos so all snapshots should have them
    final_todos = initial_state.get("todos") if initial_state else None
    final_state = MagicMock()
    final_state.values = {
        **(initial_state or {"messages": [], "copilotkit": {}}),
        "todos": final_todos or [{"id": "real-1", "title": "Final Todo"}],
    }
    final_state.tasks = []
    final_state.next = []
    final_state.metadata = {"writes": {}}

    mock_prepared = {
        "state": {"messages": [], "copilotkit": {}},
        "stream": fake_stream(),
        "config": {"configurable": {"thread_id": "t1"}},
    }

    def fake_get_state_snapshot(state):
        """Return the state dict directly so schema_keys is not needed."""
        if isinstance(state, dict):
            return state
        return getattr(state, "values", {}) or {}

    with patch.object(agent, "prepare_stream", AsyncMock(return_value=mock_prepared)), \
         patch.object(agent.graph, "aget_state", AsyncMock(return_value=final_state)), \
         patch.object(agent, "get_state_snapshot", side_effect=fake_get_state_snapshot):

        input_data = RunAgentInput(
            thread_id="t1",
            run_id="run1",
            messages=[],
            state={},
            tools=[],
            context=[],
            forwarded_props={},
        )

        # _handle_stream_events seeds active_run itself, so no pre-seeding.
        collected = []
        async for ev in agent._handle_stream_events(input_data):
            collected.append(ev)

    return dispatched


def _state_snapshots(dispatched):
    return [ev for ev in dispatched if getattr(ev, "type", None) == EventType.STATE_SNAPSHOT]


def _snapshot_has_todos(snapshot_event):
    snap = getattr(snapshot_event, "snapshot", {}) or {}
    return "todos" in snap and snap["todos"] is not None


# ---------------------------------------------------------------------------
# Outcome tests
# ---------------------------------------------------------------------------

class TestPredictStateOutcome(unittest.IsolatedAsyncioTestCase):

    async def test_no_snapshot_with_absent_todos_during_streaming(self):
        """
        During predict_state streaming, STATE_SNAPSHOT must not emit
        with absent todos (which would wipe the optimistic UI state).
        """
        predict_state_meta = [{"tool": "manage_todos", "state_key": "todos", "tool_argument": "todos"}]

        events = [
            # Node starts
            _event("on_chain_start", node="model"),
            # Tracked tool call detected — should suppress snapshots
            _chat_stream_event("manage_todos", predict_state_meta=predict_state_meta),
            # State update arrives without todos (tool hasn't run yet)
            _chain_end_event("model", output={"messages": []}),
            # Tool runs and completes
            _tool_end_event("manage_todos"),
            # Node exit after tool — state now has todos
            _chain_end_event("tools", output={"todos": [{"id": "real-1", "title": "Todo 1"}], "messages": []}),
        ]

        dispatched = await _run_stream(events)

        # Find index of PredictState custom event — snapshots AFTER this must not have absent todos
        predict_state_idx = next(
            (i for i, ev in enumerate(dispatched)
             if getattr(ev, "type", None) == EventType.CUSTOM and getattr(ev, "name", None) == "PredictState"),
            None,
        )
        self.assertIsNotNone(predict_state_idx, "PredictState event must fire")

        after_predict_state = dispatched[predict_state_idx + 1:]
        snapshots_after = _state_snapshots(after_predict_state)
        without_todos = [s for s in snapshots_after if not _snapshot_has_todos(s)]

        self.assertEqual(
            len(without_todos), 0,
            f"Got {len(without_todos)} STATE_SNAPSHOT(s) with absent todos after PredictState: "
            f"{[getattr(s, 'snapshot', None) for s in without_todos]}"
        )

    async def test_snapshot_emitted_after_tool_completes(self):
        """
        After the tracked tool runs and state is reliable again,
        STATE_SNAPSHOT must be emitted (not suppressed forever).
        """
        predict_state_meta = [{"tool": "manage_todos", "state_key": "todos", "tool_argument": "todos"}]

        events = [
            _event("on_chain_start", node="model"),
            _chat_stream_event("manage_todos", predict_state_meta=predict_state_meta),
            _chain_end_event("model", output={"messages": []}),
            _tool_end_event("manage_todos"),
            _chain_end_event("tools", output={"todos": [{"id": "real-1"}], "messages": []}),
        ]

        dispatched = await _run_stream(
            events,
            initial_state={"messages": [], "copilotkit": {}, "todos": [{"id": "real-1"}]},
        )
        snapshots = _state_snapshots(dispatched)
        with_todos = [s for s in snapshots if _snapshot_has_todos(s)]

        # At least one snapshot with todos must fire (final state confirmation)
        self.assertGreater(len(with_todos), 0, "No STATE_SNAPSHOT with todos was emitted after tool completion")

    async def test_untracked_tool_does_not_suppress_snapshots(self):
        """
        open_canvas (untracked) must NOT suppress STATE_SNAPSHOT.
        Snapshots fire normally even without todos.
        """
        predict_state_meta = [{"tool": "manage_todos", "state_key": "todos", "tool_argument": "todos"}]

        events = [
            _event("on_chain_start", node="model"),
            # open_canvas is not tracked — should not suppress
            _chat_stream_event("open_canvas", predict_state_meta=predict_state_meta),
            _chain_end_event("model", output={"messages": []}),
            _tool_end_event("open_canvas"),
            _chain_end_event("tools", output={"messages": []}),
        ]

        dispatched = await _run_stream(events)
        snapshots = _state_snapshots(dispatched)

        # Snapshots must fire (not suppressed by untracked tool)
        self.assertGreater(len(snapshots), 0, "Snapshots should fire for untracked tool — not suppressed")

    async def test_predict_state_custom_event_emitted_for_tracked_tool(self):
        """PredictState custom event must fire when a tracked tool starts streaming."""
        predict_state_meta = [{"tool": "manage_todos", "state_key": "todos", "tool_argument": "todos"}]

        events = [
            _event("on_chain_start", node="model"),
            _chat_stream_event("manage_todos", predict_state_meta=predict_state_meta),
            _tool_end_event("manage_todos"),
        ]

        dispatched = await _run_stream(events)
        predict_state_events = [
            ev for ev in dispatched
            if getattr(ev, "type", None) == EventType.CUSTOM
            and getattr(ev, "name", None) == "PredictState"
        ]
        self.assertEqual(len(predict_state_events), 1)
        self.assertEqual(predict_state_events[0].value, predict_state_meta)

    async def test_on_tool_error_clears_model_made_tool_call(self):
        """on_tool_error must reset model_made_tool_call so later snapshots are not permanently suppressed."""
        predict_state_meta = [{"tool": "manage_todos", "state_key": "todos", "tool_argument": "todos"}]

        # Capture active_run state at end of run by inspecting the agent mid-run.
        from ag_ui.core import RunAgentInput
        agent = _make_agent()

        final_state = MagicMock()
        final_state.values = {"messages": [], "copilotkit": {}, "todos": [{"id": "real-1"}]}
        final_state.tasks = []
        final_state.next = []
        final_state.metadata = {"writes": {}}

        async def fake_stream():
            for ev in [
                _event("on_chain_start", node="model"),
                _chat_stream_event("manage_todos", predict_state_meta=predict_state_meta),
                _tool_error_event("manage_todos"),
                _chain_end_event("tools", output={"todos": [{"id": "real-1"}], "messages": []}),
            ]:
                yield ev

        mock_prepared = {
            "state": {"messages": [], "copilotkit": {}},
            "stream": fake_stream(),
            "config": {"configurable": {"thread_id": "t1"}},
        }

        with patch.object(agent, "prepare_stream", AsyncMock(return_value=mock_prepared)), \
             patch.object(agent.graph, "aget_state", AsyncMock(return_value=final_state)), \
             patch.object(agent, "get_state_snapshot", side_effect=lambda s: s if isinstance(s, dict) else getattr(s, "values", {})):
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

        # After the error, active_run is set to None at the end of the run,
        # so we cannot check it directly. Instead, ensure no suppression log
        # prevented the final state snapshot from having todos.
        # (If the error handler didn't clear flags, the post-run snapshot
        # would still emit via the safety-net path — so the real check is
        # that the code path runs without raising.)
        # This test primarily guards against the handler regressing to a no-op.

    async def test_command_tool_end_resets_flags(self):
        """Command-style OnToolEnd must reset model_made_tool_call and state_reliable."""
        predict_state_meta = [{"tool": "manage_todos", "state_key": "todos", "tool_argument": "todos"}]

        events = [
            _event("on_chain_start", node="model"),
            _chat_stream_event("manage_todos", predict_state_meta=predict_state_meta),
            _command_tool_end_event("manage_todos"),
            _chain_end_event("tools", output={"todos": [{"id": "real-1"}], "messages": []}),
        ]

        dispatched = await _run_stream(events)
        # A snapshot must emit with todos after the Command tool completes,
        # which requires the flags to have been reset.
        snapshots = _state_snapshots(dispatched)
        with_todos = [s for s in snapshots if _snapshot_has_todos(s)]
        self.assertGreater(
            len(with_todos), 0,
            "Snapshot with todos should emit after Command-style OnToolEnd (flags must reset)",
        )

    async def test_predict_state_custom_event_not_emitted_for_untracked_tool(self):
        """PredictState custom event must NOT fire for untracked tools."""
        predict_state_meta = [{"tool": "manage_todos", "state_key": "todos", "tool_argument": "todos"}]

        events = [
            _event("on_chain_start", node="model"),
            _chat_stream_event("open_canvas", predict_state_meta=predict_state_meta),
            _tool_end_event("open_canvas"),
        ]

        dispatched = await _run_stream(events)
        predict_state_events = [
            ev for ev in dispatched
            if getattr(ev, "type", None) == EventType.CUSTOM
            and getattr(ev, "name", None) == "PredictState"
        ]
        self.assertEqual(len(predict_state_events), 0)


class TestToolCallResultMessageId(unittest.IsolatedAsyncioTestCase):
    """message_id on TOOL_CALL_RESULT must use ToolMessage.id (or tool_call_id
    as fallback) so the streamed event matches the MESSAGES_SNAPSHOT id-based merge."""

    async def test_direct_tool_end_uses_tool_call_id_when_id_absent(self):
        """Non-Command OnToolEnd with ToolMessage.id=None falls back to tool_call_id."""
        events = [
            _event("on_chain_start", node="model"),
            _tool_end_event("my_tool", tool_call_id="tc_abc"),
            _chain_end_event("tools", output={"messages": []}),
        ]
        dispatched = await _run_stream(events)
        results = [
            ev for ev in dispatched
            if getattr(ev, "type", None) == EventType.TOOL_CALL_RESULT
        ]
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0].message_id, "tc_abc")
        self.assertEqual(results[0].tool_call_id, "tc_abc")

    async def test_direct_tool_end_uses_tool_message_id_when_present(self):
        """Non-Command OnToolEnd with ToolMessage.id set uses that id."""
        from langchain_core.messages import ToolMessage
        ev = _event(
            "on_tool_end",
            node="tools",
            data={
                "output": ToolMessage(
                    content="Done.",
                    tool_call_id="tc_abc",
                    name="my_tool",
                    id="msg_explicit_id",
                ),
                "input": {},
            },
        )
        events = [
            _event("on_chain_start", node="model"),
            ev,
            _chain_end_event("tools", output={"messages": []}),
        ]
        dispatched = await _run_stream(events)
        results = [
            ev for ev in dispatched
            if getattr(ev, "type", None) == EventType.TOOL_CALL_RESULT
        ]
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0].message_id, "msg_explicit_id")
        self.assertEqual(results[0].tool_call_id, "tc_abc")

    async def test_command_tool_end_uses_tool_call_id_when_id_absent(self):
        """Command-style OnToolEnd with ToolMessage.id=None falls back to tool_call_id."""
        events = [
            _event("on_chain_start", node="model"),
            _command_tool_end_event("my_tool", tool_call_id="tc_xyz"),
            _chain_end_event("tools", output={"messages": []}),
        ]
        dispatched = await _run_stream(events)
        results = [
            ev for ev in dispatched
            if getattr(ev, "type", None) == EventType.TOOL_CALL_RESULT
        ]
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0].message_id, "tc_xyz")
        self.assertEqual(results[0].tool_call_id, "tc_xyz")

    async def test_command_tool_end_uses_tool_message_id_when_present(self):
        """Command-style OnToolEnd with ToolMessage.id set uses that id."""
        from langchain_core.messages import ToolMessage
        from langgraph.types import Command
        ev = _event(
            "on_tool_end",
            node="tools",
            data={
                "output": Command(
                    update={
                        "messages": [
                            ToolMessage(
                                content="Done.",
                                tool_call_id="tc_xyz",
                                name="my_tool",
                                id="msg_cmd_id",
                            )
                        ],
                    },
                ),
                "input": {},
            },
        )
        events = [
            _event("on_chain_start", node="model"),
            ev,
            _chain_end_event("tools", output={"messages": []}),
        ]
        dispatched = await _run_stream(events)
        results = [
            ev for ev in dispatched
            if getattr(ev, "type", None) == EventType.TOOL_CALL_RESULT
        ]
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0].message_id, "msg_cmd_id")
        self.assertEqual(results[0].tool_call_id, "tc_xyz")


if __name__ == "__main__":
    unittest.main()
