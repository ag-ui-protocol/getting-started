"""Concurrent subagent streaming must not cross-contaminate.

deepagents runs `task` subagents concurrently, and LangGraph's
``astream_events`` merges their chunks into one stream. Each subagent is a
distinct checkpoint-namespace boundary, so it has a distinct derived
``subagent_id``. Transient stream state (in-flight message/tool call,
reasoning, and the text-message pin) is keyed per-subagent "lane" so
interleaved chunks from two subagents stay in their own message/tool/reasoning
and carry their own attribution.

Before the lane fix, all of this state was a per-run singleton: subagent B's
delta arriving mid-stream would append to subagent A's open message (and be
tagged B), reasoning would be overwritten, etc. These tests pin the post-fix
isolation. They drive ``_handle_single_event`` directly with the REAL
``_dispatch_event`` (so ``subagent_id`` stamping happens) and set
``current_subagent_id`` per event to mimic ``reconcile_subagents``.
"""

import asyncio
import unittest
from unittest.mock import MagicMock

from ag_ui.core import EventType
from ag_ui_langgraph.agent import LangGraphAgent
from ag_ui_langgraph.types import LangGraphEventTypes


def _fresh_active_run(run_id: str = "run-1") -> dict:
    """Mirror the lane-aware INITIAL_ACTIVE_RUN shape."""
    return {
        "id": run_id,
        "thread_id": "t1",
        "mode": "start",
        "reasoning_processes": {},
        "pending_reasoning_ids": {},
        "current_text_message_ids": {},
        "current_text_message_nodes": {},
        "node_name": "agent",
        "has_function_streaming": False,
        "streamed_tool_call_ids": set(),
        "model_made_tool_call": False,
        "state_reliable": True,
        "active_subagents": {},
        "current_subagent_id": None,
        "subagent_task_meta": {},
        "subagent_task_runs": {},
        "subagent_parents": {},
        "pending_task_calls": [],
        "seen_task_call_ids": set(),
        "subagent_segments": set(),
        "subagent_messages": {},
        "subagent_tool_call_owner": {},
    }


def _make_agent(run_id: str = "run-1") -> LangGraphAgent:
    agent = LangGraphAgent(name="test", graph=MagicMock())
    agent.active_run = _fresh_active_run(run_id)
    agent.dispatched = []
    real_dispatch = agent._dispatch_event

    def _dispatch(event):
        resolved = real_dispatch(event)
        agent.dispatched.append(resolved)
        return resolved

    agent._dispatch_event = _dispatch
    return agent


def _text_chunk(chunk_id: str, content: str, node: str = "model") -> dict:
    return {
        "event": LangGraphEventTypes.OnChatModelStream,
        "metadata": {"emit-messages": True, "emit-tool-calls": True, "langgraph_node": node},
        "data": {"chunk": {"id": chunk_id, "content": content, "tool_call_chunks": [], "response_metadata": {}}},
    }


def _tool_start_chunk(chunk_id: str, tool_id: str, tool_name: str) -> dict:
    return {
        "event": LangGraphEventTypes.OnChatModelStream,
        "metadata": {"emit-messages": True, "emit-tool-calls": True},
        "data": {"chunk": {"id": chunk_id, "content": "", "tool_call_chunks": [{"id": tool_id, "name": tool_name, "args": ""}], "response_metadata": {}}},
    }


def _tool_args_chunk(chunk_id: str, args: str) -> dict:
    return {
        "event": LangGraphEventTypes.OnChatModelStream,
        "metadata": {"emit-messages": True, "emit-tool-calls": True},
        "data": {"chunk": {"id": chunk_id, "content": "", "tool_call_chunks": [{"id": None, "name": None, "args": args}], "response_metadata": {}}},
    }


def _model_end() -> dict:
    return {"event": LangGraphEventTypes.OnChatModelEnd, "metadata": {}, "data": {}}


def _feed(agent: LangGraphAgent, event: dict, subagent_id) -> None:
    """Simulate reconcile_subagents setting the lane, then handle one event."""
    agent.active_run["current_subagent_id"] = subagent_id

    async def _run():
        async for _ in agent._handle_single_event(event, {}):
            pass

    asyncio.new_event_loop().run_until_complete(_run())


class TestParallelSubagentText(unittest.TestCase):
    def test_interleaved_text_stays_in_its_own_message_and_attribution(self):
        agent = _make_agent()
        # Two subagents streaming text, interleaved at chunk granularity.
        _feed(agent, _text_chunk("msg-a", "A1"), "tools:a")
        _feed(agent, _text_chunk("msg-b", "B1"), "tools:b")
        _feed(agent, _text_chunk("msg-a", "A2"), "tools:a")
        _feed(agent, _text_chunk("msg-b", "B2"), "tools:b")
        _feed(agent, _model_end(), "tools:a")
        _feed(agent, _model_end(), "tools:b")

        content = [
            (e.message_id, e.delta, e.subagent_id)
            for e in agent.dispatched
            if e.type == EventType.TEXT_MESSAGE_CONTENT
        ]
        self.assertEqual(
            content,
            [
                ("msg-a", "A1", "tools:a"),
                ("msg-b", "B1", "tools:b"),
                ("msg-a", "A2", "tools:a"),
                ("msg-b", "B2", "tools:b"),
            ],
        )
        # Each subagent opened exactly one message under its own id + tag.
        starts = [
            (e.message_id, e.subagent_id)
            for e in agent.dispatched
            if e.type == EventType.TEXT_MESSAGE_START
        ]
        self.assertEqual(starts, [("msg-a", "tools:a"), ("msg-b", "tools:b")])
        # Each closes its own message on its own model end.
        ends = [
            (e.message_id, e.subagent_id)
            for e in agent.dispatched
            if e.type == EventType.TEXT_MESSAGE_END
        ]
        self.assertEqual(ends, [("msg-a", "tools:a"), ("msg-b", "tools:b")])

    def test_fan_out_three_way_including_root(self):
        """A supervisor (root) streaming while two fan-out subagents stream;
        all three lanes stay independent."""
        agent = _make_agent()
        _feed(agent, _text_chunk("msg-root", "R1"), None)  # root/supervisor
        _feed(agent, _text_chunk("msg-a", "A1"), "tools:a")
        _feed(agent, _text_chunk("msg-b", "B1"), "tools:b")
        _feed(agent, _text_chunk("msg-root", "R2"), None)
        _feed(agent, _text_chunk("msg-a", "A2"), "tools:a")

        content = [
            (e.message_id, e.delta, e.subagent_id)
            for e in agent.dispatched
            if e.type == EventType.TEXT_MESSAGE_CONTENT
        ]
        self.assertEqual(
            content,
            [
                ("msg-root", "R1", None),
                ("msg-a", "A1", "tools:a"),
                ("msg-b", "B1", "tools:b"),
                ("msg-root", "R2", None),
                ("msg-a", "A2", "tools:a"),
            ],
        )


class TestParallelSubagentToolCalls(unittest.TestCase):
    def test_interleaved_tool_args_route_to_the_right_tool_call(self):
        agent = _make_agent()
        _feed(agent, _tool_start_chunk("m-a", "call-a", "toolA"), "tools:a")
        _feed(agent, _tool_start_chunk("m-b", "call-b", "toolB"), "tools:b")
        _feed(agent, _tool_args_chunk("m-a", '{"x":1}'), "tools:a")
        _feed(agent, _tool_args_chunk("m-b", '{"y":2}'), "tools:b")
        _feed(agent, _model_end(), "tools:a")
        _feed(agent, _model_end(), "tools:b")

        args = [
            (e.tool_call_id, e.delta, e.subagent_id)
            for e in agent.dispatched
            if e.type == EventType.TOOL_CALL_ARGS
        ]
        self.assertEqual(
            args,
            [("call-a", '{"x":1}', "tools:a"), ("call-b", '{"y":2}', "tools:b")],
        )
        starts = [
            (e.tool_call_id, e.subagent_id)
            for e in agent.dispatched
            if e.type == EventType.TOOL_CALL_START
        ]
        self.assertEqual(starts, [("call-a", "tools:a"), ("call-b", "tools:b")])
        ends = [
            (e.tool_call_id, e.subagent_id)
            for e in agent.dispatched
            if e.type == EventType.TOOL_CALL_END
        ]
        self.assertEqual(ends, [("call-a", "tools:a"), ("call-b", "tools:b")])


class TestParallelSubagentReasoning(unittest.TestCase):
    def _reason(self, agent, subagent_id, data):
        agent.active_run["current_subagent_id"] = subagent_id
        list(agent.handle_reasoning_event(data))

    def test_interleaved_reasoning_stays_separate(self):
        agent = _make_agent()
        self._reason(agent, "tools:a", {"type": "text", "text": "A-think-1", "index": 0, "id": "rs-a"})
        self._reason(agent, "tools:b", {"type": "text", "text": "B-think-1", "index": 0, "id": "rs-b"})
        self._reason(agent, "tools:a", {"type": "text", "text": "A-think-2", "index": 0})

        content = [
            (e.message_id, e.delta, e.subagent_id)
            for e in agent.dispatched
            if e.type == EventType.REASONING_MESSAGE_CONTENT
        ]
        self.assertEqual(
            content,
            [
                ("rs-a", "A-think-1", "tools:a"),
                ("rs-b", "B-think-1", "tools:b"),
                ("rs-a", "A-think-2", "tools:a"),
            ],
        )
        # Exactly one REASONING_START per subagent, under its own id.
        starts = [
            (e.message_id, e.subagent_id)
            for e in agent.dispatched
            if e.type == EventType.REASONING_START
        ]
        self.assertEqual(starts, [("rs-a", "tools:a"), ("rs-b", "tools:b")])


class TestSingleAgentRegression(unittest.TestCase):
    def test_root_only_text_unchanged(self):
        """Root-only (no subagent) streaming behaves exactly as before: one
        lane ("__root__"), text→continue in one bubble."""
        agent = _make_agent()
        _feed(agent, _text_chunk("m1", "Hello "), None)
        _feed(agent, _text_chunk("m1", "world"), None)
        _feed(agent, _model_end(), None)

        content = [(e.message_id, e.delta) for e in agent.dispatched if e.type == EventType.TEXT_MESSAGE_CONTENT]
        self.assertEqual(content, [("m1", "Hello "), ("m1", "world")])
        # No subagent attribution on any event.
        self.assertTrue(all(getattr(e, "subagent_id", None) is None for e in agent.dispatched))
        # Exactly one start and one end.
        self.assertEqual(sum(1 for e in agent.dispatched if e.type == EventType.TEXT_MESSAGE_START), 1)
        self.assertEqual(sum(1 for e in agent.dispatched if e.type == EventType.TEXT_MESSAGE_END), 1)


class TestLaneAwareTextPin(unittest.TestCase):
    """The text-message pin is per (lane, lane's own node): a subagent's bubble
    survives across its own model invocations even while another subagent's
    node changes, and re-mints only when the subagent's OWN node changes."""

    def test_pin_survives_foreign_lane_node_change(self):
        agent = _make_agent()
        # B opens a message in node "model".
        _feed(agent, _text_chunk("b-first", "B1", node="model"), "tools:b")
        _feed(agent, _model_end(), "tools:b")  # closes b-first, clears B's slot
        # A streams from a DIFFERENT node ("tools") — must not touch B's pin.
        _feed(agent, _text_chunk("a-1", "A1", node="tools"), "tools:a")
        _feed(agent, _model_end(), "tools:a")
        # B's next model invocation, still node "model": must reuse b-first.
        _feed(agent, _text_chunk("b-second", "B2", node="model"), "tools:b")
        _feed(agent, _model_end(), "tools:b")

        b_starts = [
            e.message_id
            for e in agent.dispatched
            if e.type == EventType.TEXT_MESSAGE_START and e.subagent_id == "tools:b"
        ]
        # Two model invocations => two START/END cycles, but both must carry the
        # SAME pinned id so the client merges them into one bubble (the #1317
        # behavior). Fragmentation would show "b-second" here.
        self.assertEqual(b_starts, ["b-first", "b-first"], "B's bubble must not fragment")
        b_content = [
            (e.message_id, e.delta)
            for e in agent.dispatched
            if e.type == EventType.TEXT_MESSAGE_CONTENT and e.subagent_id == "tools:b"
        ]
        self.assertEqual(b_content, [("b-first", "B1"), ("b-first", "B2")])

    def test_handle_node_change_does_not_reset_pins(self):
        """Guard against reintroducing the old global-node pin reset: driving
        handle_node_change (as the outer loop does on a node transition) must
        NOT clear any lane's text pin. B keeps streaming into its bubble even
        though a handle_node_change fires in between."""
        agent = _make_agent()
        _feed(agent, _text_chunk("b-msg", "B1", node="model"), "tools:b")
        _feed(agent, _model_end(), "tools:b")
        # Outer loop sees a foreign node transition and drives handle_node_change.
        agent.active_run["current_subagent_id"] = "tools:a"
        list(agent.handle_node_change("tools"))
        # B resumes in its own node; pin must survive the handle_node_change.
        _feed(agent, _text_chunk("b-msg-2", "B2", node="model"), "tools:b")

        b_content = [
            (e.message_id, e.delta)
            for e in agent.dispatched
            if e.type == EventType.TEXT_MESSAGE_CONTENT and e.subagent_id == "tools:b"
        ]
        self.assertEqual(b_content, [("b-msg", "B1"), ("b-msg", "B2")])

    def test_pin_reminted_when_lane_own_node_changes(self):
        agent = _make_agent()
        _feed(agent, _text_chunk("m1", "one", node="planner"), "tools:a")
        _feed(agent, _model_end(), "tools:a")
        # Same lane, different node -> fresh bubble.
        _feed(agent, _text_chunk("m2", "two", node="writer"), "tools:a")
        _feed(agent, _model_end(), "tools:a")

        starts = [e.message_id for e in agent.dispatched if e.type == EventType.TEXT_MESSAGE_START]
        self.assertEqual(starts, ["m1", "m2"])


class TestParallelTaskCallCapture(unittest.TestCase):
    def test_all_parallel_task_calls_queued_from_one_chunk(self):
        """A supervisor fanning out several `task` calls in a single model
        chunk must queue ALL of them (bug #4: only tool_call_chunks[0] was
        captured, so the 2nd+ subagent got parentToolCallId=None)."""
        agent = _make_agent()
        chunk = {
            "event": LangGraphEventTypes.OnChatModelStream,
            "metadata": {"emit-messages": True, "emit-tool-calls": True},
            "data": {"chunk": {
                "id": "asst-1",
                "content": "",
                "tool_call_chunks": [
                    {"id": "call-a", "name": "task", "args": ""},
                    {"id": "call-b", "name": "task", "args": ""},
                ],
                "response_metadata": {},
            }},
        }
        _feed(agent, chunk, None)
        self.assertEqual(
            agent.active_run["pending_task_calls"],
            [
                {"tool_call_id": "call-a", "parent_message_id": "asst-1"},
                {"tool_call_id": "call-b", "parent_message_id": "asst-1"},
            ],
        )

    def test_task_call_not_requeued_when_name_and_id_recur(self):
        """Some providers repeat both name and id across a tool call's chunks;
        the seen-set must keep it queued exactly once (dedupe by tool_call_id).
        Both chunks carry name="task" + id="call-a" so the guard that actually
        fires is the seen-set, not the name check."""
        agent = _make_agent()
        chunk1 = {
            "event": LangGraphEventTypes.OnChatModelStream,
            "metadata": {"emit-messages": True, "emit-tool-calls": True},
            "data": {"chunk": {"id": "asst-1", "content": "",
                "tool_call_chunks": [{"id": "call-a", "name": "task", "args": ""}],
                "response_metadata": {}}},
        }
        chunk2 = {
            "event": LangGraphEventTypes.OnChatModelStream,
            "metadata": {"emit-messages": True, "emit-tool-calls": True},
            "data": {"chunk": {"id": "asst-1", "content": "",
                "tool_call_chunks": [{"id": "call-a", "name": "task", "args": '{"x":1}'}],
                "response_metadata": {}}},
        }
        _feed(agent, chunk1, None)
        _feed(agent, chunk2, None)
        self.assertEqual(
            agent.active_run["pending_task_calls"],
            [{"tool_call_id": "call-a", "parent_message_id": "asst-1"}],
        )


class TestNoCrossRunState(unittest.TestCase):
    def test_run_clears_its_in_flight_lane_slots(self):
        """After a run finishes, its entry in the instance-level
        messages_in_process map is dropped, so streaming lane state never
        survives into a later run. Per-run reasoning/pin/subagent maps live in
        active_run, which is discarded (asserted here too)."""
        from ag_ui.core import RunAgentInput

        mock_graph = MagicMock()
        mock_graph.get_input_jsonschema.return_value = {"properties": {"messages": {}}}
        mock_graph.get_output_jsonschema.return_value = {"properties": {"messages": {}}}
        mock_graph.get_config_jsonschema.return_value = {"properties": {}}

        async def _empty_stream(*args, **kwargs):
            return
            yield  # noqa: unreachable — makes this an async generator

        mock_graph.astream_events = _empty_stream

        agent = LangGraphAgent(name="test", graph=mock_graph)
        # Seed lane state as if this run had streamed a subagent message.
        agent.messages_in_process = {"run-teardown": {"tools:a": {"id": "m", "tool_call_id": None}}}

        input_data = RunAgentInput(
            thread_id="t1", run_id="run-teardown", state={}, messages=[], tools=[], context=[], forwarded_props={},
        )

        loop = asyncio.new_event_loop()
        try:
            async def _run():
                async for _ in agent.run(input_data):
                    pass
            try:
                loop.run_until_complete(_run())
            except Exception:
                # The end-of-run snapshot path may error under the bare mock;
                # the finally (which does the teardown) still runs regardless.
                pass
        finally:
            loop.close()

        self.assertNotIn("run-teardown", agent.messages_in_process)
        self.assertIsNone(agent.active_run)


if __name__ == "__main__":
    unittest.main()
