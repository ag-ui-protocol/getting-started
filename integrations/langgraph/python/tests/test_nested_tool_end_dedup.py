"""
Outcome tests for nested OnToolEnd dedup.

When a tool delegates to a sub-agent (e.g. deepagents ``task``), the inner
tool's ``OnToolEnd`` fires before the outer tool's ``OnToolEnd``. Earlier
the agent gated re-emission of Start/Args/End on a single
``has_function_streaming`` boolean, which the inner OnToolEnd reset to
False — so the outer OnToolEnd then re-emitted the outer tool_call's
Start/Args/End, producing duplicate Args deltas. Frontends concatenated
the deltas in persisted history, surfacing as
``{"subagent_type":"x"}{"subagent_type":"x"}`` on the next run.

The fix tracks streamed tool_call_ids in a per-id set instead of a single
boolean. These tests exercise the observable contract:

1. Nested execution must not duplicate the outer tool's Start/Args/End.
2. Parallel top-level tool_calls that only surface via OnToolEnd
   (i.e. were never streamed) must still emit Start/Args/End.

Mirrors the structure of test_predict_state_e2e.py.
"""

import asyncio
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from langchain_core.messages import AIMessageChunk, ToolMessage

from ag_ui_langgraph.agent import LangGraphAgent
from ag_ui.core import EventType


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


def _ai_chunk(*, name="", args="", tool_call_id="tc1", chunk_id="ai-msg-1"):
    """Build a streaming AIMessageChunk carrying a single tool_call chunk.

    ``name`` set + ``args=""`` represents the leading start chunk; subsequent
    chunks carry ``args`` only (no name). An empty tool_call_chunks list
    represents the terminal "stream end" chunk for that tool call.

    ``chunk_id`` is the AIMessageChunk's ``id`` — agent.py uses it as the
    ``MessageInProgress.id`` and bool-checks ``id`` to decide whether a stream
    is in progress, so it must be a truthy string for follow-up args/end chunks
    to be recognised.
    """
    chunk = AIMessageChunk(content="", id=chunk_id)
    chunk.response_metadata = {}
    if name or args:
        chunk.tool_call_chunks = [
            {"name": name, "args": args, "id": tool_call_id, "index": 0}
        ]
    else:
        chunk.tool_call_chunks = []
    return chunk


def _text_chunk(content, *, chunk_id="ai-text-1"):
    chunk = AIMessageChunk(content=content, id=chunk_id)
    chunk.response_metadata = {}
    chunk.tool_call_chunks = []
    return chunk


def _text_and_tool_start_chunk(content, *, name, tool_call_id, chunk_id="ai-text-1"):
    chunk = AIMessageChunk(content=content, id=chunk_id)
    chunk.response_metadata = {}
    chunk.tool_call_chunks = [
        {"name": name, "args": "", "id": tool_call_id, "index": 0}
    ]
    return chunk


def _event(event_type, *, node="model", data=None, name=None):
    return {
        "event": event_type,
        "run_id": "run1",
        "metadata": {"langgraph_node": node},
        "data": data or {},
        "name": name or node,
        "parent_ids": [],
        "tags": [],
    }


def _stream_start(name, tool_call_id, node="model"):
    return _event(
        "on_chat_model_stream",
        node=node,
        data={"chunk": _ai_chunk(name=name, args="", tool_call_id=tool_call_id)},
    )


def _stream_text(content, *, chunk_id="ai-text-1", node="model"):
    return _event(
        "on_chat_model_stream",
        node=node,
        data={"chunk": _text_chunk(content, chunk_id=chunk_id)},
    )


def _stream_text_and_start(content, name, tool_call_id, *, chunk_id="ai-text-1", node="model"):
    return _event(
        "on_chat_model_stream",
        node=node,
        data={"chunk": _text_and_tool_start_chunk(content, name=name, tool_call_id=tool_call_id, chunk_id=chunk_id)},
    )


def _stream_args(args_delta, tool_call_id, node="model"):
    return _event(
        "on_chat_model_stream",
        node=node,
        data={"chunk": _ai_chunk(args=args_delta, tool_call_id=tool_call_id)},
    )


def _stream_end(node="model"):
    """Emit a stream-terminator chunk (no tool_call_chunks)."""
    return _event(
        "on_chat_model_stream",
        node=node,
        data={"chunk": _ai_chunk()},
    )


def _tool_end(tool_name, tool_call_id, *, content="ok", input_args=None):
    return _event(
        "on_tool_end",
        node="tools",
        name=tool_name,
        data={
            "output": ToolMessage(
                content=content,
                tool_call_id=tool_call_id,
                name=tool_name,
            ),
            "input": input_args or {},
        },
    )


async def _run_stream(events):
    from ag_ui.core import RunAgentInput

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

    with patch.object(agent, "prepare_stream", AsyncMock(return_value=mock_prepared)), \
         patch.object(agent.graph, "aget_state", AsyncMock(return_value=final_state)), \
         patch.object(agent, "get_state_snapshot", side_effect=fake_snapshot):

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


def _filter_tool_events(dispatched, tool_call_id):
    """Return (start_count, args_payloads, end_count, result_count) for a given tool_call_id."""
    starts = 0
    ends = 0
    results = 0
    args_deltas = []
    for ev in dispatched:
        tc_id = getattr(ev, "tool_call_id", None)
        if tc_id != tool_call_id:
            continue
        if ev.type == EventType.TOOL_CALL_START:
            starts += 1
        elif ev.type == EventType.TOOL_CALL_END:
            ends += 1
        elif ev.type == EventType.TOOL_CALL_RESULT:
            results += 1
        elif ev.type == EventType.TOOL_CALL_ARGS:
            args_deltas.append(getattr(ev, "delta", ""))
    return starts, args_deltas, ends, results


class TestNestedOnToolEndDedup(unittest.TestCase):
    """Outer + inner tool execution must not double-emit the outer tool's Start/Args/End."""

    def test_outer_tool_not_re_emitted_after_inner_tool_end(self):
        outer_id = "tc-outer"
        inner_id = "tc-inner"
        outer_args = '{"subagent_type":"researcher"}'
        inner_args = '{"query":"hello"}'

        events = [
            # Outer model streams the `task` tool call.
            _stream_start("task", outer_id),
            _stream_args(outer_args, outer_id),
            _stream_end(),
            # Sub-agent streams its own tool call.
            _stream_start("search", inner_id),
            _stream_args(inner_args, inner_id),
            _stream_end(),
            # Inner tool finishes first (sub-agent's tool).
            _tool_end("search", inner_id, content="found", input_args={"query": "hello"}),
            # Then the outer task tool finishes.
            _tool_end("task", outer_id, content="subagent done", input_args={"subagent_type": "researcher"}),
        ]
        dispatched = asyncio.run(_run_stream(events))

        outer_starts, outer_args_payloads, outer_ends, outer_results = _filter_tool_events(dispatched, outer_id)
        inner_starts, inner_args_payloads, inner_ends, inner_results = _filter_tool_events(dispatched, inner_id)

        # The outer tool_call must only emit Start/Args/End ONCE — from the
        # streaming pass. Its OnToolEnd must NOT re-emit (which is the bug).
        self.assertEqual(outer_starts, 1, f"outer Start must fire exactly once; got {outer_starts}")
        self.assertEqual(outer_ends, 1, f"outer End must fire exactly once; got {outer_ends}")
        self.assertEqual(outer_results, 1, "outer Result must fire exactly once")
        # Args delta total should equal the outer streamed payload, not concatenated twice.
        self.assertEqual(
            "".join(outer_args_payloads),
            outer_args,
            "outer Args must not be emitted twice (would produce concatenated JSON in persisted history)",
        )

        # Inner tool also single Start/Args/End/Result.
        self.assertEqual(inner_starts, 1)
        self.assertEqual(inner_ends, 1)
        self.assertEqual(inner_results, 1)
        self.assertEqual("".join(inner_args_payloads), inner_args)


class TestParallelToolCallVisibility(unittest.TestCase):
    """A parallel tool_call that surfaces only via OnToolEnd (never streamed)
    must still emit Start/Args/End so the frontend records its name+args.
    Per-id tracking must NOT suppress it just because some other tool did stream."""

    def test_parallel_unstreamed_tool_emits_start_args_end_at_on_tool_end(self):
        streamed_id = "tc-streamed"
        unstreamed_id = "tc-unstreamed"
        streamed_args = '{"q":"streamed"}'

        events = [
            # First parallel call: streams normally.
            _stream_start("search", streamed_id),
            _stream_args(streamed_args, streamed_id),
            _stream_end(),
            # OnToolEnd for streamed tool: should NOT re-emit Start/Args/End.
            _tool_end("search", streamed_id, content="r1", input_args={"q": "streamed"}),
            # Second parallel call: never streamed (its tool_call_chunks were not
            # forwarded individually — only its OnToolEnd surfaces). Must emit
            # Start/Args/End from OnToolEnd.
            _tool_end(
                "search",
                unstreamed_id,
                content="r2",
                input_args={"q": "from_on_tool_end"},
            ),
        ]
        dispatched = asyncio.run(_run_stream(events))

        s_starts, s_args, s_ends, s_results = _filter_tool_events(dispatched, streamed_id)
        u_starts, u_args, u_ends, u_results = _filter_tool_events(dispatched, unstreamed_id)

        # Streamed tool: exactly one of each (no OnToolEnd re-emit).
        self.assertEqual(s_starts, 1)
        self.assertEqual(s_ends, 1)
        self.assertEqual(s_results, 1)
        self.assertEqual("".join(s_args), streamed_args)

        # Unstreamed parallel tool: must still get visible Start+Args+End from OnToolEnd.
        self.assertEqual(u_starts, 1, "unstreamed parallel tool must emit Start at OnToolEnd")
        self.assertEqual(u_ends, 1, "unstreamed parallel tool must emit End at OnToolEnd")
        self.assertEqual(u_results, 1)
        # Args carries the input dict serialized.
        self.assertEqual(len(u_args), 1)
        self.assertIn("from_on_tool_end", u_args[0])


class TestTextToToolCallTransition(unittest.TestCase):
    def test_tool_start_after_text_chunk_is_not_dropped(self):
        tool_call_id = "tc-search"

        dispatched = asyncio.run(
            _run_stream(
                [
                    _stream_text("I will check.", chunk_id="msg-text"),
                    _stream_start("search", tool_call_id),
                    _stream_args('{"q":"weather"}', tool_call_id),
                    _stream_end(),
                ]
            )
        )

        event_types = [ev.type for ev in dispatched]
        self.assertIn(EventType.TEXT_MESSAGE_START, event_types)
        self.assertIn(EventType.TEXT_MESSAGE_CONTENT, event_types)
        text_end_index = event_types.index(EventType.TEXT_MESSAGE_END)
        tool_start_index = next(
            index
            for index, ev in enumerate(dispatched)
            if ev.type == EventType.TOOL_CALL_START and ev.tool_call_id == tool_call_id
        )

        self.assertLess(text_end_index, tool_start_index)
        text_content = [
            ev.delta
            for ev in dispatched
            if ev.type == EventType.TEXT_MESSAGE_CONTENT
        ]
        self.assertEqual(text_content, ["I will check."])
        starts, args_payloads, ends, _ = _filter_tool_events(dispatched, tool_call_id)
        self.assertEqual(starts, 1)
        self.assertEqual("".join(args_payloads), '{"q":"weather"}')
        self.assertEqual(ends, 1)

    def test_tool_start_chunk_preserves_trailing_text(self):
        tool_call_id = "tc-search"

        dispatched = asyncio.run(
            _run_stream(
                [
                    _stream_text("I will", chunk_id="msg-text"),
                    _stream_text_and_start(" check.", "search", tool_call_id, chunk_id="msg-text"),
                    _stream_args('{"q":"weather"}', tool_call_id),
                    _stream_end(),
                ]
            )
        )

        text_content = [
            ev.delta
            for ev in dispatched
            if ev.type == EventType.TEXT_MESSAGE_CONTENT
        ]
        self.assertEqual(text_content, ["I will", " check."])

        event_types = [ev.type for ev in dispatched]
        text_end_index = event_types.index(EventType.TEXT_MESSAGE_END)
        tool_start_index = next(
            index
            for index, ev in enumerate(dispatched)
            if ev.type == EventType.TOOL_CALL_START and ev.tool_call_id == tool_call_id
        )
        self.assertLess(text_end_index, tool_start_index)

        starts, args_payloads, ends, _ = _filter_tool_events(dispatched, tool_call_id)
        self.assertEqual(starts, 1)
        self.assertEqual("".join(args_payloads), '{"q":"weather"}')
        self.assertEqual(ends, 1)


if __name__ == "__main__":
    unittest.main()
