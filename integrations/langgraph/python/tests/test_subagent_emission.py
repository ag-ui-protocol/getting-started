import asyncio
import unittest
from unittest.mock import AsyncMock, MagicMock

from ag_ui.core import (
    EventType,
    TextMessageStartEvent,
    TextMessageContentEvent,
    ToolCallResultEvent,
    ReasoningEncryptedValueEvent,
    ReasoningMessageStartEvent,
    ReasoningMessageContentEvent,
    SubagentStartedEvent,
    AssistantMessage,
)
from ag_ui_langgraph.agent import (
    close_lane_steps,
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
        self.assertEqual(ctx.subagent_run_id, "tools:e6df-uuid")  # leading segment, stable
        self.assertIsNone(ctx.parent_subagent_run_id)

    def test_stable_id_across_calls(self):
        ns = "tools:e6df-uuid|model:inner-uuid"
        a = derive_subagent_context(ns, "researcher", set())
        b = derive_subagent_context(ns, "researcher", set())
        self.assertEqual(a.subagent_run_id, b.subagent_run_id)

    def test_declared_subgraph_excluded(self):
        # if the ns root is a declared subgraph, it's handled by existing subgraph
        # logic, not treated as a deepagents subagent
        ns = "flights:sg-uuid|model:inner"
        self.assertIsNone(derive_subagent_context(ns, "researcher", {"flights"}))


def _run():
    return {"active_subagents": {}, "current_subagent_run_id": None}


class TestReconcileSubagents(unittest.TestCase):
    def test_enter_emits_started(self):
        ar = _run()
        evs = reconcile_subagents(ar, "tools:s1|model:x", "researcher", set())
        self.assertEqual([e.type for e in evs], [EventType.SUBAGENT_STARTED])
        self.assertEqual(evs[0].subagent_run_id, "tools:s1")
        self.assertEqual(evs[0].name, "researcher")
        self.assertEqual(ar["current_subagent_run_id"], "tools:s1")

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
        self.assertIsNone(ar["current_subagent_run_id"])
        # finish is deferred to drain_subagents -- the subagent stays active
        self.assertIn("tools:s1", ar["active_subagents"])

    def test_switch_subagents_emits_only_started_for_new(self):
        ar = _run()
        reconcile_subagents(ar, "tools:s1|model:x", "researcher", set())
        evs = reconcile_subagents(ar, "tools:s2|model:y", "writer", set())
        self.assertEqual([e.type for e in evs], [EventType.SUBAGENT_STARTED])
        self.assertEqual(evs[0].subagent_run_id, "tools:s2")
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
        self.assertEqual([e.subagent_run_id for e in all_events], ["tools:s1", "tools:s2"])
        self.assertIn("tools:s1", ar["active_subagents"])
        self.assertIn("tools:s2", ar["active_subagents"])

        finish_events = drain_subagents(ar)
        self.assertEqual(len(finish_events), 2)
        self.assertEqual({e.type for e in finish_events}, {EventType.SUBAGENT_FINISHED})
        self.assertEqual({e.subagent_run_id for e in finish_events}, {"tools:s1", "tools:s2"})
        self.assertEqual(ar["active_subagents"], {})

    def test_current_subagent_run_id_tracks_each_event(self):
        ar = _run()
        reconcile_subagents(ar, "tools:s1|model:a", "researcher", set())
        self.assertEqual(ar["current_subagent_run_id"], "tools:s1")
        reconcile_subagents(ar, "model:root", None, set())
        self.assertIsNone(ar["current_subagent_run_id"])
        reconcile_subagents(ar, "tools:s2|model:b", "writer", set())
        self.assertEqual(ar["current_subagent_run_id"], "tools:s2")

    def test_reconcile_stores_subagent_parent(self):
        """reconcile records each subagent's parent so a finish can restore
        it (bug #3). Top-level parent is None; a nested child's parent is the
        outer subagent."""
        ar = _run()
        reconcile_subagents(ar, "tools:outer|model:x", "outer", set())
        reconcile_subagents(ar, "tools:outer|tools:child|model:y", "child", set())
        self.assertIsNone(ar["subagent_parents"]["tools:outer"])
        self.assertEqual(ar["subagent_parents"]["tools:child"], "tools:outer")


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
    def _agent(self, current_subagent_run_id):
        agent = _make_agent()
        agent.active_run = {"current_subagent_run_id": current_subagent_run_id, "active_subagents": {}}
        return agent

    def test_stamps_creation_event_when_in_subagent(self):
        agent = self._agent("tools:s1")
        ev = agent._dispatch_event(
            TextMessageStartEvent(type=EventType.TEXT_MESSAGE_START, message_id="m1")
        )
        self.assertEqual(ev.subagent_run_id, "tools:s1")

    def test_does_not_stamp_when_not_in_subagent(self):
        agent = self._agent(None)
        ev = agent._dispatch_event(
            TextMessageStartEvent(type=EventType.TEXT_MESSAGE_START, message_id="m1")
        )
        self.assertIsNone(ev.subagent_run_id)

    def test_does_not_overwrite_existing_subagent_run_id(self):
        agent = self._agent("tools:s1")
        ev = agent._dispatch_event(
            TextMessageStartEvent(
                type=EventType.TEXT_MESSAGE_START, message_id="m1", subagent_run_id="orig"
            )
        )
        self.assertEqual(ev.subagent_run_id, "orig")

    def test_stamps_continuation_event_when_in_subagent(self):
        # Continuation/close events are now tagged too, so the stream is
        # self-describing per event (no messageId reconstruction needed).
        agent = self._agent("tools:s1")
        ev = agent._dispatch_event(
            TextMessageContentEvent(type=EventType.TEXT_MESSAGE_CONTENT, message_id="m1", delta="x")
        )
        self.assertEqual(ev.subagent_run_id, "tools:s1")

    def test_does_not_stamp_subagent_lifecycle_event(self):
        agent = self._agent("tools:s1")
        ev = agent._dispatch_event(
            SubagentStartedEvent(type=EventType.SUBAGENT_STARTED, subagent_run_id="tools:s1", name="r")
        )
        self.assertEqual(ev.subagent_run_id, "tools:s1")  # its own id, unchanged (not re-stamped by chokepoint logic)

    def test_stamps_encrypted_reasoning_value(self):
        # REASONING_ENCRYPTED_VALUE is emitted for redacted_thinking blocks and
        # for the accumulated signature at the end of a reasoning stream. Both
        # sites sit inside the same reasoning stream whose REASONING_MESSAGE_END
        # does get attributed, so leaving this one untagged splits a single
        # subagent's reasoning across two owners: the client attributes the
        # encrypted value to the parent while the surrounding reasoning events
        # belong to the subagent.
        agent = self._agent("tools:s1")
        ev = agent._dispatch_event(
            ReasoningEncryptedValueEvent(
                type=EventType.REASONING_ENCRYPTED_VALUE,
                subtype="message",
                entity_id="r1",
                encrypted_value="opaque",
            )
        )
        self.assertEqual(ev.subagent_run_id, "tools:s1")

    def test_does_not_stamp_encrypted_reasoning_outside_subagent(self):
        agent = self._agent(None)
        ev = agent._dispatch_event(
            ReasoningEncryptedValueEvent(
                type=EventType.REASONING_ENCRYPTED_VALUE,
                subtype="message",
                entity_id="r1",
                encrypted_value="opaque",
            )
        )
        self.assertIsNone(ev.subagent_run_id)


async def _collect(agen):
    return [ev async for ev in agen]


class TestSnapshotIncludesSubagentMessages(unittest.TestCase):
    """The MESSAGES_SNAPSHOT is built from MAIN-graph state, which does not
    contain subagent-internal messages. These tests pin the fix that merges the
    streamed subagent messages (with their subagent_run_id) into the snapshot so the
    client does not wipe them when it applies the snapshot."""

    def _agent_with_active_run(self, current_subagent_run_id=None):
        agent = _make_agent()
        agent.active_run = {
            "id": "run-1",
            "current_subagent_run_id": current_subagent_run_id,
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
        agent = self._agent_with_active_run(current_subagent_run_id="tools:s1")
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
            m for m in snap.messages if getattr(m, "subagent_run_id", None) == "tools:s1"
        ]
        self.assertEqual(len(subagent_msgs), 1)
        self.assertEqual(subagent_msgs[0].id, "sub-msg-1")
        self.assertEqual(subagent_msgs[0].role, "assistant")
        self.assertEqual(subagent_msgs[0].content, "Hello world")

    def test_subagent_reasoning_survives_the_snapshot(self):
        # A subagent's reasoning lives only in its subgraph checkpoint, so it is absent
        # from the main-graph MESSAGES_SNAPSHOT and the client's snapshot apply would drop
        # the streamed reasoning message. The parent's reasoning does survive (utils
        # converts LangChain reasoning content blocks), so this was the one message kind a
        # subagent could produce that vanished at snapshot time.
        agent = self._agent_with_active_run(current_subagent_run_id="tools:s1")
        agent._dispatch_event(
            ReasoningMessageStartEvent(
                type=EventType.REASONING_MESSAGE_START, message_id="r1", role="reasoning"
            )
        )
        agent._dispatch_event(
            ReasoningMessageContentEvent(
                type=EventType.REASONING_MESSAGE_CONTENT, message_id="r1", delta="think"
            )
        )

        snap = self._snapshot(agent)
        reasoning = [m for m in snap.messages if m.role == "reasoning"]
        self.assertEqual(len(reasoning), 1)
        self.assertEqual(reasoning[0].id, "r1")
        self.assertEqual(reasoning[0].content, "think")
        self.assertEqual(reasoning[0].subagent_run_id, "tools:s1")

    def test_subagent_reasoning_keeps_its_encrypted_value_through_the_snapshot(self):
        # The signature arrives on its own event. Reconstructing the snapshot message
        # without it loses the protected reasoning, because a snapshot that contains the
        # message looks authoritative and the client replaces the streamed one.
        agent = self._agent_with_active_run(current_subagent_run_id="tools:s1")
        agent._dispatch_event(
            ReasoningMessageStartEvent(
                type=EventType.REASONING_MESSAGE_START, message_id="r1", role="reasoning"
            )
        )
        agent._dispatch_event(
            ReasoningMessageContentEvent(
                type=EventType.REASONING_MESSAGE_CONTENT, message_id="r1", delta="think"
            )
        )
        agent._dispatch_event(
            ReasoningEncryptedValueEvent(
                type=EventType.REASONING_ENCRYPTED_VALUE,
                subtype="message",
                entity_id="r1",
                encrypted_value="sig-abc",
            )
        )

        snap = self._snapshot(agent)
        reasoning = [m for m in snap.messages if m.role == "reasoning"]
        self.assertEqual(len(reasoning), 1)
        self.assertEqual(reasoning[0].encrypted_value, "sig-abc")
        self.assertEqual(reasoning[0].subagent_run_id, "tools:s1")

    def test_empty_subagent_reasoning_not_appended(self):
        # Same rule as an empty assistant turn: no content, no bubble.
        agent = self._agent_with_active_run(current_subagent_run_id="tools:s1")
        agent._dispatch_event(
            ReasoningMessageStartEvent(
                type=EventType.REASONING_MESSAGE_START,
                message_id="r-empty",
                role="reasoning",
            )
        )
        snap = self._snapshot(agent)
        self.assertEqual([m for m in snap.messages if m.role == "reasoning"], [])

    def test_checkpoint_state_snapshot_suppressed_inside_subagent(self):
        # State belongs to the parent. While a subagent is active the checkpoint
        # snapshot must withhold STATE_SNAPSHOT but still emit MESSAGES_SNAPSHOT,
        # so the subagent's messages and their attribution survive without its
        # subgraph state leaking into the parent's.
        agent = self._agent_with_active_run(current_subagent_run_id="tools:s1")
        events = asyncio.run(_collect(agent.get_state_and_messages_snapshots({})))
        types = [e.type for e in events]
        self.assertNotIn(EventType.STATE_SNAPSHOT, types)
        self.assertIn(EventType.MESSAGES_SNAPSHOT, types)

    def test_checkpoint_state_snapshot_emitted_for_parent(self):
        # The same path with no subagent active is the control: the parent does
        # emit STATE_SNAPSHOT, so the test above pins suppression rather than a
        # path that never emits state at all.
        agent = self._agent_with_active_run(current_subagent_run_id=None)
        events = asyncio.run(_collect(agent.get_state_and_messages_snapshots({})))
        types = [e.type for e in events]
        self.assertIn(EventType.STATE_SNAPSHOT, types)
        self.assertIn(EventType.MESSAGES_SNAPSHOT, types)

    def test_no_subagent_messages_leaves_snapshot_unchanged(self):
        # Backwards-compat: a run with no subagent messages (normal run or the
        # declared-subgraphs demo) yields the main-graph snapshot untouched.
        agent = self._agent_with_active_run(current_subagent_run_id=None)
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
        agent = self._agent_with_active_run(current_subagent_run_id="tools:s1")
        agent._dispatch_event(
            TextMessageStartEvent(
                type=EventType.TEXT_MESSAGE_START, message_id="sub-empty", role="assistant"
            )
        )
        snap = self._snapshot(agent)
        self.assertEqual(snap.messages, [])


class TestNodeExitStateSuppression(unittest.IsolatedAsyncioTestCase):
    """The third state-emission path: the node-exit STATE_SNAPSHOT in the stream
    loop. Driven end to end through _handle_stream_events so the suppression is
    pinned where it actually runs, not at a helper."""

    async def _drive(self, in_subagent):
        agent = _make_agent()

        # The lane is derived from each event's own metadata by
        # reconcile_subagents (nested checkpoint ns + lc_agent_name), never set
        # by hand — so the metadata is what decides whether this node exit is
        # inside a subagent.
        if in_subagent:
            sub_meta = {
                "langgraph_node": "n",
                "langgraph_checkpoint_ns": "tools:s1|model:inner",
                "lc_agent_name": "researcher",
            }
        else:
            sub_meta = {"langgraph_node": "n"}

        async def fake_prepare(*args, **kwargs):
            agent.active_run["schema_keys"] = {
                "input": ["messages"], "output": ["messages"],
                "config": [], "context": [],
            }

            async def gen():
                yield {
                    "event": "on_chain_start",
                    "run_id": "run-1",
                    "name": "n",
                    "data": {},
                    "metadata": {"langgraph_node": "n"},
                }
                # Node exit carrying a state update — this is what would
                # normally produce a STATE_SNAPSHOT.
                yield {
                    "event": "on_chain_end",
                    "run_id": "run-1",
                    "name": "n",
                    "data": {"output": {"custom_key": "from_graph"}},
                    "metadata": sub_meta,
                }

            return {
                "stream": gen(),
                "state": MagicMock(values={"messages": []}),
                "config": {"configurable": {"thread_id": "t1"}},
            }

        agent.prepare_stream = fake_prepare
        final_state = MagicMock()
        final_state.values = {"messages": []}
        final_state.tasks = []
        final_state.next = []
        final_state.metadata = {"writes": {}}
        agent.graph.aget_state = AsyncMock(return_value=final_state)

        run_input = MagicMock()
        run_input.run_id = "run-1"
        run_input.thread_id = "t1"
        run_input.forwarded_props = {}

        collected = []
        async for ev in agent._handle_stream_events(run_input):
            collected.append(ev)
        return collected

    @staticmethod
    def _node_exit_snapshots(collected):
        """STATE_SNAPSHOTs produced by the node exit itself.

        The end-of-run snapshots carry no raw_event and are the parent's — by
        then the subagent has been drained — so they are not what this path is
        about. Keying on the on_chain_end raw_event isolates the node-exit one.
        """
        return [
            e for e in collected
            if getattr(e, "type", None) == EventType.STATE_SNAPSHOT
            and (getattr(e, "raw_event", None) or {}).get("event") == "on_chain_end"
        ]

    async def test_node_exit_state_snapshot_suppressed_inside_subagent(self):
        # This pins a PRODUCER-SIDE choice, not a protocol rule. Attributed state
        # events are legal (the design lists STATE_* as attributable, and the
        # explicit manually_emit_state path does emit them). Node-exit snapshots are
        # suppressed because a subgraph's state is a PARTIAL view of the run's
        # document, so emitting one mid-delegation would overwrite the whole state
        # with a fragment. If the integration's state model ever changes, this test
        # should change with it rather than being treated as a conformance rule.
        collected = await self._drive(in_subagent=True)
        self.assertEqual(
            self._node_exit_snapshots(collected), [],
            "node-exit snapshots carry a partial subgraph view, so they are "
            "suppressed mid-delegation",
        )

    async def test_node_exit_state_snapshot_emitted_for_parent(self):
        # Control: the same node exit outside a subagent does emit one, so the
        # test above pins suppression rather than a path that never fires.
        collected = await self._drive(in_subagent=False)
        self.assertTrue(
            self._node_exit_snapshots(collected),
            "parent should still emit a node-exit STATE_SNAPSHOT",
        )


class TestInterruptWithOpenSubagent(unittest.IsolatedAsyncioTestCase):
    """An interrupt surfaces the pause by ENDING the run with RUN_FINISHED, and
    the client's verifyEvents rejects RUN_FINISHED while any subagent is still
    active. So a subagent suspended at a HITL interrupt must be finished before
    the run ends, or every interrupted run with an open subagent hard-errors on
    the client. drain_subagents was unit-tested in isolation but never on this
    path, which is the one where the ordering actually matters."""

    async def _drive(self, with_interrupt):
        agent = _make_agent()

        async def fake_prepare(*args, **kwargs):
            agent.active_run["schema_keys"] = {
                "input": ["messages"], "output": ["messages"],
                "config": [], "context": [],
            }

            async def gen():
                # A subagent opens and never closes: its task OnToolEnd never
                # fires because the graph paused at an interrupt inside it.
                yield {
                    "event": "on_chain_start",
                    "run_id": "run-1",
                    "name": "n",
                    "data": {},
                    "metadata": {
                        "langgraph_node": "n",
                        "langgraph_checkpoint_ns": "tools:s1|model:inner",
                        "lc_agent_name": "researcher",
                    },
                }

            return {
                "stream": gen(),
                "state": MagicMock(values={"messages": []}),
                "config": {"configurable": {"thread_id": "t1"}},
            }

        agent.prepare_stream = fake_prepare
        final_state = MagicMock()
        final_state.values = {"messages": []}
        final_state.next = ["n"] if with_interrupt else []
        final_state.metadata = {"writes": {}}
        if with_interrupt:
            task = MagicMock()
            # Real strings, not mocks: AGUIInterrupt validates id as a str.
            interrupt = MagicMock()
            interrupt.id = "int-1"
            interrupt.value = "please confirm"
            task.interrupts = [interrupt]
            final_state.tasks = [task]
        else:
            final_state.tasks = []
        agent.graph.aget_state = AsyncMock(return_value=final_state)

        run_input = MagicMock()
        run_input.run_id = "run-1"
        run_input.thread_id = "t1"
        run_input.forwarded_props = {}

        collected = []
        async for ev in agent._handle_stream_events(run_input):
            collected.append(ev)
        return [getattr(e, "type", None) for e in collected], collected

    async def test_open_subagent_is_finished_before_run_finished_on_interrupt(self):
        types, collected = await self._drive(with_interrupt=True)

        self.assertIn(EventType.SUBAGENT_STARTED, types)
        self.assertIn(EventType.SUBAGENT_FINISHED, types)
        self.assertIn(EventType.RUN_FINISHED, types)
        self.assertLess(
            types.index(EventType.SUBAGENT_FINISHED),
            types.index(EventType.RUN_FINISHED),
            "SUBAGENT_FINISHED must precede RUN_FINISHED or the client rejects the run",
        )
        # Exactly one terminal event, and it is last — nothing trails it.
        terminal = [t for t in types if t in (EventType.RUN_FINISHED, EventType.RUN_ERROR)]
        self.assertEqual(len(terminal), 1)
        self.assertEqual(types[-1], EventType.RUN_FINISHED)

    async def test_open_subagent_is_finished_before_run_finished_without_interrupt(self):
        # Same invariant on the ordinary completion path.
        types, _ = await self._drive(with_interrupt=False)
        self.assertIn(EventType.SUBAGENT_FINISHED, types)
        self.assertLess(
            types.index(EventType.SUBAGENT_FINISHED),
            types.index(EventType.RUN_FINISHED),
        )
        self.assertEqual(types[-1], EventType.RUN_FINISHED)

    async def test_end_of_run_snapshots_are_not_attributed_to_the_open_subagent(self):
        # current_subagent_run_id is cleared before the supervisor-level end-of-run
        # events, so the final snapshots belong to the parent.
        _, collected = await self._drive(with_interrupt=False)
        for ev in collected:
            if getattr(ev, "type", None) in (
                EventType.STATE_SNAPSHOT,
                EventType.MESSAGES_SNAPSHOT,
            ):
                self.assertIsNone(
                    getattr(ev, "subagent_run_id", None),
                    f"end-of-run {ev.type} must not be attributed to a subagent",
                )

    async def test_end_of_run_step_close_pairs_with_whoever_opened_it(self):
        # STEP_* is different from the snapshots: a step is a matched pair, so its
        # close belongs to whichever lane opened it even when that lane is a
        # subagent and the run is ending. Reattributing the close to the parent
        # just because current_subagent_run_id was cleared would emit
        # `STEP_STARTED under s1` / `STEP_FINISHED under None` for one step.
        #
        # Safe with respect to the terminal rule because the step close happens
        # before drain_subagents emits SUBAGENT_FINISHED, so the owner is still
        # open at that point.
        _, collected = await self._drive(with_interrupt=False)
        types = [getattr(e, "type", None) for e in collected]
        starts = [e for e in collected if getattr(e, "type", None) == EventType.STEP_STARTED]
        finishes = [e for e in collected if getattr(e, "type", None) == EventType.STEP_FINISHED]

        self.assertTrue(starts and finishes, f"expected a step pair, got {types}")
        for start, finish in zip(starts, finishes):
            self.assertEqual(start.step_name, finish.step_name)
            self.assertEqual(
                start.subagent_run_id, finish.subagent_run_id,
                "a step's two halves must carry the same owner",
            )

        # And the close still precedes the subagent's terminal event.
        self.assertLess(
            types.index(EventType.STEP_FINISHED),
            types.index(EventType.SUBAGENT_FINISHED),
        )


class TestClosedSubagentsNeverRestart(unittest.TestCase):
    """SUBAGENT_FINISHED is terminal for the id it names.

    reconcile_subagents emits SUBAGENT_STARTED for any id not currently in
    `active_subagents`, and both _finish_subagent_on_task_end and drain_subagents
    REMOVE the id from that dict when they close it. Nothing recorded that the id
    had already been closed, so a single trailing event bearing the finished
    subagent's namespace re-opened it: two SUBAGENT_STARTED and two terminals for
    one invocation, and output after a terminal.
    """

    def test_finished_subagent_is_not_restarted_by_a_trailing_event(self):
        ar = _run()
        ar["subagent_segments"] = set()

        ns = "tools:s1|model:x"
        first = reconcile_subagents(ar, ns, "researcher", set())
        self.assertEqual([e.type for e in first], [EventType.SUBAGENT_STARTED])

        # The `task` delegation returns and the subagent is closed.
        drained = drain_subagents(ar)
        self.assertEqual([e.type for e in drained], [EventType.SUBAGENT_FINISHED])

        # A trailing event from the same namespace arrives (the subagent's inner
        # tooling can emit after its task tool returns).
        again = reconcile_subagents(ar, ns, "researcher", set())
        self.assertEqual(
            [e.type for e in again], [],
            "a closed subagent must not be re-opened by a trailing event",
        )

    def test_events_after_close_keep_their_true_owner(self):
        ar = _run()
        ar["subagent_segments"] = set()
        ns = "tools:s1|model:x"

        reconcile_subagents(ar, ns, "researcher", set())
        drain_subagents(ar)
        reconcile_subagents(ar, ns, "researcher", set())

        self.assertEqual(
            ar["current_subagent_run_id"], "tools:s1",
            "the protocol permits attributing output to an already-finished subagent, "
            "so trailing output keeps its true owner rather than becoming the parent's",
        )

    def test_closed_subagent_namespace_still_suppresses_state(self):
        """Not re-opening a closed subagent must not hand its state to the parent.

        Routing a trailing event from a closed subagent's namespace to the root lane
        fixes the duplicate SUBAGENT_STARTED, but the state guards key on "is a
        subagent open?" — so with the lane cleared they stop firing, and a trailing
        node exit carrying the subagent's own state update escapes as an
        UNATTRIBUTED parent STATE_SNAPSHOT. Suppression has to key on whether the
        event came from a subagent's namespace at all, which is still true after the
        subagent closed.
        """
        ar = _run()
        ar["subagent_segments"] = set()
        ns = "tools:s1|model:x"

        reconcile_subagents(ar, ns, "researcher", set())
        drain_subagents(ar)
        reconcile_subagents(ar, ns, "researcher", set())

        self.assertEqual(
            ar["current_subagent_run_id"], "tools:s1",
            "attribution follows the namespace even after the subagent closed; blanking "
            "it would reparent the trailing output — and its state — to the parent",
        )

    def test_root_events_are_not_attributed(self):
        # Control: a genuine root event stays unattributed, so the parent's own state is
        # still emitted.
        ar = _run()
        ar["subagent_segments"] = set()
        reconcile_subagents(ar, "model:root-uuid", None, set())
        self.assertIsNone(ar["current_subagent_run_id"])

    def test_a_different_subagent_still_starts_normally(self):
        # Control: closing s1 must not suppress an unrelated subagent.
        ar = _run()
        ar["subagent_segments"] = set()

        reconcile_subagents(ar, "tools:s1|model:x", "researcher", set())
        drain_subagents(ar)
        events = reconcile_subagents(ar, "tools:s2|model:y", "writer", set())

        self.assertEqual([e.type for e in events], [EventType.SUBAGENT_STARTED])
        self.assertEqual(events[0].subagent_run_id, "tools:s2")

    def test_closed_set_is_per_run(self):
        # A fresh run reuses ids freely; the closed set is run-scoped like
        # active_subagents.
        ar = _run()
        ar["subagent_segments"] = set()
        reconcile_subagents(ar, "tools:s1|model:x", "researcher", set())
        drain_subagents(ar)

        fresh = _run()
        fresh["subagent_segments"] = set()
        events = reconcile_subagents(fresh, "tools:s1|model:x", "researcher", set())
        self.assertEqual([e.type for e in events], [EventType.SUBAGENT_STARTED])


class TestStepOwnership(unittest.TestCase):
    """A step's STEP_FINISHED must carry the lane that STARTED it.

    In the stream loop reconcile_subagents runs before handle_node_change, so by
    the time the previous node's step is closed, current_subagent_run_id already points
    at the NEW lane. Leaving STEP_FINISHED to the dispatch chokepoint therefore
    pairs `STEP_STARTED research` under s1 with `STEP_FINISHED research` under s2 —
    a step whose two halves belong to different owners.
    """

    def _agent(self):
        agent = _make_agent()
        agent.active_run = {
            "id": "run-1",
            "node_name": None,
            "current_subagent_run_id": None,
            "active_subagents": {},
            "subagent_messages": {},
        }
        return agent

    def test_concurrent_lanes_keep_their_own_steps_open(self):
        # Steps are per-lane, so an event from s2 does NOT close s1's step. Under the
        # old flat model any lane switch closed whatever step happened to be open,
        # which is what produced mismatched STEP_STARTED/STEP_FINISHED pairs.
        agent = self._agent()

        agent.active_run["current_subagent_run_id"] = "s1"
        started = list(agent.handle_node_change("research"))
        self.assertEqual([e.type for e in started], [EventType.STEP_STARTED])
        self.assertEqual(started[0].subagent_run_id, "s1")

        agent.active_run["current_subagent_run_id"] = "s2"
        transition = list(agent.handle_node_change("write"))

        self.assertEqual(
            [e.type for e in transition], [EventType.STEP_STARTED],
            "s2 starting work must not close s1's step",
        )
        self.assertEqual(transition[0].subagent_run_id, "s2")

        # Each lane still closes under its own owner when it ends.
        closes = close_lane_steps(agent.active_run, ["s1", "s2"])
        self.assertEqual(
            [(e.step_name, e.subagent_run_id) for e in closes],
            [("research", "s1"), ("write", "s2")],
        )

    def test_parent_step_stays_open_across_a_subagent_run(self):
        # The shape a design partner reported: the parent's `tools` step wraps the
        # delegation, so it must NOT close when the subagent starts its own work, and
        # must not acquire the subagent's id. The subagent's step nests inside it --
        # even when it has the SAME name, which is normal since a subagent runs the
        # same graph shape.
        agent = self._agent()
        opened = list(agent.handle_node_change("tools"))
        self.assertEqual([e.type for e in opened], [EventType.STEP_STARTED])
        self.assertIsNone(opened[0].subagent_run_id)

        agent.active_run["current_subagent_run_id"] = "s1"
        agent.active_run["active_subagents"]["s1"] = "alpha"
        nested = list(agent.handle_node_change("tools"))

        self.assertEqual(
            [e.type for e in nested], [EventType.STEP_STARTED],
            "the parent's step must stay open across the subagent run",
        )
        self.assertEqual(nested[0].subagent_run_id, "s1")

        # The subagent's step closes inside its own window, tagged; the parent's is
        # still open afterwards and remains the parent's.
        drained = drain_subagents(agent.active_run)
        self.assertEqual(
            [(getattr(e, "step_name", None), e.subagent_run_id) for e in drained],
            [("tools", "s1"), (None, "s1")],
        )
        agent.active_run["current_subagent_run_id"] = None
        closing = list(agent.handle_node_change("model"))
        self.assertEqual(closing[0].type, EventType.STEP_FINISHED)
        self.assertEqual(closing[0].step_name, "tools")
        self.assertIsNone(
            closing[0].subagent_run_id,
            "the parent's wrapping step closes as the parent's, after the subagent",
        )


class TestErrorOpenSubagents(unittest.TestCase):
    def test_emits_error_for_all_open_and_clears(self):
        active_run = {
            "active_subagents": {"tools:a": "x", "tools:b": "y"},
            "current_subagent_run_id": "tools:b",
        }
        events = error_open_subagents(active_run, "boom")
        self.assertEqual({e.subagent_run_id for e in events}, {"tools:a", "tools:b"})
        self.assertTrue(all(e.type == EventType.SUBAGENT_ERROR for e in events))
        self.assertTrue(all(e.message == "boom" for e in events))
        # Cleared so a subsequent drain_subagents can't also emit SUBAGENT_FINISHED
        # for a subagent that already errored.
        self.assertEqual(active_run["active_subagents"], {})
        self.assertIsNone(active_run["current_subagent_run_id"])

    def test_no_open_subagents_is_noop(self):
        active_run = {"active_subagents": {}, "current_subagent_run_id": None}
        self.assertEqual(error_open_subagents(active_run, "boom"), [])


class TestFinishSubagentOnTaskEnd(unittest.TestCase):
    def _agent(self):
        agent = _make_agent()
        agent.active_run = {
            "active_subagents": {},
            "current_subagent_run_id": None,
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
        agent.active_run["current_subagent_run_id"] = "tools:sub1"
        events = agent._finish_subagent_on_task_end(
            {"event": "on_tool_end", "run_id": "run-task-1"}
        )
        self.assertEqual([e.type for e in events], [EventType.SUBAGENT_FINISHED])
        self.assertEqual(events[0].subagent_run_id, "tools:sub1")
        self.assertEqual(agent.active_run["active_subagents"], {})
        self.assertIsNone(agent.active_run["current_subagent_run_id"])

    def test_finish_restores_parent_for_nested_subagent(self):
        """When a nested child finishes, the `task` result belongs to the
        invoking (outer) subagent — current_subagent_run_id must return to the
        parent, not the root (bug #3)."""
        agent = self._agent()
        agent.active_run["subagent_task_runs"]["run-child"] = "tools:child"
        agent.active_run["active_subagents"]["tools:child"] = "writer"
        agent.active_run["subagent_parents"] = {"tools:child": "tools:outer"}
        agent.active_run["current_subagent_run_id"] = "tools:child"
        agent._finish_subagent_on_task_end(
            {"event": "on_tool_end", "run_id": "run-child"}
        )
        self.assertEqual(agent.active_run["current_subagent_run_id"], "tools:outer")

    def test_nested_task_result_is_attributed_to_outer_subagent(self):
        """End-to-end observable of bug #3: after a nested child finishes, the
        `task` TOOL_CALL_RESULT dispatched at that level is stamped with the
        outer (invoking) subagent, and the child's parent entry is popped."""
        agent = self._agent()
        agent.active_run["subagent_task_runs"]["run-child"] = "tools:child"
        agent.active_run["active_subagents"]["tools:child"] = "writer"
        agent.active_run["subagent_parents"] = {"tools:child": "tools:outer"}
        agent.active_run["current_subagent_run_id"] = "tools:child"

        agent._finish_subagent_on_task_end(
            {"event": "on_tool_end", "run_id": "run-child"}
        )
        # The `task` result now dispatched belongs to the outer subagent.
        ev = agent._dispatch_event(ToolCallResultEvent(
            type=EventType.TOOL_CALL_RESULT,
            message_id="tr-1",
            tool_call_id="call-child",
            content="child done",
        ))
        self.assertEqual(ev.subagent_run_id, "tools:outer")
        self.assertNotIn("tools:child", agent.active_run["subagent_parents"])

    def test_finish_restores_none_for_top_level_subagent(self):
        """A top-level subagent's parent is the root, so finishing it returns
        current_subagent_run_id to None — unchanged single-level behavior."""
        agent = self._agent()
        agent.active_run["subagent_task_runs"]["run-1"] = "tools:sub1"
        agent.active_run["active_subagents"]["tools:sub1"] = "researcher"
        agent.active_run["subagent_parents"] = {"tools:sub1": None}
        agent.active_run["current_subagent_run_id"] = "tools:sub1"
        agent._finish_subagent_on_task_end(
            {"event": "on_tool_end", "run_id": "run-1"}
        )
        self.assertIsNone(agent.active_run["current_subagent_run_id"])

    def test_parallel_task_calls_link_each_subagent_fifo(self):
        """Two subagents fanned out in one turn each get their OWN
        parentToolCallId (bug #4: previously only the first was queued, so the
        second got None)."""
        agent = self._agent()
        agent.active_run["pending_task_calls"] = [
            {"tool_call_id": "call-a", "parent_message_id": "msg-1"},
            {"tool_call_id": "call-b", "parent_message_id": "msg-1"},
        ]
        agent._capture_subagent_task_meta({
            "event": "on_tool_start", "run_id": "run-a",
            "data": {"input": {"subagent_type": "researcher", "description": "A"}},
            "metadata": {"langgraph_checkpoint_ns": "tools:subA|model:x"},
        })
        agent._capture_subagent_task_meta({
            "event": "on_tool_start", "run_id": "run-b",
            "data": {"input": {"subagent_type": "writer", "description": "B"}},
            "metadata": {"langgraph_checkpoint_ns": "tools:subB|model:y"},
        })
        self.assertEqual(
            agent.active_run["subagent_task_meta"]["tools:subA"]["parent_tool_call_id"],
            "call-a",
        )
        self.assertEqual(
            agent.active_run["subagent_task_meta"]["tools:subB"]["parent_tool_call_id"],
            "call-b",
        )
        self.assertEqual(agent.active_run["pending_task_calls"], [])

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


class TestRobustParentLinkJoin(unittest.TestCase):
    """Parent-call links are matched by the per-call ToolNode dispatch
    namespace, not FIFO, so reordered tool starts (async wrappers, HITL, or
    default concurrent scheduling) can't swap sibling subagents' links (P2)."""

    def _agent(self):
        agent = _make_agent()
        agent.active_run = {
            "active_subagents": {},
            "current_subagent_run_id": None,
            "subagent_task_meta": {},
            "subagent_task_runs": {},
            "pending_task_calls": [
                {"tool_call_id": "call-a", "parent_message_id": "msg-1"},
                {"tool_call_id": "call-b", "parent_message_id": "msg-1"},
            ],
            "task_tool_call_ids_by_ns": {},
        }
        return agent

    def _dispatch(self, agent, ns, call_ids, run_id="run-x"):
        calls = [call_ids] if isinstance(call_ids, str) else call_ids
        agent._capture_task_tool_dispatch({
            "event": "on_chain_start",
            "name": "tools",
            "run_id": run_id,
            "metadata": {"langgraph_node": "tools", "langgraph_checkpoint_ns": ns},
            "data": {"input": [
                {"type": "tool_call", "id": c, "name": "task", "args": {}} for c in calls
            ]},
        })

    def _task_start(self, agent, ns, run_id, subagent_type, parent_ids=None):
        agent._capture_subagent_task_meta({
            "event": "on_tool_start",
            "run_id": run_id,
            "parent_ids": parent_ids or [],
            "data": {"input": {"subagent_type": subagent_type, "description": subagent_type}},
            "metadata": {"langgraph_checkpoint_ns": ns},
        })

    def test_reordered_tool_starts_do_not_swap_parent_links(self):
        agent = self._agent()
        # ToolNode dispatches arrive in tool_calls order (A, then B)...
        self._dispatch(agent, "tools:subA", "call-a", "run-A")
        self._dispatch(agent, "tools:subB", "call-b", "run-B")
        # ...but the task on_tool_start events arrive REVERSED (B, then A).
        self._task_start(agent, "tools:subB", "task-run-B", "writer")
        self._task_start(agent, "tools:subA", "task-run-A", "researcher")
        meta = agent.active_run["subagent_task_meta"]
        # Each subagent is still linked to ITS OWN call — FIFO would have
        # swapped these (B->call-a, A->call-b).
        self.assertEqual(meta["tools:subB"]["parent_tool_call_id"], "call-b")
        self.assertEqual(meta["tools:subA"]["parent_tool_call_id"], "call-a")
        self.assertEqual(meta["tools:subB"]["parent_message_id"], "msg-1")
        self.assertEqual(meta["tools:subA"]["parent_message_id"], "msg-1")
        self.assertEqual(agent.active_run["pending_task_calls"], [])

    def test_fifo_fallback_when_no_dispatch_captured(self):
        # Older/batched ToolNode shape: no per-call dispatch captured -> FIFO.
        agent = self._agent()
        self._task_start(agent, "tools:subA", "task-run-A", "researcher")
        self.assertEqual(
            agent.active_run["subagent_task_meta"]["tools:subA"]["parent_tool_call_id"],
            "call-a",
        )

    def test_batched_multi_task_dispatch_left_to_fifo(self):
        # A single ToolNode namespace carrying TWO task calls is ambiguous, so
        # _capture_task_tool_dispatch records nothing and FIFO is used.
        agent = self._agent()
        self._dispatch(agent, "tools:x", ["call-a", "call-b"])
        self.assertEqual(agent.active_run["task_tool_call_ids_by_ns"], {})
        # The subagent then falls through to FIFO (first queued call).
        self._task_start(agent, "tools:x", "task-run-x", "researcher")
        self.assertEqual(
            agent.active_run["subagent_task_meta"]["tools:x"]["parent_tool_call_id"],
            "call-a",
        )

    def test_nested_uncaptured_child_does_not_match_ancestor(self):
        """Regression for the ancestor-run fallback bug: a nested child whose
        own dispatch was NOT captured (batched) must fall to FIFO, NOT borrow
        the outer subagent's captured call via a parent_ids/run-id scan."""
        agent = self._agent()
        # pending is [call-a, call-b]; add the child's second call.
        agent.active_run["pending_task_calls"].append(
            {"tool_call_id": "call-c", "parent_message_id": "msg-1"}
        )
        # Outer dispatch captured; outer subagent starts and claims call-a by ns.
        self._dispatch(agent, "tools:outer", "call-a", run_id="run-outer")
        self._task_start(agent, "tools:outer", "task-run-outer", "outer")
        self.assertEqual(
            agent.active_run["subagent_task_meta"]["tools:outer"]["parent_tool_call_id"],
            "call-a",
        )
        # Child dispatch is BATCHED (two calls in one ns) -> not captured.
        self._dispatch(agent, "tools:outer|tools:child", ["call-b", "call-c"],
                       run_id="run-child")
        self.assertNotIn("tools:outer|tools:child",
                         agent.active_run["task_tool_call_ids_by_ns"])
        # Child task start: ns uncaptured; parent_ids includes the outer
        # ToolNode run. Must fall to FIFO (call-b), NOT borrow the outer's
        # call-a. (With the old run-id fallback this returned call-a.)
        self._task_start(agent, "tools:outer|tools:child", "task-run-child", "writer",
                         parent_ids=["run-outer"])
        link = agent.active_run["subagent_task_meta"]["tools:child"]["parent_tool_call_id"]
        self.assertEqual(link, "call-b")
        self.assertNotEqual(link, "call-a")


class TestCrossTurnPersistence(unittest.TestCase):
    def _agent(self, inbound):
        agent = _make_agent()
        agent.active_run = {
            "id": "run-1",
            "current_subagent_run_id": None,
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
            subagent_run_id="tools:s1",
        )
        snap = self._snapshot(self._agent([prior]))
        ids = [(m.id, getattr(m, "subagent_run_id", None)) for m in snap.messages]
        self.assertIn(("prev-sub-1", "tools:s1"), ids)

    def test_inbound_deduped_by_id(self):
        prior = AssistantMessage(
            id="dup", role="assistant", content="x", subagent_run_id="tools:s1",
        )
        snap = self._snapshot(self._agent([prior, prior]))
        self.assertEqual(sum(1 for m in snap.messages if m.id == "dup"), 1)


if __name__ == "__main__":
    unittest.main()


class TestSubagentNewFields(unittest.TestCase):
    def test_started_carries_parent_links_from_task_meta(self):
        ar = {"active_subagents": {}, "current_subagent_run_id": None,
              "subagent_task_meta": {"tools:s1": {
                  "name": "alpha", "description": "d",
                  "parent_tool_call_id": "call-1", "parent_message_id": "msg-1"}}}
        evs = reconcile_subagents(ar, "tools:s1|model:x", "alpha", set())
        self.assertEqual([e.type for e in evs], [EventType.SUBAGENT_STARTED])
        self.assertEqual(evs[0].parent_tool_call_id, "call-1")
        self.assertEqual(evs[0].parent_message_id, "msg-1")
        self.assertIsNone(evs[0].parent_subagent_run_id)
        self.assertEqual(evs[0].description, "d")

    def test_finish_includes_result_from_command_output(self):
        agent = _make_agent()
        agent.active_run = {"active_subagents": {"tools:sub1": "alpha"},
                            "current_subagent_run_id": "tools:sub1",
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


class TestNestedSubagentParent(unittest.TestCase):
    def test_parent_derived_from_boundary_segments(self):
        # Mirrors the real nested-run namespaces (supervisor -> outer -> inner):
        #   outer events:  tools:a|model
        #   inner events:  tools:a|tools:b|model
        #   inner's tool:  tools:a|tools:b|tools:c   (c is NOT a subagent)
        ar = {"active_subagents": {}, "current_subagent_run_id": None,
              "subagent_segments": set()}

        e1 = reconcile_subagents(ar, "tools:a|model:x", "outer", set())
        self.assertEqual([e.subagent_run_id for e in e1], ["tools:a"])
        self.assertIsNone(e1[0].parent_subagent_run_id)

        e2 = reconcile_subagents(ar, "tools:a|tools:b|model:y", "inner", set())
        self.assertEqual([e.subagent_run_id for e in e2], ["tools:b"])
        self.assertEqual(e2[0].parent_subagent_run_id, "tools:a")  # <-- the parent link

        # inner running its OWN tool: c is a leaf, not a subagent boundary, so the
        # event stays attributed to inner (tools:b) and emits no new SUBAGENT_STARTED.
        e3 = reconcile_subagents(ar, "tools:a|tools:b|tools:c", "inner", set())
        self.assertEqual(e3, [])
        self.assertEqual(ar["current_subagent_run_id"], "tools:b")
