"""Tests for hierarchical multi-agent / nested-crew STEP attribution.

Four layers are covered:

* the pure :mod:`ag_ui_crewai.attribution` boundary stack + event builders,
  which reconstruct the Flow-method -> Crew -> Agent topology from boundary
  identity alone (CrewAI has no wire-level namespace to lean on);
* the ordered ``StreamFrameTranslator`` seam (``_frames.py``), which is where
  FULL hierarchical attribution lives; it is driven single-threaded and in
  emit order, so a boundary stack is correct there. Tests feed ORDERED fake raw
  events and assert the emitted STEP events carry the right
  depth/parent/path/step_id and stay balanced (every STEP_STARTED closed);
* the LEGACY bus-listener path (``endpoint.py``), which crewai 1.x dispatches on
  an unordered ThreadPoolExecutor and therefore CANNOT maintain a stack; it
  stamps FLAT per-method attribution only (flow ownership + a stable per-run
  step_id shared by the method's start and finish);
* the CONVERSATIONAL route, which shares that same translator: one test drives
  the shipped conversational wrapper over a REAL nested Crew (network replaced
  at crewai's ``BaseLLM`` extension point) and asserts the hierarchy survives.

That crew_kickoff_started / agent_execution_started frames reach ``astream`` end
to end was verified empirically against a real crewai wheel; the end-to-end sink
gating lives in ``test_streaming.py``. The translator tests drive it
directly with ordered fakes; the conversational test drives real crewai objects.
Neither depends on a live LLM.
"""

import asyncio
import json
import time
from types import SimpleNamespace

import pytest

from crewai import Agent, Crew, Process, Task
from crewai.flow.flow import Flow, start
from crewai.llms.base_llm import BaseLLM

from ag_ui.core import EventType, RunAgentInput, UserMessage
from ag_ui.encoder import EventEncoder

from ag_ui_crewai import attribution as attr
from ag_ui_crewai import endpoint as ep
from ag_ui_crewai._frames import StreamFrameTranslator
from ag_ui_crewai._conversation import prepare_conversational_turn
from ag_ui_crewai.context import flow_context
from ag_ui_crewai.sdk import CopilotKitState
from ag_ui_crewai._capabilities import (
    _conversational_stream_available,
    crewai_event_bus,
    MethodExecutionStartedEvent,
    MethodExecutionFinishedEvent,
)


# ==========================================================================
# Pure BoundaryTracker + event builders
# ==========================================================================

def test_tracker_reconstructs_parent_child_depth_and_path():
    tracker = attr.BoundaryTracker()

    method = tracker.enter(attr.FLOW_METHOD, "generate", flow_name="ResearchFlow")
    crew = tracker.enter(attr.CREW, "research_crew")
    agent = tracker.enter(attr.AGENT, "Researcher")

    # Depth increases with nesting.
    assert (method.depth, crew.depth, agent.depth) == (0, 1, 2)

    # Parent linkage chains child -> parent by step_id.
    assert method.parent_id is None
    assert crew.parent_id == method.step_id
    assert agent.parent_id == crew.step_id

    # flow_name is inherited by nested boundaries that carry none of their own.
    assert crew.flow_name == "ResearchFlow"
    assert agent.flow_name == "ResearchFlow"

    # Root-to-leaf path accumulates.
    assert method.path == ("generate",)
    assert crew.path == ("generate", "research_crew")
    assert agent.path == ("generate", "research_crew", "Researcher")

    # current() / stack reflect the open boundaries.
    assert tracker.current() is agent
    assert tracker.stack == (method, crew, agent)


def test_tracker_step_ids_are_unique_per_boundary():
    tracker = attr.BoundaryTracker()
    m = tracker.enter(attr.FLOW_METHOD, "run")
    c = tracker.enter(attr.CREW, "crew")
    a = tracker.enter(attr.AGENT, "Worker")
    assert len({m.step_id, c.step_id, a.step_id}) == 3


def test_tracker_exit_returns_matched_boundary_and_pops():
    tracker = attr.BoundaryTracker()
    method = tracker.enter(attr.FLOW_METHOD, "generate")
    crew = tracker.enter(attr.CREW, "research_crew")

    assert tracker.exit(attr.CREW, "research_crew") == [crew]
    assert tracker.current() is method

    assert tracker.exit(attr.FLOW_METHOD, "generate") == [method]
    assert tracker.current() is None
    assert tracker.stack == ()


def test_tracker_exit_closes_dangling_inner_boundaries_deepest_first():
    """A lost inner finish must not wedge the stack or leave a dangling
    STEP_STARTED. Exiting the method returns the orphaned inners too,
    deepest-first, so the caller closes them all in balanced order."""
    tracker = attr.BoundaryTracker()
    method = tracker.enter(attr.FLOW_METHOD, "generate")
    crew = tracker.enter(attr.CREW, "research_crew")
    agent = tracker.enter(attr.AGENT, "Researcher")  # inner finishes never fire

    closed = tracker.exit(attr.FLOW_METHOD, "generate")
    assert closed == [agent, crew, method]  # deepest-first
    assert tracker.stack == ()


def test_tracker_exit_returns_empty_for_unknown_boundary():
    tracker = attr.BoundaryTracker()
    tracker.enter(attr.FLOW_METHOD, "run")
    assert tracker.exit(attr.CREW, "never_opened") == []
    # The unmatched exit must not disturb the open method.
    assert tracker.current().name == "run"


def test_tracker_duplicate_names_pair_lifo_with_distinct_step_ids():
    """Two sequential boundaries sharing a name are distinct (unique step_ids)
    and each finish pops its own start via the stable name key (LIFO)."""
    tracker = attr.BoundaryTracker()
    tracker.enter(attr.FLOW_METHOD, "run")
    a1 = tracker.enter(attr.AGENT, "Worker", fingerprint="fp-a1")
    assert tracker.exit(attr.AGENT, "Worker") == [a1]
    a2 = tracker.enter(attr.AGENT, "Worker", fingerprint="fp-a2")
    assert a2.step_id != a1.step_id
    assert tracker.exit(attr.AGENT, "Worker") == [a2]


def test_tracker_drain_all_closes_every_open_boundary_and_clears():
    tracker = attr.BoundaryTracker()
    m = tracker.enter(attr.FLOW_METHOD, "run")
    c = tracker.enter(attr.CREW, "crew")
    assert tracker.drain_all() == [c, m]  # deepest-first
    assert tracker.stack == ()
    # Draining an empty tracker is a no-op.
    assert tracker.drain_all() == []


def test_step_events_carry_attribution_payload():
    tracker = attr.BoundaryTracker()
    method = tracker.enter(
        attr.FLOW_METHOD, "generate", flow_name="ResearchFlow", fingerprint="fp-123"
    )
    crew = tracker.enter(attr.CREW, "research_crew")

    started = attr.step_started_event(crew, source_event_type="crew_kickoff_started")
    assert started.type == EventType.STEP_STARTED
    assert started.step_name == "research_crew"  # leaf identity, backward compatible

    payload = started.raw_event["attribution"]
    assert payload["adapter"] == attr.ATTRIBUTION_ADAPTER
    assert payload["boundary"] == attr.CREW
    assert payload["depth"] == 1
    assert payload["parent_step_id"] == method.step_id
    assert payload["path"] == ["generate", "research_crew"]
    assert payload["qualified_name"] == "generate/research_crew"
    assert payload["flow_name"] == "ResearchFlow"
    assert started.raw_event["crewai_event_type"] == "crew_kickoff_started"

    finished = attr.step_finished_event(crew)
    # Start and finish reference the same boundary -> same step_id.
    assert finished.raw_event["attribution"]["step_id"] == crew.step_id
    # A finish with no source tag omits the provenance key.
    assert "crewai_event_type" not in finished.raw_event


def test_flat_method_attribution_shape():
    payload = attr.flat_method_attribution(
        "generate", flow_name="F", fingerprint="fp", step_id="abc123"
    )["attribution"]
    assert payload["adapter"] == attr.ATTRIBUTION_ADAPTER
    assert payload["boundary"] == attr.FLOW_METHOD
    assert payload["depth"] == 0
    assert payload["parent_step_id"] is None
    assert payload["path"] == ["generate"]
    assert payload["qualified_name"] == "generate"
    assert payload["step_id"] == "abc123"
    assert payload["flow_name"] == "F"
    assert payload["fingerprint"] == "fp"


# ==========================================================================
# StreamFrameTranslator (ordered path: FULL hierarchical attribution)
# ==========================================================================

_seq = 0


def _ev(event_type, **fields):
    """Build a fake raw crewai event: a ``SimpleNamespace`` with ``.type`` and a
    unique ``.event_id`` (the translator keys off ``.type``; ``event_id`` mirrors
    the real events for realism)."""
    global _seq
    _seq += 1
    return SimpleNamespace(type=event_type, event_id=f"evt-{_seq}", **fields)


def _agent_ev(event_type, role, fingerprint=None):
    return _ev(
        event_type,
        agent=SimpleNamespace(role=role),
        source_fingerprint=fingerprint,
    )


def _make_translator():
    return StreamFrameTranslator(
        thread_id="thread-1",
        run_id="run-1",
        state_provider=lambda: {"messages": []},
    )


def _run(translator, events):
    """Feed a list of raw events through ``translate`` and return the flat list
    of AG-UI events emitted, in order."""
    out = []
    for e in events:
        out.extend(translator.translate(e))
    return out


def _steps(events):
    return [
        e for e in events
        if e.type in (EventType.STEP_STARTED, EventType.STEP_FINISHED)
    ]


def _attribution(step_event):
    return (step_event.raw_event or {}).get("attribution") if step_event.raw_event else None


def _assert_pairs_balanced(pairs):
    """``pairs`` is an ordered iterable of ``(is_start, identity)``. Every start
    must have exactly one later finish sharing its identity.

    Single implementation so the translator tests and the decoded-SSE tests
    cannot drift apart on what "balanced" means."""
    open_ids = []
    for is_start, ident in pairs:
        if is_start:
            open_ids.append(ident)
        else:
            assert ident in open_ids, f"unbalanced STEP_FINISHED for {ident!r}"
            open_ids.remove(ident)
    assert open_ids == [], f"unclosed STEP_STARTED(s): {open_ids}"


def _assert_balanced(step_events):
    """Every STEP_STARTED has exactly one later STEP_FINISHED sharing its
    attribution step_id (or step_name for legacy un-attributed steps)."""
    _assert_pairs_balanced(
        (
            e.type == EventType.STEP_STARTED,
            (_attribution(e) or {}).get("step_id") or e.step_name,
        )
        for e in step_events
    )


def test_translator_nested_flow_crew_agent_hierarchy():
    translator = _make_translator()
    events = _run(translator, [
        _ev("flow_started"),
        _ev("method_execution_started", method_name="generate",
            flow_name="ResearchFlow", source_fingerprint="flow-fp"),
        _ev("crew_kickoff_started", crew_name="research_crew",
            source_fingerprint="crew-fp"),
        _agent_ev("agent_execution_started", "Researcher", fingerprint="agent-fp"),
        _agent_ev("agent_execution_completed", "Researcher"),
        _ev("crew_kickoff_completed", crew_name="research_crew"),
        _ev("method_execution_finished", method_name="generate"),
        _ev("flow_finished"),
    ])

    kinds = [e.type for e in events]
    assert kinds[0] == EventType.RUN_STARTED
    assert kinds[-1] == EventType.RUN_FINISHED
    # method_execution_finished still emits its snapshots (unchanged behaviour).
    assert EventType.MESSAGES_SNAPSHOT in kinds
    assert EventType.STATE_SNAPSHOT in kinds

    step_events = _steps(events)
    _assert_balanced(step_events)
    assert [(e.type.name, e.step_name) for e in step_events] == [
        ("STEP_STARTED", "generate"),
        ("STEP_STARTED", "research_crew"),
        ("STEP_STARTED", "Researcher"),
        ("STEP_FINISHED", "Researcher"),
        ("STEP_FINISHED", "research_crew"),
        ("STEP_FINISHED", "generate"),
    ]

    def start_attr(name):
        for e in step_events:
            if e.type == EventType.STEP_STARTED and e.step_name == name:
                return _attribution(e)
        raise AssertionError(name)

    method = start_attr("generate")
    crew = start_attr("research_crew")
    agent = start_attr("Researcher")

    assert method["depth"] == 0 and method["parent_step_id"] is None
    assert crew["depth"] == 1 and crew["parent_step_id"] == method["step_id"]
    assert agent["depth"] == 2 and agent["parent_step_id"] == crew["step_id"]
    assert agent["path"] == ["generate", "research_crew", "Researcher"]
    assert crew["flow_name"] == "ResearchFlow"  # inherited from the method
    assert agent["flow_name"] == "ResearchFlow"  # inherited transitively
    assert method["fingerprint"] == "flow-fp"
    assert crew["fingerprint"] == "crew-fp"
    assert agent["fingerprint"] == "agent-fp"

    # Each finish reuses its start's step_id.
    def finish_attr(name):
        for e in step_events:
            if e.type == EventType.STEP_FINISHED and e.step_name == name:
                return _attribution(e)
        raise AssertionError(name)

    assert finish_attr("Researcher")["step_id"] == agent["step_id"]
    assert finish_attr("research_crew")["step_id"] == crew["step_id"]
    assert finish_attr("generate")["step_id"] == method["step_id"]


def test_translator_parallel_methods_stay_balanced_roots():
    """Concurrent @listen methods interleave their start/finish frames. Each
    must be an independent depth-0 root and close exactly once; a finishing
    method must not force-close a still-running sibling."""
    translator = _make_translator()
    events = _run(translator, [
        _ev("flow_started"),
        _ev("method_execution_started", method_name="a", flow_name="F"),
        _ev("method_execution_started", method_name="b", flow_name="F"),
        _ev("method_execution_finished", method_name="a"),
        _ev("method_execution_finished", method_name="b"),
        _ev("flow_finished"),
    ])

    step_events = _steps(events)
    _assert_balanced(step_events)
    # Exactly one start and one finish per method; no spurious extra close.
    assert [(e.type.name, e.step_name) for e in step_events] == [
        ("STEP_STARTED", "a"),
        ("STEP_STARTED", "b"),
        ("STEP_FINISHED", "a"),
        ("STEP_FINISHED", "b"),
    ]

    def attr_for(kind, name):
        for e in step_events:
            if e.type == kind and e.step_name == name:
                return _attribution(e)
        raise AssertionError(name)

    a_start = attr_for(EventType.STEP_STARTED, "a")
    b_start = attr_for(EventType.STEP_STARTED, "b")
    # Both methods are independent roots, not chained under one another.
    assert a_start["depth"] == 0 and a_start["parent_step_id"] is None
    assert b_start["depth"] == 0 and b_start["parent_step_id"] is None
    # Finishes pair to their own starts.
    assert attr_for(EventType.STEP_FINISHED, "a")["step_id"] == a_start["step_id"]
    assert attr_for(EventType.STEP_FINISHED, "b")["step_id"] == b_start["step_id"]


def test_translator_crew_finish_does_not_close_sibling_method():
    """A crew finishing while a concurrent sibling @listen method sits above it
    on the stack must close only the crew, never over-close the sibling method."""
    translator = _make_translator()
    events = _run(translator, [
        _ev("flow_started"),
        _ev("method_execution_started", method_name="a", flow_name="F"),
        _ev("crew_kickoff_started", crew_name="ca"),
        _ev("method_execution_started", method_name="b", flow_name="F"),
        _ev("crew_kickoff_completed", crew_name="ca"),
        _ev("method_execution_finished", method_name="a"),
        _ev("method_execution_finished", method_name="b"),
        _ev("flow_finished"),
    ])

    step_events = _steps(events)
    _assert_balanced(step_events)
    # ca closes right after its completion frame, before either method finishes;
    # method b is not dragged closed by ca's exit.
    assert [(e.type.name, e.step_name) for e in step_events] == [
        ("STEP_STARTED", "a"),
        ("STEP_STARTED", "ca"),
        ("STEP_STARTED", "b"),
        ("STEP_FINISHED", "ca"),
        ("STEP_FINISHED", "a"),
        ("STEP_FINISHED", "b"),
    ]


def test_translator_dangling_inner_closed_at_method_finish():
    """A crew whose completion frame is lost is force-closed when its owning
    method finishes, so the stream stays balanced."""
    translator = _make_translator()
    events = _run(translator, [
        _ev("flow_started"),
        _ev("method_execution_started", method_name="m", source_fingerprint=None),
        _ev("crew_kickoff_started", crew_name="c", source_fingerprint="cf"),
        # crew never completes; the method just finishes.
        _ev("method_execution_finished", method_name="m"),
        _ev("flow_finished"),
    ])
    step_events = _steps(events)
    _assert_balanced(step_events)
    assert [(e.type.name, e.step_name) for e in step_events] == [
        ("STEP_STARTED", "m"),
        ("STEP_STARTED", "c"),
        ("STEP_FINISHED", "c"),   # dangling inner, closed deepest-first
        ("STEP_FINISHED", "m"),
    ]


def test_translator_drains_open_boundaries_at_flow_finished():
    """A crew AND a method left open (no finish frames) are force-closed at
    flow_finished, deepest-first, before RUN_FINISHED."""
    translator = _make_translator()
    events = _run(translator, [
        _ev("flow_started"),
        _ev("method_execution_started", method_name="m", source_fingerprint=None),
        _ev("crew_kickoff_started", crew_name="c", source_fingerprint="cf"),
        _ev("flow_finished"),
    ])
    _assert_balanced(_steps(events))
    # The last event is RUN_FINISHED and the two closes precede it deepest-first.
    assert events[-1].type == EventType.RUN_FINISHED
    closes = [e for e in _steps(events) if e.type == EventType.STEP_FINISHED]
    assert [e.step_name for e in closes] == ["c", "m"]


def test_translator_crew_finish_without_start_emits_nothing():
    translator = _make_translator()
    translator.translate(_ev("flow_started"))
    # A completion for a crew that never started must not emit an unbalanced
    # close.
    assert translator.translate(
        _ev("crew_kickoff_completed", crew_name="ghost", source_fingerprint=None)
    ) == []


def test_translator_agent_finish_without_start_emits_nothing():
    translator = _make_translator()
    translator.translate(_ev("flow_started"))
    assert translator.translate(
        _agent_ev("agent_execution_error", "ghost")
    ) == []


def test_translator_method_finish_without_start_falls_back_to_flat_close():
    """A method_execution_finished with no open boundary preserves the old flat
    shape: snapshots + an un-attributed STEP_FINISHED named by the method."""
    translator = _make_translator()
    translator.translate(_ev("flow_started"))
    out = translator.translate(_ev("method_execution_finished", method_name="orphan"))
    kinds = [e.type for e in out]
    assert EventType.MESSAGES_SNAPSHOT in kinds
    assert EventType.STATE_SNAPSHOT in kinds
    finishes = [e for e in out if e.type == EventType.STEP_FINISHED]
    assert len(finishes) == 1
    assert finishes[0].step_name == "orphan"
    assert finishes[0].raw_event is None  # legacy un-attributed shape


def test_translator_agent_error_and_crew_failed_close_their_boundaries():
    translator = _make_translator()
    events = _run(translator, [
        _ev("flow_started"),
        _ev("method_execution_started", method_name="m", source_fingerprint=None),
        _ev("crew_kickoff_started", crew_name="c", source_fingerprint="cf"),
        _agent_ev("agent_execution_started", "W", fingerprint="af"),
        _agent_ev("agent_execution_error", "W"),
        _ev("crew_kickoff_failed", crew_name="c"),
        _ev("method_execution_finished", method_name="m"),
        _ev("flow_finished"),
    ])
    step_events = _steps(events)
    _assert_balanced(step_events)
    assert [e.step_name for e in step_events] == ["m", "c", "W", "W", "c", "m"]


def test_translator_method_failed_closes_boundary_without_snapshots():
    """A method_execution_failed closes the open method boundary so no dangling
    STEP_STARTED is left when a flow method fails but the flow continues. Unlike
    method_execution_finished, it emits no MESSAGES/STATE snapshots."""
    translator = _make_translator()
    events = _run(translator, [
        _ev("flow_started"),
        _ev("method_execution_started", method_name="m", source_fingerprint="fp"),
        _ev("method_execution_failed", method_name="m", source_fingerprint="fp"),
        _ev("flow_finished"),
    ])
    step_events = _steps(events)
    _assert_balanced(step_events)
    assert [(e.type.name, e.step_name) for e in step_events] == [
        ("STEP_STARTED", "m"),
        ("STEP_FINISHED", "m"),
    ]
    # The failed close carries provenance and is not accompanied by snapshots.
    finish = next(e for e in step_events if e.type == EventType.STEP_FINISHED)
    assert finish.raw_event["crewai_event_type"] == "method_execution_failed"
    kinds = [e.type for e in events]
    assert EventType.MESSAGES_SNAPSHOT not in kinds
    assert EventType.STATE_SNAPSHOT not in kinds


def test_translator_method_failed_closes_open_crew_and_agent():
    """A method that fails with an open crew/agent below it closes the whole
    subtree (deepest-first), leaving nothing dangling."""
    translator = _make_translator()
    events = _run(translator, [
        _ev("flow_started"),
        _ev("method_execution_started", method_name="m"),
        _ev("crew_kickoff_started", crew_name="c"),
        _agent_ev("agent_execution_started", "W"),
        _ev("method_execution_failed", method_name="m"),
        _ev("flow_finished"),
    ])
    step_events = _steps(events)
    _assert_balanced(step_events)
    assert [(e.type.name, e.step_name) for e in step_events] == [
        ("STEP_STARTED", "m"),
        ("STEP_STARTED", "c"),
        ("STEP_STARTED", "W"),
        ("STEP_FINISHED", "W"),
        ("STEP_FINISHED", "c"),
        ("STEP_FINISHED", "m"),
    ]


def test_translator_names_coerced_to_str():
    """A non-str method/crew name and a UUID-ish agent id must not raise in the
    attribution path; everything is coerced to str."""
    class _UUIDish:
        def __str__(self):
            return "11111111-2222-3333-4444-555555555555"

    translator = _make_translator()
    events = _run(translator, [
        _ev("flow_started"),
        _ev("method_execution_started", method_name=123, source_fingerprint=None),
        _ev("crew_kickoff_started", crew_name=None, source_fingerprint=None),
        # Agent with empty role -> falls back to str(id).
        _ev("agent_execution_started",
            agent=SimpleNamespace(role="", id=_UUIDish()),
            source_fingerprint=None),
        _ev("flow_finished"),
    ])
    step_events = _steps(events)
    _assert_balanced(step_events)
    starts = [e for e in step_events if e.type == EventType.STEP_STARTED]
    assert starts[0].step_name == "123"        # int coerced
    assert starts[1].step_name == "crew"       # None -> fallback
    assert starts[2].step_name.startswith("11111111")  # empty role -> str(id)
    for e in step_events:
        assert isinstance(e.step_name, str)


def test_translator_finalize_drains_when_stream_exhausts_without_flow_finished():
    """If the stream ends with the run open but no flow_finished, finalize()
    closes every dangling boundary before the synthesized RUN_FINISHED."""
    translator = _make_translator()
    _run(translator, [
        _ev("flow_started"),
        _ev("method_execution_started", method_name="m", source_fingerprint=None),
        _ev("crew_kickoff_started", crew_name="c", source_fingerprint="cf"),
    ])
    tail = translator.finalize()
    closes = [e for e in tail if e.type == EventType.STEP_FINISHED]
    assert [e.step_name for e in closes] == ["c", "m"]
    assert tail[-1].type == EventType.RUN_FINISHED
    # A second finalize is idempotent (run already finished).
    assert translator.finalize() == []


def test_translator_run_started_emitted_once():
    translator = _make_translator()
    assert translator.translate(_ev("flow_started"))[0].type == EventType.RUN_STARTED
    # A second flow_started (defensive) emits nothing.
    assert translator.translate(_ev("flow_started")) == []


# ==========================================================================
# Legacy bus-listener path (unordered: FLAT per-method attribution only)
# ==========================================================================

class _FakeFlow:
    """Minimal Flow stand-in the listener can attach a queue to."""

    def __init__(self):
        self.state = {"messages": []}


def _drain(queue):
    items = []
    while True:
        try:
            items.append(queue.get_nowait())
        except asyncio.QueueEmpty:
            break
    return items


async def _settle_bus(queue, expected, budget=3.0):
    """Wait for crewai's off-thread (ThreadPoolExecutor) sync handlers to land.

    crewai 1.x dispatches our listener callbacks on a worker thread; each hops
    back onto the request loop via ``call_soon_threadsafe``. ``flush`` waits for
    the workers, then a loop yield lets the scheduled ``put_nowait`` callbacks
    run. Poll until ``expected`` items are queued or the budget expires.
    """
    flush = getattr(crewai_event_bus, "flush", None)
    deadline = time.monotonic() + budget
    while time.monotonic() < deadline:
        if callable(flush):
            flush(5.0)
        await asyncio.sleep(0.02)
        if queue.qsize() >= expected:
            break


async def test_legacy_method_step_events_carry_flat_attribution_and_matching_step_id():
    """The legacy bus path stamps FLAT attribution on the method's STEP_STARTED
    and STEP_FINISHED with the SAME step_id, so a consumer can pair them.
    No nesting is claimed (depth 0, parent None).

    NOTE: the legacy path is dispatched on crewai's unordered ThreadPoolExecutor
    (see attribution.py "Threading contract"), so the START and FINISH may LAND
    in either order. That is exactly why pairing is by ``step_id`` rather than by
    position; this test asserts the pairing invariant, never arrival order.
    """
    flow = _FakeFlow()
    queue = await ep.create_queue(flow)
    token = flow_context.set(flow)
    try:
        ep.FastAPICrewFlowEventListener()  # registers handlers on the global bus
        crewai_event_bus.emit(flow, MethodExecutionStartedEvent.model_construct(
            flow_name="ResearchFlow", method_name="generate",
            source_fingerprint="flow-fp"))
        crewai_event_bus.emit(flow, MethodExecutionFinishedEvent.model_construct(
            flow_name="ResearchFlow", method_name="generate"))
        # 4 STEP/snapshot events: STEP_STARTED, MESSAGES_SNAPSHOT,
        # STATE_SNAPSHOT, STEP_FINISHED (order between start/finish is not
        # guaranteed on this path).
        await _settle_bus(queue, expected=4)
    finally:
        flow_context.reset(token)
        await ep.delete_queue(flow)

    events = _drain(queue)
    starts = [e for e in events if e is not None and e.type == EventType.STEP_STARTED]
    finishes = [e for e in events if e is not None and e.type == EventType.STEP_FINISHED]
    assert len(starts) == 1 and len(finishes) == 1
    assert starts[0].step_name == "generate"
    assert finishes[0].step_name == "generate"

    start_attr = starts[0].raw_event["attribution"]
    finish_attr = finishes[0].raw_event["attribution"]

    # Flat: no nesting is claimed.
    assert start_attr["boundary"] == attr.FLOW_METHOD
    assert start_attr["depth"] == 0
    assert start_attr["parent_step_id"] is None
    assert start_attr["path"] == ["generate"]
    assert start_attr["flow_name"] == "ResearchFlow"
    assert start_attr["fingerprint"] == "flow-fp"

    # Start and finish share the SAME deterministic step_id (the pairing key),
    # independent of the order in which the two off-thread handlers landed.
    assert start_attr["step_id"] == finish_attr["step_id"]

    # The snapshots are still emitted (unchanged behaviour).
    kinds = [e.type for e in events if e is not None]
    assert EventType.MESSAGES_SNAPSHOT in kinds
    assert EventType.STATE_SNAPSHOT in kinds


def test_legacy_step_id_is_deterministic_and_run_scoped():
    """The helper yields the SAME id for one (run, method) and DIFFERENT ids
    across runs / methods, so start and finish pair without shared state."""
    a1 = ep._legacy_method_step_id("run-key-A", "generate")
    a2 = ep._legacy_method_step_id("run-key-A", "generate")
    b = ep._legacy_method_step_id("run-key-B", "generate")
    c = ep._legacy_method_step_id("run-key-A", "other")
    assert a1 == a2          # same (run, method) -> same id
    assert a1 != b           # different run -> different id
    assert a1 != c           # different method -> different id


def test_crew_agent_lifecycle_types_is_the_single_source_of_truth():
    """The ``_sink`` gate keys off ``CREW_AGENT_LIFECYCLE_TYPES``: it holds
    exactly the six crew/agent ``.type`` strings and none of the flow/method
    ones, so the nested-FLOW drop rule holds."""
    from ag_ui_crewai._frames import CREW_AGENT_LIFECYCLE_TYPES

    assert CREW_AGENT_LIFECYCLE_TYPES == frozenset({
        "crew_kickoff_started", "crew_kickoff_completed", "crew_kickoff_failed",
        "agent_execution_started", "agent_execution_completed",
        "agent_execution_error",
    })
    for t in ("flow_started", "flow_finished",
              "method_execution_started", "method_execution_finished",
              "method_execution_failed"):
        assert t not in CREW_AGENT_LIFECYCLE_TYPES


# ==========================================================================
# Conversational route, real Crew (offline LLM)
# ==========================================================================

class _OfflineLLM(BaseLLM):
    """crewai's public custom-LLM extension point, answering without network.

    Only the model call is replaced: the Crew, Agent, Task, agent executor and
    the crewai event bus all run for real, so the lifecycle frames the
    translator consumes are the ones a live crew emits."""

    def call(
        self,
        messages,
        tools=None,
        callbacks=None,
        available_functions=None,
        from_task=None,
        from_agent=None,
        response_model=None,
    ):
        return "Thought: I know the answer.\nFinal Answer: nested crew reply"


class _NestedCrewFlow(Flow[CopilotKitState]):
    """Regular Flow whose method kicks off a real nested Crew."""

    @start()
    async def chat(self):
        agent = Agent(
            role="Researcher",
            goal="Answer the user briefly.",
            backstory="A terse researcher.",
            llm=_OfflineLLM(model="offline-test-model"),
            verbose=False,
        )
        task = Task(
            description="Answer the user.",
            expected_output="One sentence.",
            agent=agent,
        )
        crew = Crew(
            name="research_crew",
            agents=[agent],
            tasks=[task],
            process=Process.sequential,
            verbose=False,
        )
        result = await asyncio.to_thread(crew.kickoff)
        self.state.messages.append(
            {"role": "assistant", "content": getattr(result, "raw", None) or str(result)}
        )


@pytest.mark.skipif(
    not _conversational_stream_available,
    reason="this crewai build exposes no conversational stream_turn surface",
)
async def test_conversational_route_preserves_nested_crew_attribution():
    """A conversational route shares the regular path's translator, so a Crew
    invoked from a public turn keeps its Flow -> Crew -> Agent attribution."""
    # Imported here, not at module scope: the conversational examples pull in
    # crewai.experimental.conversational, which the floor build does not ship,
    # and a module-scope import would fail collection of this whole file.
    # importorskip covers the module itself; the skipif above covers the case
    # where the module exists but the build has no stream_turn surface.
    conversational = pytest.importorskip("agents.conversational")
    _conversational_type = conversational._conversational_type

    # The SAME factory the dojo's conversational routes use, so this drives the
    # shipped wrapper rather than a lookalike.
    conversational_flow_type = _conversational_type(_NestedCrewFlow)
    input_data = RunAgentInput(
        thread_id="thread-1",
        run_id="run-1",
        state={},
        messages=[UserMessage(id="u1", role="user", content="hello")],
        tools=[],
        context=[],
        forwarded_props={},
    )
    chunks = [
        chunk
        async for chunk in ep._run_flow_frame_stream(
            flow_copy=conversational_flow_type(),
            encoder=EventEncoder(),
            input_data=input_data,
            inputs={"id": "thread-1", "messages": []},
            timeout=30,
            conversational_turn=prepare_conversational_turn(input_data.messages),
        )
    ]
    events = [
        json.loads(line.removeprefix("data:").strip())
        for chunk in chunks
        for line in chunk.splitlines()
        if line.startswith("data:")
    ]

    assert events[0]["type"] == "RUN_STARTED"
    assert events[-1]["type"] == "RUN_FINISHED"

    def payload(event):
        return (event.get("rawEvent") or {}).get("attribution")

    # Same invariant every other translator test enforces, via the same helper:
    # EVERY step opened on this route closes, including the ones outside the
    # nested subtree asserted below.
    _assert_pairs_balanced(
        (
            event["type"] == "STEP_STARTED",
            (payload(event) or {}).get("step_id") or event["stepName"],
        )
        for event in events
        if event["type"] in ("STEP_STARTED", "STEP_FINISHED")
    )

    # The crew did not merely emit lifecycle frames: its answer reached the wire.
    assert any(
        message.get("content") == "nested crew reply"
        for event in events
        if event["type"] == "MESSAGES_SNAPSHOT"
        for message in event["messages"]
    ), "the nested crew's reply never reached the client"

    nested = [
        (event["type"], event["stepName"], payload(event))
        for event in events
        if event["type"] in ("STEP_STARTED", "STEP_FINISHED")
        and payload(event)
        and payload(event)["path"][0] == "chat"
    ]
    assert [(kind, name) for kind, name, _ in nested] == [
        ("STEP_STARTED", "chat"),
        ("STEP_STARTED", "research_crew"),
        ("STEP_STARTED", "Researcher"),
        ("STEP_FINISHED", "Researcher"),
        ("STEP_FINISHED", "research_crew"),
        ("STEP_FINISHED", "chat"),
    ]

    starts = {name: attribution for kind, name, attribution in nested if kind == "STEP_STARTED"}
    method, crew, agent = starts["chat"], starts["research_crew"], starts["Researcher"]

    assert (method["boundary"], method["depth"], method["parent_step_id"]) == (
        attr.FLOW_METHOD,
        0,
        None,
    )
    assert (crew["boundary"], crew["depth"], crew["parent_step_id"]) == (
        attr.CREW,
        1,
        method["step_id"],
    )
    assert (agent["boundary"], agent["depth"], agent["parent_step_id"]) == (
        attr.AGENT,
        2,
        crew["step_id"],
    )
    assert agent["path"] == ["chat", "research_crew", "Researcher"]
    assert agent["flow_name"] == conversational_flow_type.__name__

    finishes = {name: attribution for kind, name, attribution in nested if kind == "STEP_FINISHED"}
    for name in ("chat", "research_crew", "Researcher"):
        assert finishes[name]["step_id"] == starts[name]["step_id"]
