"""The governing contract for ``subagent_visibility="hidden"``.

Hidden means invisible delegation: the client sees only the parent's ``task``
tool call, its TOOL_CALL_RESULT, and the parent's own reply. The subagent's
internal stream — text, tool calls, reasoning, steps, state — never reaches
the wire, not even untagged (the "inline" leak the design partner reported:
with the old flag off, the subagent's greeting streamed as a spurious
top-level parent message).

Suppression is identity-paired, not purely window-based: openers are
suppressed when they occur inside a subagent window, and every follower
inherits its opener's fate by id — so a parent step that opened before the
window and closes inside it stays visible, and the wire never carries an
unpaired STEP_FINISHED or TEXT_MESSAGE_CONTENT.
"""
import unittest
from unittest.mock import AsyncMock, MagicMock

from ag_ui.core import (
    EventType,
    RawEvent,
    StateSnapshotEvent,
    StepStartedEvent,
    StepFinishedEvent,
    TextMessageStartEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    ToolCallStartEvent,
    ToolCallResultEvent,
)
from ag_ui_langgraph.agent import (
    LangGraphAgent,
    SUBAGENT_VISIBILITY_ATTRIBUTED,
    SUBAGENT_VISIBILITY_HIDDEN,
    SUBAGENT_VISIBILITY_INLINE,
)


def _make_graph():
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
    return graph


def _make_agent(**kwargs):
    return LangGraphAgent(name="test", graph=_make_graph(), **kwargs)


async def _drive(agent, events):
    """Drive ``_handle_stream_events`` over a canned LangGraph event list.

    NOTE: this collects UPSTREAM of run()'s None filter, so suppressed events
    appear as None here — deliberate, so tests can distinguish "suppressed"
    from "never produced"."""

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


def _sub_meta(sid, node, name="researcher"):
    return {
        "langgraph_node": node,
        "langgraph_checkpoint_ns": f"tools:{sid}|model:inner",
        "lc_agent_name": name,
    }


def _root_meta(node):
    return {"langgraph_node": node, "langgraph_checkpoint_ns": "", "lc_agent_name": "main"}


def _chain_start(node, metadata, run_id="r-x"):
    return {
        "event": "on_chain_start",
        "run_id": run_id,
        "name": node,
        "data": {},
        "metadata": metadata,
    }


def _model_stream(run_id, content, metadata):
    return {
        "event": "on_chat_model_stream",
        "run_id": run_id,
        "name": "model",
        "data": {"chunk": {
            "id": f"chunk-{run_id}",
            "content": content,
            "tool_call_chunks": [],
            "response_metadata": {},
        }},
        "metadata": {**metadata, "emit-messages": True, "emit-tool-calls": True},
    }


class TestVisibilityAPI(unittest.TestCase):
    def test_default_is_inline_and_matches_the_old_default(self):
        agent = _make_agent()
        self.assertEqual(agent.subagent_visibility, SUBAGENT_VISIBILITY_INLINE)
        self.assertFalse(agent.emit_subagent_events)

    def test_the_boolean_alias_maps_both_ways(self):
        self.assertEqual(
            _make_agent(emit_subagent_events=True).subagent_visibility,
            SUBAGENT_VISIBILITY_ATTRIBUTED,
        )
        self.assertEqual(
            _make_agent(emit_subagent_events=False).subagent_visibility,
            SUBAGENT_VISIBILITY_INLINE,
        )
        self.assertTrue(
            _make_agent(subagent_visibility="attributed").emit_subagent_events
        )
        self.assertFalse(_make_agent(subagent_visibility="hidden").emit_subagent_events)

    def test_conflicting_alias_and_visibility_is_an_error(self):
        with self.assertRaises(ValueError):
            _make_agent(emit_subagent_events=True, subagent_visibility="hidden")
        with self.assertRaises(ValueError):
            _make_agent(emit_subagent_events=False, subagent_visibility="attributed")
        # Agreeing spellings are allowed.
        agent = _make_agent(emit_subagent_events=True, subagent_visibility="attributed")
        self.assertEqual(agent.subagent_visibility, SUBAGENT_VISIBILITY_ATTRIBUTED)

    def test_an_unknown_visibility_is_an_error(self):
        with self.assertRaises(ValueError):
            _make_agent(subagent_visibility="invisible")

    def test_clone_carries_hidden(self):
        agent = _make_agent(subagent_visibility="hidden")
        self.assertEqual(agent.clone().subagent_visibility, SUBAGENT_VISIBILITY_HIDDEN)

    def test_clone_of_inline_and_attributed_still_speaks_the_boolean(self):
        # Subclasses written before subagent_visibility existed accept only the
        # boolean; they must keep cloning unless they opt into "hidden".
        class LegacySubclass(LangGraphAgent):
            def __init__(self, *, name, graph, description=None, config=None,
                         enable_legacy_on_interrupt_event=True,
                         emit_interrupt_outcome=False, emit_raw_events=True,
                         emit_subagent_events=False):
                super().__init__(
                    name=name, graph=graph, description=description, config=config,
                    enable_legacy_on_interrupt_event=enable_legacy_on_interrupt_event,
                    emit_interrupt_outcome=emit_interrupt_outcome,
                    emit_raw_events=emit_raw_events,
                    emit_subagent_events=emit_subagent_events,
                )

        agent = LegacySubclass(name="t", graph=_make_graph(), emit_subagent_events=True)
        clone = agent.clone()
        self.assertEqual(clone.subagent_visibility, SUBAGENT_VISIBILITY_ATTRIBUTED)


class TestHiddenSuppressesTheSubagentStream(unittest.IsolatedAsyncioTestCase):
    """The design partner's exact leak: with the boolean off, the subagent's
    greeting streamed untagged as the parent's own message. Hidden must drop
    it while a genuine parent message still flows."""

    async def _run(self, visibility):
        agent = _make_agent(subagent_visibility=visibility)
        return await _drive(agent, [
            # Subagent window: its model streams a greeting.
            _chain_start("model", _sub_meta("s1", "model"), run_id="r1"),
            _model_stream("r2", "from the subagent", _sub_meta("s1", "model")),
        ])

    async def test_hidden_emits_no_subagent_text(self):
        collected = [e for e in await self._run("hidden") if e is not None]
        text = [
            e for e in collected
            if getattr(e, "type", None) in (
                EventType.TEXT_MESSAGE_START,
                EventType.TEXT_MESSAGE_CONTENT,
                EventType.TEXT_MESSAGE_END,
                EventType.TEXT_MESSAGE_CHUNK,
            )
        ]
        self.assertEqual(
            text, [],
            "hidden means the subagent's text never reaches the wire — this is "
            "the leak the design partner reported against inline",
        )

    async def test_hidden_emits_no_subagent_lifecycle_or_tags(self):
        collected = [e for e in await self._run("hidden") if e is not None]
        for ev in collected:
            t = getattr(ev, "type", None)
            self.assertFalse(
                t is not None and str(getattr(t, "value", t)).upper().startswith("SUBAGENT"),
                f"hidden leaked a lifecycle event: {t}",
            )
            self.assertIsNone(getattr(ev, "subagent_run_id", None))

    async def test_inline_still_streams_the_same_text_untagged(self):
        # The contrast pin: the same drive under inline (the default) DOES
        # stream the text — hidden's suppression must not bleed into inline.
        collected = [e for e in await self._run("inline") if e is not None]
        text = [
            e for e in collected
            if getattr(e, "type", None) in (
                EventType.TEXT_MESSAGE_START, EventType.TEXT_MESSAGE_CONTENT
            )
        ]
        self.assertTrue(text, "inline must keep the pre-subagent behavior")
        for ev in text:
            self.assertIsNone(getattr(ev, "subagent_run_id", None))

    async def test_a_parent_message_still_flows_under_hidden(self):
        agent = _make_agent(subagent_visibility="hidden")
        collected = [
            e for e in await _drive(agent, [
                _chain_start("model", _root_meta("model"), run_id="r1"),
                _model_stream("r2", "the parent speaking", _root_meta("model")),
            ]) if e is not None
        ]
        text = [
            e for e in collected
            if getattr(e, "type", None) == EventType.TEXT_MESSAGE_CONTENT
        ]
        self.assertTrue(text, "hidden hides the SUBAGENT, not the parent")


class TestHiddenDoesNotSwallowTheParent(unittest.IsolatedAsyncioTestCase):
    """Review round 1, P1: the OnChatModelEnd branches cleared the shared
    message-in-progress slot only when the close was EMITTED. Hidden withheld
    the subagent's close, the slot stayed open, and the parent's entire
    streamed reply was read as a continuation of the suppressed entity and
    vanished — reproduced on a real DeepAgents graph. One combined drive, the
    shape the earlier separate-drive tests missed."""

    async def test_parent_text_flows_after_a_suppressed_subagent_message(self):
        agent = _make_agent(subagent_visibility="hidden")
        collected = [
            e for e in await _drive(agent, [
                # Subagent streams and CLOSES a message (close suppressed).
                _chain_start("model", _sub_meta("s1", "model"), run_id="r1"),
                _model_stream("r2", "from the subagent", _sub_meta("s1", "model")),
                {
                    "event": "on_chat_model_end",
                    "run_id": "r2",
                    "name": "model",
                    "data": {},
                    "metadata": _sub_meta("s1", "model"),
                },
                # Then the PARENT streams its reply.
                _chain_start("model", _root_meta("model"), run_id="r3"),
                _model_stream("r4", "the parent replying", _root_meta("model")),
            ]) if e is not None
        ]
        parent_text = [
            e for e in collected
            if getattr(e, "type", None) == EventType.TEXT_MESSAGE_CONTENT
        ]
        self.assertTrue(
            parent_text,
            "the parent's streamed reply must survive a suppressed subagent close",
        )
        for ev in parent_text:
            self.assertIsNone(getattr(ev, "subagent_run_id", None))
        deltas = "".join(getattr(e, "delta", "") for e in parent_text)
        self.assertIn("the parent replying", deltas)
        self.assertNotIn("from the subagent", deltas)


class TestHiddenPairing(unittest.TestCase):
    """Identity-paired suppression at the unit level: no unpaired opener or
    closer may ever reach the wire."""

    def _agent(self):
        agent = _make_agent(subagent_visibility="hidden")
        agent.active_run = {"current_subagent_run_id": None}
        return agent

    def _enter_window(self, agent, sid="s1"):
        agent.active_run["current_subagent_run_id"] = sid

    def _leave_window(self, agent):
        agent.active_run["current_subagent_run_id"] = None

    def test_a_step_opened_in_window_is_suppressed_with_its_close(self):
        agent = self._agent()
        self._enter_window(agent)
        opened = agent._dispatch_event(
            StepStartedEvent(type=EventType.STEP_STARTED, step_name="model")
        )
        self.assertIsNone(opened)
        self._leave_window(agent)
        # The close arrives after the window ended — still suppressed, because
        # its open was.
        closed = agent._dispatch_event(
            StepFinishedEvent(type=EventType.STEP_FINISHED, step_name="model")
        )
        self.assertIsNone(closed)

    def test_a_visible_steps_close_survives_the_window(self):
        agent = self._agent()
        opened = agent._dispatch_event(
            StepStartedEvent(type=EventType.STEP_STARTED, step_name="tools")
        )
        self.assertIsNotNone(opened, "opened outside the window — visible")
        self._enter_window(agent)
        closed = agent._dispatch_event(
            StepFinishedEvent(type=EventType.STEP_FINISHED, step_name="tools")
        )
        self.assertIsNotNone(
            closed,
            "the parent's step close lands mid-window (the node transition is "
            "triggered by the subagent's first event) and must stay visible, "
            "or the wire carries an unpaired STEP_STARTED",
        )

    def test_same_name_hidden_subagent_step_does_not_close_the_parent(self):
        agent = self._agent()
        agent.active_run["lane_nodes"] = {None: "model", "tools:s1": "model"}
        parent_opened = list(agent.start_step("model", None))
        self.assertIsNotNone(parent_opened[0])

        self._enter_window(agent, "tools:s1")
        hidden_opened = list(agent.start_step("model", "tools:s1"))
        self.assertIsNone(hidden_opened[0])

        parent_closed = agent.end_step(None)
        self.assertIsNotNone(
            parent_closed,
            "a hidden subagent's same-name step must not consume the visible "
            "parent close",
        )
        self.assertIsNone(parent_closed.subagent_run_id)

    def test_a_visible_messages_continuation_survives_the_window(self):
        agent = self._agent()
        start = agent._dispatch_event(TextMessageStartEvent(
            type=EventType.TEXT_MESSAGE_START, message_id="m1", role="assistant",
        ))
        self.assertIsNotNone(start)
        self._enter_window(agent)
        content = agent._dispatch_event(TextMessageContentEvent(
            type=EventType.TEXT_MESSAGE_CONTENT, message_id="m1", delta="x",
        ))
        self.assertIsNotNone(content, "follower of a visible opener stays visible")
        end = agent._dispatch_event(TextMessageEndEvent(
            type=EventType.TEXT_MESSAGE_END, message_id="m1",
        ))
        self.assertIsNotNone(end)

    def test_a_suppressed_messages_followers_are_suppressed_after_the_window(self):
        agent = self._agent()
        self._enter_window(agent)
        self.assertIsNone(agent._dispatch_event(TextMessageStartEvent(
            type=EventType.TEXT_MESSAGE_START, message_id="m2", role="assistant",
        )))
        self._leave_window(agent)
        self.assertIsNone(agent._dispatch_event(TextMessageContentEvent(
            type=EventType.TEXT_MESSAGE_CONTENT, message_id="m2", delta="y",
        )))
        self.assertIsNone(agent._dispatch_event(TextMessageEndEvent(
            type=EventType.TEXT_MESSAGE_END, message_id="m2",
        )))

    def test_the_parents_task_call_and_result_stay_visible(self):
        agent = self._agent()
        start = agent._dispatch_event(ToolCallStartEvent(
            type=EventType.TOOL_CALL_START, tool_call_id="tc1", tool_call_name="task",
        ))
        self.assertIsNotNone(start, "the parent's own `task` call opens pre-window")
        self._enter_window(agent)
        self._leave_window(agent)
        result = agent._dispatch_event(ToolCallResultEvent(
            type=EventType.TOOL_CALL_RESULT, message_id="tr1", tool_call_id="tc1",
            content="42",
        ))
        self.assertIsNotNone(
            result, "the task's result is the delegation's visible outcome"
        )

    def test_a_subagents_internal_tool_call_is_fully_suppressed(self):
        agent = self._agent()
        self._enter_window(agent)
        self.assertIsNone(agent._dispatch_event(ToolCallStartEvent(
            type=EventType.TOOL_CALL_START, tool_call_id="tc-sub", tool_call_name="search",
        )))
        self._leave_window(agent)
        self.assertIsNone(agent._dispatch_event(ToolCallResultEvent(
            type=EventType.TOOL_CALL_RESULT, message_id="tr-sub", tool_call_id="tc-sub",
            content="internal",
        )))


class TestRunFiltersSuppressedEvents(unittest.IsolatedAsyncioTestCase):
    async def test_run_never_yields_none(self):
        agent = _make_agent(subagent_visibility="hidden")

        async def fake_prepare(*args, **kwargs):
            agent.active_run["schema_keys"] = {
                "input": ["messages"], "output": ["messages"],
                "config": [], "context": [],
            }

            async def gen():
                yield _chain_start("model", _sub_meta("s1", "model"), run_id="r1")
                yield _model_stream("r2", "hidden text", _sub_meta("s1", "model"))

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
        run_input.messages = []
        run_input.model_copy = lambda update=None: run_input

        collected = [ev async for ev in agent.run(run_input)]
        self.assertNotIn(None, collected, "run() is the terminal None filter")
        self.assertTrue(collected, "the run lifecycle itself still flows")


if __name__ == "__main__":
    unittest.main()


class TestHiddenIdReuseAndCollision(unittest.TestCase):
    """Review round 1, P2: suppressed identities were permanent, so upstream
    id reuse corrupted later visible entities (hidden runs without attributed
    mode's collision-minting registry)."""

    def _agent(self):
        agent = _make_agent(subagent_visibility="hidden")
        agent.active_run = {"current_subagent_run_id": None}
        return agent

    def _window(self, agent, sid):
        agent.active_run["current_subagent_run_id"] = sid

    def test_a_visible_opener_retires_a_suppressed_message_id(self):
        agent = self._agent()
        self._window(agent, "s1")
        self.assertIsNone(agent._dispatch_event(TextMessageStartEvent(
            type=EventType.TEXT_MESSAGE_START, message_id="m1", role="assistant",
        )))
        self._window(agent, None)
        # The parent (or a later turn) legally reuses the upstream id: the
        # visible opener must retire the suppressed record, or the new
        # message's content and end vanish and the wire carries a bare START.
        self.assertIsNotNone(agent._dispatch_event(TextMessageStartEvent(
            type=EventType.TEXT_MESSAGE_START, message_id="m1", role="assistant",
        )))
        self.assertIsNotNone(agent._dispatch_event(TextMessageContentEvent(
            type=EventType.TEXT_MESSAGE_CONTENT, message_id="m1", delta="x",
        )))
        self.assertIsNotNone(agent._dispatch_event(TextMessageEndEvent(
            type=EventType.TEXT_MESSAGE_END, message_id="m1",
        )))

    def test_a_subagent_colliding_with_the_parents_task_call_cannot_suppress_its_result(self):
        agent = self._agent()
        # The parent's own `task` call, visible.
        self.assertIsNotNone(agent._dispatch_event(ToolCallStartEvent(
            type=EventType.TOOL_CALL_START, tool_call_id="tc1", tool_call_name="task",
        )))
        self._window(agent, "s1")
        # A subagent-internal tool reusing the SAME upstream id: its own events
        # are suppressed while the window is open...
        self.assertIsNone(agent._dispatch_event(ToolCallStartEvent(
            type=EventType.TOOL_CALL_START, tool_call_id="tc1", tool_call_name="search",
        )))
        self.assertIsNone(agent._dispatch_event(ToolCallResultEvent(
            type=EventType.TOOL_CALL_RESULT, message_id="tr-inner", tool_call_id="tc1",
            content="internal",
        )))
        self._window(agent, None)
        # ...but the parent's REQUIRED result, arriving after the window, must
        # stay visible or the client aborts on an unanswered tool call.
        self.assertIsNotNone(agent._dispatch_event(ToolCallResultEvent(
            type=EventType.TOOL_CALL_RESULT, message_id="tr1", tool_call_id="tc1",
            content="42",
        )))


class TestHiddenBoundaryAndStateLeaks(unittest.TestCase):
    """Review round 2, P1: DeepAgents' boundary chain events run under a bare
    `tools:<uuid>` namespace (no `|`), which the window cannot see, and
    mid-fan-out snapshots carry partial subgraph fragments that would REPLACE
    the parent's state on the client."""

    def _agent(self):
        agent = _make_agent(subagent_visibility="hidden")
        agent.active_run = {"current_subagent_run_id": None, "active_subagents": {}}
        return agent

    def test_a_boundary_raw_is_suppressed_before_any_lane_exists(self):
        agent = self._agent()
        boundary = RawEvent(type=EventType.RAW, event={
            "event": "on_chain_start",
            "name": "researcher",
            "metadata": {
                "langgraph_checkpoint_ns": "tools:3ed68888-899f-e671-0f12-5fcec1a7ff89",
                "lc_agent_name": "researcher",
            },
        })
        self.assertIsNone(agent._dispatch_event(boundary))

    def test_a_parent_raw_stays_visible(self):
        agent = self._agent()
        parent = RawEvent(type=EventType.RAW, event={
            "event": "on_chain_start",
            "name": "model",
            "metadata": {"langgraph_checkpoint_ns": "", "lc_agent_name": "main"},
        })
        self.assertIsNotNone(agent._dispatch_event(parent))

    def test_a_known_boundary_segment_suppresses_nested_raws(self):
        # Round 3 caught the round-2 version of this test seeding a key
        # production never writes (known_subagent_segments); reconcile
        # populates "subagent_segments" — pin against the REAL key.
        agent = self._agent()
        agent.active_run["subagent_segments"] = {"tools:abc"}
        nested = RawEvent(type=EventType.RAW, event={
            "event": "on_chain_end",
            "name": "researcher",
            "metadata": {
                "langgraph_checkpoint_ns": "tools:abc",
                "lc_agent_name": None,
            },
        })
        self.assertIsNone(agent._dispatch_event(nested))

    def test_parent_state_flows_during_a_delegation(self):
        # Round 3 flipped the round-2 blanket: suppressing all state while any
        # delegation was in flight starved a concurrent root tool's
        # manually_emit_state and lost the parent's update PERMANENTLY. State
        # suppression is provenance-based: window membership here, and the
        # subagent-triggered transition snapshot is stopped at its trigger site
        # in the stream loop (where the triggering event is in scope).
        agent = self._agent()
        agent.active_run["active_subagents"] = {"tools:s1": {}}
        self.assertIsNotNone(agent._dispatch_event(StateSnapshotEvent(
            type=EventType.STATE_SNAPSHOT, snapshot={"progress": "published while worker runs"},
        )), "the parent's own state must survive a concurrent delegation")

    def test_in_window_state_is_still_suppressed(self):
        agent = self._agent()
        agent.active_run["current_subagent_run_id"] = "tools:s1"
        self.assertIsNone(agent._dispatch_event(StateSnapshotEvent(
            type=EventType.STATE_SNAPSHOT, snapshot={"subagent": "internal"},
        )))

    def test_a_parent_tools_raw_flows_during_a_delegation(self):
        # The same round-3 starvation, RAW flavor: an ordinary root tool
        # running alongside a slow task had its on_tool_end RAW suppressed
        # while its on_tool_start stayed visible.
        agent = self._agent()
        agent.active_run["active_subagents"] = {"tools:s1": {}}
        parent_raw = RawEvent(type=EventType.RAW, event={
            "event": "on_tool_end",
            "name": "publish_parent_state",
            "metadata": {"langgraph_checkpoint_ns": "", "lc_agent_name": None},
        })
        self.assertIsNotNone(agent._dispatch_event(parent_raw))


class TestHiddenLaneScopedStreamMembership(unittest.TestCase):
    """Review round 2, P2: streamed_tool_call_ids was keyed by bare public id.
    Hidden mints no lane-specific ids, so a nested `task` call reusing the
    parent's raw id collided: the inner completion discarded the parent's
    membership, and the parent's completion re-emitted a full visible
    Start/Args/End before its result."""

    def test_hidden_keys_are_lane_scoped(self):
        agent = _make_agent(subagent_visibility="hidden")
        agent.active_run = {"current_subagent_run_id": None, "streamed_tool_call_ids": set()}
        ids = agent.active_run["streamed_tool_call_ids"]
        # Parent streams the task call at the root lane.
        ids.add(agent._streamed_call_key("task-collide"))
        # The inner lane's completion discards ITS key...
        agent.active_run["current_subagent_run_id"] = "tools:inner"
        ids.discard(agent._streamed_call_key("task-collide"))
        # ...and the parent's membership survives, so its completion does not
        # re-emit the call.
        agent.active_run["current_subagent_run_id"] = None
        self.assertIn(agent._streamed_call_key("task-collide"), ids)

    def test_inline_and_attributed_keep_the_bare_key(self):
        for kwargs in ({"subagent_visibility": "inline"}, {"subagent_visibility": "attributed"}):
            agent = _make_agent(**kwargs)
            agent.active_run = {"current_subagent_run_id": "tools:x"}
            self.assertEqual(
                agent._streamed_call_key("tc1"), "tc1",
                "inline is byte-identical legacy; attributed's minting already "
                "separates lanes — only hidden needs lane scoping",
            )
