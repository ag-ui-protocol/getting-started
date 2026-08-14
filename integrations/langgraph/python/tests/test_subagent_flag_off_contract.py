"""The governing contract for ``emit_subagent_events``.

With the flag OFF (the default) the emitted stream must be indistinguishable
from the pre-subagent integration: no SUBAGENT_* events, no ``subagentRunId``
anywhere, no step-structure change, no MESSAGES_SNAPSHOT change and no
state-snapshot change. Subagent *bookkeeping* still runs (other paths read it),
so every place that reads that bookkeeping to decide what to EMIT has to be
gated on the flag as well -- the violations pinned here.

The flag-ON tests in this module cover the step-lifecycle invariants that the
same bookkeeping controls: every STEP_STARTED must be paired with a
STEP_FINISHED carrying the same (owner, name), or clients abort the run with
"steps are still active".
"""
import logging
import unittest
from unittest.mock import AsyncMock, MagicMock

from ag_ui.core import AssistantMessage, EventType, ToolMessage as AGUIToolMessage
from ag_ui_langgraph.agent import LangGraphAgent, drain_subagents, error_open_subagents

try:
    from langchain.schema import ToolMessage
except ImportError:  # langchain >= 1.0
    from langchain_core.messages import ToolMessage


def _make_agent(emit_subagent_events=False):
    from langgraph.graph.state import CompiledStateGraph

    graph = MagicMock(spec=CompiledStateGraph)
    graph.config_specs = []
    graph.nodes = {}
    state = MagicMock()
    state.values = {"messages": []}
    state.tasks = []
    state.next = []
    state.metadata = {"writes": {}}
    graph.aget_state = AsyncMock(return_value=state)
    return LangGraphAgent(
        name="test", graph=graph, emit_subagent_events=emit_subagent_events
    )


async def _drive(agent, events):
    """Drive ``_handle_stream_events`` over a canned LangGraph event list.

    The lane of every event is derived from its own metadata (nested checkpoint
    ns + ``lc_agent_name``) by reconcile_subagents, exactly as in production --
    nothing here sets ``current_subagent_run_id`` by hand, so the tests pin the
    behaviour where it actually runs rather than at a helper.
    """

    async def fake_prepare(*args, **kwargs):
        agent.active_run["schema_keys"] = {
            "input": ["messages"], "output": ["messages"],
            "config": [], "context": [],
        }

        async def gen():
            for event in events:
                yield event

        return {
            "stream": gen(),
            "state": MagicMock(values={"messages": []}),
            "config": {"configurable": {"thread_id": "t1"}},
        }

    agent.prepare_stream = fake_prepare

    run_input = MagicMock()
    run_input.run_id = "run-1"
    run_input.thread_id = "t1"
    run_input.forwarded_props = {}

    return [ev async for ev in agent._handle_stream_events(run_input)]


async def _drive_with_state(agent, events, tasks=None):
    """Like ``_drive``, but the FINAL checkpoint state carries ``tasks`` —
    for pinning the interrupt path, where state.tasks is what decides whether
    the run actually suspended."""

    async def fake_prepare(*args, **kwargs):
        agent.active_run["schema_keys"] = {
            "input": ["messages"], "output": ["messages"],
            "config": [], "context": [],
        }

        async def gen():
            for event in events:
                yield event

        return {
            "stream": gen(),
            "state": MagicMock(values={"messages": []}),
            "config": {"configurable": {"thread_id": "t1"}},
        }

    agent.prepare_stream = fake_prepare
    final_state = MagicMock()
    final_state.values = {"messages": []}
    final_state.tasks = tasks or []
    final_state.next = []
    final_state.metadata = {"writes": {}}
    agent.graph.aget_state = AsyncMock(return_value=final_state)

    run_input = MagicMock()
    run_input.run_id = "run-1"
    run_input.thread_id = "t1"
    run_input.forwarded_props = {}

    return [ev async for ev in agent._handle_stream_events(run_input)]


def _sub_meta(sid, node, name="researcher"):
    return {
        "langgraph_node": node,
        "langgraph_checkpoint_ns": f"tools:{sid}|model:inner",
        "lc_agent_name": name,
    }


def _chain_start(node, metadata, run_id="r-x"):
    return {
        "event": "on_chain_start",
        "run_id": run_id,
        "name": node,
        "data": {},
        "metadata": metadata,
    }


def _types(collected):
    return [getattr(e, "type", None) for e in collected]


def _step_key(pair):
    """Sort key tolerating the parent lane's ``None`` owner."""
    owner, name = pair
    return (owner or "", name or "")


def _steps(collected):
    """The (owner, step_name) pairs opened and closed, in emission order."""
    starts = [
        (e.subagent_run_id, e.step_name)
        for e in collected
        if getattr(e, "type", None) == EventType.STEP_STARTED
    ]
    finishes = [
        (e.subagent_run_id, e.step_name)
        for e in collected
        if getattr(e, "type", None) == EventType.STEP_FINISHED
    ]
    return starts, finishes


class TestFlagOffStateSnapshotsSurvive(unittest.IsolatedAsyncioTestCase):
    """Fix 1: the two state-snapshot suppressions were not gated on the flag.

    ``reconcile_subagents`` sets ``current_subagent_run_id`` unconditionally
    (other paths read it), so with the flag OFF both suppressions fired and
    silently withheld snapshots that pre-subagent main emitted during a
    delegation -- a state regression invisible to the client.
    """

    async def _node_exit(self, agent):
        collected = await _drive(agent, [
            _chain_start("n", {"langgraph_node": "n"}, run_id="run-1"),
            {
                "event": "on_chain_end",
                "run_id": "run-1",
                "name": "n",
                "data": {"output": {"custom_key": "from_graph"}},
                "metadata": _sub_meta("s1", "n"),
            },
        ])
        # The end-of-run snapshots carry no raw_event; keying on the on_chain_end
        # raw_event isolates the node-exit one.
        return [
            e for e in collected
            if getattr(e, "type", None) == EventType.STATE_SNAPSHOT
            and (getattr(e, "raw_event", None) or {}).get("event") == "on_chain_end"
        ]

    async def test_node_exit_snapshot_still_emitted_with_the_flag_off(self):
        self.assertTrue(
            await self._node_exit(_make_agent(emit_subagent_events=False)),
            "with the flag off the node-exit STATE_SNAPSHOT must be emitted "
            "exactly as it was before subagent support",
        )

    async def test_node_exit_snapshot_still_suppressed_with_the_flag_on(self):
        # Control: the suppression itself is unchanged when the caller opted in.
        self.assertEqual(await self._node_exit(_make_agent(emit_subagent_events=True)), [])

    def _checkpoint_agent(self, emit_subagent_events):
        agent = _make_agent(emit_subagent_events=emit_subagent_events)
        agent.active_run = {
            "id": "run-1",
            "current_subagent_run_id": "tools:s1",
            "active_subagents": {"tools:s1": "researcher"},
            "subagent_messages": {},
            "subagent_tool_call_owner": {},
            "inbound_subagent_messages": [],
            "schema_keys": {
                "input": ["messages"], "output": ["messages"],
                "config": [], "context": [],
            },
        }
        return agent

    async def test_checkpoint_snapshot_still_emitted_with_the_flag_off(self):
        agent = self._checkpoint_agent(False)
        types = [
            e.type
            async for e in agent.get_state_and_messages_snapshots({})
        ]
        self.assertIn(
            EventType.STATE_SNAPSHOT, types,
            "the checkpoint STATE_SNAPSHOT must not be withheld when the caller "
            "never opted into subagent behaviour",
        )

    async def test_checkpoint_snapshot_still_suppressed_with_the_flag_on(self):
        agent = self._checkpoint_agent(True)
        types = [
            e.type
            async for e in agent.get_state_and_messages_snapshots({})
        ]
        self.assertNotIn(EventType.STATE_SNAPSHOT, types)
        self.assertIn(EventType.MESSAGES_SNAPSHOT, types)


class TestTrailingEventStepIsClosed(unittest.IsolatedAsyncioTestCase):
    """Fix 2: a trailing event from a CLOSED subagent opened a step nothing closed.

    reconcile_subagents deliberately keeps attributing trailing events to the
    finished subagent (blanking the lane would reparent its output), so
    handle_node_change opens a new step in that closed lane. drain_subagents only
    closed lanes for ids still in ``active_subagents``, so the step survived to
    RUN_FINISHED and clients abort with "steps are still active".
    """

    async def _run(self):
        agent = _make_agent(emit_subagent_events=True)
        return await _drive(agent, [
            # The `task` delegation starts, in the subagent's own namespace.
            {
                "event": "on_tool_start",
                "run_id": "task-run",
                "name": "task",
                "data": {"input": {"subagent_type": "researcher", "description": "d"}},
                "metadata": {"langgraph_checkpoint_ns": "tools:s1"},
            },
            # The subagent works: SUBAGENT_STARTED + a step in its own lane.
            _chain_start("n1", _sub_meta("s1", "n1"), run_id="r2"),
            # The task returns: the lane's step closes and s1 gets its terminal.
            {
                "event": "on_tool_end",
                "run_id": "task-run",
                "name": "task",
                "data": {"output": None},
                "metadata": {"langgraph_checkpoint_ns": "tools:s1"},
            },
            # TRAILING event: still s1's namespace (its inner tooling can emit
            # after the task tool returns) but a NEW node -> a step opens in the
            # already-closed lane.
            _chain_start("n2", _sub_meta("s1", "n2"), run_id="r4"),
        ]), agent

    async def test_the_trailing_lanes_step_is_closed_at_drain(self):
        collected, agent = await self._run()
        starts, finishes = _steps(collected)
        self.assertIn(
            ("tools:s1", "n2"), starts,
            "setup check: the trailing event must open a step in the closed lane",
        )
        self.assertIn(
            ("tools:s1", "n2"), finishes,
            "a step opened in a closed subagent's lane must still be closed "
            "before RUN_FINISHED",
        )

    async def test_every_step_start_has_a_matching_finish(self):
        collected, agent = await self._run()
        starts, finishes = _steps(collected)
        self.assertEqual(
            sorted(starts, key=_step_key), sorted(finishes, key=_step_key),
            "every STEP_STARTED needs a STEP_FINISHED on the same "
            "(subagent_run_id, step_name) or the client aborts the run",
        )

    async def test_no_lane_is_left_open(self):
        collected, agent = await self._run()
        # active_run is torn down in the finally block, so assert on the emitted
        # stream plus the drain's own view: nothing may remain closable.
        self.assertEqual(
            _types(collected)[-1], EventType.RUN_FINISHED,
        )

    async def test_the_closed_subagent_gets_exactly_one_terminal(self):
        # Closing the leaked step must NOT hand s1 a second SUBAGENT_FINISHED:
        # a terminal is terminal for the id it names.
        collected, agent = await self._run()
        finished = [
            e for e in collected
            if getattr(e, "type", None) == EventType.SUBAGENT_FINISHED
        ]
        self.assertEqual([e.subagent_run_id for e in finished], ["tools:s1"])


class TestPerLaneStepTransitions(unittest.IsolatedAsyncioTestCase):
    """Fix 4: the step-transition guard compared against the GLOBAL node name.

    ``active_run["node_name"]`` is a single flat field last written by whichever
    lane transitioned. Two lanes on the SAME node name therefore collided: the
    second lane's transition looked like a no-op and its step never opened.
    """

    async def test_two_lanes_on_the_same_node_name_each_open_their_step(self):
        agent = _make_agent(emit_subagent_events=True)
        collected = await _drive(agent, [
            # Parent enters `tools` (the delegation wrapper).
            _chain_start("tools", {"langgraph_node": "tools"}, run_id="r1"),
            # s1 works in node `model`.
            _chain_start("model", _sub_meta("s1", "model", "alpha"), run_id="r2"),
            # s2 works in node `model` TOO -- same name, different lane.
            _chain_start("model", _sub_meta("s2", "model", "beta"), run_id="r3"),
        ])
        starts, finishes = _steps(collected)
        self.assertIn(
            ("tools:s2", "model"), starts,
            "s2 must get its own STEP_STARTED even though another lane is "
            "already on a node of the same name",
        )
        self.assertIn((None, "tools"), starts)
        self.assertIn(("tools:s1", "model"), starts)
        self.assertEqual(
            sorted(starts, key=_step_key), sorted(finishes, key=_step_key),
            "each lane's step must close under its own owner",
        )


class TestFlagOffStreamLoopGate(unittest.IsolatedAsyncioTestCase):
    """The two-line gate in the stream loop that withholds SUBAGENT_* events.

    This must fail if someone deletes it: a DEFAULT-constructed agent driven
    over unmistakably subagent-shaped events may not emit a single SUBAGENT_*
    event of any type, and the subagent's text must still reach the client
    untagged (it arrives as the parent's own work).
    """

    async def _run(self):
        agent = _make_agent(emit_subagent_events=False)
        return await _drive(agent, [
            _chain_start("model", _sub_meta("s1", "model"), run_id="r1"),
            {
                "event": "on_chat_model_stream",
                "run_id": "r2",
                "name": "model",
                "data": {"chunk": {
                    "id": "chunk-1",
                    "content": "from the subagent",
                    "tool_call_chunks": [],
                    "response_metadata": {},
                }},
                "metadata": {
                    **_sub_meta("s1", "model"),
                    "emit-messages": True,
                    "emit-tool-calls": True,
                },
            },
        ])

    async def test_no_subagent_event_of_any_type_is_emitted(self):
        collected = await self._run()
        leaked = [
            t for t in _types(collected)
            if t is not None and str(getattr(t, "value", t)).upper().startswith("SUBAGENT")
        ]
        self.assertEqual(
            leaked, [],
            "a released @ag-ui/client rejects unknown event types as they come "
            "off the wire, so not one SUBAGENT_* event may escape",
        )

    async def test_the_subagent_text_still_flows_untagged(self):
        collected = await self._run()
        text = [
            e for e in collected
            if getattr(e, "type", None) in (
                EventType.TEXT_MESSAGE_START, EventType.TEXT_MESSAGE_CONTENT
            )
        ]
        self.assertTrue(text, "the subagent's text must still reach the client")
        for ev in text:
            self.assertIsNone(
                getattr(ev, "subagent_run_id", None),
                "with the flag off nothing may carry subagentRunId",
            )

    async def test_nothing_at_all_carries_subagent_attribution(self):
        collected = await self._run()
        for ev in collected:
            self.assertIsNone(
                getattr(ev, "subagent_run_id", None),
                f"{getattr(ev, 'type', None)} leaked a subagentRunId",
            )


class TestFlagOffInboundMessagesSurvive(unittest.TestCase):
    """Fix 3: inbound subagent-attributed messages were silently DELETED.

    ``run()`` splits every message carrying a ``subagent_run_id`` out of the
    graph input unconditionally (they must never enter supervisor state), but
    the re-emission early-returned when the flag was off -- so prior turns'
    subagent messages vanished from MESSAGES_SNAPSHOT and the client, whose
    snapshot apply is authoritative, deleted them.
    """

    def _agent(self, emit_subagent_events, inbound):
        agent = _make_agent(emit_subagent_events=emit_subagent_events)
        agent.active_run = {
            "id": "run-1",
            "current_subagent_run_id": None,
            "active_subagents": {},
            "subagent_messages": {},
            "subagent_tool_call_owner": {},
            "inbound_subagent_messages": inbound,
        }
        return agent

    def test_flag_off_keeps_them_but_strips_the_attribution(self):
        prior = AssistantMessage(
            id="prev-sub-1", role="assistant", content="earlier finding",
            subagent_run_id="tools:s1",
        )
        agent = self._agent(False, [prior])
        merged = agent._merge_subagent_messages([])
        by_id = {m.id: m for m in merged}
        self.assertIn(
            "prev-sub-1", by_id,
            "the split removed it from graph input, so the snapshot is the only "
            "thing keeping it in the client's display",
        )
        self.assertIsNone(
            by_id["prev-sub-1"].subagent_run_id,
            "with the flag off it must surface as an ordinary parent message",
        )
        self.assertEqual(by_id["prev-sub-1"].content, "earlier finding")
        self.assertEqual(
            prior.subagent_run_id, "tools:s1",
            "the inbound message itself must not be mutated in place",
        )

    def test_flag_off_strips_attribution_from_tool_messages_too(self):
        prior = AGUIToolMessage(
            id="prev-tool-1", role="tool", content="ok", tool_call_id="call-1",
            subagent_run_id="tools:s1",
        )
        merged = self._agent(False, [prior])._merge_subagent_messages([])
        self.assertEqual([m.id for m in merged], ["prev-tool-1"])
        self.assertIsNone(merged[0].subagent_run_id)

    def test_flag_off_does_not_duplicate_a_message_already_in_the_snapshot(self):
        prior = AssistantMessage(
            id="dup", role="assistant", content="x", subagent_run_id="tools:s1",
        )
        existing = AssistantMessage(id="dup", role="assistant", content="x")
        merged = self._agent(False, [prior])._merge_subagent_messages([existing])
        self.assertEqual([m.id for m in merged], ["dup"])

    def test_flag_off_still_merges_nothing_from_this_runs_stream(self):
        # Only the inbound (client-echoed) messages are re-emitted with the flag
        # off; this run's freshly-streamed subagent messages are already on the
        # wire as the parent's own work, so merging them would duplicate them.
        agent = self._agent(False, [])
        agent.active_run["subagent_messages"] = {
            "m1": {
                "kind": "assistant", "id": "m1", "role": "assistant",
                "content": "streamed", "subagent_run_id": "tools:s1",
                "tool_calls": {},
            }
        }
        self.assertEqual(agent._merge_subagent_messages([]), [])

    def test_flag_on_keeps_the_attribution(self):
        prior = AssistantMessage(
            id="prev-sub-1", role="assistant", content="earlier finding",
            subagent_run_id="tools:s1",
        )
        merged = self._agent(True, [prior])._merge_subagent_messages([])
        self.assertEqual(merged[0].subagent_run_id, "tools:s1")

    def test_the_docstring_is_reachable(self):
        # The docstring sat BELOW the early return, so it was a no-op statement
        # and __doc__ was None -- the method looked undocumented to help().
        self.assertIsNotNone(LangGraphAgent._merge_subagent_messages.__doc__)


class TestTaskEndResultExtraction(unittest.TestCase):
    """Fix 6: ``msgs[0]`` was an unguarded index on an untyped payload.

    A single ToolMessage (rather than a list) raised TypeError inside the
    stream loop, which the run-level ``except`` turned into a failed run;
    dict-shaped messages silently produced no result at all.
    """

    def _agent(self):
        agent = _make_agent(emit_subagent_events=True)
        agent.active_run = {
            "active_subagents": {"tools:s1": "researcher"},
            "current_subagent_run_id": "tools:s1",
            "subagent_task_runs": {"run-1": "tools:s1"},
        }
        return agent

    def _finish(self, output):
        agent = self._agent()
        return agent._finish_subagent_on_task_end(
            {"event": "on_tool_end", "run_id": "run-1", "data": {"output": output}}
        )

    def test_a_single_tool_message_instead_of_a_list_does_not_raise(self):
        class _Cmd:
            update = {"messages": ToolMessage(content="solo", tool_call_id="c1")}

        events = self._finish(_Cmd())
        self.assertEqual([e.type for e in events], [EventType.SUBAGENT_FINISHED])
        self.assertIsNone(
            events[0].result,
            "an un-listed payload yields no result rather than killing the run",
        )

    def test_a_dict_shaped_message_still_yields_its_content(self):
        class _Cmd:
            update = {"messages": [{"role": "tool", "content": "dict result"}]}

        events = self._finish(_Cmd())
        self.assertEqual(events[0].result, "dict result")

    def test_the_first_tool_message_wins_over_a_leading_non_tool_message(self):
        class _NotAToolMessage:
            content = "the assistant's own text"

        class _Cmd:
            update = {"messages": [
                _NotAToolMessage(),
                ToolMessage(content="the subagent result", tool_call_id="c1"),
            ]}

        events = self._finish(_Cmd())
        self.assertEqual(events[0].result, "the subagent result")

    def test_no_extractable_content_logs_and_reports_no_result(self):
        class _Cmd:
            update = {"messages": [object()]}

        with self.assertLogs("ag_ui_langgraph.agent", level=logging.DEBUG) as logs:
            events = self._finish(_Cmd())
        self.assertIsNone(events[0].result)
        self.assertTrue(any("result" in r.getMessage() for r in logs.records))


class TestTaskToolErrorTerminatesTheSubagent(unittest.TestCase):
    """A failed `task` delegation must end in SUBAGENT_ERROR, not FINISHED.

    on_tool_error cleared streaming flags but left the task/subagent mappings
    active, so a recovered task failure (parent catches it and completes
    normally) emitted no terminal at error time — and run-end draining then
    reported the failed subagent as successfully FINISHED.
    """

    def _agent(self):
        agent = _make_agent(emit_subagent_events=True)
        agent.active_run = {
            "active_subagents": {"tools:s1": "researcher"},
            "current_subagent_run_id": "tools:s1",
            "subagent_task_runs": {"run-1": "tools:s1"},
            "subagent_parents": {"tools:s1": None},
            "lane_nodes": {"tools:s1": "model"},
            "step_owners": {},
            "emit_subagent_events": True,
        }
        return agent

    def test_a_task_tool_error_emits_subagent_error(self):
        agent = self._agent()
        events = agent._finish_subagent_on_task_end({
            "event": "on_tool_error",
            "run_id": "run-1",
            "data": {"error": RuntimeError("boom")},
        })
        types = [e.type for e in events]
        self.assertIn(EventType.SUBAGENT_ERROR, types)
        self.assertNotIn(EventType.SUBAGENT_FINISHED, types)
        error = next(e for e in events if e.type == EventType.SUBAGENT_ERROR)
        self.assertIn("boom", error.message)
        # The lane's open step closes inside the window, before the terminal.
        self.assertEqual(types[0], EventType.STEP_FINISHED)
        # The subagent is closed: the run-end drain must not emit a second,
        # contradictory terminal for it.
        self.assertNotIn("tools:s1", agent.active_run["active_subagents"])
        self.assertIn("tools:s1", agent.active_run["closed_subagents"])
        self.assertEqual(drain_subagents(agent.active_run), [])

    def test_a_bare_exception_still_produces_a_message(self):
        agent = self._agent()

        class _Bare(Exception):
            pass

        events = agent._finish_subagent_on_task_end({
            "event": "on_tool_error",
            "run_id": "run-1",
            "data": {"error": _Bare()},
        })
        error = next(e for e in events if e.type == EventType.SUBAGENT_ERROR)
        self.assertTrue(error.message.strip(), "str() of a bare exception is ''")

    def test_flag_off_still_tears_the_lane_down_silently(self):
        agent = self._agent()
        agent.emit_subagent_events = False
        agent.active_run["emit_subagent_events"] = False
        events = agent._finish_subagent_on_task_end({
            "event": "on_tool_error",
            "run_id": "run-1",
            "data": {"error": RuntimeError("boom")},
        })
        self.assertEqual(events, [])
        self.assertNotIn("tools:s1", agent.active_run["active_subagents"])
        self.assertNotIn("tools:s1", agent.active_run.get("lane_nodes", {}))


class TestTaskInterruptIsNotAnError(unittest.TestCase):
    """An in-subagent HITL interrupt must not terminate the subagent as failed.

    LangGraph propagates an interrupt raised inside a subagent (e.g.
    HumanInTheLoopMiddleware) through the parent's `task` tool as an
    on_tool_error whose error is a GraphInterrupt. Treating every tool error
    as a failure emitted SUBAGENT_ERROR with the raw Interrupt repr as the
    message — a design partner hit exactly this. An interrupt is a pause: the
    subagent stays open (the run-end drain finishes it; on resume it replays),
    and the interrupt's identity is recorded so the run-end interrupt tail can
    attribute the on_interrupt event to the subagent that raised it.
    """

    def _agent(self):
        agent = _make_agent(emit_subagent_events=True)
        agent.active_run = {
            "active_subagents": {"tools:s1": "clock"},
            "current_subagent_run_id": "tools:s1",
            "subagent_task_runs": {"run-1": "tools:s1"},
            "subagent_parents": {"tools:s1": None},
            "lane_nodes": {"tools:s1": "model"},
            "step_owners": {},
            "emit_subagent_events": True,
        }
        return agent

    def _graph_interrupt(self):
        from langgraph.errors import GraphInterrupt
        from langgraph.types import Interrupt

        return GraphInterrupt((Interrupt(value={"type": "hitl"}, id="int-1"),))

    def test_an_interrupt_shaped_tool_error_emits_no_terminal(self):
        agent = self._agent()
        events = agent._finish_subagent_on_task_end({
            "event": "on_tool_error",
            "run_id": "run-1",
            "data": {"error": self._graph_interrupt()},
        })
        self.assertEqual(events, [])
        # The subagent is SUSPENDED, not closed: the run-end drain finishes it.
        self.assertIn("tools:s1", agent.active_run["active_subagents"])
        self.assertNotIn("tools:s1", agent.active_run.get("closed_subagents", set()))
        # The interrupt's identity is recorded for tail attribution.
        self.assertEqual(
            agent.active_run.get("interrupt_subagents"), {"int-1": "tools:s1"}
        )

    def test_a_real_tool_error_still_errors_the_subagent(self):
        agent = self._agent()
        events = agent._finish_subagent_on_task_end({
            "event": "on_tool_error",
            "run_id": "run-1",
            "data": {"error": RuntimeError("boom")},
        })
        self.assertIn(EventType.SUBAGENT_ERROR, [e.type for e in events])

    def test_a_domain_error_payload_with_value_and_id_is_still_an_error(self):
        # Structural duck typing is not enough: any exception whose args happen
        # to carry `value` and `id` attributes (a domain error payload, say)
        # must stay a FAILURE. Only actual langgraph Interrupt instances count.
        class DomainErrorPayload:
            def __init__(self):
                self.value = "invalid action"
                self.id = "domain-1"

        agent = self._agent()
        events = agent._finish_subagent_on_task_end({
            "event": "on_tool_error",
            "run_id": "run-1",
            "data": {"error": RuntimeError(DomainErrorPayload())},
        })
        self.assertIn(EventType.SUBAGENT_ERROR, [e.type for e in events])
        self.assertNotIn("interrupt_subagents", agent.active_run)

    def test_a_rewrapped_real_interrupt_still_counts_as_an_interrupt(self):
        # A re-raised propagation whose args are ACTUAL Interrupt instances is
        # still recognized without being a GraphInterrupt subclass.
        from langgraph.types import Interrupt

        agent = self._agent()
        events = agent._finish_subagent_on_task_end({
            "event": "on_tool_error",
            "run_id": "run-1",
            "data": {"error": Exception(Interrupt(value={"type": "hitl"}, id="int-9"))},
        })
        self.assertEqual(events, [])
        self.assertEqual(
            agent.active_run.get("interrupt_subagents"), {"int-9": "tools:s1"}
        )

    def test_flag_off_interrupt_keeps_the_silent_teardown_for_the_drain(self):
        agent = self._agent()
        agent.emit_subagent_events = False
        agent.active_run["emit_subagent_events"] = False
        events = agent._finish_subagent_on_task_end({
            "event": "on_tool_error",
            "run_id": "run-1",
            "data": {"error": self._graph_interrupt()},
        })
        self.assertEqual(events, [])
        self.assertIn("tools:s1", agent.active_run["active_subagents"])
        # No attribution is recorded with the flag off.
        self.assertNotIn("interrupt_subagents", agent.active_run)


class TestInterruptTailAttribution(unittest.TestCase):
    """The run-end on_interrupt CUSTOM event names the subagent that raised it."""

    def _interrupt(self, iid="int-1"):
        from langgraph.types import Interrupt

        return Interrupt(value={"type": "hitl"}, id=iid)

    def test_the_on_interrupt_event_carries_the_subagents_id(self):
        agent = _make_agent(emit_subagent_events=True)
        agent.active_run = {
            "active_subagents": {},
            "current_subagent_run_id": None,
            "interrupt_subagents": {"int-1": "tools:s1"},
            "emit_subagent_events": True,
        }
        events = agent._emit_interrupt_finish(
            thread_id="t1", run_id="r1", lg_interrupts=[self._interrupt()],
        )
        custom = next(e for e in events if e.type == EventType.CUSTOM)
        self.assertEqual(custom.subagent_run_id, "tools:s1")
        finished = next(e for e in events if e.type == EventType.RUN_FINISHED)
        self.assertIsNone(getattr(finished, "subagent_run_id", None))

    def test_an_unrecorded_interrupt_stays_unattributed(self):
        agent = _make_agent(emit_subagent_events=True)
        agent.active_run = {
            "active_subagents": {},
            "current_subagent_run_id": None,
            "emit_subagent_events": True,
        }
        events = agent._emit_interrupt_finish(
            thread_id="t1", run_id="r1", lg_interrupts=[self._interrupt("other")],
        )
        custom = next(e for e in events if e.type == EventType.CUSTOM)
        self.assertIsNone(custom.subagent_run_id)

    def test_the_structured_outcome_interrupts_carry_the_owner_too(self):
        agent = _make_agent(emit_subagent_events=True)
        agent.emit_interrupt_outcome = True
        agent.active_run = {
            "active_subagents": {},
            "current_subagent_run_id": None,
            "interrupt_subagents": {"int-1": "tools:s1"},
            "emit_subagent_events": True,
        }
        events = agent._emit_interrupt_finish(
            thread_id="t1", run_id="r1", lg_interrupts=[self._interrupt()],
        )
        finished = next(e for e in events if e.type == EventType.RUN_FINISHED)
        self.assertEqual(finished.outcome.type, "interrupt")
        self.assertEqual(finished.outcome.interrupts[0].subagent_run_id, "tools:s1")

    def test_flag_off_never_attributes_the_tail(self):
        agent = _make_agent(emit_subagent_events=False)
        agent.active_run = {
            "active_subagents": {},
            "current_subagent_run_id": None,
            # Even if something recorded a mapping, flag-off output stays clean.
            "interrupt_subagents": {"int-1": "tools:s1"},
            "emit_subagent_events": False,
        }
        events = agent._emit_interrupt_finish(
            thread_id="t1", run_id="r1", lg_interrupts=[self._interrupt()],
        )
        custom = next(e for e in events if e.type == EventType.CUSTOM)
        self.assertIsNone(custom.subagent_run_id)


class TestSuspendedOutcomeOnDrain(unittest.TestCase):
    """A lane suspended by a confirmed interrupt closes with outcome=suspended."""

    def test_suspended_lane_carries_its_interrupt_ids(self):
        active_run = {
            "emit_subagent_events": True,
            "active_subagents": {"tools:s1": "clock"},
            "subagent_parents": {"tools:s1": None},
            "lane_nodes": {},
            "step_owners": {},
            "current_subagent_run_id": None,
            "suspended_subagent_interrupts": {"tools:s1": ["int-1"]},
        }
        events = drain_subagents(active_run)
        finished = next(e for e in events if e.type == EventType.SUBAGENT_FINISHED)
        self.assertEqual(finished.outcome.type, "suspended")
        self.assertEqual(finished.outcome.interrupt_ids, ["int-1"])

    def test_ancestor_of_a_suspended_lane_is_suspended_with_no_owned_ids(self):
        active_run = {
            "emit_subagent_events": True,
            "active_subagents": {"tools:outer": "o", "tools:inner": "i"},
            "subagent_parents": {"tools:inner": "tools:outer"},
            "lane_nodes": {},
            "step_owners": {},
            "current_subagent_run_id": None,
            "suspended_subagent_interrupts": {"tools:inner": ["int-1"], "tools:outer": []},
        }
        events = drain_subagents(active_run)
        finished = {e.subagent_run_id: e for e in events if e.type == EventType.SUBAGENT_FINISHED}
        self.assertEqual(finished["tools:inner"].outcome.interrupt_ids, ["int-1"])
        self.assertEqual(finished["tools:outer"].outcome.type, "suspended")
        self.assertIsNone(finished["tools:outer"].outcome.interrupt_ids)

    def test_a_lane_without_a_confirmed_interrupt_stays_plain(self):
        active_run = {
            "emit_subagent_events": True,
            "active_subagents": {"tools:s1": "clock"},
            "subagent_parents": {},
            "lane_nodes": {},
            "step_owners": {},
            "current_subagent_run_id": None,
        }
        events = drain_subagents(active_run)
        finished = next(e for e in events if e.type == EventType.SUBAGENT_FINISHED)
        self.assertIsNone(finished.outcome)


class TestInterruptSuspendsEndToEnd(unittest.IsolatedAsyncioTestCase):
    """The full S&P sequence: an in-subagent HITL interrupt suspends, never errors.

    Drives the real stream loop: the subagent starts, its `task` delegation
    raises a GraphInterrupt through on_tool_error, and the final checkpoint
    holds the interrupt. The tail must be: lane closed, SUBAGENT_FINISHED with
    outcome=suspended naming the interrupt, attributed on_interrupt CUSTOM,
    RUN_FINISHED — and no SUBAGENT_ERROR anywhere.
    """

    def _events(self):
        from langgraph.errors import GraphInterrupt
        from langgraph.types import Interrupt

        return [
            _chain_start("model", _sub_meta("s1", "model", "clock"), run_id="r1"),
            {
                "event": "on_tool_start",
                "run_id": "task-run-1",
                "metadata": {"langgraph_checkpoint_ns": "tools:s1|model:x"},
                "data": {"input": {"subagent_type": "clock", "description": "tells time"}},
            },
            {
                "event": "on_tool_error",
                "run_id": "task-run-1",
                "metadata": {},
                "data": {"error": GraphInterrupt((Interrupt(value={"type": "hitl"}, id="int-1"),))},
            },
        ]

    async def _drive_with_final_interrupt(self, agent, with_interrupt=True):
        from types import SimpleNamespace
        from langgraph.types import Interrupt

        collected = await _drive_with_state(
            agent,
            self._events(),
            tasks=(
                [SimpleNamespace(interrupts=[Interrupt(value={"type": "hitl"}, id="int-1")])]
                if with_interrupt
                else []
            ),
        )
        return collected

    async def test_the_subagent_suspends_with_attribution(self):
        agent = _make_agent(emit_subagent_events=True)
        collected = await self._drive_with_final_interrupt(agent)
        types = _types(collected)
        self.assertNotIn(EventType.SUBAGENT_ERROR, types)
        finished = next(e for e in collected if e.type == EventType.SUBAGENT_FINISHED)
        self.assertEqual(finished.subagent_run_id, "tools:s1")
        self.assertEqual(finished.outcome.type, "suspended")
        self.assertEqual(finished.outcome.interrupt_ids, ["int-1"])
        custom = next(e for e in collected if e.type == EventType.CUSTOM)
        self.assertEqual(custom.subagent_run_id, "tools:s1")
        self.assertEqual(types[-1], EventType.RUN_FINISHED)

    async def test_an_unconfirmed_candidate_does_not_suspend_or_attribute(self):
        # The parent handled the failure and the run completed normally: the
        # recorded candidate is absent from the final tasks, so the subagent
        # closes plain and nothing carries interrupt attribution.
        agent = _make_agent(emit_subagent_events=True)
        collected = await self._drive_with_final_interrupt(agent, with_interrupt=False)
        types = _types(collected)
        self.assertNotIn(EventType.SUBAGENT_ERROR, types)
        finished = next(e for e in collected if e.type == EventType.SUBAGENT_FINISHED)
        self.assertIsNone(finished.outcome)
        # No interrupt reached the final state, so nothing emits an interrupt
        # tail and nothing carries interrupt attribution.
        self.assertNotIn(EventType.CUSTOM, types)


class _FanOutAgent(LangGraphAgent):
    """Fans each raw interrupt into two AG-UI interrupts, like a
    HumanInTheLoopMiddleware override splitting action_requests."""

    def _interrupts_to_agui(self, lg_interrupts):
        from ag_ui.core import Interrupt as AGUIInterrupt

        mapped = []
        for raw in lg_interrupts:
            for suffix in ("a", "b"):
                mapped.append(AGUIInterrupt(id=f"{raw.id}::{suffix}", reason="hitl"))
        return mapped


def _make_fanout_agent():
    from langgraph.graph.state import CompiledStateGraph

    graph = MagicMock(spec=CompiledStateGraph)
    graph.config_specs = []
    graph.nodes = {}
    return _FanOutAgent(name="test", graph=graph, emit_subagent_events=True)


class TestFanOutInterruptProvenance(unittest.TestCase):
    """One raw interrupt fanning into N AG-UI interrupts keeps its owner.

    A flat zip of raw and mapped lists crossed owners as soon as one raw
    fanned out: the second mapped interrupt of raw #1 took raw #2's slot, and
    the suspended outcome named RAW ids the client can never answer.
    """

    def _interrupt(self, iid):
        from langgraph.types import Interrupt

        return Interrupt(value={"type": "hitl"}, id=iid)

    def test_every_mapped_interrupt_inherits_its_own_raws_owner(self):
        agent = _make_fanout_agent()
        agent.emit_interrupt_outcome = True
        agent.active_run = {
            "active_subagents": {},
            "current_subagent_run_id": None,
            "interrupt_subagents": {"int-1": "tools:s1", "int-2": "tools:s2"},
            "emit_subagent_events": True,
        }
        events = agent._emit_interrupt_finish(
            thread_id="t1", run_id="r1",
            lg_interrupts=[self._interrupt("int-1"), self._interrupt("int-2")],
        )
        finished = next(e for e in events if e.type == EventType.RUN_FINISHED)
        owners = [(i.id, i.subagent_run_id) for i in finished.outcome.interrupts]
        self.assertEqual(owners, [
            ("int-1::a", "tools:s1"),
            ("int-1::b", "tools:s1"),
            ("int-2::a", "tools:s2"),
            ("int-2::b", "tools:s2"),
        ])
        # One legacy CUSTOM per RAW interrupt, each with its own owner.
        customs = [(e.subagent_run_id) for e in events if e.type == EventType.CUSTOM]
        self.assertEqual(customs, ["tools:s1", "tools:s2"])


class TestFanOutSuspendedCorrelation(unittest.IsolatedAsyncioTestCase):
    """The suspended outcome names the EMITTED interrupt ids, not raw ids."""

    async def test_suspended_interrupt_ids_match_the_structured_outcome(self):
        from types import SimpleNamespace
        from langgraph.errors import GraphInterrupt
        from langgraph.types import Interrupt

        agent = _make_fanout_agent()
        agent.emit_interrupt_outcome = True
        events = [
            _chain_start("model", _sub_meta("s1", "model", "clock"), run_id="r1"),
            {
                "event": "on_tool_start",
                "run_id": "task-run-1",
                "metadata": {"langgraph_checkpoint_ns": "tools:s1|model:x"},
                "data": {"input": {"subagent_type": "clock", "description": "d"}},
            },
            {
                "event": "on_tool_error",
                "run_id": "task-run-1",
                "metadata": {},
                "data": {"error": GraphInterrupt((Interrupt(value={"type": "hitl"}, id="int-1"),))},
            },
        ]
        collected = await _drive_with_state(
            agent, events,
            tasks=[SimpleNamespace(interrupts=[Interrupt(value={"type": "hitl"}, id="int-1")])],
        )
        finished = next(e for e in collected if e.type == EventType.SUBAGENT_FINISHED)
        self.assertEqual(finished.outcome.interrupt_ids, ["int-1::a", "int-1::b"])
        run_finished = next(e for e in collected if e.type == EventType.RUN_FINISHED)
        emitted_ids = [i.id for i in run_finished.outcome.interrupts]
        self.assertEqual(emitted_ids, ["int-1::a", "int-1::b"])
        for interrupt in run_finished.outcome.interrupts:
            self.assertEqual(interrupt.subagent_run_id, "tools:s1")


class TestNestedInterruptKeepsDeepestOwner(unittest.TestCase):
    """A nested interrupt bubbling through both task boundaries keeps the
    deepest owner: the outer boundary's later recording must not overwrite the
    inner one. The outer lane still suspends as an ancestor with no owned ids
    (pinned by the reconciliation's ancestor expansion)."""

    def test_the_outer_boundary_does_not_overwrite_the_inner_owner(self):
        from langgraph.errors import GraphInterrupt
        from langgraph.types import Interrupt

        agent = _make_agent(emit_subagent_events=True)
        agent.active_run = {
            "active_subagents": {"tools:outer": "o", "tools:inner": "i"},
            "current_subagent_run_id": "tools:inner",
            "subagent_task_runs": {"run-inner": "tools:inner", "run-outer": "tools:outer"},
            "subagent_parents": {"tools:inner": "tools:outer", "tools:outer": None},
            "lane_nodes": {},
            "step_owners": {},
            "emit_subagent_events": True,
        }
        interrupt_error = GraphInterrupt((Interrupt(value={"type": "hitl"}, id="nested-int"),))
        # Child-first, as LangGraph surfaces it, then the outer boundary.
        agent._finish_subagent_on_task_end({
            "event": "on_tool_error", "run_id": "run-inner",
            "data": {"error": interrupt_error},
        })
        agent._finish_subagent_on_task_end({
            "event": "on_tool_error", "run_id": "run-outer",
            "data": {"error": interrupt_error},
        })
        self.assertEqual(
            agent.active_run["interrupt_subagents"], {"nested-int": "tools:inner"}
        )


class TestErrorPathRobustness(unittest.IsolatedAsyncioTestCase):
    """Fix 7: the error handlers could fail, or report nothing useful."""

    async def test_a_non_string_upstream_error_message_still_produces_run_error(self):
        # ``data.message`` is not guaranteed to be a string. A dict passes the
        # truthiness guard and then explodes as a pydantic ValidationError INSIDE
        # the error handler, so RUN_ERROR is never emitted at all.
        agent = _make_agent(emit_subagent_events=True)
        collected = await _drive(agent, [
            _chain_start("n", _sub_meta("s1", "n"), run_id="r1"),
            {"event": "error", "run_id": "r2", "data": {"message": {"code": 500}}},
        ])
        errors = [
            e for e in collected if getattr(e, "type", None) == EventType.RUN_ERROR
        ]
        self.assertEqual(len(errors), 1, "RUN_ERROR must survive a non-string message")
        self.assertIn("500", errors[0].message)
        # And the open subagent still gets its terminal.
        self.assertIn(EventType.SUBAGENT_ERROR, _types(collected))

    async def test_a_bare_exception_does_not_yield_an_empty_subagent_error(self):
        class _Bare(Exception):
            pass

        agent = _make_agent(emit_subagent_events=True)

        async def fake_prepare(*args, **kwargs):
            agent.active_run["schema_keys"] = {
                "input": ["messages"], "output": ["messages"],
                "config": [], "context": [],
            }

            async def gen():
                yield _chain_start("n", _sub_meta("s1", "n"), run_id="r1")
                raise _Bare()

            return {
                "stream": gen(),
                "state": MagicMock(values={"messages": []}),
                "config": {"configurable": {"thread_id": "t1"}},
            }

        agent.prepare_stream = fake_prepare
        run_input = MagicMock()
        run_input.run_id = "run-1"
        run_input.thread_id = "t1"
        run_input.forwarded_props = {}

        collected = []
        with self.assertRaises(_Bare):
            async for ev in agent._handle_stream_events(run_input):
                collected.append(ev)

        errors = [
            e for e in collected if getattr(e, "type", None) == EventType.SUBAGENT_ERROR
        ]
        self.assertEqual(len(errors), 1)
        self.assertTrue(
            errors[0].message.strip(),
            "str(exc) is '' for a bare exception, so the message must fall back "
            "to repr(exc) rather than reporting nothing",
        )


class TestAccumulatorDoesNotLoseText(unittest.TestCase):
    """Fix 8a/8b/8c: silent degradation in the snapshot accumulator."""

    def _agent(self):
        agent = _make_agent(emit_subagent_events=True)
        agent.active_run = {
            "id": "run-1",
            "current_subagent_run_id": "tools:s1",
            "active_subagents": {"tools:s1": "researcher"},
            "subagent_messages": {},
            "subagent_tool_call_owner": {},
            "inbound_subagent_messages": [],
        }
        return agent

    def test_text_content_without_a_seen_opener_is_still_captured(self):
        from ag_ui.core import TextMessageContentEvent

        agent = self._agent()
        with self.assertLogs("ag_ui_langgraph.agent", level=logging.WARNING):
            agent._dispatch_event(TextMessageContentEvent(
                type=EventType.TEXT_MESSAGE_CONTENT, message_id="m-late", delta="text"
            ))
        entry = agent.active_run["subagent_messages"].get("m-late")
        self.assertIsNotNone(
            entry, "discarding the delta loses the subagent's text from the snapshot"
        )
        self.assertEqual(entry["content"], "text")
        self.assertEqual(entry["subagent_run_id"], "tools:s1")

    def test_reasoning_content_without_a_seen_opener_is_still_captured(self):
        from ag_ui.core import ReasoningMessageContentEvent

        agent = self._agent()
        with self.assertLogs("ag_ui_langgraph.agent", level=logging.WARNING):
            agent._dispatch_event(ReasoningMessageContentEvent(
                type=EventType.REASONING_MESSAGE_CONTENT, message_id="r-late", delta="hmm"
            ))
        entry = agent.active_run["subagent_messages"].get("r-late")
        self.assertIsNotNone(entry)
        self.assertEqual(entry["kind"], "reasoning")
        self.assertEqual(entry["content"], "hmm")

    def test_unowned_tool_call_args_warns(self):
        from ag_ui.core import ToolCallArgsEvent

        agent = self._agent()
        with self.assertLogs("ag_ui_langgraph.agent", level=logging.WARNING) as logs:
            agent._dispatch_event(ToolCallArgsEvent(
                type=EventType.TOOL_CALL_ARGS, tool_call_id="tc-unknown", delta="{}"
            ))
        self.assertTrue(any("tc-unknown" in r.getMessage() for r in logs.records))

    def test_a_continuation_disagreeing_about_its_owner_warns(self):
        from ag_ui.core import TextMessageContentEvent, TextMessageStartEvent

        agent = self._agent()
        agent._dispatch_event(TextMessageStartEvent(
            type=EventType.TEXT_MESSAGE_START, message_id="m1", role="assistant"
        ))
        agent.active_run["current_subagent_run_id"] = "tools:s2"
        with self.assertLogs("ag_ui_langgraph.agent", level=logging.WARNING):
            agent._dispatch_event(TextMessageContentEvent(
                type=EventType.TEXT_MESSAGE_CONTENT, message_id="m1", delta="more"
            ))
        # The entry keeps its original owner; the delta is not lost.
        entry = agent.active_run["subagent_messages"]["m1"]
        self.assertEqual(entry["subagent_run_id"], "tools:s1")
        self.assertEqual(entry["content"], "more")


class TestTaskMetaShapeLogging(unittest.TestCase):
    """Fix 8: a `task` tool whose input no longer carries ``subagent_type`` is a
    shape change worth reporting -- distinct from the correct silent no-op for
    every other tool."""

    def _agent(self):
        agent = _make_agent(emit_subagent_events=True)
        agent.active_run = {
            "active_subagents": {},
            "current_subagent_run_id": None,
            "subagent_task_meta": {},
            "subagent_task_runs": {},
            "pending_task_calls": [],
            "task_tool_call_ids_by_ns": {},
        }
        return agent

    def test_task_tool_with_an_unexpected_input_shape_warns(self):
        agent = self._agent()
        with self.assertLogs("ag_ui_langgraph.agent", level=logging.WARNING) as logs:
            agent._capture_subagent_task_meta({
                "event": "on_tool_start",
                "run_id": "run-1",
                "name": "task",
                "data": {"input": {"prompt": "no subagent_type here"}},
                "metadata": {"langgraph_checkpoint_ns": "tools:s1"},
            })
        self.assertTrue(any("task" in r.getMessage() for r in logs.records))
        self.assertEqual(agent.active_run["subagent_task_meta"], {})

    def test_a_non_task_tool_stays_silent(self):
        agent = self._agent()
        with self.assertNoLogs("ag_ui_langgraph.agent", level=logging.WARNING):
            agent._capture_subagent_task_meta({
                "event": "on_tool_start",
                "run_id": "run-1",
                "name": "grep",
                "data": {"input": {"pattern": "x"}},
                "metadata": {"langgraph_checkpoint_ns": "tools:s1"},
            })

    def test_the_fifo_fallback_is_reported(self):
        agent = self._agent()
        agent.active_run["pending_task_calls"] = [
            {"tool_call_id": "call-a", "parent_message_id": "msg-1"}
        ]
        with self.assertLogs("ag_ui_langgraph.agent", level=logging.WARNING) as logs:
            agent._capture_subagent_task_meta({
                "event": "on_tool_start",
                "run_id": "run-1",
                "name": "task",
                "data": {"input": {"subagent_type": "researcher", "description": "d"}},
                "metadata": {"langgraph_checkpoint_ns": "tools:s1"},
            })
        messages = " ".join(r.getMessage() for r in logs.records)
        self.assertIn("call-a", messages)
        self.assertIn("tools:s1", messages)


class TestFlagOffTeardownClearsLanes(unittest.TestCase):
    """The flag-off early returns still have to tear the lane bookkeeping down,
    or the next turn starts with lanes that look open."""

    def _active_run(self):
        return {
            "active_subagents": {"tools:s1": "researcher"},
            "current_subagent_run_id": "tools:s1",
            "emit_subagent_events": False,
            "lane_nodes": {None: "tools", "tools:s1": "research"},
            "step_owners": {None: None, "tools:s1": "tools:s1"},
        }

    def test_drain_emits_nothing_and_clears_subagent_lanes(self):
        active_run = self._active_run()
        self.assertEqual(drain_subagents(active_run), [])
        self.assertEqual(active_run["active_subagents"], {})
        self.assertIn("tools:s1", active_run["closed_subagents"])
        self.assertIsNone(active_run["current_subagent_run_id"])
        self.assertNotIn("tools:s1", active_run["lane_nodes"])
        self.assertNotIn("tools:s1", active_run["step_owners"])
        # The parent lane is untouched: its step is closed by handle_node_change.
        self.assertEqual(active_run["lane_nodes"], {None: "tools"})

    def test_error_emits_nothing_and_clears_subagent_lanes(self):
        active_run = self._active_run()
        self.assertEqual(error_open_subagents(active_run, "boom"), [])
        self.assertEqual(active_run["active_subagents"], {})
        self.assertIn("tools:s1", active_run["closed_subagents"])
        self.assertIsNone(active_run["current_subagent_run_id"])
        self.assertNotIn("tools:s1", active_run["lane_nodes"])
        self.assertNotIn("tools:s1", active_run["step_owners"])


class TestFlagOffLaneCollapse(unittest.TestCase):
    """With the flag off, ALL transient streaming state lives in the root lane.

    _current_lane reads current_subagent_run_id, which reconcile_subagents sets
    even when the flag is off (lane bookkeeping still runs). Left ungated, the
    text pin / reasoning / in-flight-message slots were keyed per subagent lane
    with the flag off — a benign but real stream-shape change against
    pre-subagent behavior, where everything shared one slot. The flag's
    contract is byte-identity, not improvement.
    """

    def test_flag_off_collapses_every_lane_to_root(self):
        agent = _make_agent(emit_subagent_events=False)
        agent.active_run = {"current_subagent_run_id": "tools:s1", "active_subagents": {}}
        self.assertEqual(agent._current_lane(), "__root__")

    def test_flag_on_keeps_the_subagent_lane(self):
        agent = _make_agent(emit_subagent_events=True)
        agent.active_run = {"current_subagent_run_id": "tools:s1", "active_subagents": {}}
        self.assertEqual(agent._current_lane(), "tools:s1")


class TestRunErrorIsTerminal(unittest.IsolatedAsyncioTestCase):
    """An in-band ``error`` event must end the stream at RUN_ERROR.

    Clients reject EVERY event after RUN_ERROR ("The run has already errored").
    The error branch used to ``break`` out of the stream loop and then fall
    through normal finalisation — STEP_FINISHED, STATE_SNAPSHOT,
    MESSAGES_SNAPSHOT and a second terminal (RUN_FINISHED) — so a conforming
    client aborted the errored run at the first trailing event.
    """

    _EVENTS = [
        _chain_start("tools", {"langgraph_node": "tools"}, run_id="r1"),
        _chain_start("model", _sub_meta("s1", "model"), run_id="r2"),
        {"event": "error", "run_id": "r3", "data": {"message": "boom"}, "metadata": {}},
    ]

    async def test_flag_on_nothing_follows_run_error(self):
        collected = await _drive(_make_agent(emit_subagent_events=True), self._EVENTS)
        types = _types(collected)
        self.assertEqual(types[-1], EventType.RUN_ERROR, f"trailing events: {types}")
        terminals = [t for t in types if t in (EventType.RUN_FINISHED, EventType.RUN_ERROR)]
        self.assertEqual(terminals, [EventType.RUN_ERROR], "exactly one terminal")

    async def test_flag_on_every_step_and_subagent_closes_before_run_error(self):
        collected = await _drive(_make_agent(emit_subagent_events=True), self._EVENTS)
        starts, finishes = _steps(collected)
        self.assertEqual(
            sorted(starts, key=_step_key), sorted(finishes, key=_step_key),
            "every STEP_STARTED needs its matching close before the terminal",
        )
        types = _types(collected)
        self.assertIn(EventType.SUBAGENT_ERROR, types)
        self.assertLess(types.index(EventType.SUBAGENT_ERROR), types.index(EventType.RUN_ERROR))

    async def test_flag_off_nothing_follows_run_error_either(self):
        collected = await _drive(_make_agent(emit_subagent_events=False), self._EVENTS)
        types = _types(collected)
        self.assertEqual(types[-1], EventType.RUN_ERROR, f"trailing events: {types}")
        terminals = [t for t in types if t in (EventType.RUN_FINISHED, EventType.RUN_ERROR)]
        self.assertEqual(terminals, [EventType.RUN_ERROR])
        # And the flat (pre-subagent) step still closes before the terminal.
        starts, finishes = _steps(collected)
        self.assertEqual(sorted(starts, key=_step_key), sorted(finishes, key=_step_key))


class TestNestedTeardownIsDeepestFirst(unittest.TestCase):
    """drain/error teardown must close nested subagents deepest-first.

    With root -> outer -> inner all still open at stream end, insertion-order
    teardown closed the outer subagent before the inner one, so the inner
    lifecycle ended after its declared parent — violating the containment the
    per-subagent windows promise. Each subagent's step close must also land
    immediately before ITS terminal, not batched ahead of all terminals.
    """

    def _active_run(self):
        return {
            "emit_subagent_events": True,
            # Insertion order is shallow-first: outer registered before inner.
            "active_subagents": {"tools:outer": "o", "tools:outer:inner": "i"},
            "subagent_parents": {"tools:outer:inner": "tools:outer"},
            "lane_nodes": {"tools:outer": "plan", "tools:outer:inner": "model"},
            "step_owners": {},
            "current_subagent_run_id": None,
        }

    def _key(self, e):
        t = e.type
        if t == EventType.STEP_FINISHED:
            return ("step", e.subagent_run_id)
        return ("terminal", e.subagent_run_id)

    def test_drain_finishes_the_inner_subagent_before_the_outer(self):
        events = [self._key(e) for e in drain_subagents(self._active_run())]
        self.assertEqual(events, [
            ("step", "tools:outer:inner"),
            ("terminal", "tools:outer:inner"),
            ("step", "tools:outer"),
            ("terminal", "tools:outer"),
        ])

    def test_error_teardown_uses_the_same_order(self):
        events = [self._key(e) for e in error_open_subagents(self._active_run(), "boom")]
        self.assertEqual(events, [
            ("step", "tools:outer:inner"),
            ("terminal", "tools:outer:inner"),
            ("step", "tools:outer"),
            ("terminal", "tools:outer"),
        ])


class TestRunEndFallbackClosesChildrenFirst(unittest.IsolatedAsyncioTestCase):
    """The run-end fallback must close a child before its parent wrapper.

    When the stream ends while a subagent is still open (its task's
    on_tool_end never fired — interrupt/fallback paths), the parent's
    wrapper step used to close via handle_node_change BEFORE drain_subagents
    closed the child's step and finished the subagent. That inverts the
    stated containment semantics: the child's lifecycle must sit inside the
    parent step that spawned it.
    """

    _EVENTS = [
        _chain_start("tools", {"langgraph_node": "tools"}, run_id="r1"),
        _chain_start("model", _sub_meta("s1", "model"), run_id="r2"),
        # Stream ends here: no on_tool_end for the task, no error event.
    ]

    async def test_child_step_and_terminal_precede_the_parent_step_close(self):
        collected = await _drive(_make_agent(emit_subagent_events=True), self._EVENTS)
        types = _types(collected)

        child_step_close = next(
            i for i, e in enumerate(collected)
            if getattr(e, "type", None) == EventType.STEP_FINISHED
            and getattr(e, "subagent_run_id", None) == "tools:s1"
        )
        child_terminal = types.index(EventType.SUBAGENT_FINISHED)
        parent_step_close = next(
            i for i, e in enumerate(collected)
            if getattr(e, "type", None) == EventType.STEP_FINISHED
            and getattr(e, "subagent_run_id", None) is None
            and e.step_name == "tools"
        )
        self.assertLess(child_step_close, child_terminal,
                        "the child's step closes inside its own window")
        self.assertLess(child_terminal, parent_step_close,
                        "the child finishes before the parent wrapper closes")
        self.assertEqual(types[-1], EventType.RUN_FINISHED)

    async def test_the_fallback_still_closes_every_step(self):
        collected = await _drive(_make_agent(emit_subagent_events=True), self._EVENTS)
        starts, finishes = _steps(collected)
        self.assertEqual(sorted(starts, key=_step_key), sorted(finishes, key=_step_key))


if __name__ == "__main__":
    unittest.main()
