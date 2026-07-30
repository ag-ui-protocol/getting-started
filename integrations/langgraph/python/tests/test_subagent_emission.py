import asyncio
import unittest
from unittest.mock import AsyncMock, MagicMock

from ag_ui.core import (
    EventType,
    TextMessageStartEvent,
    TextMessageContentEvent,
    SubagentStartedEvent,
    AssistantMessage,
)
from ag_ui_langgraph.agent import (
    LangGraphAgent,
    derive_subagent_context,
    reconcile_subagents,
    drain_subagents,
    error_open_subagents,
)


class TestDeriveSubagentContext(unittest.TestCase):
    def test_none_for_root_or_missing_signals(self):
        # single-segment ns, no lc_agent_name -> not a subagent
        self.assertIsNone(derive_subagent_context("model:root-uuid", None, set()))
        # nested ns but no lc_agent_name (e.g. a declared subgraph) -> not a subagent
        self.assertIsNone(derive_subagent_context("tools:x|model:y", None, set()))
        # empty ns -> not a subagent
        self.assertIsNone(derive_subagent_context("", "researcher", set()))

    def test_nested_ns_with_agent_name_is_subagent(self):
        ns = "tools:e6df-uuid|model:inner-uuid"
        ctx = derive_subagent_context(ns, "researcher", set())
        self.assertIsNotNone(ctx)
        self.assertEqual(ctx.name, "researcher")
        self.assertEqual(ctx.subagent_id, "tools:e6df-uuid")  # leading segment, stable
        self.assertIsNone(ctx.parent_subagent_id)

    def test_stable_id_across_calls(self):
        ns = "tools:e6df-uuid|model:inner-uuid"
        a = derive_subagent_context(ns, "researcher", set())
        b = derive_subagent_context(ns, "researcher", set())
        self.assertEqual(a.subagent_id, b.subagent_id)

    def test_declared_subgraph_excluded(self):
        # if the ns root is a declared subgraph, it's handled by existing subgraph
        # logic, not treated as a deepagents subagent
        ns = "flights:sg-uuid|model:inner"
        self.assertIsNone(derive_subagent_context(ns, "researcher", {"flights"}))


def _run():
    return {"active_subagents": {}, "current_subagent_id": None}


class TestReconcileSubagents(unittest.TestCase):
    def test_enter_emits_started(self):
        ar = _run()
        evs = reconcile_subagents(ar, "tools:s1|model:x", "researcher", set())
        self.assertEqual([e.type for e in evs], [EventType.SUBAGENT_STARTED])
        self.assertEqual(evs[0].subagent_id, "tools:s1")
        self.assertEqual(evs[0].name, "researcher")
        self.assertEqual(ar["current_subagent_id"], "tools:s1")

    def test_stay_emits_nothing(self):
        ar = _run()
        reconcile_subagents(ar, "tools:s1|model:x", "researcher", set())
        evs = reconcile_subagents(ar, "tools:s1|model:y", "researcher", set())
        self.assertEqual(evs, [])

    def test_exit_to_root_emits_nothing_and_clears_current(self):
        ar = _run()
        reconcile_subagents(ar, "tools:s1|model:x", "researcher", set())
        evs = reconcile_subagents(ar, "model:root", None, set())
        self.assertEqual(evs, [])
        self.assertIsNone(ar["current_subagent_id"])
        # finish is deferred to drain_subagents -- the subagent stays active
        self.assertIn("tools:s1", ar["active_subagents"])

    def test_switch_subagents_emits_only_started_for_new(self):
        ar = _run()
        reconcile_subagents(ar, "tools:s1|model:x", "researcher", set())
        evs = reconcile_subagents(ar, "tools:s2|model:y", "writer", set())
        self.assertEqual([e.type for e in evs], [EventType.SUBAGENT_STARTED])
        self.assertEqual(evs[0].subagent_id, "tools:s2")
        self.assertIn("tools:s1", ar["active_subagents"])
        self.assertIn("tools:s2", ar["active_subagents"])

    def test_root_only_emits_nothing(self):
        ar = _run()
        self.assertEqual(reconcile_subagents(ar, "model:root", None, set()), [])

    def test_interleaved_concurrent_subagents(self):
        ar = _run()
        all_events = []
        all_events += reconcile_subagents(ar, "tools:s1|model:a", "researcher", set())
        all_events += reconcile_subagents(ar, "tools:s2|model:b", "writer", set())
        all_events += reconcile_subagents(ar, "tools:s1|model:c", "researcher", set())
        all_events += reconcile_subagents(ar, "tools:s2|model:d", "writer", set())

        self.assertEqual([e.type for e in all_events], [EventType.SUBAGENT_STARTED, EventType.SUBAGENT_STARTED])
        self.assertEqual([e.subagent_id for e in all_events], ["tools:s1", "tools:s2"])
        self.assertIn("tools:s1", ar["active_subagents"])
        self.assertIn("tools:s2", ar["active_subagents"])

        finish_events = drain_subagents(ar)
        self.assertEqual(len(finish_events), 2)
        self.assertEqual({e.type for e in finish_events}, {EventType.SUBAGENT_FINISHED})
        self.assertEqual({e.subagent_id for e in finish_events}, {"tools:s1", "tools:s2"})
        self.assertEqual(ar["active_subagents"], {})

    def test_current_subagent_id_tracks_each_event(self):
        ar = _run()
        reconcile_subagents(ar, "tools:s1|model:a", "researcher", set())
        self.assertEqual(ar["current_subagent_id"], "tools:s1")
        reconcile_subagents(ar, "model:root", None, set())
        self.assertIsNone(ar["current_subagent_id"])
        reconcile_subagents(ar, "tools:s2|model:b", "writer", set())
        self.assertEqual(ar["current_subagent_id"], "tools:s2")


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


class TestDispatchStamping(unittest.TestCase):
    def _agent(self, current_subagent_id):
        agent = _make_agent()
        agent.active_run = {"current_subagent_id": current_subagent_id, "active_subagents": {}}
        return agent

    def test_stamps_creation_event_when_in_subagent(self):
        agent = self._agent("tools:s1")
        ev = agent._dispatch_event(
            TextMessageStartEvent(type=EventType.TEXT_MESSAGE_START, message_id="m1")
        )
        self.assertEqual(ev.subagent_id, "tools:s1")

    def test_does_not_stamp_when_not_in_subagent(self):
        agent = self._agent(None)
        ev = agent._dispatch_event(
            TextMessageStartEvent(type=EventType.TEXT_MESSAGE_START, message_id="m1")
        )
        self.assertIsNone(ev.subagent_id)

    def test_does_not_overwrite_existing_subagent_id(self):
        agent = self._agent("tools:s1")
        ev = agent._dispatch_event(
            TextMessageStartEvent(
                type=EventType.TEXT_MESSAGE_START, message_id="m1", subagent_id="orig"
            )
        )
        self.assertEqual(ev.subagent_id, "orig")

    def test_stamps_continuation_event_when_in_subagent(self):
        # Continuation/close events are now tagged too, so the stream is
        # self-describing per event (no messageId reconstruction needed).
        agent = self._agent("tools:s1")
        ev = agent._dispatch_event(
            TextMessageContentEvent(type=EventType.TEXT_MESSAGE_CONTENT, message_id="m1", delta="x")
        )
        self.assertEqual(ev.subagent_id, "tools:s1")

    def test_does_not_stamp_subagent_lifecycle_event(self):
        agent = self._agent("tools:s1")
        ev = agent._dispatch_event(
            SubagentStartedEvent(type=EventType.SUBAGENT_STARTED, subagent_id="tools:s1", name="r")
        )
        self.assertEqual(ev.subagent_id, "tools:s1")  # its own id, unchanged (not re-stamped by chokepoint logic)


async def _collect(agen):
    return [ev async for ev in agen]


class TestSnapshotIncludesSubagentMessages(unittest.TestCase):
    """The MESSAGES_SNAPSHOT is built from MAIN-graph state, which does not
    contain subagent-internal messages. These tests pin the fix that merges the
    streamed subagent messages (with their subagent_id) into the snapshot so the
    client does not wipe them when it applies the snapshot."""

    def _agent_with_active_run(self, current_subagent_id=None):
        agent = _make_agent()
        agent.active_run = {
            "id": "run-1",
            "current_subagent_id": current_subagent_id,
            "active_subagents": {},
            "subagent_messages": {},
            "subagent_tool_call_owner": {},
            "subagent_task_runs": {},
            "inbound_subagent_messages": [],
        }
        return agent

    def _snapshot(self, agent):
        events = asyncio.run(_collect(agent.get_state_and_messages_snapshots({})))
        return next(e for e in events if e.type == EventType.MESSAGES_SNAPSHOT)

    def test_subagent_message_merged_into_snapshot_with_id(self):
        agent = self._agent_with_active_run(current_subagent_id="tools:s1")
        # A subagent assistant message streams (START gets stamped with the
        # active subagent id, CONTENT accumulates the text).
        agent._dispatch_event(
            TextMessageStartEvent(
                type=EventType.TEXT_MESSAGE_START, message_id="sub-msg-1", role="assistant"
            )
        )
        agent._dispatch_event(
            TextMessageContentEvent(
                type=EventType.TEXT_MESSAGE_CONTENT, message_id="sub-msg-1", delta="Hello "
            )
        )
        agent._dispatch_event(
            TextMessageContentEvent(
                type=EventType.TEXT_MESSAGE_CONTENT, message_id="sub-msg-1", delta="world"
            )
        )

        snap = self._snapshot(agent)
        subagent_msgs = [
            m for m in snap.messages if getattr(m, "subagent_id", None) == "tools:s1"
        ]
        self.assertEqual(len(subagent_msgs), 1)
        self.assertEqual(subagent_msgs[0].id, "sub-msg-1")
        self.assertEqual(subagent_msgs[0].role, "assistant")
        self.assertEqual(subagent_msgs[0].content, "Hello world")

    def test_no_subagent_messages_leaves_snapshot_unchanged(self):
        # Backwards-compat: a run with no subagent messages (normal run or the
        # declared-subgraphs demo) yields the main-graph snapshot untouched.
        agent = self._agent_with_active_run(current_subagent_id=None)
        agent._dispatch_event(
            TextMessageStartEvent(
                type=EventType.TEXT_MESSAGE_START, message_id="main-msg-1", role="assistant"
            )
        )
        self.assertEqual(agent.active_run["subagent_messages"], {})
        snap = self._snapshot(agent)
        # main-graph state is empty in the mock -> snapshot stays empty
        self.assertEqual(snap.messages, [])

    def test_empty_subagent_message_not_appended(self):
        # A subagent turn that streamed no text should not add an empty bubble.
        agent = self._agent_with_active_run(current_subagent_id="tools:s1")
        agent._dispatch_event(
            TextMessageStartEvent(
                type=EventType.TEXT_MESSAGE_START, message_id="sub-empty", role="assistant"
            )
        )
        snap = self._snapshot(agent)
        self.assertEqual(snap.messages, [])


class TestErrorOpenSubagents(unittest.TestCase):
    def test_emits_error_for_all_open_and_clears(self):
        active_run = {
            "active_subagents": {"tools:a": "x", "tools:b": "y"},
            "current_subagent_id": "tools:b",
        }
        events = error_open_subagents(active_run, "boom")
        self.assertEqual({e.subagent_id for e in events}, {"tools:a", "tools:b"})
        self.assertTrue(all(e.type == EventType.SUBAGENT_ERROR for e in events))
        self.assertTrue(all(e.message == "boom" for e in events))
        # Cleared so a subsequent drain_subagents can't also emit SUBAGENT_FINISHED
        # for a subagent that already errored.
        self.assertEqual(active_run["active_subagents"], {})
        self.assertIsNone(active_run["current_subagent_id"])

    def test_no_open_subagents_is_noop(self):
        active_run = {"active_subagents": {}, "current_subagent_id": None}
        self.assertEqual(error_open_subagents(active_run, "boom"), [])


class TestFinishSubagentOnTaskEnd(unittest.TestCase):
    def _agent(self):
        agent = _make_agent()
        agent.active_run = {
            "active_subagents": {},
            "current_subagent_id": None,
            "subagent_task_meta": {},
            "subagent_task_runs": {},
        }
        return agent

    def test_capture_records_name_description_and_run_id(self):
        agent = self._agent()
        # A pending supervisor `task` call (captured from the stream) is popped
        # FIFO to link the subagent back to its spawning call.
        agent.active_run["pending_task_calls"] = [
            {"tool_call_id": "call-1", "parent_message_id": "msg-1"}
        ]
        agent._capture_subagent_task_meta({
            "event": "on_tool_start",
            "run_id": "run-task-1",
            "data": {"input": {"subagent_type": "researcher", "description": "dig"}},
            "metadata": {"langgraph_checkpoint_ns": "tools:sub1|model:x"},
        })
        self.assertEqual(
            agent.active_run["subagent_task_meta"]["tools:sub1"],
            {
                "name": "researcher",
                "description": "dig",
                "parent_tool_call_id": "call-1",
                "parent_message_id": "msg-1",
            },
        )
        self.assertEqual(agent.active_run["subagent_task_runs"]["run-task-1"], "tools:sub1")
        self.assertEqual(agent.active_run["pending_task_calls"], [])  # consumed

    def test_task_end_finishes_exactly_the_subagent_it_started(self):
        agent = self._agent()
        agent.active_run["subagent_task_runs"]["run-task-1"] = "tools:sub1"
        agent.active_run["active_subagents"]["tools:sub1"] = "researcher"
        agent.active_run["current_subagent_id"] = "tools:sub1"
        events = agent._finish_subagent_on_task_end(
            {"event": "on_tool_end", "run_id": "run-task-1"}
        )
        self.assertEqual([e.type for e in events], [EventType.SUBAGENT_FINISHED])
        self.assertEqual(events[0].subagent_id, "tools:sub1")
        self.assertEqual(agent.active_run["active_subagents"], {})
        self.assertIsNone(agent.active_run["current_subagent_id"])

    def test_inner_tool_end_does_not_finish_subagent_early(self):
        # A subagent's inner tool (grep/write_file) shares the subagent's
        # checkpoint ns but has a DIFFERENT run_id, so its OnToolEnd must NOT
        # finish the subagent — this is the exact hazard the run_id keying guards.
        agent = self._agent()
        agent.active_run["subagent_task_runs"]["run-task-1"] = "tools:sub1"
        agent.active_run["active_subagents"]["tools:sub1"] = "researcher"
        events = agent._finish_subagent_on_task_end(
            {"event": "on_tool_end", "run_id": "inner-tool-99"}
        )
        self.assertEqual(events, [])
        self.assertIn("tools:sub1", agent.active_run["active_subagents"])

    def test_non_tool_end_event_is_noop(self):
        agent = self._agent()
        self.assertEqual(
            agent._finish_subagent_on_task_end({"event": "on_chain_end"}), []
        )


class TestCrossTurnPersistence(unittest.TestCase):
    def _agent(self, inbound):
        agent = _make_agent()
        agent.active_run = {
            "id": "run-1",
            "current_subagent_id": None,
            "active_subagents": {},
            "subagent_messages": {},
            "subagent_tool_call_owner": {},
            "subagent_task_runs": {},
            "inbound_subagent_messages": inbound,
        }
        return agent

    def _snapshot(self, agent):
        events = asyncio.run(_collect(agent.get_state_and_messages_snapshots({})))
        return next(e for e in events if e.type == EventType.MESSAGES_SNAPSHOT)

    def test_prior_turn_subagent_messages_reemitted(self):
        prior = AssistantMessage(
            id="prev-sub-1", role="assistant", content="earlier finding",
            subagent_id="tools:s1",
        )
        snap = self._snapshot(self._agent([prior]))
        ids = [(m.id, getattr(m, "subagent_id", None)) for m in snap.messages]
        self.assertIn(("prev-sub-1", "tools:s1"), ids)

    def test_inbound_deduped_by_id(self):
        prior = AssistantMessage(
            id="dup", role="assistant", content="x", subagent_id="tools:s1",
        )
        snap = self._snapshot(self._agent([prior, prior]))
        self.assertEqual(sum(1 for m in snap.messages if m.id == "dup"), 1)


if __name__ == "__main__":
    unittest.main()


class TestSubagentNewFields(unittest.TestCase):
    def test_started_carries_parent_links_from_task_meta(self):
        ar = {"active_subagents": {}, "current_subagent_id": None,
              "subagent_task_meta": {"tools:s1": {
                  "name": "alpha", "description": "d",
                  "parent_tool_call_id": "call-1", "parent_message_id": "msg-1"}}}
        evs = reconcile_subagents(ar, "tools:s1|model:x", "alpha", set())
        self.assertEqual([e.type for e in evs], [EventType.SUBAGENT_STARTED])
        self.assertEqual(evs[0].parent_tool_call_id, "call-1")
        self.assertEqual(evs[0].parent_message_id, "msg-1")
        self.assertIsNone(evs[0].parent_subagent_id)
        self.assertEqual(evs[0].description, "d")

    def test_finish_includes_result_from_command_output(self):
        agent = _make_agent()
        agent.active_run = {"active_subagents": {"tools:sub1": "alpha"},
                            "current_subagent_id": "tools:sub1",
                            "subagent_task_runs": {"run-1": "tools:sub1"}}

        class _ToolMsg:
            content = "the subagent result"

        class _Cmd:
            update = {"messages": [_ToolMsg()]}

        evs = agent._finish_subagent_on_task_end(
            {"event": "on_tool_end", "run_id": "run-1", "data": {"output": _Cmd()}}
        )
        self.assertEqual([e.type for e in evs], [EventType.SUBAGENT_FINISHED])
        self.assertEqual(evs[0].result, "the subagent result")
