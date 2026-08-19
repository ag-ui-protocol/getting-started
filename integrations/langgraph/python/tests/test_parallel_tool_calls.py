"""
Parallel tool_call streaming scenarios.

These tests pin the contract for several parallel tool_call patterns that
have produced runtime crashes / silently dropped tools in production:

* Sequential parallel: LLM streams tool A's chunks fully, then tool B's
  chunks. The agent must NOT splice B's args onto A's tool_call_id.

* Truly parallel chunks in a single stream event: tool_call_chunks
  carries entries for BOTH A and B in one chunk. The handler currently
  only inspects ``tool_call_chunks_list[0]``, so B must surface from
  OnToolEnd. Both must be visible end-to-end.

* Concatenated JSON in a single tool_use's accumulated args (e.g.
  ``{"sceneId":1}{"sceneId":2}{"sceneId":3}``): the LLM intended N
  parallel calls but they collapsed into one tool_use's arguments.
  Pin behaviour for this so regressions are detectable.

* Empty tool name: must not surface in dispatched tool_call events,
  otherwise downstream Anthropic Messages API rejects the next round
  with "name: String should have at least 1 character".
"""

import asyncio
import json
import unittest

from langchain_core.messages import AIMessageChunk, ToolMessage

from ag_ui.core import EventType

from tests.test_nested_tool_end_dedup import (
    _ai_chunk,
    _event,
    _make_agent,
    _run_stream,
    _stream_args,
    _stream_end,
    _stream_start,
    _tool_end,
    _filter_tool_events,
)


def _multi_chunk_event(chunks, *, chunk_id="ai-msg-1", node="model"):
    """Build a single OnChatModelStream event whose AIMessageChunk carries
    multiple tool_call_chunks (truly parallel intent in one chat step)."""
    chunk = AIMessageChunk(content="", id=chunk_id)
    chunk.response_metadata = {}
    chunk.tool_call_chunks = [
        {"name": c.get("name", ""), "args": c.get("args", ""), "id": c["id"], "index": i}
        for i, c in enumerate(chunks)
    ]
    return _event("on_chat_model_stream", node=node, data={"chunk": chunk})


class TestSequentialParallelToolCalls(unittest.TestCase):
    """LLM streams A's chunks fully, then B's chunks. Each tool_call must
    receive its OWN Start/Args/End — no cross-contamination of args."""

    def test_two_sequential_parallel_tools_keep_args_separate(self):
        events = [
            # Tool A streams completely.
            _stream_start("search", "tc-A"),
            _stream_args('{"q":"alpha"}', "tc-A"),
            # Tool B starts (still no terminator between them — this is the
            # tricky transition the agent must detect).
            _stream_start("search", "tc-B"),
            _stream_args('{"q":"beta"}', "tc-B"),
            _stream_end(),
            _tool_end("search", "tc-A", content="ra", input_args={"q": "alpha"}),
            _tool_end("search", "tc-B", content="rb", input_args={"q": "beta"}),
        ]
        dispatched = asyncio.run(_run_stream(events))

        a_starts, a_args, a_ends, a_results = _filter_tool_events(dispatched, "tc-A")
        b_starts, b_args, b_ends, b_results = _filter_tool_events(dispatched, "tc-B")

        # Each tool gets exactly one Start/End/Result.
        self.assertEqual(a_starts, 1, f"A Start count: {a_starts}")
        self.assertEqual(b_starts, 1, f"B Start count: {b_starts}")
        self.assertEqual(a_ends, 1, f"A End count: {a_ends}")
        self.assertEqual(b_ends, 1, f"B End count: {b_ends}")
        self.assertEqual(a_results, 1)
        self.assertEqual(b_results, 1)

        # Critical: B's args must not be appended to A's tool_call_id stream.
        a_args_concat = "".join(a_args)
        b_args_concat = "".join(b_args)
        self.assertEqual(
            a_args_concat,
            '{"q":"alpha"}',
            f"A's args got polluted with B's args: {a_args_concat!r}",
        )
        self.assertEqual(
            b_args_concat,
            '{"q":"beta"}',
            f"B's args missing or wrong: {b_args_concat!r}",
        )


class TestTrulyParallelChunksInSingleEvent(unittest.TestCase):
    """A single AIMessageChunk carrying tool_call_chunks for two tools.
    The handler only inspects the first chunk; the second tool surfaces
    from its OnToolEnd. Both tools must be fully visible end-to-end."""

    def test_two_parallel_chunks_in_one_event_both_emit_full_lifecycle(self):
        # Single event with both chunks
        multi_event = _multi_chunk_event([
            {"name": "search", "id": "tc-A", "args": ""},
            {"name": "search", "id": "tc-B", "args": ""},
        ])
        events = [
            multi_event,
            _stream_args('{"q":"alpha"}', "tc-A"),
            _stream_end(),
            # OnToolEnd for both. tc-A streamed, tc-B did not (parallel-not-streamed).
            _tool_end("search", "tc-A", content="ra", input_args={"q": "alpha"}),
            _tool_end("search", "tc-B", content="rb", input_args={"q": "beta"}),
        ]
        dispatched = asyncio.run(_run_stream(events))

        a_starts, _, a_ends, a_results = _filter_tool_events(dispatched, "tc-A")
        b_starts, b_args, b_ends, b_results = _filter_tool_events(dispatched, "tc-B")

        # Both tools fully visible (Start + End + Result each).
        self.assertGreaterEqual(a_starts, 1)
        self.assertGreaterEqual(a_ends, 1)
        self.assertEqual(a_results, 1)
        self.assertGreaterEqual(b_starts, 1, "B must be visible (only OnToolEnd surfaces it)")
        self.assertGreaterEqual(b_ends, 1)
        self.assertEqual(b_results, 1)

        # B's args came only from OnToolEnd input dict.
        b_args_concat = "".join(b_args)
        self.assertIn("beta", b_args_concat)


class TestEmptyToolNameNeverSurfaces(unittest.TestCase):
    """A tool_call with empty name in either streaming or OnToolEnd must
    never produce a downstream ToolCallStartEvent with an empty
    ``tool_call_name`` — that breaks Anthropic Messages API on replay."""

    def test_on_tool_end_substitutes_event_name_when_tool_msg_name_empty(self):
        """OnToolEnd already falls back to ``event.get("name", "")`` when
        tool_msg.name is empty. Pin: when both fall through, Start must
        not carry an empty name."""
        events = [
            # No streaming for this tool — surfaces only via OnToolEnd.
            _event(
                "on_tool_end",
                node="tools",
                name="my_tool",  # event-level name fallback
                data={
                    "output": ToolMessage(
                        content="ok",
                        tool_call_id="tc-empty",
                        # name omitted on the ToolMessage to exercise the
                        # ``tool_msg.name or event.get('name', '')`` fallback.
                    ),
                    "input": {"foo": 1},
                },
            ),
        ]
        dispatched = asyncio.run(_run_stream(events))

        starts = [
            ev for ev in dispatched
            if ev.type == EventType.TOOL_CALL_START and getattr(ev, "tool_call_id", None) == "tc-empty"
        ]
        self.assertEqual(len(starts), 1)
        self.assertNotEqual(
            getattr(starts[0], "tool_call_name", ""),
            "",
            "ToolCallStartEvent must never carry an empty tool_call_name",
        )

    def test_streamed_tool_with_empty_name_does_not_emit_empty_name_start(self):
        """If chat-model-stream sees an empty-name start chunk (rare but
        possible from upstream LLM glitches), the agent must not emit a
        downstream Start with empty name — either suppress or substitute."""
        events = [
            # Empty name + valid id. Currently `is_tool_call_start_event`
            # requires `tool_call_data.get("name")` truthy, so this should
            # NOT trigger a Start at all.
            _event(
                "on_chat_model_stream",
                data={"chunk": _ai_chunk(name="", args="", tool_call_id="tc-empty-name")},
            ),
            # Subsequent OnToolEnd carries the real name.
            _tool_end("real_tool", "tc-empty-name", content="ok", input_args={}),
        ]
        dispatched = asyncio.run(_run_stream(events))

        starts = [
            ev for ev in dispatched
            if ev.type == EventType.TOOL_CALL_START
            and getattr(ev, "tool_call_id", None) == "tc-empty-name"
        ]
        self.assertEqual(len(starts), 1)
        self.assertEqual(starts[0].tool_call_name, "real_tool")


class TestAtomicArgsInFirstChunk(unittest.TestCase):
    """Some providers (e.g. GLM) emit name + complete args in the same first
    chunk instead of streaming arg deltas later. The start handler must emit
    TOOL_CALL_ARGS in that case, otherwise START is followed immediately by
    END and the client never sees the invocation arguments (#2463)."""

    def test_name_and_complete_args_in_first_chunk_emits_tool_call_args(self):
        events = [
            _event(
                "on_chat_model_stream",
                data={"chunk": _ai_chunk(
                    name="get_weather",
                    args='{"location":"Chengdu","date":"tomorrow"}',
                    tool_call_id="tc-glm",
                )},
            ),
            _stream_end(),
            _tool_end(
                "get_weather",
                "tc-glm",
                content="Sunny",
                input_args={"location": "Chengdu", "date": "tomorrow"},
            ),
        ]
        dispatched = asyncio.run(_run_stream(events))

        starts, args_payloads, ends, results = _filter_tool_events(dispatched, "tc-glm")

        self.assertEqual(starts, 1)
        self.assertEqual(ends, 1)
        self.assertEqual(results, 1)
        self.assertEqual(
            "".join(args_payloads),
            '{"location":"Chengdu","date":"tomorrow"}',
            "Complete first-chunk args must surface as TOOL_CALL_ARGS",
        )

    def test_dict_args_in_first_chunk_are_json_serialized(self):
        events = [
            _event(
                "on_chat_model_stream",
                data={"chunk": _ai_chunk(
                    name="get_weather",
                    args={"location": "Chengdu", "date": "tomorrow"},
                    tool_call_id="tc-glm-dict",
                )},
            ),
            _stream_end(),
            _tool_end(
                "get_weather",
                "tc-glm-dict",
                content="Sunny",
                input_args={"location": "Chengdu", "date": "tomorrow"},
            ),
        ]
        dispatched = asyncio.run(_run_stream(events))

        _, args_payloads, _, _ = _filter_tool_events(dispatched, "tc-glm-dict")
        accumulated = "".join(args_payloads)
        self.assertNotEqual(accumulated, "", "Dict args in the start chunk must emit TOOL_CALL_ARGS")
        parsed = json.loads(accumulated)
        self.assertEqual(parsed, {"location": "Chengdu", "date": "tomorrow"})


class TestConcatenatedJsonInSingleToolUseArgs(unittest.TestCase):

    """When the LLM emits a single tool_use whose args field accumulates
    concatenated JSON like ``{"a":1}{"a":2}{"a":3}`` (intent: parallel
    calls collapsed into one), pin the current behaviour. The user-visible
    effect today: only the first object is parsed/executed; rest lost.

    These tests exist so any future split-into-N behaviour change is
    detectable rather than silent."""

    def test_three_concatenated_args_objects_streamed_as_one_tool_call(self):
        events = [
            _stream_start("query_scene", "tc-cat"),
            _stream_args('{"sceneId":1}', "tc-cat"),
            _stream_args('{"sceneId":2}', "tc-cat"),
            _stream_args('{"sceneId":3}', "tc-cat"),
            _stream_end(),
            # Tool execution runs once with whatever input langgraph parsed
            # (typically only the first object).
            _tool_end(
                "query_scene",
                "tc-cat",
                content="ok",
                input_args={"sceneId": 1},
            ),
        ]
        dispatched = asyncio.run(_run_stream(events))

        starts, args_payloads, ends, results = _filter_tool_events(dispatched, "tc-cat")

        # Today: a single tool_call, single Result. The frontend sees the
        # concatenated args delta-by-delta.
        self.assertEqual(starts, 1)
        self.assertEqual(ends, 1)
        self.assertEqual(results, 1)
        accumulated = "".join(args_payloads)
        self.assertEqual(
            accumulated,
            '{"sceneId":1}{"sceneId":2}{"sceneId":3}',
            "All args deltas should be forwarded in order so persisted history matches the LLM's raw output",
        )


if __name__ == "__main__":
    unittest.main()
