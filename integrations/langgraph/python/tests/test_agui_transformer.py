"""Port of the TypeScript ``agui-transformer.test.ts`` suite.

Each case pins an invariant that a real UI depends on:

  * balance -- every ``*_START`` gets its matching ``*_END``, including on the
    abnormal ``message-error`` path and when the run fails mid-block,
  * identity -- streamed message / reasoning ids must equal the ids the
    MESSAGES_SNAPSHOT converter mints, or the snapshot copy replaces the
    streamed one and the UI flickers or loses the reasoning indicator,
  * append-only args -- ``TOOL_CALL_ARGS`` deltas must concatenate to exactly
    the cumulative buffer, never re-sending an already-streamed prefix,
  * terminal ``RUN_ERROR`` -- nothing may follow it,
  * dedup -- snapshots by value, interrupts by id.

The transformer subclasses ``langgraph.stream.StreamTransformer``, which only
exists in langgraph >= 1.2, so the whole module is skipped on older langgraph
(the package's floor is ``langgraph>=0.6.0,<2``). ``test_lazy_import`` runs
either way: on < 1.2 it asserts the actionable ImportError, on >= 1.2 it
asserts the factory builds.
"""

import unittest
from typing import Any, Dict, List

from ag_ui.core import EventType

from ag_ui_langgraph.transformer import MIN_LANGGRAPH_ERROR, agui_transformer
from ag_ui_langgraph.types import CustomEventNames, LangGraphEventTypes

try:  # langgraph >= 1.2 only
    import langgraph.stream as _langgraph_stream

    HAS_STREAM_API = _langgraph_stream is not None
except ImportError:  # pragma: no cover - depends on the installed langgraph
    HAS_STREAM_API = False

requires_stream_api = unittest.skipUnless(
    HAS_STREAM_API,
    "langgraph.stream (v3 streaming API, langgraph >= 1.2) is not installed",
)


class Harness:
    """Drive the transformer and capture everything it pushes.

    ``init()`` returns the very channel the transformer pushes through, so we
    swap its ``push`` for a capturing function -- the same trick the TS suite
    uses. This keeps the test independent of the ``StreamMux`` wiring while
    still exercising the real ``StreamTransformer`` subclass.
    """

    def __init__(self) -> None:
        self.transformer = agui_transformer()
        projection = self.transformer.init()
        self.events: List[Any] = []
        projection["agui"].push = self.events.append

    def process(self, method: str, params: Dict[str, Any]) -> None:
        self.transformer.process({"type": "event", "method": method, "params": params})

    def msg(self, data: Dict[str, Any]) -> None:
        # Python's StreamMessagesHandler delivers `(payload, metadata)`; the TS
        # protocol delivers the frame directly. Tests drive the Python shape.
        self.process("messages", {"namespace": [], "data": (data, {"run_id": "r1"})})

    def only(self, event_type: EventType) -> List[Any]:
        return [e for e in self.events if e.type == event_type]

    def types(self) -> List[str]:
        return [e.type for e in self.events]

    def interrupts(self) -> List[Any]:
        return [
            e
            for e in self.events
            if e.type == EventType.CUSTOM and e.name == LangGraphEventTypes.OnInterrupt.value
        ]


class TestLazyImport(unittest.TestCase):
    def test_importing_the_package_never_needs_langgraph_stream(self):
        """``import ag_ui_langgraph`` must work on the package's langgraph floor.

        The name is exported eagerly; only calling the factory may raise.
        """
        import ag_ui_langgraph

        self.assertIs(ag_ui_langgraph.agui_transformer, agui_transformer)

    def test_factory_behaviour_matches_the_installed_langgraph(self):
        if HAS_STREAM_API:
            self.assertIsNotNone(agui_transformer())
        else:
            with self.assertRaises(ImportError) as ctx:
                agui_transformer()
            self.assertIn("langgraph >= 1.2", str(ctx.exception))
            self.assertEqual(MIN_LANGGRAPH_ERROR, str(ctx.exception))


@requires_stream_api
class TestHarness(unittest.TestCase):
    def test_captures_pushed_events(self):
        h = Harness()
        h.msg({"event": "message-start", "id": "m1"})
        h.msg({"event": "content-block-start", "index": 0, "content": {"type": "text"}})
        h.msg(
            {
                "event": "content-block-delta",
                "index": 0,
                "delta": {"type": "text-delta", "text": "hi"},
            }
        )
        self.assertEqual(1, len(h.only(EventType.TEXT_MESSAGE_START)))
        self.assertEqual(1, len(h.only(EventType.TEXT_MESSAGE_CONTENT)))

    def test_drops_everything_until_init(self):
        """The mux wires the channel only after ``init()`` returns, so a
        transformer that has not been initialized must not translate anything."""
        transformer = agui_transformer()
        captured: List[Any] = []
        # Reach the channel without calling init(), then feed an event.
        transformer._channel.push = captured.append
        transformer.process(
            {
                "type": "event",
                "method": "messages",
                "params": {"namespace": [], "data": {"event": "message-start", "id": "m0"}},
            }
        )
        self.assertEqual([], captured)


@requires_stream_api
class TestMessageErrorClosesOpenBlocks(unittest.TestCase):
    def test_emits_text_message_end_for_an_open_text_block(self):
        h = Harness()
        h.msg({"event": "message-start", "id": "m1"})
        h.msg({"event": "content-block-start", "index": 0, "content": {"type": "text"}})
        h.msg(
            {
                "event": "content-block-delta",
                "index": 0,
                "delta": {"type": "text-delta", "text": "hi"},
            }
        )
        h.msg({"event": "message-error"})
        starts = h.only(EventType.TEXT_MESSAGE_START)
        ends = h.only(EventType.TEXT_MESSAGE_END)
        self.assertEqual(1, len(starts))
        self.assertEqual(1, len(ends))
        self.assertEqual(starts[0].message_id, ends[0].message_id)

    def test_emits_tool_call_end_and_reasoning_end_for_open_blocks(self):
        h = Harness()
        h.msg({"event": "message-start", "id": "m1"})
        h.msg(
            {
                "event": "content-block-start",
                "index": 0,
                "content": {"type": "reasoning", "reasoning": "think"},
            }
        )
        h.msg(
            {
                "event": "content-block-start",
                "index": 1,
                "content": {"type": "tool_call", "id": "tc1", "name": "search", "args": ""},
            }
        )
        h.msg({"event": "message-error"})
        self.assertEqual(1, len(h.only(EventType.TOOL_CALL_END)))
        self.assertEqual(1, len(h.only(EventType.REASONING_END)))
        # The reasoning message opened (initial text), so it must also close.
        self.assertEqual(1, len(h.only(EventType.REASONING_MESSAGE_END)))


@requires_stream_api
class TestDistinctTextBlockIds(unittest.TestCase):
    def test_two_text_blocks_never_share_a_message_id(self):
        h = Harness()
        h.msg({"event": "message-start", "id": "m2"})
        h.msg({"event": "content-block-start", "index": 0, "content": {"type": "text"}})
        h.msg({"event": "content-block-start", "index": 1, "content": {"type": "text"}})
        starts = h.only(EventType.TEXT_MESSAGE_START)
        self.assertEqual(2, len(starts))
        self.assertEqual(2, len({s.message_id for s in starts}))

    def test_end_ids_match_their_start_ids_per_block(self):
        h = Harness()
        h.msg({"event": "message-start", "id": "m2"})
        h.msg({"event": "content-block-start", "index": 0, "content": {"type": "text"}})
        h.msg({"event": "content-block-start", "index": 1, "content": {"type": "text"}})
        h.msg({"event": "content-block-finish", "index": 0, "content": {"type": "text"}})
        h.msg({"event": "content-block-finish", "index": 1, "content": {"type": "text"}})
        starts = {e.message_id for e in h.only(EventType.TEXT_MESSAGE_START)}
        ends = [e.message_id for e in h.only(EventType.TEXT_MESSAGE_END)]
        self.assertEqual(starts, set(ends))
        self.assertEqual(2, len(ends))

    def test_a_sole_text_block_keeps_the_bare_message_id(self):
        """Required so the streamed message reconciles with the
        MESSAGES_SNAPSHOT copy emitted under the same id."""
        h = Harness()
        h.msg({"event": "message-start", "id": "sole"})
        h.msg({"event": "content-block-start", "index": 0, "content": {"type": "text"}})
        self.assertEqual("sole", h.only(EventType.TEXT_MESSAGE_START)[0].message_id)

    def test_text_delta_at_an_unopened_index_implicitly_opens_the_block(self):
        h = Harness()
        h.msg({"event": "message-start", "id": "imp"})
        h.msg(
            {
                "event": "content-block-delta",
                "index": 3,
                "delta": {"type": "text-delta", "text": "x"},
            }
        )
        starts = h.only(EventType.TEXT_MESSAGE_START)
        self.assertEqual(1, len(starts))
        self.assertEqual("imp", starts[0].message_id)


@requires_stream_api
class TestMessageFinishClosesNonTextBlocks(unittest.TestCase):
    def test_emits_tool_call_end_without_a_content_block_finish(self):
        h = Harness()
        h.msg({"event": "message-start", "id": "m3"})
        h.msg(
            {
                "event": "content-block-start",
                "index": 0,
                "content": {"type": "tool_call", "id": "tc1", "name": "foo", "args": ""},
            }
        )
        h.msg({"event": "message-finish"})
        self.assertEqual(1, len(h.only(EventType.TOOL_CALL_END)))

    def test_emits_reasoning_end_without_a_content_block_finish(self):
        h = Harness()
        h.msg({"event": "message-start", "id": "m3"})
        h.msg(
            {
                "event": "content-block-start",
                "index": 0,
                "content": {"type": "reasoning", "reasoning": "x"},
            }
        )
        h.msg({"event": "message-finish"})
        self.assertEqual(1, len(h.only(EventType.REASONING_END)))

    def test_falls_back_to_the_snapshot_converters_id_formula(self):
        """Must match ``_reasoning_block_to_agui_message`` (utils.py) so the
        snapshot copy reconciles with the streamed one instead of replacing it."""
        h = Harness()
        h.msg({"event": "message-start", "id": "m9t"})
        h.msg(
            {
                "event": "content-block-start",
                "index": 0,
                "content": {"type": "reasoning", "reasoning": "no id"},
            }
        )
        h.msg({"event": "message-finish"})
        self.assertEqual("m9t-reasoning-0", h.only(EventType.REASONING_START)[0].message_id)

    def test_fallback_id_includes_the_block_index(self):
        h = Harness()
        h.msg({"event": "message-start", "id": "m9i"})
        h.msg(
            {
                "event": "content-block-start",
                "index": 2,
                "content": {"type": "reasoning", "reasoning": "second"},
            }
        )
        self.assertEqual("m9i-reasoning-2", h.only(EventType.REASONING_START)[0].message_id)

    def test_uses_the_providers_canonical_reasoning_id(self):
        """The MESSAGES_SNAPSHOT reasoning copy is emitted under the block's
        canonical id (e.g. OpenAI ``rs_...``); a synthetic streamed id would be
        dropped by the snapshot's replace semantics, wiping the indicator."""
        h = Harness()
        h.msg({"event": "message-start", "id": "m3rs"})
        h.msg(
            {
                "event": "content-block-start",
                "index": 0,
                "content": {"type": "reasoning", "id": "rs_xyz", "reasoning": "x"},
            }
        )
        h.msg({"event": "message-finish"})
        self.assertEqual("rs_xyz", h.only(EventType.REASONING_START)[0].message_id)
        self.assertEqual("rs_xyz", h.only(EventType.REASONING_END)[0].message_id)

    def test_id_only_reasoning_block_opens_and_closes_without_a_message(self):
        """``store=True`` yields an empty summary but a real id. The snapshot
        converter still emits a ReasoningMessage for it, so the streamed side
        must open the same entity -- with no REASONING_MESSAGE_* pair, since
        there is no text to render."""
        h = Harness()
        h.msg({"event": "message-start", "id": "m3only"})
        h.msg(
            {
                "event": "content-block-start",
                "index": 0,
                "content": {"type": "reasoning", "id": "rs_only"},
            }
        )
        h.msg({"event": "message-finish"})
        self.assertEqual(["rs_only"], [e.message_id for e in h.only(EventType.REASONING_START)])
        self.assertEqual(["rs_only"], [e.message_id for e in h.only(EventType.REASONING_END)])
        self.assertEqual([], h.only(EventType.REASONING_MESSAGE_START))
        self.assertEqual([], h.only(EventType.REASONING_MESSAGE_END))

    def test_forwards_encrypted_content_on_a_reasoning_block(self):
        """``store=False`` puts the round-trip handle in ``encrypted_content``,
        which the snapshot converter also preserves."""
        h = Harness()
        h.msg({"event": "message-start", "id": "m3enc"})
        h.msg(
            {
                "event": "content-block-start",
                "index": 0,
                "content": {
                    "type": "reasoning",
                    "id": "rs_enc",
                    "reasoning": "x",
                    "encrypted_content": "ENC",
                },
            }
        )
        encrypted = h.only(EventType.REASONING_ENCRYPTED_VALUE)
        self.assertEqual(1, len(encrypted))
        self.assertEqual("rs_enc", encrypted[0].entity_id)
        self.assertEqual("ENC", encrypted[0].encrypted_value)

    def test_does_not_leak_a_tool_block_into_the_next_message(self):
        h = Harness()
        # First message opens a tool at index 0 but never gets a block-finish.
        h.msg({"event": "message-start", "id": "m3a"})
        h.msg(
            {
                "event": "content-block-start",
                "index": 0,
                "content": {"type": "tool_call", "id": "tcA", "name": "foo", "args": ""},
            }
        )
        h.msg({"event": "message-finish"})
        # Second message opens a different tool at the same index.
        h.msg({"event": "message-start", "id": "m3b"})
        h.msg(
            {
                "event": "content-block-start",
                "index": 0,
                "content": {"type": "tool_call", "id": "tcB", "name": "bar", "args": ""},
            }
        )
        h.msg({"event": "content-block-finish", "index": 0, "content": {"type": "tool_call"}})
        ends = [e.tool_call_id for e in h.only(EventType.TOOL_CALL_END)]
        self.assertIn("tcA", ends)
        self.assertIn("tcB", ends)


@requires_stream_api
class TestDeferredToolName(unittest.TestCase):
    def test_defers_tool_call_start_until_the_name_is_available(self):
        h = Harness()
        h.msg({"event": "message-start", "id": "m4"})
        h.msg(
            {
                "event": "content-block-start",
                "index": 0,
                "content": {"type": "tool_call_chunk", "id": "tc1", "name": "", "args": ""},
            }
        )
        self.assertEqual(0, len(h.only(EventType.TOOL_CALL_START)))
        h.msg(
            {
                "event": "content-block-delta",
                "index": 0,
                "delta": {"type": "block-delta", "fields": {"name": "search"}},
            }
        )
        starts = h.only(EventType.TOOL_CALL_START)
        self.assertEqual(1, len(starts))
        self.assertEqual("search", starts[0].tool_call_name)

    def test_emits_start_immediately_when_the_name_is_present_up_front(self):
        h = Harness()
        h.msg({"event": "message-start", "id": "m4"})
        h.msg(
            {
                "event": "content-block-start",
                "index": 0,
                "content": {"type": "tool_call", "id": "tc1", "name": "known", "args": ""},
            }
        )
        starts = h.only(EventType.TOOL_CALL_START)
        self.assertEqual(1, len(starts))
        self.assertEqual("known", starts[0].tool_call_name)

    def test_flushes_buffered_args_once_the_name_arrives(self):
        h = Harness()
        h.msg({"event": "message-start", "id": "m4"})
        h.msg(
            {
                "event": "content-block-start",
                "index": 0,
                "content": {"type": "tool_call_chunk", "id": "tc1", "name": "", "args": '{"q"'},
            }
        )
        h.msg(
            {
                "event": "content-block-delta",
                "index": 0,
                "delta": {"type": "block-delta", "fields": {"name": "search", "args": '{"q":"x"}'}},
            }
        )
        self.assertEqual(1, len(h.only(EventType.TOOL_CALL_START)))
        deltas = [e.delta for e in h.only(EventType.TOOL_CALL_ARGS)]
        # Concatenation must reconstruct the full args exactly once.
        self.assertEqual('{"q":"x"}', "".join(deltas))

    def test_a_tool_whose_name_never_arrives_still_gets_a_balanced_pair(self):
        h = Harness()
        h.msg({"event": "message-start", "id": "m4n"})
        h.msg(
            {
                "event": "content-block-start",
                "index": 0,
                "content": {"type": "tool_call_chunk", "id": "tcN", "name": "", "args": "{}"},
            }
        )
        h.msg({"event": "message-finish"})
        starts = h.only(EventType.TOOL_CALL_START)
        ends = h.only(EventType.TOOL_CALL_END)
        self.assertEqual(1, len(starts))
        self.assertEqual(1, len(ends))
        # The buffered args flush ahead of the END.
        self.assertEqual(["{}"], [e.delta for e in h.only(EventType.TOOL_CALL_ARGS)])
        self.assertLess(h.types().index(EventType.TOOL_CALL_START), h.types().index(EventType.TOOL_CALL_END))


@requires_stream_api
class TestToolArgsBufferDiff(unittest.TestCase):
    def _open_tool(self, h: Harness) -> None:
        h.msg({"event": "message-start", "id": "m5"})
        h.msg(
            {
                "event": "content-block-start",
                "index": 0,
                "content": {"type": "tool_call", "id": "tc1", "name": "t", "args": ""},
            }
        )

    def _args(self, h: Harness, value: str) -> None:
        h.msg(
            {
                "event": "content-block-delta",
                "index": 0,
                "delta": {"type": "block-delta", "fields": {"args": value}},
            }
        )

    def test_normal_append_emits_only_the_appended_tail(self):
        h = Harness()
        self._open_tool(h)
        self._args(h, '{"a"')
        self._args(h, '{"a":1}')
        deltas = [e.delta for e in h.only(EventType.TOOL_CALL_ARGS)]
        self.assertEqual('{"a":1}', "".join(deltas))
        self.assertEqual(['{"a"', ":1}"], deltas)

    def test_replace_does_not_double_the_common_prefix(self):
        h = Harness()
        self._open_tool(h)
        self._args(h, '{"a":1}')
        # Buffer replaced: last chars corrected 1} -> 12}. Common prefix {"a":1.
        self._args(h, '{"a":12}')
        deltas = [e.delta for e in h.only(EventType.TOOL_CALL_ARGS)]
        # The replace frame must NOT re-send the full new buffer.
        self.assertNotIn('{"a":12}', deltas)
        self.assertEqual("2}", deltas[-1])

    def test_an_unchanged_cumulative_value_emits_nothing(self):
        h = Harness()
        self._open_tool(h)
        self._args(h, '{"a":1}')
        before = len(h.only(EventType.TOOL_CALL_ARGS))
        self._args(h, '{"a":1}')
        self.assertEqual(before, len(h.only(EventType.TOOL_CALL_ARGS)))


@requires_stream_api
class TestToolResults(unittest.TestCase):
    def test_unwraps_the_toolnode_envelope(self):
        """``tool-finished.output`` is the ToolNode envelope
        ``{status, content}``; the client must see the INNER content, never the
        stringified envelope."""
        h = Harness()
        h.process(
            "tools",
            {
                "namespace": [],
                "data": {
                    "event": "tool-finished",
                    "tool_call_id": "tc1",
                    "output": {"status": "success", "content": "42"},
                },
            },
        )
        results = h.only(EventType.TOOL_CALL_RESULT)
        self.assertEqual(1, len(results))
        self.assertEqual("42", results[0].content)
        self.assertEqual("tc1", results[0].tool_call_id)
        self.assertEqual("tool", results[0].role)

    def test_flattens_list_content_blocks(self):
        h = Harness()
        h.process(
            "tools",
            {
                "namespace": [],
                "data": {
                    "event": "tool-finished",
                    "tool_call_id": "tc2",
                    "output": {
                        "status": "success",
                        "content": [
                            {"type": "text", "text": "sunny"},
                            {"type": "text", "text": " today"},
                        ],
                    },
                },
            },
        )
        self.assertEqual("sunny today", h.only(EventType.TOOL_CALL_RESULT)[0].content)

    def test_ignores_non_terminal_tool_events(self):
        h = Harness()
        for event in ("tool-started", "tool-output-delta", "tool-error"):
            h.process(
                "tools",
                {"namespace": [], "data": {"event": event, "tool_call_id": "tc3"}},
            )
        self.assertEqual([], h.only(EventType.TOOL_CALL_RESULT))


@requires_stream_api
class TestInterrupts(unittest.TestCase):
    def test_tasks_interrupt_with_no_value_emits_the_string_null(self):
        h = Harness()
        h.process("tasks", {"namespace": [], "data": {"id": "task1", "interrupts": [{"id": "i1"}]}})
        interrupts = h.interrupts()
        self.assertEqual(1, len(interrupts))
        self.assertIsInstance(interrupts[0].value, str)
        self.assertEqual("null", interrupts[0].value)

    def test_input_requested_with_no_payload_emits_the_string_null(self):
        h = Harness()
        h.process("input.requested", {"namespace": [], "data": {"interrupt_id": "i2"}})
        interrupts = h.interrupts()
        self.assertEqual(1, len(interrupts))
        self.assertEqual("null", interrupts[0].value)

    def test_tasks_dedup_by_interrupt_id(self):
        h = Harness()
        frame = {"namespace": [], "data": {"id": "t", "interrupts": [{"id": "dup", "value": {"q": 1}}]}}
        h.process("tasks", frame)
        h.process("tasks", frame)
        self.assertEqual(1, len(h.interrupts()))

    def test_input_requested_dedup_by_id(self):
        h = Harness()
        frame = {"namespace": [], "data": {"interrupt_id": "dup1", "payload": "hi"}}
        h.process("input.requested", frame)
        h.process("input.requested", frame)
        interrupts = h.interrupts()
        self.assertEqual(1, len(interrupts))
        self.assertEqual("hi", interrupts[0].value)

    def test_tasks_and_input_requested_share_the_dedup_set(self):
        """The same interrupt can arrive on both channels; only one prompt."""
        h = Harness()
        h.process("tasks", {"namespace": [], "data": {"interrupts": [{"id": "shared"}]}})
        h.process("input.requested", {"namespace": [], "data": {"interrupt_id": "shared"}})
        self.assertEqual(1, len(h.interrupts()))


@requires_stream_api
class TestSteps(unittest.TestCase):
    def test_strips_the_uuid_from_the_namespace_head(self):
        h = Harness()
        h.process("lifecycle", {"namespace": ["node:abc-123"], "data": {"event": "started"}})
        h.process("lifecycle", {"namespace": ["node:abc-123"], "data": {"event": "completed"}})
        self.assertEqual(["node"], [e.step_name for e in h.only(EventType.STEP_STARTED)])
        self.assertEqual(["node"], [e.step_name for e in h.only(EventType.STEP_FINISHED)])

    def test_an_inner_node_colliding_on_name_is_ignored(self):
        """Both ends of a colliding inner step would unbalance the outer pair."""
        h = Harness()
        h.process("lifecycle", {"namespace": ["agent:1"], "data": {"event": "started"}})
        h.process("lifecycle", {"namespace": ["agent:1", "inner:2"], "data": {"event": "started"}})
        h.process("lifecycle", {"namespace": ["agent:1", "inner:2"], "data": {"event": "completed"}})
        h.process("lifecycle", {"namespace": ["agent:1"], "data": {"event": "completed"}})
        self.assertEqual(1, len(h.only(EventType.STEP_STARTED)))
        self.assertEqual(1, len(h.only(EventType.STEP_FINISHED)))

    def test_finalize_closes_a_step_left_open(self):
        h = Harness()
        h.process("lifecycle", {"namespace": ["node:1"], "data": {"event": "started"}})
        h.transformer.finalize()
        self.assertEqual(1, len(h.only(EventType.STEP_FINISHED)))


@requires_stream_api
class TestRootFailed(unittest.TestCase):
    def test_closes_blocks_and_steps_before_a_terminal_run_error(self):
        h = Harness()
        # Open a step, then a message with an open text block.
        h.process("lifecycle", {"namespace": ["node:uuid"], "data": {"event": "started"}})
        h.msg({"event": "message-start", "id": "m1"})
        h.msg({"event": "content-block-start", "index": 0, "content": {"type": "text"}})
        h.msg(
            {
                "event": "content-block-delta",
                "index": 0,
                "delta": {"type": "text-delta", "text": "hi"},
            }
        )
        # Root failure.
        h.process("lifecycle", {"namespace": [], "data": {"event": "failed", "error": "boom"}})
        # finalize() runs at run end; it must not append anything.
        h.transformer.finalize()

        types = h.types()
        err_idx = types.index(EventType.RUN_ERROR)
        self.assertEqual("boom", h.events[err_idx].message)
        # RUN_ERROR is the terminal event: nothing may follow it.
        self.assertEqual(len(h.events) - 1, err_idx)
        self.assertLess(types.index(EventType.TEXT_MESSAGE_END), err_idx)
        self.assertLess(types.index(EventType.STEP_FINISHED), err_idx)
        self.assertEqual(1, len(h.only(EventType.RUN_ERROR)))

    def test_nothing_is_pushed_after_run_error(self):
        h = Harness()
        h.process("lifecycle", {"namespace": [], "data": {"event": "failed", "error": "boom"}})
        count = len(h.events)
        # Every family must be suppressed once the latch is set.
        h.msg({"event": "message-start", "id": "late"})
        h.msg({"event": "content-block-start", "index": 0, "content": {"type": "text"}})
        h.process("values", {"namespace": [], "data": {"foo": "bar"}})
        h.process("lifecycle", {"namespace": [], "data": {"event": "completed"}})
        h.process("tasks", {"namespace": [], "data": {"interrupts": [{"id": "late"}]}})
        h.process("custom", {"namespace": [], "data": {"name": "anything", "payload": {}}})
        h.transformer.finalize()
        h.transformer.fail(RuntimeError("later"))
        self.assertEqual(count, len(h.events))

    def test_a_missing_error_message_falls_back(self):
        h = Harness()
        h.process("lifecycle", {"namespace": [], "data": {"event": "failed"}})
        self.assertEqual("Unknown error", h.only(EventType.RUN_ERROR)[0].message)

    def test_fail_closes_open_blocks_without_a_second_terminal_event(self):
        """A raw exception (no root ``failed`` frame) must still leave a
        balanced stream, but the agent owns the terminal error event."""
        h = Harness()
        h.msg({"event": "message-start", "id": "mf"})
        h.msg({"event": "content-block-start", "index": 0, "content": {"type": "text"}})
        h.transformer.fail(RuntimeError("kaboom"))
        self.assertEqual(1, len(h.only(EventType.TEXT_MESSAGE_END)))
        self.assertEqual([], h.only(EventType.RUN_ERROR))


@requires_stream_api
class TestManuallyEmit(unittest.TestCase):
    def _custom(self, h: Harness, name: str, payload: Any) -> None:
        h.process("custom", {"namespace": [], "data": {"name": name, "payload": payload}})

    def test_manually_emit_message_translates_to_a_text_message_triple(self):
        h = Harness()
        self._custom(
            h,
            CustomEventNames.ManuallyEmitMessage.value,
            {"message_id": "mm1", "message": "hello"},
        )
        self.assertEqual(
            [
                EventType.TEXT_MESSAGE_START,
                EventType.TEXT_MESSAGE_CONTENT,
                EventType.TEXT_MESSAGE_END,
            ],
            h.types(),
        )
        self.assertEqual("mm1", h.only(EventType.TEXT_MESSAGE_START)[0].message_id)
        self.assertEqual("hello", h.only(EventType.TEXT_MESSAGE_CONTENT)[0].delta)
        # No generic CUSTOM passthrough for this name (matches v2 / the TS port).
        self.assertEqual([], h.only(EventType.CUSTOM))

    def test_manually_emit_tool_call_translates_to_a_tool_call_triple(self):
        h = Harness()
        self._custom(
            h,
            CustomEventNames.ManuallyEmitToolCall.value,
            {"id": "mt1", "name": "do_thing", "args": '{"a":1}'},
        )
        starts = h.only(EventType.TOOL_CALL_START)
        self.assertEqual(1, len(starts))
        self.assertEqual("do_thing", starts[0].tool_call_name)
        # v2 (agent.py) uses the tool call id as the parent message id.
        self.assertEqual("mt1", starts[0].parent_message_id)
        self.assertEqual('{"a":1}', h.only(EventType.TOOL_CALL_ARGS)[0].delta)
        self.assertEqual(1, len(h.only(EventType.TOOL_CALL_END)))

    def test_manually_emit_tool_call_json_encodes_dict_args(self):
        h = Harness()
        self._custom(
            h,
            CustomEventNames.ManuallyEmitToolCall.value,
            {"id": "mt2", "name": "do_thing", "args": {"a": 1}},
        )
        self.assertEqual('{"a": 1}', h.only(EventType.TOOL_CALL_ARGS)[0].delta)

    def test_manually_emit_state_emits_a_snapshot_and_the_passthrough(self):
        h = Harness()
        self._custom(h, CustomEventNames.ManuallyEmitState.value, {"foo": "bar"})
        snapshots = h.only(EventType.STATE_SNAPSHOT)
        self.assertEqual(1, len(snapshots))
        self.assertEqual({"foo": "bar"}, snapshots[0].snapshot)
        # ManuallyEmitState alone falls through to the generic CUSTOM
        # passthrough so application listeners still see it.
        self.assertEqual(1, len(h.only(EventType.CUSTOM)))

    def test_an_unknown_custom_name_is_passed_through_verbatim(self):
        h = Harness()
        self._custom(h, "app_notification", {"level": "info"})
        customs = h.only(EventType.CUSTOM)
        self.assertEqual(1, len(customs))
        self.assertEqual("app_notification", customs[0].name)
        self.assertEqual({"level": "info"}, customs[0].value)


@requires_stream_api
class TestSnapshotDedup(unittest.TestCase):
    def test_manual_state_matching_the_auto_snapshot_emits_once(self):
        h = Harness()
        h.process(
            "custom",
            {
                "namespace": [],
                "data": {"name": CustomEventNames.ManuallyEmitState.value, "payload": {"foo": "bar"}},
            },
        )
        # Root completion flushes snapshots from cached state. The cached state
        # equals the manually emitted value, so no new snapshot.
        h.process("lifecycle", {"namespace": [], "data": {"event": "completed"}})
        self.assertEqual(1, len(h.only(EventType.STATE_SNAPSHOT)))

    def test_state_changing_after_the_manual_emit_still_emits_a_second(self):
        h = Harness()
        h.process(
            "custom",
            {
                "namespace": [],
                "data": {"name": CustomEventNames.ManuallyEmitState.value, "payload": {"foo": "bar"}},
            },
        )
        # Dedup is by value, not blanket suppression.
        h.process("values", {"namespace": [], "data": {"foo": "baz"}})
        h.process("lifecycle", {"namespace": [], "data": {"event": "completed"}})
        self.assertEqual(2, len(h.only(EventType.STATE_SNAPSHOT)))

    def test_repeated_identical_flushes_emit_one_snapshot_pair(self):
        h = Harness()
        h.process("values", {"namespace": [], "data": {"foo": "bar", "messages": []}})
        h.process("lifecycle", {"namespace": [], "data": {"event": "completed"}})
        h.process("lifecycle", {"namespace": [], "data": {"event": "completed"}})
        self.assertEqual(1, len(h.only(EventType.STATE_SNAPSHOT)))

    def test_state_snapshot_excludes_messages(self):
        h = Harness()
        h.process("values", {"namespace": [], "data": {"foo": "bar", "messages": []}})
        h.process("lifecycle", {"namespace": [], "data": {"event": "completed"}})
        self.assertEqual({"foo": "bar"}, h.only(EventType.STATE_SNAPSHOT)[0].snapshot)

    def test_non_root_values_events_are_ignored(self):
        h = Harness()
        h.process("values", {"namespace": ["sub:1"], "data": {"foo": "sub"}})
        h.process("lifecycle", {"namespace": [], "data": {"event": "completed"}})
        self.assertEqual([], h.only(EventType.STATE_SNAPSHOT))

    def test_partial_values_events_merge_instead_of_replacing(self):
        """A later root ``values`` frame may carry only the changed keys;
        replacing wholesale would ship an empty MESSAGES_SNAPSHOT."""
        h = Harness()
        h.process("values", {"namespace": [], "data": {"foo": "bar", "keep": 1}})
        h.process("values", {"namespace": [], "data": {"foo": "baz"}})
        h.process("lifecycle", {"namespace": [], "data": {"event": "completed"}})
        self.assertEqual({"foo": "baz", "keep": 1}, h.only(EventType.STATE_SNAPSHOT)[-1].snapshot)


@requires_stream_api
class TestReasoningFromAdditionalKwargs(unittest.TestCase):
    @staticmethod
    def _ai_message(reasoning: Any) -> Any:
        from langchain_core.messages import AIMessage

        return AIMessage(
            id="ai-1",
            content="Here are my recommendations.",
            additional_kwargs={"reasoning": reasoning},
        )

    def test_emits_a_reasoning_sequence_from_the_summary(self):
        h = Harness()
        h.process(
            "values",
            {
                "namespace": [],
                "data": {
                    "messages": [
                        self._ai_message(
                            {
                                "id": "rs_1",
                                "type": "reasoning",
                                "summary": [
                                    {"type": "summary_text", "text": "I weighed reliability."}
                                ],
                            }
                        )
                    ]
                },
            },
        )
        h.process("lifecycle", {"namespace": [], "data": {"event": "completed"}})
        self.assertEqual(1, len(h.only(EventType.REASONING_START)))
        self.assertEqual(1, len(h.only(EventType.REASONING_END)))
        self.assertEqual(
            "I weighed reliability.",
            h.only(EventType.REASONING_MESSAGE_CONTENT)[0].delta,
        )

    def test_does_not_emit_when_the_summary_is_empty(self):
        h = Harness()
        h.process(
            "values",
            {
                "namespace": [],
                "data": {"messages": [self._ai_message({"id": "rs_2", "summary": []})]},
            },
        )
        h.process("lifecycle", {"namespace": [], "data": {"event": "completed"}})
        self.assertEqual([], h.only(EventType.REASONING_START))

    def test_does_not_re_emit_the_same_reasoning_id(self):
        h = Harness()
        message = self._ai_message(
            {"id": "rs_3", "summary": [{"type": "summary_text", "text": "thinking"}]}
        )
        h.process("values", {"namespace": [], "data": {"messages": [message]}})
        h.process("lifecycle", {"namespace": [], "data": {"event": "completed"}})
        # A second flush of the same state must not duplicate the reasoning.
        h.process("values", {"namespace": [], "data": {"messages": [message], "tick": 1}})
        h.process("lifecycle", {"namespace": [], "data": {"event": "completed"}})
        self.assertEqual(1, len(h.only(EventType.REASONING_START)))

    def test_streamed_reasoning_suppresses_the_additional_kwargs_copy(self):
        """When reasoning already streamed, surfacing it again from
        additional_kwargs would render the same summary twice."""
        h = Harness()
        h.msg({"event": "message-start", "id": "ai-1"})
        h.msg(
            {
                "event": "content-block-start",
                "index": 0,
                "content": {"type": "reasoning", "id": "rs_stream", "reasoning": "streamed"},
            }
        )
        h.msg({"event": "message-finish"})
        h.process(
            "values",
            {
                "namespace": [],
                "data": {
                    "messages": [
                        self._ai_message(
                            {"id": "rs_kw", "summary": [{"type": "summary_text", "text": "kw"}]}
                        )
                    ]
                },
            },
        )
        h.process("lifecycle", {"namespace": [], "data": {"event": "completed"}})
        starts = [e.message_id for e in h.only(EventType.REASONING_START)]
        self.assertEqual(["rs_stream"], starts)


@requires_stream_api
class TestPythonProtocolDifferences(unittest.TestCase):
    """Cases covering where the Python v3 API diverges from the TS one.

    These have no TS counterpart -- they exist because Python delivers the same
    information in a different envelope, and getting the envelope wrong makes the
    transformer silently emit nothing.
    """

    def test_accepts_a_bare_message_frame_as_well_as_the_tuple(self):
        """TS delivers `params.data` as the frame; Python as
        ``(payload, metadata)``. Both must work."""
        h = Harness()
        h.process("messages", {"namespace": [], "data": {"event": "message-start", "id": "bare"}})
        h.process(
            "messages",
            {"namespace": [], "data": {"event": "content-block-start", "index": 0, "content": {"type": "text"}}},
        )
        self.assertEqual("bare", h.only(EventType.TEXT_MESSAGE_START)[0].message_id)

    def test_ignores_a_legacy_ai_message_chunk_payload(self):
        """The v1 ``on_llm_new_token`` path puts an ``AIMessageChunk`` where the
        v3 frame would be. It must be skipped, not crash -- the finalized message
        still reaches the client via MESSAGES_SNAPSHOT."""
        from langchain_core.messages import AIMessageChunk

        h = Harness()
        h.process("messages", {"namespace": [], "data": (AIMessageChunk(content="hi"), {})})
        self.assertEqual([], h.events)

    def test_the_wire_spelling_of_message_error_also_closes_blocks(self):
        """``langchain_protocol.MessageErrorData`` spells it ``"error"``; the TS
        port matches ``"message-error"``. Both must close open blocks."""
        h = Harness()
        h.msg({"event": "message-start", "id": "me"})
        h.msg({"event": "content-block-start", "index": 0, "content": {"type": "text"}})
        h.msg({"event": "error", "message": "upstream exploded"})
        self.assertEqual(1, len(h.only(EventType.TEXT_MESSAGE_END)))

    def test_steps_are_derived_from_the_raw_tasks_stream(self):
        """Python transformers never see `lifecycle` frames (the mux forwards
        channel pushes without re-entering the pipeline), so step bracketing
        comes from `tasks`: a payload without ``result`` starts a task, one with
        ``result`` ends it."""
        h = Harness()
        h.process("tasks", {"namespace": [], "data": {"id": "t1", "name": "node_a", "input": {}}})
        self.assertEqual(["node_a"], [e.step_name for e in h.only(EventType.STEP_STARTED)])
        h.process(
            "tasks",
            {"namespace": [], "data": {"id": "t1", "name": "node_a", "result": {}, "interrupts": []}},
        )
        self.assertEqual(["node_a"], [e.step_name for e in h.only(EventType.STEP_FINISHED)])

    def test_a_task_result_does_not_flush_snapshots(self):
        """Flushing per node ships the in-between dip (here: a still-empty
        ``messages`` list, which CopilotKit reads as "no messages")."""
        h = Harness()
        h.process("values", {"namespace": [], "data": {"messages": []}})
        h.process("tasks", {"namespace": [], "data": {"id": "t1", "name": "n", "input": {}}})
        h.process("tasks", {"namespace": [], "data": {"id": "t1", "name": "n", "result": {}}})
        self.assertEqual([], h.only(EventType.MESSAGES_SNAPSHOT))

    def test_finalize_flushes_the_run_terminal_snapshot(self):
        h = Harness()
        h.process("values", {"namespace": [], "data": {"foo": "bar", "messages": []}})
        h.transformer.finalize()
        self.assertEqual(1, len(h.only(EventType.STATE_SNAPSHOT)))
        self.assertEqual({"foo": "bar"}, h.only(EventType.STATE_SNAPSHOT)[0].snapshot)

    def test_a_colliding_task_name_does_not_unbalance_the_outer_step(self):
        h = Harness()
        h.process("tasks", {"namespace": [], "data": {"id": "outer", "name": "agent", "input": {}}})
        h.process("tasks", {"namespace": ["agent:outer"], "data": {"id": "inner", "name": "agent", "input": {}}})
        h.process("tasks", {"namespace": ["agent:outer"], "data": {"id": "inner", "name": "agent", "result": {}}})
        h.process("tasks", {"namespace": [], "data": {"id": "outer", "name": "agent", "result": {}}})
        self.assertEqual(1, len(h.only(EventType.STEP_STARTED)))
        self.assertEqual(1, len(h.only(EventType.STEP_FINISHED)))

    def test_unwraps_a_toolmessage_shaped_tool_output(self):
        """ToolNode's ``tool-finished.output`` is a ``ToolMessage`` on the
        prebuilt path and a ``{status, content}`` dict on others."""
        from langchain_core.messages import ToolMessage

        h = Harness()
        h.process(
            "tools",
            {
                "namespace": [],
                "data": {
                    "event": "tool-finished",
                    "tool_call_id": "call-1",
                    "output": ToolMessage(id="tm-1", content="3", tool_call_id="call-1"),
                },
            },
        )
        result = h.only(EventType.TOOL_CALL_RESULT)[0]
        self.assertEqual("3", result.content)
        # ToolMessage.id wins over tool_call_id so the snapshot merge reconciles.
        self.assertEqual("tm-1", result.message_id)
        self.assertEqual("call-1", result.tool_call_id)

    def test_falls_back_to_the_tool_call_id_when_the_output_has_no_id(self):
        h = Harness()
        h.process(
            "tools",
            {
                "namespace": [],
                "data": {
                    "event": "tool-finished",
                    "tool_call_id": "call-2",
                    "output": {"status": "success", "content": "ok"},
                },
            },
        )
        self.assertEqual("call-2", h.only(EventType.TOOL_CALL_RESULT)[0].message_id)

    def test_reads_interrupts_from_the_params_envelope(self):
        """`_ProtocolEventParams` carries an ``interrupts`` tuple alongside
        ``data`` on some paths."""
        h = Harness()
        h.process(
            "tasks",
            {"namespace": [], "data": {"id": "t", "name": "n", "result": {}}, "interrupts": [{"id": "pi"}]},
        )
        self.assertEqual(1, len(h.interrupts()))

    def test_required_stream_modes_cover_every_translated_channel(self):
        """`stream_events(version="v3")` asks the graph for exactly the union of
        the registered transformers' declared modes -- a missing mode means that
        channel's events are never produced at all."""
        self.assertEqual(
            {"values", "messages", "custom", "tasks", "tools"},
            set(agui_transformer().required_stream_modes),
        )


if __name__ == "__main__":
    unittest.main()
