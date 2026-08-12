"""Concurrent subagent streaming must not cross-contaminate.

deepagents runs `task` subagents concurrently, and LangGraph's
``astream_events`` merges their chunks into one stream. Each subagent is a
distinct checkpoint-namespace boundary, so it has a distinct derived
``subagent_run_id``. Transient stream state (in-flight message/tool call,
reasoning, and the text-message pin) is keyed per-subagent "lane" so
interleaved chunks from two subagents stay in their own message/tool/reasoning
and carry their own attribution.

Before the lane fix, all of this state was a per-run singleton: subagent B's
delta arriving mid-stream would append to subagent A's open message (and be
tagged B), reasoning would be overwritten, etc. These tests pin the post-fix
isolation. They drive ``_handle_single_event`` directly with the REAL
``_dispatch_event`` (so ``subagent_run_id`` stamping happens) and set
``current_subagent_run_id`` per event to mimic ``reconcile_subagents``.
"""

import asyncio
import unittest
from unittest.mock import MagicMock

from ag_ui.core import EventType
from ag_ui_langgraph.agent import LangGraphAgent
from ag_ui_langgraph.types import LangGraphEventTypes

try:
    from langchain.schema import ToolMessage
except ImportError:  # langchain >= 1.0
    from langchain_core.messages import ToolMessage


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
        "current_subagent_run_id": None,
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
    # Parallel-subagent behaviour, so this suite opts in; the flag defaults to off.
    agent = LangGraphAgent(name="test", graph=MagicMock(), emit_subagent_events=True)
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


def _feed(agent: LangGraphAgent, event: dict, subagent_run_id) -> None:
    """Simulate reconcile_subagents setting the lane, then handle one event."""
    agent.active_run["current_subagent_run_id"] = subagent_run_id

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
            (e.message_id, e.delta, e.subagent_run_id)
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
            (e.message_id, e.subagent_run_id)
            for e in agent.dispatched
            if e.type == EventType.TEXT_MESSAGE_START
        ]
        self.assertEqual(starts, [("msg-a", "tools:a"), ("msg-b", "tools:b")])
        # Each closes its own message on its own model end.
        ends = [
            (e.message_id, e.subagent_run_id)
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
            (e.message_id, e.delta, e.subagent_run_id)
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
            (e.tool_call_id, e.delta, e.subagent_run_id)
            for e in agent.dispatched
            if e.type == EventType.TOOL_CALL_ARGS
        ]
        self.assertEqual(
            args,
            [("call-a", '{"x":1}', "tools:a"), ("call-b", '{"y":2}', "tools:b")],
        )
        starts = [
            (e.tool_call_id, e.subagent_run_id)
            for e in agent.dispatched
            if e.type == EventType.TOOL_CALL_START
        ]
        self.assertEqual(starts, [("call-a", "tools:a"), ("call-b", "tools:b")])
        ends = [
            (e.tool_call_id, e.subagent_run_id)
            for e in agent.dispatched
            if e.type == EventType.TOOL_CALL_END
        ]
        self.assertEqual(ends, [("call-a", "tools:a"), ("call-b", "tools:b")])


class TestParallelSubagentReasoning(unittest.TestCase):
    def _reason(self, agent, subagent_run_id, data):
        agent.active_run["current_subagent_run_id"] = subagent_run_id
        list(agent.handle_reasoning_event(data))

    def test_interleaved_reasoning_stays_separate(self):
        agent = _make_agent()
        self._reason(agent, "tools:a", {"type": "text", "text": "A-think-1", "index": 0, "id": "rs-a"})
        self._reason(agent, "tools:b", {"type": "text", "text": "B-think-1", "index": 0, "id": "rs-b"})
        self._reason(agent, "tools:a", {"type": "text", "text": "A-think-2", "index": 0})

        content = [
            (e.message_id, e.delta, e.subagent_run_id)
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
            (e.message_id, e.subagent_run_id)
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
        self.assertTrue(all(getattr(e, "subagent_run_id", None) is None for e in agent.dispatched))
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
            if e.type == EventType.TEXT_MESSAGE_START and e.subagent_run_id == "tools:b"
        ]
        # Two model invocations => two START/END cycles, but both must carry the
        # SAME pinned id so the client merges them into one bubble (the #1317
        # behavior). Fragmentation would show "b-second" here.
        self.assertEqual(b_starts, ["b-first", "b-first"], "B's bubble must not fragment")
        b_content = [
            (e.message_id, e.delta)
            for e in agent.dispatched
            if e.type == EventType.TEXT_MESSAGE_CONTENT and e.subagent_run_id == "tools:b"
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
        agent.active_run["current_subagent_run_id"] = "tools:a"
        list(agent.handle_node_change("tools"))
        # B resumes in its own node; pin must survive the handle_node_change.
        _feed(agent, _text_chunk("b-msg-2", "B2", node="model"), "tools:b")

        b_content = [
            (e.message_id, e.delta)
            for e in agent.dispatched
            if e.type == EventType.TEXT_MESSAGE_CONTENT and e.subagent_run_id == "tools:b"
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
                # public_tool_call_id == tool_call_id: no cross-lane collision here.
                {"lane": "__root__", "tool_call_id": "call-a", "public_tool_call_id": "call-a", "parent_message_id": "asst-1"},
                {"lane": "__root__", "tool_call_id": "call-b", "public_tool_call_id": "call-b", "parent_message_id": "asst-1"},
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
            [{"lane": "__root__", "tool_call_id": "call-a", "public_tool_call_id": "call-a", "parent_message_id": "asst-1"}],
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

        agent = LangGraphAgent(name="test", graph=mock_graph, emit_subagent_events=True)
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


class TestParallelAttributionInvariants(unittest.TestCase):
    """Regression for the S&P Global parallel-run report (feedback #3).

    Their captured run — two `alpha` subagents fanned out in parallel, each
    calling a tool and streaming a reply — showed three failures of one root
    cause (a single global "current subagent" slot): a tool call whose START,
    END and RESULT carried different tags; both subagents streaming text under
    ONE shared message id, reopened three times; and step boundaries tagged
    with whichever subagent's event came last. This test replays their
    interleaving shape and asserts the two invariants their tables violate;
    the step half lives in TestStepOwnership / TestPerLaneStepTransitions.
    """

    def test_every_entity_keeps_one_owner_across_interleaving(self):
        agent = _make_agent()
        a, b = "tools:3cab", "tools:0ca0"

        # Their events 83-86: both subagents open a tool call back to back,
        # then finish them — in the captured log call-a's END arrived tagged
        # with subagent b because b's START had stolen the global slot.
        _feed(agent, _tool_start_chunk("m-a", "tooluse_rXbq", "current_datetime"), a)
        _feed(agent, _tool_start_chunk("m-b", "tooluse_HRj4", "current_datetime"), b)
        _feed(agent, _model_end(), a)
        _feed(agent, _model_end(), b)

        # Their events 105-158: both subagents stream their reply,
        # interleaved at chunk granularity — in the captured log both landed
        # in ONE message id, START/END tags flipping between the two.
        _feed(agent, _text_chunk("lc_run-a", "It "), a)
        _feed(agent, _text_chunk("lc_run-b", "The "), b)
        _feed(agent, _text_chunk("lc_run-a", "is "), a)
        _feed(agent, _text_chunk("lc_run-b", "date "), b)
        _feed(agent, _text_chunk("lc_run-a", "Tuesday."), a)
        _feed(agent, _text_chunk("lc_run-b", "is Tuesday."), b)
        _feed(agent, _model_end(), a)
        _feed(agent, _model_end(), b)

        # Invariant 1: every event of one tool call carries ONE tag — the
        # opener's. (Their table: START 3cab / END 0ca0 on the same call.)
        owners_by_call = {}
        for e in agent.dispatched:
            if e.type in (EventType.TOOL_CALL_START, EventType.TOOL_CALL_ARGS, EventType.TOOL_CALL_END):
                owners_by_call.setdefault(e.tool_call_id, set()).add(e.subagent_run_id)
        self.assertEqual(owners_by_call, {"tooluse_rXbq": {a}, "tooluse_HRj4": {b}})

        # Invariant 2: each subagent streams under its OWN message id, opened
        # once and closed once, every event of that id carrying one tag.
        # (Their table: one shared id, three START/END pairs, tags flipping.)
        owners_by_message = {}
        opens = {}
        closes = {}
        for e in agent.dispatched:
            if e.type in (EventType.TEXT_MESSAGE_START, EventType.TEXT_MESSAGE_CONTENT, EventType.TEXT_MESSAGE_END):
                owners_by_message.setdefault(e.message_id, set()).add(e.subagent_run_id)
            if e.type == EventType.TEXT_MESSAGE_START:
                opens[e.message_id] = opens.get(e.message_id, 0) + 1
            if e.type == EventType.TEXT_MESSAGE_END:
                closes[e.message_id] = closes.get(e.message_id, 0) + 1
        self.assertEqual(len(owners_by_message), 2, "two subagents must get two distinct message ids")
        for owners in owners_by_message.values():
            self.assertEqual(len(owners), 1, "a message id must never change owner")
        self.assertEqual(opens, {mid: 1 for mid in owners_by_message})
        self.assertEqual(closes, {mid: 1 for mid in owners_by_message})


class TestEqualUpstreamIdsAcrossLanes(unittest.TestCase):
    """Two lanes presenting the SAME upstream chunk id must not collide.

    Public message ids are run-global: the client rejects a second
    TEXT_MESSAGE_START for an id already in progress, and the snapshot
    accumulator (keyed by public id) crossed both lanes' text into one
    entry ("AB") owned by whichever lane came first. Distinct LangChain
    runs mint distinct ``lc_run--*`` ids, so this needs two lanes to
    genuinely present the same id — but nothing upstream *guarantees*
    that, so the producer must keep public ids unique itself. The first
    lane to present an id keeps it verbatim (single-lane streams stay
    byte-identical); colliders get a minted, lane-namespaced id.
    """

    def _drive_shared_id(self):
        agent = _make_agent()
        _feed(agent, _text_chunk("shared", "A"), "tools:a")
        _feed(agent, _text_chunk("shared", "B"), "tools:b")
        _feed(agent, _model_end(), "tools:a")
        _feed(agent, _model_end(), "tools:b")
        return agent

    def test_the_second_lane_gets_a_minted_run_global_id(self):
        agent = self._drive_shared_id()
        starts = [
            (e.message_id, e.subagent_run_id)
            for e in agent.dispatched
            if e.type == EventType.TEXT_MESSAGE_START
        ]
        self.assertEqual(len(starts), 2)
        ids = [mid for mid, _ in starts]
        self.assertEqual(len(set(ids)), 2, f"public ids must be run-global: {starts}")
        # First-comer keeps the raw upstream id.
        self.assertEqual(starts[0], ("shared", "tools:a"))
        self.assertEqual(starts[1][1], "tools:b")

    def test_content_and_end_follow_each_lanes_public_id(self):
        agent = self._drive_shared_id()
        by_type = {}
        for e in agent.dispatched:
            if e.type in (
                EventType.TEXT_MESSAGE_START,
                EventType.TEXT_MESSAGE_CONTENT,
                EventType.TEXT_MESSAGE_END,
            ):
                by_type.setdefault(e.type, []).append((e.message_id, e.subagent_run_id))
        start_ids = dict(by_type[EventType.TEXT_MESSAGE_START])
        # Every content/end event pairs the id its own lane opened.
        for mid, owner in by_type[EventType.TEXT_MESSAGE_CONTENT]:
            self.assertEqual(start_ids.get(mid), owner)
        self.assertEqual(
            sorted(by_type[EventType.TEXT_MESSAGE_END]),
            sorted(by_type[EventType.TEXT_MESSAGE_START]),
        )

    def test_the_snapshot_accumulator_keeps_the_lanes_apart(self):
        agent = self._drive_shared_id()
        entries = [
            (entry["content"], entry["subagent_run_id"])
            for entry in agent.active_run["subagent_messages"].values()
        ]
        self.assertEqual(
            sorted(entries),
            [("A", "tools:a"), ("B", "tools:b")],
            "equal upstream ids must not cross lanes into one snapshot entry",
        )


class TestToolParentMessagesShareTheRegistry(unittest.TestCase):
    """Tool-created assistant messages must claim public ids like text does.

    TOOL_CALL_START's parent_message_id used the raw chunk id, bypassing the
    public-id registry — so the equal-upstream-id collision fixed for text
    stayed open for tool-calling subagents: a text start in another lane
    reused the assistant message the tool call had created, crossing owners
    in the accumulator and in the TypeScript reducer.
    """

    def test_tool_parent_and_foreign_text_get_distinct_public_ids(self):
        agent = _make_agent()
        _feed(agent, _tool_start_chunk("shared", "call-a", "search"), "tools:a")
        _feed(agent, _text_chunk("shared", "B"), "tools:b")
        _feed(agent, _model_end(), "tools:a")
        _feed(agent, _model_end(), "tools:b")

        tool_parent = next(
            e.parent_message_id for e in agent.dispatched
            if e.type == EventType.TOOL_CALL_START
        )
        text_id = next(
            e.message_id for e in agent.dispatched
            if e.type == EventType.TEXT_MESSAGE_START
        )
        self.assertNotEqual(tool_parent, text_id, "run-global ids must not collide")
        self.assertEqual(tool_parent, "shared", "first-comer keeps the raw id")

        entries = {
            mid: (entry["subagent_run_id"], entry["content"], sorted(entry.get("tool_calls", {})))
            for mid, entry in agent.active_run["subagent_messages"].items()
        }
        self.assertEqual(entries[tool_parent], ("tools:a", "", ["call-a"]))
        self.assertEqual(entries[text_id], ("tools:b", "B", []))

    def test_two_tool_only_lanes_with_one_upstream_id_stay_apart(self):
        agent = _make_agent()
        _feed(agent, _tool_start_chunk("shared", "call-a", "search"), "tools:a")
        _feed(agent, _tool_start_chunk("shared", "call-b", "fetch"), "tools:b")
        _feed(agent, _model_end(), "tools:a")
        _feed(agent, _model_end(), "tools:b")

        parents = [
            (e.parent_message_id, e.subagent_run_id)
            for e in agent.dispatched
            if e.type == EventType.TOOL_CALL_START
        ]
        self.assertEqual(len(parents), 2)
        self.assertEqual(len({mid for mid, _ in parents}), 2)
        # One assistant entry per lane, each holding only its own call.
        calls_by_owner = {
            entry["subagent_run_id"]: sorted(entry.get("tool_calls", {}))
            for entry in agent.active_run["subagent_messages"].values()
        }
        self.assertEqual(calls_by_owner, {"tools:a": ["call-a"], "tools:b": ["call-b"]})

    def test_same_lane_text_then_tool_keeps_one_public_id(self):
        # The merge case the registry must NOT break: one model invocation
        # streaming text then a tool call under one chunk id is ONE assistant
        # message, so the tool's parent must resolve to the text's public id.
        agent = _make_agent()
        _feed(agent, _text_chunk("m", "hi"), "tools:a")
        _feed(agent, _tool_start_chunk("m", "call-1", "search"), "tools:a")
        _feed(agent, _model_end(), "tools:a")

        text_id = next(
            e.message_id for e in agent.dispatched
            if e.type == EventType.TEXT_MESSAGE_START
        )
        tool_parent = next(
            e.parent_message_id for e in agent.dispatched
            if e.type == EventType.TOOL_CALL_START
        )
        self.assertEqual(text_id, tool_parent, "same lane + same chunk id = one message")


class TestEqualToolCallIdsAcrossLanes(unittest.TestCase):
    """Two lanes presenting the SAME upstream tool-call id must not collide.

    Public tool-call ids are run-global (the verifier rejects a second START
    for an active id), and the streamed-ids set was raw-keyed, so lane A's
    result discarding the shared raw id made lane B's result spuriously
    re-emit START/ARGS/END. Emission now maps raw -> public per lane (raw ids
    stay in graph state, so internal correlation is untouched); first-comer
    keeps the raw id, colliders get a lane-namespaced mint.
    """

    def _stream_both(self):
        agent = _make_agent()
        _feed(agent, _tool_start_chunk("m-a", "dup", "search"), "tools:a")
        _feed(agent, _tool_start_chunk("m-b", "dup", "fetch"), "tools:b")
        _feed(agent, _tool_args_chunk("m-a", '{"q":1}'), "tools:a")
        _feed(agent, _tool_args_chunk("m-b", '{"q":2}'), "tools:b")
        _feed(agent, _model_end(), "tools:a")
        _feed(agent, _model_end(), "tools:b")
        return agent

    def test_starts_args_and_ends_stay_lane_consistent(self):
        agent = self._stream_both()
        starts = [
            (e.tool_call_id, e.subagent_run_id)
            for e in agent.dispatched if e.type == EventType.TOOL_CALL_START
        ]
        self.assertEqual(len(starts), 2)
        self.assertEqual(len({tid for tid, _ in starts}), 2, f"ids must differ: {starts}")
        self.assertEqual(starts[0], ("dup", "tools:a"), "first-comer keeps the raw id")

        public_by_owner = {owner: tid for tid, owner in starts}
        for e in agent.dispatched:
            if e.type == EventType.TOOL_CALL_ARGS:
                self.assertEqual(e.tool_call_id, public_by_owner[e.subagent_run_id])
        ends = [
            (e.tool_call_id, e.subagent_run_id)
            for e in agent.dispatched if e.type == EventType.TOOL_CALL_END
        ]
        self.assertEqual(sorted(ends), sorted(starts))

    def test_one_lanes_result_does_not_reemit_the_other_lanes_call(self):
        agent = self._stream_both()

        def _tool_end(raw_id, content):
            return {
                "event": LangGraphEventTypes.OnToolEnd,
                "name": "search",
                "metadata": {},
                "data": {
                    "output": ToolMessage(content=content, tool_call_id=raw_id),
                    "input": {"q": 1},
                },
            }

        _feed(agent, _tool_end("dup", "result-a"), "tools:a")
        _feed(agent, _tool_end("dup", "result-b"), "tools:b")

        starts = [e for e in agent.dispatched if e.type == EventType.TOOL_CALL_START]
        self.assertEqual(
            len(starts), 2,
            "a result for an already-streamed call must not re-emit its START",
        )
        results = [
            (e.tool_call_id, e.subagent_run_id)
            for e in agent.dispatched if e.type == EventType.TOOL_CALL_RESULT
        ]
        self.assertEqual(len(results), 2)
        self.assertEqual(
            len({tid for tid, _ in results}), 2,
            f"each result must carry its own lane's public id: {results}",
        )


class TestNestedDuplicateTaskCallIds(unittest.TestCase):
    """Colliding raw `task` ids across lanes must not mislink SUBAGENT_STARTED.

    The pending-task capture deduped by a run-global set of RAW tool-call ids,
    so a second lane's `task` call with an already-seen raw id never recorded
    its public tool-call/message pair — and the ns->tool_call_id join matched
    pending records by raw id alone, popping the OTHER lane's record. The
    nested subagent's SUBAGENT_STARTED then referenced the root's unrelated
    call ("dup") instead of the spawning call the client actually saw
    ("dup::tools:outer").
    """

    def _capture_both_and_join(self):
        agent = _make_agent()
        # Root and an outer subagent each fan out a `task` call with the same
        # raw id but different assistant chunks.
        _feed(agent, _tool_start_chunk("root-msg", "dup", "task"), None)
        _feed(agent, _tool_start_chunk("outer-msg", "dup", "task"), "tools:outer")
        # The outer lane's dispatch: its ToolNode schedules the inner subagent.
        agent._capture_task_tool_dispatch({
            "event": LangGraphEventTypes.OnChainStart.value,
            "name": "tools",
            "metadata": {
                "langgraph_node": "tools",
                "langgraph_checkpoint_ns": "tools:outer|tools:inner",
            },
            "data": {"input": {"type": "tool_call", "name": "task", "id": "dup"}},
        })
        agent._capture_subagent_task_meta({
            "event": LangGraphEventTypes.OnToolStart.value,
            "name": "task",
            "metadata": {"langgraph_checkpoint_ns": "tools:outer|tools:inner"},
            "data": {"input": {"subagent_type": "researcher", "description": "d"}},
        })
        return agent

    def test_both_lanes_task_calls_are_captured(self):
        agent = self._capture_both_and_join()
        # The root's record must still be pending for ITS spawned subagent —
        # the raw-global dedupe used to swallow the second capture entirely.
        remaining = agent.active_run["pending_task_calls"]
        self.assertEqual(len(remaining), 1)
        self.assertEqual(remaining[0]["parent_message_id"], "root-msg")

    def test_the_inner_subagent_links_to_the_spawning_lanes_public_call(self):
        agent = self._capture_both_and_join()
        meta = agent.active_run["subagent_task_meta"]["tools:inner"]
        self.assertEqual(
            meta["parent_tool_call_id"], "dup::tools:outer",
            "the client saw the outer lane's call as dup::tools:outer; linking "
            f"to {meta['parent_tool_call_id']!r} points at the root's unrelated call",
        )
        self.assertEqual(meta["parent_message_id"], "outer-msg")

    def test_an_unstreamed_colliding_call_does_not_steal_the_other_lanes_record(self):
        # Same collision, but the outer lane's `task` call never streams a
        # model chunk (this producer supports that: OnToolEnd re-emits such
        # calls). The raw-only fallback must NOT treat the root's record as an
        # "unambiguous" match — its lane explicitly differs — and the
        # dispatch-known fallback must resolve the public id for the parent
        # lane, matching what the outer lane's later re-emit will carry.
        agent = _make_agent()
        _feed(agent, _tool_start_chunk("root-msg", "dup", "task"), None)
        agent._capture_task_tool_dispatch({
            "event": LangGraphEventTypes.OnChainStart.value,
            "name": "tools",
            "metadata": {
                "langgraph_node": "tools",
                "langgraph_checkpoint_ns": "tools:outer|tools:inner",
            },
            "data": {"input": {"type": "tool_call", "name": "task", "id": "dup"}},
        })
        agent._capture_subagent_task_meta({
            "event": LangGraphEventTypes.OnToolStart.value,
            "name": "task",
            "metadata": {"langgraph_checkpoint_ns": "tools:outer|tools:inner"},
            "data": {"input": {"subagent_type": "researcher", "description": "d"}},
        })

        meta = agent.active_run["subagent_task_meta"]["tools:inner"]
        self.assertEqual(
            meta["parent_tool_call_id"], "dup::tools:outer",
            "must resolve the parent lane's public id, not borrow the root's raw call",
        )
        self.assertIsNone(meta["parent_message_id"])
        # The root's record stays pending for the root's own subagent.
        remaining = agent.active_run["pending_task_calls"]
        self.assertEqual(len(remaining), 1)
        self.assertEqual(remaining[0]["parent_message_id"], "root-msg")


class TestEqualReasoningIdsAcrossLanes(unittest.TestCase):
    """Two lanes presenting the SAME provider reasoning id must not collide.

    Reasoning ids are run-global on the client (its owner map keys reasoning
    messages by id), so the second lane's opener was rejected by the verifier.
    Same rule as text/tool-call ids, in reasoning's own kind namespace.
    """

    def _reason(self, agent, subagent_run_id, data):
        agent.active_run["current_subagent_run_id"] = subagent_run_id
        list(agent.handle_reasoning_event(data))

    def test_the_second_lane_gets_a_minted_reasoning_id(self):
        agent = _make_agent()
        self._reason(agent, "tools:a", {"type": "text", "text": "A", "index": 0, "id": "rs-shared"})
        self._reason(agent, "tools:b", {"type": "text", "text": "B", "index": 0, "id": "rs-shared"})

        starts = [
            (e.message_id, e.subagent_run_id)
            for e in agent.dispatched
            if e.type == EventType.REASONING_START
        ]
        self.assertEqual(len(starts), 2)
        self.assertEqual(starts[0], ("rs-shared", "tools:a"), "first-comer keeps the raw id")
        self.assertNotEqual(starts[1][0], "rs-shared", f"run-global ids: {starts}")
        # Content follows each lane's own public id.
        for e in agent.dispatched:
            if e.type == EventType.REASONING_MESSAGE_CONTENT:
                expected = starts[0][0] if e.subagent_run_id == "tools:a" else starts[1][0]
                self.assertEqual(e.message_id, expected)


class TestEqualManualEmitIdsAcrossLanes(unittest.TestCase):
    """Manually emitted message/tool-call ids are caller-chosen and can collide
    across lanes; they resolve through the same registry as streamed ids."""

    def test_manual_messages_with_one_id_stay_apart(self):
        agent = _make_agent()
        for lane, text in (("tools:a", "A"), ("tools:b", "B")):
            _feed(agent, {
                "event": LangGraphEventTypes.OnCustomEvent,
                "name": "manually_emit_message",
                "metadata": {},
                "data": {"message_id": "manual-1", "message": text},
            }, lane)

        starts = [
            (e.message_id, e.subagent_run_id)
            for e in agent.dispatched
            if e.type == EventType.TEXT_MESSAGE_START
        ]
        self.assertEqual(len(starts), 2)
        self.assertEqual(len({mid for mid, _ in starts}), 2, f"ids must differ: {starts}")
        self.assertEqual(starts[0], ("manual-1", "tools:a"))

    def test_manual_tool_calls_with_one_id_stay_apart(self):
        agent = _make_agent()
        for lane in ("tools:a", "tools:b"):
            _feed(agent, {
                "event": LangGraphEventTypes.OnCustomEvent,
                "name": "manually_emit_tool_call",
                "metadata": {},
                "data": {"id": "call-1", "name": "search", "args": "{}"},
            }, lane)

        starts = [
            (e.tool_call_id, e.subagent_run_id)
            for e in agent.dispatched
            if e.type == EventType.TOOL_CALL_START
        ]
        self.assertEqual(len(starts), 2)
        self.assertEqual(len({tid for tid, _ in starts}), 2, f"ids must differ: {starts}")


class TestSnapshotIdsTranslateToPublicIds(unittest.TestCase):
    """The snapshot must present the ids the client actually saw streamed.

    A root/subagent raw-id collision used to delete the subagent's output at
    snapshot time: the subagent claimed public id 'shared', the root's copy was
    minted 'shared::__root__' on the stream, but the state snapshot still said
    'shared' — so the merge's dedup matched the SUBAGENT's accumulator entry
    against the ROOT's message and discarded it, and the root's snapshot id no
    longer matched its own streamed events.
    """

    def _collide(self):
        agent = _make_agent()
        # Subagent s1 claims raw id 'shared'; the root then mints 'shared::__root__'.
        _feed(agent, _text_chunk("shared", "sub says hi"), "tools:s1")
        _feed(agent, _model_end(), "tools:s1")
        _feed(agent, _text_chunk("shared", "root says hi"), None)
        _feed(agent, _model_end(), None)
        return agent

    def test_root_snapshot_message_carries_its_streamed_public_id(self):
        from ag_ui.core import AssistantMessage

        agent = self._collide()
        translated = agent._translate_snapshot_ids([
            AssistantMessage(id="shared", role="assistant", content="root says hi"),
        ])
        self.assertEqual(translated[0].id, "shared::__root__")

    def test_the_subagent_entry_survives_the_merge_dedup(self):
        from ag_ui.core import AssistantMessage

        agent = self._collide()
        merged = agent._merge_subagent_messages(
            agent._translate_snapshot_ids([
                AssistantMessage(id="shared", role="assistant", content="root says hi"),
            ])
        )
        by_id = {m.id: m for m in merged}
        self.assertIn("shared", by_id, "the subagent's public id is 'shared'")
        self.assertEqual(getattr(by_id["shared"], "subagent_run_id", None), "tools:s1")
        self.assertIn("shared::__root__", by_id, "the root's streamed id")

    def test_ids_the_stream_never_claimed_pass_through(self):
        from ag_ui.core import AssistantMessage, UserMessage

        agent = self._collide()
        translated = agent._translate_snapshot_ids([
            UserMessage(id="user-1", role="user", content="hi"),
            AssistantMessage(id="unrelated", role="assistant", content="x"),
        ])
        self.assertEqual([m.id for m in translated], ["user-1", "unrelated"])


class TestOrdinaryToolIsNotASubagentBoundary(unittest.TestCase):
    """An ordinary tool that invokes a runnable must not fabricate a subagent.

    The boundary heuristic assumed an inner ToolNode is always a leaf, but a
    tool that internally invokes a model produces tools:X|model:Y — which
    satisfied the heuristic, so all the tool's inner output was attributed to
    a fabricated nested subagent with its own SUBAGENT_STARTED. The per-call
    ToolNode dispatch names the call being dispatched, so a non-`task`
    dispatch is positive evidence its segment is NOT a subagent boundary.
    """

    def _agent_inside_outer(self):
        from ag_ui_langgraph.agent import reconcile_subagents

        agent = _make_agent()
        # The outer subagent is genuinely active.
        list_events = reconcile_subagents(
            agent.active_run, "tools:outer|model:m", "researcher", set()
        )
        self.assertEqual([e.type for e in list_events], [EventType.SUBAGENT_STARTED])
        return agent

    def test_a_non_task_dispatch_excludes_its_segment(self):
        from ag_ui_langgraph.agent import reconcile_subagents

        agent = self._agent_inside_outer()
        agent._capture_task_tool_dispatch({
            "event": LangGraphEventTypes.OnChainStart,
            "name": "tools",
            "metadata": {
                "langgraph_node": "tools",
                "langgraph_checkpoint_ns": "tools:outer|tools:ordinary-call",
            },
            "data": {"input": {"type": "tool_call", "name": "web_search", "id": "c9"}},
        })
        events = reconcile_subagents(
            agent.active_run,
            "tools:outer|tools:ordinary-call|model:inside-tool",
            "researcher",
            set(),
        )
        self.assertEqual(
            [e.type for e in events], [],
            "an ordinary tool's inner model run is the OUTER subagent's work",
        )
        self.assertEqual(agent.active_run["current_subagent_run_id"], "tools:outer")
        self.assertNotIn("tools:ordinary-call", agent.active_run["active_subagents"])

    def test_a_task_dispatch_still_creates_the_nested_boundary(self):
        from ag_ui_langgraph.agent import reconcile_subagents

        agent = self._agent_inside_outer()
        agent._capture_task_tool_dispatch({
            "event": LangGraphEventTypes.OnChainStart,
            "name": "tools",
            "metadata": {
                "langgraph_node": "tools",
                "langgraph_checkpoint_ns": "tools:outer|tools:inner",
            },
            "data": {"input": {"type": "tool_call", "name": "task", "id": "t1"}},
        })
        events = reconcile_subagents(
            agent.active_run,
            "tools:outer|tools:inner|model:inside",
            "researcher",
            set(),
        )
        self.assertEqual([e.type for e in events], [EventType.SUBAGENT_STARTED])
        self.assertEqual(events[0].subagent_run_id, "tools:inner")
        self.assertEqual(events[0].parent_subagent_run_id, "tools:outer")


class TestInputSeedingProtectsHistoryIds(unittest.TestCase):
    """The registry must know the ids the client already displays.

    The registry is per-run, so unseeded it protected only same-turn
    collisions: (a) a lane claiming a raw id equal to a HISTORY message's id
    kept it verbatim and the snapshot merge deduped that lane's entry away —
    content loss across turns; (b) a root id minted in a prior run came back
    from the client as a new-looking id and the graph's merge duplicated the
    message against its checkpoint copy, which still holds the raw id.
    Seeding derives from the run's input alone — nothing persists between
    runs.
    """

    def _input(self, messages):
        from ag_ui.core import RunAgentInput

        return RunAgentInput(
            thread_id="t", run_id="r", state={}, messages=messages,
            tools=[], context=[], forwarded_props={},
        )

    def test_a_lane_colliding_with_a_history_id_mints(self):
        from ag_ui.core import AssistantMessage

        agent = _make_agent()
        history = AssistantMessage(id="shared", role="assistant", content="prior root text")
        agent._seed_public_ids_from_input(self._input([history]))
        _feed(agent, _text_chunk("shared", "sub says hi"), "tools:s1")
        _feed(agent, _model_end(), "tools:s1")

        start = next(e for e in agent.dispatched if e.type == EventType.TEXT_MESSAGE_START)
        self.assertNotEqual(start.message_id, "shared", "the history id is taken")

        merged = agent._merge_subagent_messages(
            agent._translate_snapshot_ids([history])
        )
        ids = [m.id for m in merged]
        self.assertIn("shared", ids, "the history message survives")
        self.assertIn(start.message_id, ids, "the subagent's entry survives the dedup")

    def test_minted_root_ids_reverse_translate_for_the_graph(self):
        from ag_ui.core import AssistantMessage

        agent = _make_agent()
        out = agent._seed_public_ids_from_input(self._input([
            AssistantMessage(id="shared::__root__", role="assistant", content="root text"),
        ]))
        # The graph sees the raw id its checkpoint already holds — no duplicate.
        self.assertEqual([m.id for m in out.messages], ["shared"])
        # And this run's snapshot keeps presenting the id the client knows.
        translated = agent._translate_snapshot_ids([
            AssistantMessage(id="shared", role="assistant", content="root text"),
        ])
        self.assertEqual(translated[0].id, "shared::__root__")

    def test_tagged_inbound_history_ids_are_reserved(self):
        from ag_ui.core import AssistantMessage

        agent = _make_agent()
        agent._inbound_subagent_messages = [
            AssistantMessage(id="taken", role="assistant", content="x", subagent_run_id="tools:old"),
        ]
        agent._seed_public_ids_from_input(self._input([]))
        _feed(agent, _text_chunk("taken", "new text"), "tools:new")
        start = next(e for e in agent.dispatched if e.type == EventType.TEXT_MESSAGE_START)
        self.assertNotEqual(start.message_id, "taken")

    def test_flag_off_leaves_the_input_untouched(self):
        from ag_ui.core import AssistantMessage

        agent = LangGraphAgent(name="test", graph=MagicMock(), emit_subagent_events=False)
        agent.active_run = _fresh_active_run()
        original = self._input([
            AssistantMessage(id="shared::__root__", role="assistant", content="x"),
        ])
        out = agent._seed_public_ids_from_input(original)
        self.assertIs(out, original)
        self.assertNotIn("public_id_maps", agent.active_run)

    def test_an_upstream_id_that_looks_minted_is_never_emitted_verbatim(self):
        # The '::__root__' suffix is load-bearing: the next turn's seeding
        # strips it to recover the raw checkpoint id. Emitting a genuine
        # upstream id matching it verbatim would strip it to a DIFFERENT id
        # and duplicate the message against the checkpoint — so the resolver
        # enforces the suffix's exclusivity by minting instead. The mint gains
        # a second suffix layer, which reverse-translation unwinds one layer
        # per turn, converging.
        from ag_ui.core import AssistantMessage

        agent = _make_agent()
        public = agent._resolve_public_message_id("provider-id::__root__", "__root__")
        self.assertNotEqual(public, "provider-id::__root__")

        # Round trip: seeding a fresh run with the minted id recovers the raw
        # form for the graph and re-presents the minted id publicly.
        agent2 = _make_agent()
        out = agent2._seed_public_ids_from_input(self._input([
            AssistantMessage(id=public, role="assistant", content="x"),
        ]))
        self.assertEqual(out.messages[0].id, "provider-id::__root__")
        translated = agent2._translate_snapshot_ids([
            AssistantMessage(id="provider-id::__root__", role="assistant", content="x"),
        ])
        self.assertEqual(translated[0].id, public)

    def test_a_resumed_lane_recovers_its_minted_tool_call_mapping(self):
        # HITL resume replays the SAME lane (checkpoint namespaces persist)
        # and its upstream events carry the RAW id. Seeding must map
        # raw -> public for that lane, or the resumed call minted a THIRD id
        # and the replayed call/result no longer matched its own history.
        from ag_ui.core import AssistantMessage, ToolCall, FunctionCall

        agent = _make_agent()
        agent._inbound_subagent_messages = [
            AssistantMessage(
                id="m1::tools:s1", role="assistant", subagent_run_id="tools:s1",
                tool_calls=[ToolCall(id="call::tools:s1", type="function",
                                     function=FunctionCall(name="search", arguments="{}"))],
            ),
        ]
        agent._seed_public_ids_from_input(self._input([]))
        self.assertEqual(
            agent._resolve_public_tool_call_id("call", "tools:s1"),
            "call::tools:s1",
            "the resumed lane resolves its raw id back to the minted public id",
        )
        self.assertEqual(
            agent._resolve_public_message_id("m1", "tools:s1"),
            "m1::tools:s1",
        )
        # Another lane claiming the same raw id still mints something new.
        other = agent._resolve_public_tool_call_id("call", "tools:s2")
        self.assertNotIn(other, ("call::tools:s1",))

    def test_an_upstream_id_ending_in_its_own_lane_suffix_is_never_emitted_verbatim(self):
        # Symmetric to the root-suffix rule: tagged seeding strips the lane's
        # OWN mint suffix on resume, so a lane emitting a genuine raw id that
        # ends in that suffix verbatim would have it stripped to a DIFFERENT
        # id — the resumed replay then forked into a new message/call instead
        # of completing the displayed one.
        from ag_ui.core import AssistantMessage

        agent = _make_agent()
        public = agent._resolve_public_message_id("provider-id::tools:s1", "tools:s1")
        self.assertNotEqual(public, "provider-id::tools:s1")

        # Round trip: a resumed lane seeded with the minted id recovers the
        # raw form and resolves straight back to it — no fork.
        agent2 = _make_agent()
        agent2._inbound_subagent_messages = [
            AssistantMessage(id=public, role="assistant", content="x", subagent_run_id="tools:s1"),
        ]
        agent2._seed_public_ids_from_input(self._input([]))
        self.assertEqual(
            agent2._resolve_public_message_id("provider-id::tools:s1", "tools:s1"),
            public,
        )


if __name__ == "__main__":
    unittest.main()
