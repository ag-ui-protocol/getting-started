"""Regression tests for the advisory ``exit`` custom event (PNI-386).

``CustomEventNames.Exit`` is **advisory**: a graph that emits it gets the event
forwarded to the client as ``CUSTOM(name="exit")``, and nothing else changes.
Streaming continues, the graph runs to its own terminal node, and the terminal
event sequence is untouched.

Before PNI-386 the streaming loop accumulated a ``should_exit`` flag that no
code ever read, which implied a stream-termination contract the bridge never
had. These tests pin the contract from both sides so it cannot drift:

* the advisory forwarding must not regress to being dropped, and
* the termination behavior must not be "restored" by a future reader who finds
  the enum member and assumes it was meant to stop the stream.

They also pin the *documented wire order*, because the contract comment on the
enum member names an exact terminal sequence and a comment 2000 lines from the
code that produces it is the highest-rot line in the change.

Like ``test_raw_event_payload_size.py``, these drive the real pipeline
(``_handle_stream_events`` -> ``_handle_single_event`` -> ``_dispatch_event``)
over a synthetic LangGraph event stream.

NOTE: ``_run`` collects UPSTREAM of ``run()``'s ``None`` filter, so a suppressed
event appears here as ``None`` rather than being absent — deliberate, so the
subagent-visibility tests can tell "suppressed" from "never produced". Guard for
``None`` before touching ``.type``.
"""
import unittest
from dataclasses import dataclass
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

from langchain_core.messages import AIMessageChunk

from ag_ui.core import EventType, RunAgentInput

from ag_ui_langgraph.agent import (
    SUBAGENT_VISIBILITY_ATTRIBUTED,
    SUBAGENT_VISIBILITY_HIDDEN,
    SUBAGENT_VISIBILITY_INLINE,
)
from ag_ui_langgraph.types import CustomEventNames
from tests._helpers import make_agent

# Handed to the pipeline only as a copy — see _exit_stream_event.
_EXIT_PAYLOAD = {"reason": "done"}

# The terminal tail the CustomEventNames.Exit contract comment promises on the
# normal (end-node) path. Pinned here so the comment cannot drift from reality:
# handle_node_change("__end__") closes the open step BEFORE
# get_state_and_messages_snapshots runs, so STEP_FINISHED leads.
_TERMINAL_TAIL = [
    EventType.STEP_FINISHED,
    EventType.STATE_SNAPSHOT,
    EventType.MESSAGES_SNAPSHOT,
    EventType.RUN_FINISHED,
]


def _text_stream_event(text, node="model", message_id="run--msg1"):
    """A LangGraph ``on_chat_model_stream`` event carrying ``text``."""
    chunk = AIMessageChunk(content=text, id=message_id)
    chunk.response_metadata = {}
    chunk.tool_call_chunks = []
    return {
        "event": "on_chat_model_stream",
        "run_id": "run1",
        "metadata": {"langgraph_node": node},
        "data": {"chunk": chunk},
        "name": "model",
        "parent_ids": [],
        "tags": [],
    }


def _tool_call_stream_event(args, name=None, call_id=None, node="model"):
    """An ``on_chat_model_stream`` event carrying a tool-call chunk.

    The first chunk of a call carries ``name``/``id``; continuation chunks carry
    only ``args``.
    """
    chunk = AIMessageChunk(content="", id="run--msg1")
    chunk.response_metadata = {}
    chunk.tool_call_chunks = [
        {"name": name, "args": args, "id": call_id, "index": 0, "type": "tool_call_chunk"}
    ]
    return {
        "event": "on_chat_model_stream",
        "run_id": "run1",
        "metadata": {"langgraph_node": node},
        "data": {"chunk": chunk},
        "name": "model",
        "parent_ids": [],
        "tags": [],
    }


def _model_end_stream_event(node="model"):
    """The ``on_chat_model_end`` that closes the streamed message or tool call.

    Without it the fixture would leave the message open and never exercise
    TEXT_MESSAGE_END / TOOL_CALL_END, which is precisely the cleanup an exit
    mid-stream must not disturb.
    """
    return {
        "event": "on_chat_model_end",
        "run_id": "run1",
        "metadata": {"langgraph_node": node},
        "data": {},
        "name": "model",
        "parent_ids": [],
        "tags": [],
    }


def _exit_stream_event(node="model", metadata=None, as_enum_member=False):
    """The public exit custom event, as a graph would dispatch it.

    ``data`` is a fresh copy of ``_EXIT_PAYLOAD``: the bridge forwards the
    payload object by reference, so sharing the module constant would make the
    payload assertion ``x == x`` and let an in-place mutation by production code
    leak across tests.

    ``as_enum_member`` dispatches the enum member itself rather than its
    ``.value``, covering the form a caller might reasonably use.
    """
    return {
        "event": "on_custom_event",
        "run_id": "run1",
        "metadata": metadata if metadata is not None else {"langgraph_node": node},
        "name": CustomEventNames.Exit if as_enum_member else CustomEventNames.Exit.value,
        "data": dict(_EXIT_PAYLOAD),
        "parent_ids": [],
        "tags": [],
    }


def _stream_with_exit():
    """A model turn with the exit event dispatched mid-message, same node.

    Same ``langgraph_node`` as the surrounding text so the event cannot
    incidentally trigger a node transition — this isolates the exit semantics
    from step-lifecycle behavior. The cross-node case is covered separately.
    """
    return [
        _text_stream_event("hello "),
        _exit_stream_event(),
        _text_stream_event("world"),
        _model_end_stream_event(),
    ]


def _stream_without_exit():
    """The same turn with the exit event removed — the control sequence."""
    return [
        _text_stream_event("hello "),
        _text_stream_event("world"),
        _model_end_stream_event(),
    ]


def _sub_meta(node="model", sid="s1"):
    """Metadata placing an event inside a subagent's checkpoint namespace."""
    return {
        "langgraph_node": node,
        "langgraph_checkpoint_ns": f"tools:{sid}|model:inner",
        "lc_agent_name": "researcher",
    }


def _root_meta(node="agent"):
    return {
        "langgraph_node": node,
        "langgraph_checkpoint_ns": "",
        "lc_agent_name": "main",
    }


@dataclass
class _FakeInterrupt:
    """Mirrors ``FakeInterrupt`` in tests/test_interrupt_handling.py."""
    value: Any
    id: Any = None


def _chain_start(node, metadata, run_id="r-x"):
    return {
        "event": "on_chain_start",
        "run_id": run_id,
        "name": node,
        "data": {},
        "metadata": metadata,
    }


async def _run(stream_events, interrupts=None, **agent_kwargs):
    """Drive the real streaming pipeline over ``stream_events``.

    ``emit_raw_events=False`` strips the RAW passthrough channel, which would
    otherwise echo every input event verbatim and make the emitted sequences
    trivially differ. Verified not to hide anything: with RAW on, the same AG-UI
    event types arrive in the same order, interleaved with RAW passthroughs. The
    events are not field-identical — RAW-on also retains ``raw_event`` on each of
    them — which is why the additive comparison runs with RAW off.

    Returns the raw yields, including ``None`` for suppressed events.
    """
    # Default off so emitted sequences stay comparable; overridable so one test
    # can exercise the raw-on branch.
    agent = make_agent(**{"emit_raw_events": False, **agent_kwargs})

    async def fake_stream():
        for ev in stream_events:
            yield ev

    final_state = MagicMock()
    final_state.values = {"messages": []}
    # An interrupt is surfaced through state.tasks[*].interrupts; _collect_interrupts
    # walks every task. A non-empty list drives the interrupt finalisation path,
    # whose terminal order differs from the end-node path.
    if interrupts:
        task = MagicMock()
        task.interrupts = list(interrupts)
        final_state.tasks = [task]
        final_state.next = ("model",)
    else:
        final_state.tasks = []
        final_state.next = []
    final_state.metadata = {"writes": {}}

    mock_prepared = {
        "state": {"messages": []},
        "stream": fake_stream(),
        "config": {"configurable": {"thread_id": "t1"}},
    }

    def fake_get_state_snapshot(state):
        if isinstance(state, dict):
            return state
        return getattr(state, "values", {}) or {}

    with patch.object(agent, "prepare_stream", AsyncMock(return_value=mock_prepared)), \
         patch.object(agent.graph, "aget_state", AsyncMock(return_value=final_state)), \
         patch.object(agent, "get_state_snapshot", side_effect=fake_get_state_snapshot):
        input_data = RunAgentInput(
            thread_id="t1",
            run_id="run1",
            messages=[],
            state={},
            tools=[],
            context=[],
            forwarded_props={},
        )
        return [ev async for ev in agent._handle_stream_events(input_data)]


def _custom_exit_events(emitted):
    return [
        ev for ev in emitted
        if ev is not None
        and ev.type == EventType.CUSTOM
        and ev.name == CustomEventNames.Exit.value
    ]


def _content_deltas(emitted):
    return [
        ev.delta for ev in emitted
        if ev is not None and ev.type == EventType.TEXT_MESSAGE_CONTENT
    ]


def _types(emitted):
    return [None if ev is None else ev.type for ev in emitted]


class TestExitCustomEventIsAdvisory(unittest.IsolatedAsyncioTestCase):
    """The exit event reaches the client and changes nothing else."""

    async def test_exit_is_forwarded_to_the_client_with_its_payload(self):
        emitted = await _run(_stream_with_exit())

        exits = _custom_exit_events(emitted)
        self.assertEqual(
            len(exits), 1,
            f"expected exactly one CUSTOM exit event; got {_types(emitted)!r}",
        )
        # Compared against an independent literal, not _EXIT_PAYLOAD: the bridge
        # forwards the payload by reference, so asserting against the module
        # constant would be x == x and could not detect in-place mutation.
        self.assertEqual(exits[0].value, {"reason": "done"})
        self.assertIsNot(
            exits[0].value, _EXIT_PAYLOAD,
            "fixture must hand the pipeline a copy, not the shared constant",
        )

    async def test_exit_dispatched_as_the_enum_member_forwards_identically(self):
        """The contract comment tells authors to pass the enum member's value.

        A caller passing the member itself must produce the same wire event —
        ``CustomEventNames`` is a ``str`` Enum, so the name coerces to "exit".
        """
        def stream(as_enum):
            return [
                _text_stream_event("hello "),
                _exit_stream_event(as_enum_member=as_enum),
                _model_end_stream_event(),
            ]

        as_member = _custom_exit_events(await _run(stream(True)))
        as_value = _custom_exit_events(await _run(stream(False)))

        self.assertEqual(len(as_member), 1, "enum-member dispatch must forward")
        self.assertEqual(len(as_value), 1, "value dispatch must forward")
        # The whole event, not just name: "identically" has to cover the payload,
        # or a divergence on the enum path (name coerced but data mishandled)
        # would pass.
        self.assertEqual(
            as_member[0].model_dump(), as_value[0].model_dump(),
            "dispatching the enum member must produce the same wire event as "
            "dispatching its .value",
        )
        self.assertEqual(as_member[0].name, "exit")

    async def test_streaming_continues_after_exit(self):
        """The core regression: content emitted *after* the exit still streams.

        If the exit event ever terminates the stream, "world" is dropped and
        this fails.
        """
        emitted = await _run(_stream_with_exit())
        types = _types(emitted)

        self.assertEqual(_content_deltas(emitted), ["hello ", "world"])

        # Assert before indexing: a bare next() over a generator would raise
        # StopIteration here, which inside a coroutine surfaces as an opaque
        # "RuntimeError: coroutine raised StopIteration" instead of a failure
        # carrying the sequence.
        exits = _custom_exit_events(emitted)
        self.assertEqual(len(exits), 1, f"expected one exit event; sequence was {types!r}")
        exit_index = emitted.index(exits[0])

        post_exit_deltas = _content_deltas(emitted[exit_index:])
        self.assertEqual(
            post_exit_deltas, ["world"],
            f"expected post-exit content to stream; sequence was {types!r}",
        )

    async def test_exit_adds_the_custom_event_and_nothing_else(self):
        """Identical to the same run without the exit event, plus one CUSTOM.

        This is the contract that makes "advisory" precise: the exit event is
        purely additive on the wire. Removing the single CUSTOM event must
        reproduce the control run exactly — full events, not just their types,
        so a perturbed message_id, delta, or snapshot is caught too.
        """
        with_exit = await _run(_stream_with_exit())
        control = await _run(_stream_without_exit())

        exits = _custom_exit_events(with_exit)
        # Without this guard the test passes vacuously when the exit event is
        # dropped entirely: the strip removes nothing and the sequences match.
        self.assertEqual(
            len(exits), 1,
            f"expected one exit event to strip; sequence was {_types(with_exit)!r}",
        )

        # Index-based removal, not `not in`: membership uses pydantic value
        # equality, so a duplicate-forward regression would silently strip both.
        exit_index = with_exit.index(exits[0])
        stripped = with_exit[:exit_index] + with_exit[exit_index + 1:]

        # model_dump() below is the file's only unguarded attribute access on a
        # _run result. Assert the precondition explicitly so a future visibility
        # parameterisation fails with a readable message instead of an
        # AttributeError raised from inside a list comprehension.
        self.assertNotIn(None, stripped, "suppressed events are not expected here")
        self.assertNotIn(None, control, "suppressed events are not expected here")

        self.assertEqual(
            [ev.model_dump() for ev in stripped],
            [ev.model_dump() for ev in control],
            "exit must be purely additive: removing the CUSTOM event should "
            "reproduce the no-exit run exactly",
        )

    async def test_terminal_events_remain_coherent(self):
        """Required cleanup and terminal events survive an exit mid-stream.

        Also pins the exact terminal order the contract comment promises.
        """
        emitted = await _run(_stream_with_exit())
        types = _types(emitted)

        # Without this the test degenerates into the control run when the exit is
        # dropped, and passes while asserting nothing about an exit mid-stream.
        self.assertEqual(
            len(_custom_exit_events(emitted)), 1,
            f"expected an exit mid-stream; sequence: {types!r}",
        )

        self.assertEqual(types[0], EventType.RUN_STARTED, f"sequence: {types!r}")
        self.assertEqual(types.count(EventType.RUN_STARTED), 1, f"sequence: {types!r}")
        self.assertEqual(types.count(EventType.RUN_FINISHED), 1, f"sequence: {types!r}")

        # The in-flight message is closed rather than left dangling.
        self.assertEqual(types.count(EventType.TEXT_MESSAGE_END), 1, f"sequence: {types!r}")

        # STEP_FINISHED leads the tail — see _TERMINAL_TAIL.
        self.assertEqual(
            types[-len(_TERMINAL_TAIL):], _TERMINAL_TAIL,
            f"terminal tail drifted from the documented order; sequence: {types!r}",
        )

    async def test_exit_as_the_final_stream_event_still_finishes_the_run(self):
        """The boundary case: exit arrives last, with no work behind it."""
        emitted = await _run([
            _text_stream_event("hello "),
            _model_end_stream_event(),
            _exit_stream_event(),
        ])
        types = _types(emitted)

        exits = _custom_exit_events(emitted)
        self.assertEqual(len(exits), 1, f"sequence: {types!r}")

        # The run does not end on the exit event: the full terminal tail still
        # follows it. (Asserting `types[-1] != CUSTOM` would be a tautology
        # against the RUN_FINISHED check.)
        self.assertEqual(
            types[-len(_TERMINAL_TAIL):], _TERMINAL_TAIL,
            f"terminal tail must follow a trailing exit; sequence: {types!r}",
        )
        self.assertLess(
            emitted.index(exits[0]), len(emitted) - len(_TERMINAL_TAIL),
            f"exit must precede the terminal tail; sequence: {types!r}",
        )

    async def test_exit_from_a_different_node_keeps_steps_coherent(self):
        """The realistic shape: exit dispatched from a dedicated finalize node.

        This is what a graph author actually writes, and it exercises what the
        same-node fixture deliberately excludes — the message staying open
        across node transitions while steps open and close around it.
        """
        emitted = await _run([
            _text_stream_event("hello "),
            _exit_stream_event(node="finalize"),
            _text_stream_event("world"),
            _model_end_stream_event(),
        ])
        types = _types(emitted)

        self.assertEqual(len(_custom_exit_events(emitted)), 1, f"sequence: {types!r}")
        self.assertEqual(_content_deltas(emitted), ["hello ", "world"])

        # Every opened step is closed, and the message still closes exactly once
        # despite spanning the node transitions.
        self.assertEqual(
            types.count(EventType.STEP_STARTED), types.count(EventType.STEP_FINISHED),
            f"unbalanced steps; sequence: {types!r}",
        )
        # Both ends of the lifecycle, and the ids matched. Asserting only END==1
        # still passes when the message is torn down and reopened across the
        # transition: verified by clearing the in-flight message on the exit
        # (clear_message_in_progress), which emits a second START for the same id —
        # a duplicate-open the client would reject, and the opposite of the
        # "spans the transitions" claim this test is named for.
        self.assertEqual(types.count(EventType.TEXT_MESSAGE_START), 1, f"sequence: {types!r}")
        self.assertEqual(types.count(EventType.TEXT_MESSAGE_END), 1, f"sequence: {types!r}")
        starts = [e for e in emitted if e is not None and e.type == EventType.TEXT_MESSAGE_START]
        ends = [e for e in emitted if e is not None and e.type == EventType.TEXT_MESSAGE_END]
        self.assertEqual(
            starts[0].message_id, ends[0].message_id,
            "the message opened before the transition must be the one that closes",
        )
        self.assertEqual(types[-len(_TERMINAL_TAIL):], _TERMINAL_TAIL, f"sequence: {types!r}")

    async def test_exit_mid_tool_call_still_closes_the_tool_call(self):
        """Cleanup coherence for the tool-call path, not just the message path.

        A termination-restoration could plausibly close in-flight messages while
        orphaning in-flight tool calls; the text-only tests would not notice.
        """
        emitted = await _run([
            _tool_call_stream_event("", name="get_weather", call_id="call_1"),
            _exit_stream_event(),
            _tool_call_stream_event('{"city":"SF"}'),
            _model_end_stream_event(),
        ])
        types = _types(emitted)

        self.assertEqual(len(_custom_exit_events(emitted)), 1, f"sequence: {types!r}")
        self.assertEqual(types.count(EventType.TOOL_CALL_START), 1, f"sequence: {types!r}")
        self.assertEqual(
            types.count(EventType.TOOL_CALL_END), 1,
            f"in-flight tool call must still close; sequence: {types!r}",
        )
        # The args emitted after the exit still reach the client.
        args_deltas = [
            ev.delta for ev in emitted
            if ev is not None and ev.type == EventType.TOOL_CALL_ARGS
        ]
        self.assertIn('{"city":"SF"}', args_deltas, f"sequence: {types!r}")


    async def test_interrupt_path_closes_the_step_after_the_snapshots(self):
        """Pins the SECOND terminal order the contract comment names.

        Both paths run the same finalisation block; the divergence is a single
        line — ``node_name`` comes from ``active_run`` when interrupts exist,
        making the first ``handle_node_change`` a no-op so the step survives to
        close after the snapshots. Without this pin, someone "normalising" the two
        orderings would break ``_TERMINAL_TAIL``, update the constant, go green,
        and leave the interrupt half of the comment silently false.
        """
        emitted = await _run(
            _stream_with_exit(), interrupts=[_FakeInterrupt(value="please confirm", id="int-1")]
        )
        types = _types(emitted)

        # The exit still forwards on this path.
        self.assertEqual(len(_custom_exit_events(emitted)), 1, f"sequence: {types!r}")
        self.assertEqual(types[-1], EventType.RUN_FINISHED, f"sequence: {types!r}")

        self.assertIn(EventType.STEP_FINISHED, types, f"sequence: {types!r}")
        self.assertIn(EventType.MESSAGES_SNAPSHOT, types, f"sequence: {types!r}")
        self.assertIn(EventType.STATE_SNAPSHOT, types, f"sequence: {types!r}")
        # Against BOTH snapshots: the contract says "after the snapshots", so pinning
        # only MESSAGES_SNAPSHOT leaves a suppressed terminal STATE_SNAPSHOT green.
        self.assertGreater(
            types.index(EventType.STEP_FINISHED),
            max(
                types.index(EventType.STATE_SNAPSHOT),
                types.index(EventType.MESSAGES_SNAPSHOT),
            ),
            "on the interrupt path STEP_FINISHED must land AFTER the snapshots — "
            f"the inverse of _TERMINAL_TAIL; sequence: {types!r}",
        )

    async def test_exit_forwards_with_raw_events_enabled(self):
        """Covers the raw-on branch, which the harness otherwise never reaches.

        The two paths genuinely differ — _dispatch_event runs make_json_safe over
        the raw payload when raw is on and discards it when off — and the harness
        defaults to off so the emitted sequences stay comparable.

        This does NOT pin the production default: it sets the flag explicitly, so
        a flipped default would not fail here. The default is pinned by
        tests/test_raw_event_optout.py::test_default_is_on_and_preserves_raw_event;
        the assertion below is only a local guard that raw really is on.
        """
        agent_events = await _run(_stream_with_exit(), emit_raw_events=True)

        exits = _custom_exit_events(agent_events)
        self.assertEqual(
            len(exits), 1,
            f"exit must forward at the default; sequence: {_types(agent_events)!r}",
        )
        self.assertEqual(exits[0].value, {"reason": "done"})
        # Guards the fixture: RAW really is on, so this is not silently the
        # emit_raw_events=False path under another name.
        self.assertIn(EventType.RAW, _types(agent_events))


class TestExitUnderSubagentVisibility(unittest.IsolatedAsyncioTestCase):
    """Forwarding is subject to subagent visibility — pinned, not assumed.

    The contract comment on CustomEventNames.Exit claims the bridge forwards the
    event. That is true at top level and under ``inline``/``attributed``, but an
    exit dispatched from inside a subagent window is suppressed under
    ``hidden``, because EventType.CUSTOM is in
    _SUBAGENT_ATTRIBUTABLE_EVENT_TYPES and _hidden_should_suppress drops
    attributable point events by window membership.

    These tests pin the behavior as it stands so the comment and the code cannot
    disagree silently. The hidden case is recorded as CURRENT behavior, not as
    endorsed behavior: nothing in test_subagent_hidden_contract.py covered CUSTOM
    before PNI-386, so the drop is incidental fallthrough rather than a considered
    contract. Note it is not an anomaly either — a subagent's manually_emit_state
    is withheld under hidden by the same window rule. Whether an advisory signal
    should be exempt is a question for the subagent-visibility design; if it is ever
    exempted, the hidden expectation below flips.
    """

    def _subagent_stream(self):
        return [
            _chain_start("agent", _root_meta("agent")),
            _text_stream_event("parent "),
            _chain_start("model", _sub_meta()),
            _exit_stream_event(metadata=_sub_meta()),
            _model_end_stream_event(),
        ]

    async def test_inline_forwards_a_subagent_exit(self):
        emitted = await _run(
            self._subagent_stream(), subagent_visibility=SUBAGENT_VISIBILITY_INLINE
        )
        self.assertEqual(
            len(_custom_exit_events(emitted)), 1,
            f"inline must forward the exit; sequence: {_types(emitted)!r}",
        )

    async def test_attributed_forwards_a_subagent_exit(self):
        emitted = await _run(
            self._subagent_stream(), subagent_visibility=SUBAGENT_VISIBILITY_ATTRIBUTED
        )
        exits = _custom_exit_events(emitted)
        self.assertEqual(
            len(exits), 1,
            f"attributed must forward the exit; sequence: {_types(emitted)!r}",
        )
        # Attribution is the whole distinguishing contract of this mode; asserting
        # only the forward would duplicate the inline test.
        self.assertEqual(
            exits[0].subagent_run_id, "tools:s1",
            "attributed must stamp the owning subagent on the forwarded exit",
        )

    async def test_hidden_suppresses_the_exit_that_inline_forwards(self):
        """CURRENT behavior, flagged as an open question — see the class docstring.

        Asserting only "hidden forwards zero exits" would pass just as happily if
        the fixture stopped producing an exit at all, or if forwarding broke
        globally. The inline leg is a positive control: it proves this exact
        stream yields a forwardable exit, so the hidden leg's zero can only mean
        suppression. ``_subagent_stream()`` is rebuilt per run so the two runs
        cannot share mutable event payloads.
        """
        forwarded = await _run(
            self._subagent_stream(), subagent_visibility=SUBAGENT_VISIBILITY_INLINE
        )
        self.assertEqual(
            len(_custom_exit_events(forwarded)), 1,
            "fixture must produce a forwardable exit, else the hidden assertion "
            f"below is vacuous; sequence: {_types(forwarded)!r}",
        )

        hidden = await _run(
            self._subagent_stream(), subagent_visibility=SUBAGENT_VISIBILITY_HIDDEN
        )
        self.assertEqual(
            len(_custom_exit_events(hidden)), 0,
            "hidden currently suppresses a subagent-emitted exit; if this now "
            "forwards, the exemption landed and the contract comment on "
            "CustomEventNames.Exit must be updated to match",
        )
        # Positive evidence of suppression rather than absence. A bare
        # `assertIn(None, hidden)` would not do: the hidden run withholds an
        # unrelated STATE_SNAPSHOT too, so it passes even when the exit was never
        # produced. The differential is what isolates the exit's own suppression.
        without_exit = await _run(
            [
                ev for ev in self._subagent_stream()
                if ev.get("name") != CustomEventNames.Exit.value
            ],
            subagent_visibility=SUBAGENT_VISIBILITY_HIDDEN,
        )
        self.assertEqual(
            _types(hidden).count(None), _types(without_exit).count(None) + 1,
            "the exit must account for exactly one additional withheld event; "
            f"with={_types(hidden)!r} without={_types(without_exit)!r}",
        )


if __name__ == "__main__":
    unittest.main()
