"""
Outcome tests for issue #2515 — the Python twin of #2014.

``active_run["streamed_tool_call_ids"]`` is rebuilt as an empty set on every
HTTP request. That is only safe while a logical turn fits in one request. A
LangGraph ``interrupt()`` splits a turn across two requests: the tool call is
announced (Start/Args/End) in the first request, and its ``OnToolEnd`` lands in
the *second* one, where the set is empty. ``already_streamed`` is then False and
the re-emit fallback announces the call a second time.

``TOOL_CALL_ARGS`` is a delta protocol keyed by tool-call id, so a client that
persists history appends rather than replaces: the stored arguments become two
concatenated JSON documents (``{...}{...}``) which no longer parse, and because
history replays on every later turn the thread stays broken.

A tool call present in the inbound ``RunAgentInput.messages`` is by definition
one the client already received, so the inbound history seeds the set.

These tests drive the real ``_handle_stream_events`` path twice — one request
per turn, with the first request's emissions rebuilt into the history the
client echoes back on the second — rather than asserting against a hand-built
``active_run``.
"""

import asyncio
import json
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from langchain_core.messages import AIMessageChunk, ToolMessage as LCToolMessage

from ag_ui.core import (
    AssistantMessage,
    EventType,
    FunctionCall,
    RunAgentInput,
    ToolCall,
    UserMessage,
)
from ag_ui_langgraph.agent import LangGraphAgent

TOOL_NAME = "book_hotel"
TOOL_CALL_ID = "tc-hitl-1"
PARENT_MESSAGE_ID = "ai-msg-1"
TOOL_ARGS = '{"hotel":"Hilton"}'


def _make_agent(**agent_kwargs) -> LangGraphAgent:
    from langgraph.graph.state import CompiledStateGraph

    graph = MagicMock(spec=CompiledStateGraph)
    graph.config_specs = []
    graph.nodes = {}
    state = MagicMock()
    state.values = {"messages": [], "copilotkit": {}}
    state.tasks = []
    state.next = []
    state.metadata = {"writes": {}}
    graph.aget_state = AsyncMock(return_value=state)
    return LangGraphAgent(name="test", graph=graph, **agent_kwargs)


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


def _ai_chunk(*, name="", args="", tool_call_id=TOOL_CALL_ID, chunk_id=PARENT_MESSAGE_ID):
    chunk = AIMessageChunk(content="", id=chunk_id)
    chunk.response_metadata = {}
    if name or args:
        chunk.tool_call_chunks = [
            {"name": name, "args": args, "id": tool_call_id, "index": 0}
        ]
    else:
        chunk.tool_call_chunks = []
    return chunk


def _stream_start(name=TOOL_NAME, tool_call_id=TOOL_CALL_ID):
    return _event(
        "on_chat_model_stream",
        data={"chunk": _ai_chunk(name=name, args="", tool_call_id=tool_call_id)},
    )


def _stream_args(args_delta, tool_call_id=TOOL_CALL_ID):
    return _event(
        "on_chat_model_stream",
        data={"chunk": _ai_chunk(args=args_delta, tool_call_id=tool_call_id)},
    )


def _stream_end():
    return _event("on_chat_model_stream", data={"chunk": _ai_chunk()})


def _tool_end(tool_call_id=TOOL_CALL_ID, *, content="booked", input_args=None):
    return _event(
        "on_tool_end",
        node="tools",
        name=TOOL_NAME,
        data={
            "output": LCToolMessage(
                content=content,
                tool_call_id=tool_call_id,
                name=TOOL_NAME,
            ),
            "input": input_args if input_args is not None else json.loads(TOOL_ARGS),
        },
    )


async def _request(agent, events, messages):
    """Drive one HTTP request's worth of streaming and return the dispatched events.

    ``prepare_stream`` is patched (no real graph), but everything downstream of
    it — including the per-request rebuild of ``active_run`` in
    ``_handle_stream_events`` — is the production path.
    """
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

    prepared = {
        "state": {"messages": [], "copilotkit": {}},
        "stream": fake_stream(),
        "config": {"configurable": {"thread_id": "t1"}},
    }

    def fake_snapshot(state):
        return state if isinstance(state, dict) else (getattr(state, "values", {}) or {})

    with patch.object(agent, "prepare_stream", AsyncMock(return_value=prepared)), \
         patch.object(agent.graph, "aget_state", AsyncMock(return_value=final_state)), \
         patch.object(agent, "get_state_snapshot", side_effect=fake_snapshot):
        run_input = RunAgentInput(
            thread_id="t1",
            run_id="run1",
            messages=messages,
            state={},
            tools=[],
            context=[],
            forwarded_props={},
        )
        async for _ in agent._handle_stream_events(run_input):
            pass

    agent._dispatch_event = original_dispatch
    return dispatched


def _tool_events(dispatched, tool_call_id=TOOL_CALL_ID):
    """(start_count, args_deltas, end_count, result_count) for one tool call id."""
    starts = ends = results = 0
    args_deltas = []
    for ev in dispatched:
        if getattr(ev, "tool_call_id", None) != tool_call_id:
            continue
        if ev.type == EventType.TOOL_CALL_START:
            starts += 1
        elif ev.type == EventType.TOOL_CALL_ARGS:
            args_deltas.append(getattr(ev, "delta", ""))
        elif ev.type == EventType.TOOL_CALL_END:
            ends += 1
        elif ev.type == EventType.TOOL_CALL_RESULT:
            results += 1
    return starts, args_deltas, ends, results


def _history_after_first_request(dispatched):
    """Rebuild the history a persisting client holds after the first request.

    The assistant message carries the tool call the client assembled from the
    first request's TOOL_CALL_START/ARGS events, with the args it accumulated.
    This is what the client echoes back on the resume request.
    """
    starts, args_deltas, _, _ = _tool_events(dispatched)
    assert starts == 1, f"first request must announce the call exactly once, got {starts}"
    return [
        UserMessage(id="u1", role="user", content="book me a hotel"),
        AssistantMessage(
            id=PARENT_MESSAGE_ID,
            role="assistant",
            content="",
            tool_calls=[
                ToolCall(
                    id=TOOL_CALL_ID,
                    type="function",
                    function=FunctionCall(
                        name=TOOL_NAME,
                        arguments="".join(args_deltas),
                    ),
                )
            ],
        ),
    ]


class TestResumeToolCallDedup(unittest.TestCase):
    """A resumed turn must not re-announce a tool call the client already holds."""

    def test_resume_request_does_not_re_emit_start_args_end(self):
        async def scenario():
            agent = _make_agent()

            # Request 1: the model streams the tool call, then the graph
            # interrupts inside the tool — so no OnToolEnd in this request.
            first = await _request(
                agent,
                [_stream_start(), _stream_args(TOOL_ARGS), _stream_end()],
                [UserMessage(id="u1", role="user", content="book me a hotel")],
            )

            # Request 2 (the resume): the client echoes back the history it
            # holds, and the tool completes — OnToolEnd lands here.
            second = await _request(
                agent,
                [_tool_end()],
                _history_after_first_request(first),
            )
            return first, second

        first, second = asyncio.run(scenario())

        first_starts, first_args, first_ends, _ = _tool_events(first)
        self.assertEqual(first_starts, 1)
        self.assertEqual("".join(first_args), TOOL_ARGS)
        self.assertEqual(first_ends, 1)

        starts, args_deltas, ends, results = _tool_events(second)
        self.assertEqual(
            starts,
            0,
            "the resume request re-announced a tool call the client already holds",
        )
        self.assertEqual(
            args_deltas,
            [],
            "re-emitted TOOL_CALL_ARGS concatenates onto the persisted arguments, "
            f"leaving {TOOL_ARGS + ''.join(args_deltas)!r} — which no longer parses",
        )
        self.assertEqual(ends, 0)

        # The result must still be delivered; only the re-announcement is suppressed.
        self.assertEqual(results, 1)

    def test_persisted_arguments_still_parse_after_the_resume(self):
        """The user-visible damage: concatenated JSON documents on the thread."""

        async def scenario():
            agent = _make_agent()
            first = await _request(
                agent,
                [_stream_start(), _stream_args(TOOL_ARGS), _stream_end()],
                [UserMessage(id="u1", role="user", content="book me a hotel")],
            )
            second = await _request(
                agent, [_tool_end()], _history_after_first_request(first)
            )
            return first, second

        first, second = asyncio.run(scenario())

        # What a delta-appending client stores across both requests.
        stored = "".join(_tool_events(first)[1] + _tool_events(second)[1])
        self.assertEqual(json.loads(stored), {"hotel": "Hilton"})

    def test_a_fresh_tool_call_in_the_resume_request_still_emits(self):
        """The seed must not become a blanket suppression rule.

        A tool call the client has never seen — surfaced only by OnToolEnd,
        never streamed — must still get its full Start/Args/End.
        """

        async def scenario():
            agent = _make_agent()
            first = await _request(
                agent,
                [_stream_start(), _stream_args(TOOL_ARGS), _stream_end()],
                [UserMessage(id="u1", role="user", content="book me a hotel")],
            )
            second = await _request(
                agent,
                [_tool_end(), _tool_end("tc-fresh", content="ok", input_args={"a": 1})],
                _history_after_first_request(first),
            )
            return second

        second = asyncio.run(scenario())

        starts, args_deltas, ends, results = _tool_events(second, "tc-fresh")
        self.assertEqual(starts, 1)
        self.assertEqual(args_deltas, ['{"a": 1}'])
        self.assertEqual(ends, 1)
        self.assertEqual(results, 1)


    def test_resume_dedup_holds_under_hidden_subagent_visibility(self):
        """The seeded key must match the key OnToolEnd looks up.

        ``_streamed_call_key`` scopes membership by lane under
        ``subagent_visibility="hidden"``, so seeding a bare id there would land
        in a different membership space than the one the main-lane OnToolEnd
        reads.
        """

        async def scenario():
            agent = _make_agent(subagent_visibility="hidden")
            first = await _request(
                agent,
                [_stream_start(), _stream_args(TOOL_ARGS), _stream_end()],
                [UserMessage(id="u1", role="user", content="book me a hotel")],
            )
            return await _request(
                agent, [_tool_end()], _history_after_first_request(first)
            )

        second = asyncio.run(scenario())

        starts, args_deltas, ends, results = _tool_events(second)
        self.assertEqual(starts, 0)
        self.assertEqual(args_deltas, [])
        self.assertEqual(ends, 0)
        self.assertEqual(results, 1)


if __name__ == "__main__":
    unittest.main()
