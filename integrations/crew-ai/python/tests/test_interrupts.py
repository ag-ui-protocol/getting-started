"""Async human-in-the-loop (interrupt / resume) for the CrewAI AG-UI bridge.

Covers the capability resolution, the ``_hitl`` mapping / gating helpers, the
translator's pause capture, and an end-to-end kickoff-pause + resume through the
real StreamFrame drivers with a live (LLM-free) ``@human_feedback`` flow.
"""

import json
from types import SimpleNamespace

import pytest

from crewai.flow.flow import Flow, start, listen
from crewai.flow import human_feedback
from pydantic import BaseModel

from ag_ui.core import EventType, RunAgentInput
from ag_ui.core.types import ResumeEntry
from ag_ui.encoder import EventEncoder

from ag_ui_crewai import endpoint as ep
from ag_ui_crewai import _capabilities as caps
from ag_ui_crewai._frames import StreamFrameTranslator
from ag_ui_crewai._hitl import (
    HITLOptions,
    AGUIFeedbackProvider,
    agui_feedback_provider,
    build_agui_interrupt,
    build_interrupt_tail,
    feedback_from_resume,
    resume_requested,
)


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------

def _mk_input(thread_id="t-1", run_id="r-1", resume=None):
    return RunAgentInput(
        thread_id=thread_id,
        run_id=run_id,
        state={},
        messages=[],
        tools=[],
        context=[],
        forwarded_props={},
        resume=resume,
    )


def _decode(chunks):
    """Parse encoded SSE chunks into a list of event dicts."""
    events = []
    for chunk in chunks:
        for line in chunk.splitlines():
            if line.startswith("data:"):
                try:
                    events.append(json.loads(line[len("data:"):].strip()))
                except json.JSONDecodeError:
                    pass
    return events


def _types(events):
    return [e.get("type") for e in events]


async def _collect(agen):
    return [chunk async for chunk in agen]


class _DemoState(BaseModel):
    result: str = ""


class _DemoInterruptFlow(Flow[_DemoState]):
    """Live, LLM-free flow that pauses on ``@human_feedback`` then applies it."""

    @start()
    @human_feedback(message="Approve the plan?", provider=agui_feedback_provider)
    def propose(self):
        return {"plan": ["a", "b"]}

    @listen(propose)
    def apply(self, feedback):
        answer = getattr(feedback, "feedback", feedback)
        self.state.result = f"done: {answer}"
        return {"result": self.state.result}


class _DoubleInterruptFlow(Flow[_DemoState]):
    """Live flow with TWO sequential feedback points (exercises re-pause)."""

    @start()
    @human_feedback(message="Approve step 1?", provider=agui_feedback_provider)
    def step_one(self):
        return {"step": 1}

    @listen(step_one)
    @human_feedback(message="Approve step 2?", provider=agui_feedback_provider)
    def step_two(self, feedback):
        return {"step": 2}

    @listen(step_two)
    def done(self, feedback):
        answer = getattr(feedback, "feedback", feedback)
        self.state.result = f"finished: {answer}"
        return {"result": self.state.result}


# --------------------------------------------------------------------------
# Capability resolution
# --------------------------------------------------------------------------

def test_hitl_symbols_resolve_on_supported_crewai():
    # The lock pins crewai 1.15.7, which exposes the whole async-HITL surface.
    assert caps.HumanFeedbackPending is not None
    assert caps.HumanFeedbackRequestedEvent is not None
    assert caps.FlowPausedEvent is not None
    assert caps._flow_from_pending_supported
    assert caps._flow_resume_async_supported
    assert caps.CAPABILITIES.human_feedback_available
    assert caps.CAPABILITIES.human_feedback_request_id_supported


def test_hitl_events_resolve_from_flow_events_module():
    # The pause lifecycle events live on crewai.events.types.flow_events (NOT
    # re-exported at the crewai.events root); the export trap this resolver
    # exists to absorb.
    assert caps.CAPABILITIES.flow_events_module == "crewai.events.types.flow_events"


def test_enabling_versions_table_is_complete():
    assert set(caps.HITL_ENABLING_VERSIONS) == {
        "human_feedback",
        "request_id",
        "stream_frame",
    }


def test_flow_supports_human_feedback_per_flow():
    assert caps.flow_supports_human_feedback(_DemoInterruptFlow())
    # A double exposing neither resume_async nor astream stays off the path.
    double = SimpleNamespace()
    assert not caps.flow_supports_human_feedback(double)


def test_resume_gate_does_not_require_request_id():
    # The resume lifecycle must be usable even without a stable request id
    # (1.8-1.12.1): the interrupt id falls back to the flow/thread id. So the
    # resume gate is the broader capability, and the advertised (stable-id)
    # capability is a strict subset.
    assert caps._human_feedback_resume_available
    assert caps.CAPABILITIES.human_feedback_resume_available
    # Advertised availability implies resume availability, never the reverse.
    assert not (caps.CAPABILITIES.human_feedback_available and not caps.CAPABILITIES.human_feedback_resume_available)


# --------------------------------------------------------------------------
# _hitl: interrupt mapping
# --------------------------------------------------------------------------

def test_build_agui_interrupt_prefers_request_id():
    interrupt = build_agui_interrupt(
        request_id="req-9",
        flow_id="thread-9",
        message="Approve?",
        method_name="propose",
        output={"plan": ["a"]},
        emit=["approved", "rejected"],
    )
    assert interrupt.id == "req-9"
    assert interrupt.reason == "crewai:human_feedback"
    assert interrupt.message == "Approve?"
    assert interrupt.response_schema == {
        "type": "string",
        "enum": ["approved", "rejected"],
    }
    assert interrupt.metadata["crewai"]["flowId"] == "thread-9"
    assert interrupt.metadata["crewai"]["methodName"] == "propose"


def test_build_agui_interrupt_falls_back_to_flow_id():
    interrupt = build_agui_interrupt(
        request_id=None,
        flow_id="thread-9",
        message=None,
        method_name="propose",
        output=None,
        emit=None,
    )
    assert interrupt.id == "thread-9"
    assert interrupt.response_schema is None


def test_build_agui_interrupt_none_without_any_id():
    assert (
        build_agui_interrupt(
            request_id=None,
            flow_id=None,
            message="x",
            method_name="m",
            output=None,
            emit=None,
        )
        is None
    )


def test_build_agui_interrupt_metadata_json_safe():
    # A non-JSON-safe output is coerced rather than left to break encoding.
    interrupt = build_agui_interrupt(
        request_id="r",
        flow_id="f",
        message=None,
        method_name="m",
        output={1, 2, 3},
        emit=None,
    )
    assert isinstance(interrupt.metadata["crewai"]["output"], str)


# --------------------------------------------------------------------------
# _hitl: interrupt tail gating (opt-in outcome)
# --------------------------------------------------------------------------

def _interrupt():
    return build_agui_interrupt(
        request_id="req-1",
        flow_id="t-1",
        message="Approve?",
        method_name="propose",
        output=None,
        emit=None,
    )


def test_tail_default_legacy_event_no_outcome():
    events = build_interrupt_tail(
        _interrupt(), thread_id="t-1", run_id="r-1", options=HITLOptions()
    )
    assert [e.type for e in events] == [EventType.CUSTOM, EventType.RUN_FINISHED]
    custom, finished = events
    assert custom.name == "on_interrupt"
    assert custom.value["id"] == "req-1"
    assert finished.outcome is None


def test_tail_opt_in_outcome():
    events = build_interrupt_tail(
        _interrupt(),
        thread_id="t-1",
        run_id="r-1",
        options=HITLOptions(emit_interrupt_outcome=True),
    )
    finished = events[-1]
    assert finished.outcome is not None
    assert finished.outcome.type == "interrupt"
    assert finished.outcome.interrupts[0].id == "req-1"


def test_tail_opt_in_outcome_keeps_legacy_channel():
    # Opt-in outcome with the legacy event still on (both defaults-plus-opt-in):
    # BOTH channels are present, so old and new clients each see the interrupt.
    events = build_interrupt_tail(
        _interrupt(),
        thread_id="t-1",
        run_id="r-1",
        options=HITLOptions(
            emit_interrupt_outcome=True, enable_legacy_on_interrupt_event=True
        ),
    )
    assert [e.type for e in events] == [EventType.CUSTOM, EventType.RUN_FINISHED]
    assert events[0].name == "on_interrupt"
    assert events[-1].outcome is not None


def test_tail_legacy_disabled_forces_outcome():
    # Disabling the legacy event forces the structured outcome on so the
    # interrupt is always surfaced by at least one channel.
    events = build_interrupt_tail(
        _interrupt(),
        thread_id="t-1",
        run_id="r-1",
        options=HITLOptions(enable_legacy_on_interrupt_event=False),
    )
    assert [e.type for e in events] == [EventType.RUN_FINISHED]
    assert events[0].outcome is not None


# --------------------------------------------------------------------------
# _hitl: resume parsing
# --------------------------------------------------------------------------

def test_resume_requested():
    assert not resume_requested(_mk_input())
    assert resume_requested(
        _mk_input(resume=[ResumeEntry(interrupt_id="i", status="resolved")])
    )


def test_feedback_from_resume_resolved_string():
    feedback, interrupt_id = feedback_from_resume(
        _mk_input(resume=[ResumeEntry(interrupt_id="i", status="resolved", payload="yes")])
    )
    assert feedback == "yes"
    assert interrupt_id == "i"


def test_feedback_from_resume_non_string_payload_is_json():
    feedback, _ = feedback_from_resume(
        _mk_input(
            resume=[ResumeEntry(interrupt_id="i", status="resolved", payload={"ok": True})]
        )
    )
    assert json.loads(feedback) == {"ok": True}


def test_feedback_from_resume_cancelled_is_empty():
    feedback, _ = feedback_from_resume(
        _mk_input(resume=[ResumeEntry(interrupt_id="i", status="cancelled", payload="x")])
    )
    assert feedback == ""


def test_feedback_from_resume_empty():
    assert feedback_from_resume(_mk_input()) == ("", None)


def test_feedback_from_resume_multiple_uses_first(caplog):
    import logging

    with caplog.at_level(logging.WARNING, logger="ag_ui_crewai._hitl"):
        feedback, interrupt_id = feedback_from_resume(
            _mk_input(
                resume=[
                    ResumeEntry(interrupt_id="a", status="resolved", payload="first"),
                    ResumeEntry(interrupt_id="b", status="resolved", payload="second"),
                ]
            )
        )
    assert feedback == "first"
    assert interrupt_id == "a"
    assert any("one pending feedback per flow" in r.message for r in caplog.records)


def test_feedback_from_resume_resolved_none_payload_is_empty():
    feedback, interrupt_id = feedback_from_resume(
        _mk_input(resume=[ResumeEntry(interrupt_id="i", status="resolved")])
    )
    assert feedback == ""
    assert interrupt_id == "i"


# --------------------------------------------------------------------------
# _hitl: provider emits request event + raises pending
# --------------------------------------------------------------------------

def _provider_context(flow_id="thread-7"):
    return SimpleNamespace(
        method_name="propose",
        method_output={"plan": ["a"]},
        message="Approve?",
        emit=["approved"],
        flow_id=flow_id,
    )


def test_provider_emits_request_and_raises_pending():
    captured = []
    bus = caps.crewai_event_bus

    # scoped_handlers auto-unregisters on exit, so the handler never leaks into
    # sibling tests.
    with bus.scoped_handlers():

        @bus.on(caps.HumanFeedbackRequestedEvent)
        def _handler(source, event):  # pylint: disable=unused-argument
            captured.append(event)

        # A real class (name=None) so the provider's ``flow.__class__.__name__``
        # fallback is genuinely exercised (a SimpleNamespace __class__ override
        # does not change __name__).
        class _FakeFlow:
            name = None

        with pytest.raises(caps.HumanFeedbackPending):
            AGUIFeedbackProvider().request_feedback(_provider_context(), _FakeFlow())

        bus.flush()

    assert len(captured) == 1
    assert captured[0].request_id == "thread-7"
    assert captured[0].message == "Approve?"
    assert captured[0].flow_name == "_FakeFlow"


def test_provider_still_pauses_when_event_emit_fails(monkeypatch, caplog):
    import logging

    # A request-event class whose construction always raises: emitting the
    # request event is best-effort, so the provider must STILL raise
    # HumanFeedbackPending (the pause), never let the failure become a RUN_ERROR.
    class _BrokenEvent:
        model_fields = {"type": None}

        def __init__(self, **kwargs):
            raise ValueError("boom")

    monkeypatch.setattr(caps, "HumanFeedbackRequestedEvent", _BrokenEvent)

    class _FakeFlow:
        name = None

    with caplog.at_level(logging.WARNING, logger="ag_ui_crewai._hitl"):
        with pytest.raises(caps.HumanFeedbackPending):
            AGUIFeedbackProvider().request_feedback(_provider_context(), _FakeFlow())
    assert any("could not emit" in r.message for r in caplog.records)


# --------------------------------------------------------------------------
# _frames: translator pause capture
# --------------------------------------------------------------------------

def _translator(**opts):
    return StreamFrameTranslator(
        thread_id="t-1",
        run_id="r-1",
        state_provider=lambda: {},
        hitl_options=HITLOptions(**opts) if opts else None,
    )


def _flow_started():
    return SimpleNamespace(type="flow_started")


def _hf_requested(request_id="req-1"):
    return SimpleNamespace(
        type="human_feedback_requested",
        request_id=request_id,
        message="Approve?",
        method_name="propose",
        output={"plan": ["a"]},
        emit=None,
    )


def _flow_paused(flow_id="t-1"):
    return SimpleNamespace(type="flow_paused", flow_id=flow_id)


def test_translator_captures_pause_and_finalizes_interrupt():
    tr = _translator()
    assert _types_of(tr.translate(_flow_started())) == [EventType.RUN_STARTED]
    assert tr.translate(_hf_requested()) == []
    assert tr.translate(_flow_paused()) == []
    assert tr.interrupted
    tail = tr.finalize()
    assert [e.type for e in tail] == [EventType.CUSTOM, EventType.RUN_FINISHED]
    assert tail[0].value["id"] == "req-1"


async def test_translator_terminal_snapshot_precedes_interrupt_tail():
    # A method emit_states then pauses for async HITL (request + pause, no
    # method_finished). finalize must redeliver the authoritative flow.state as a
    # terminal STATE_SNAPSHOT BEFORE the interrupt tail (CUSTOM, RUN_FINISHED),
    # not strand the client on the ephemeral emit payload.
    from ag_ui_crewai.context import flow_context
    from ag_ui_crewai.sdk import copilotkit_emit_state

    class _F:
        state = {"messages": [], "v": "authoritative"}

    flow = _F()
    tr = StreamFrameTranslator(
        thread_id="t-1",
        run_id="r-1",
        state_provider=lambda: flow.state,
        flow_provider=lambda: flow,
    )
    tr.translate(_flow_started())
    tr.translate(SimpleNamespace(type="method_execution_started", method_name="propose"))
    token = flow_context.set(flow)
    try:
        await copilotkit_emit_state({"v": "ephemeral"})  # sets the suppression flag
    finally:
        flow_context.reset(token)
    tr.translate(_hf_requested())
    tr.translate(_flow_paused())
    tail = tr.finalize()
    types = [e.type for e in tail]
    assert EventType.STATE_SNAPSHOT in types, types
    assert types[-2:] == [EventType.CUSTOM, EventType.RUN_FINISHED], types
    assert types.index(EventType.STATE_SNAPSHOT) < types.index(EventType.CUSTOM), types
    snap = next(e for e in tail if e.type == EventType.STATE_SNAPSHOT)
    assert snap.snapshot == {"messages": [], "v": "authoritative"}


def test_translator_no_pause_finalizes_plain_run_finished():
    tr = _translator()
    tr.translate(_flow_started())
    assert not tr.interrupted
    tail = tr.finalize()
    assert [e.type for e in tail] == [EventType.RUN_FINISHED]
    assert tail[0].outcome is None


def test_translator_pause_outcome_opt_in():
    tr = _translator(emit_interrupt_outcome=True)
    tr.translate(_flow_started())
    tr.translate(_hf_requested())
    tr.translate(_flow_paused())
    tail = tr.finalize()
    assert tail[-1].outcome is not None
    assert tail[-1].outcome.interrupts[0].id == "req-1"


def test_translator_flow_paused_without_request_still_interrupts():
    # A custom provider that raises HumanFeedbackPending WITHOUT emitting the
    # request event: only flow_paused arrives. The run must still terminate with
    # an interrupt (built from the flow id), not a plain RUN_FINISHED that would
    # misreport the paused, persisted flow as completed.
    tr = _translator(emit_interrupt_outcome=True)
    tr.translate(_flow_started())
    tr.translate(_flow_paused(flow_id="t-1"))
    assert tr.interrupted
    tail = tr.finalize()
    assert tail[-1].outcome is not None
    assert tail[-1].outcome.interrupts[0].id == "t-1"


def test_translator_ensure_run_started_idempotent_and_suppresses_flow_started():
    tr = _translator()
    started = tr.ensure_run_started()
    assert _types_of(started) == [EventType.RUN_STARTED]
    # Idempotent: a second call and a later flow_started both emit nothing.
    assert tr.ensure_run_started() == []
    assert tr.translate(_flow_started()) == []


def test_translator_note_pause_from_context_builds_interrupt():
    tr = _translator(emit_interrupt_outcome=True)
    tr.translate(_flow_started())
    ctx = SimpleNamespace(
        flow_id="t-1",
        message="Approve?",
        method_name="propose",
        method_output={"plan": ["a"]},
        emit=None,
    )
    tr.note_pause_from_context(ctx)
    assert tr.interrupted
    tail = tr.finalize()
    assert tail[-1].outcome is not None
    assert tail[-1].outcome.interrupts[0].id == "t-1"


def _types_of(events):
    return [e.type for e in events]


# --------------------------------------------------------------------------
# End-to-end: kickoff pause + resume through the real drivers
# --------------------------------------------------------------------------

@pytest.fixture
def _isolated_cwd(tmp_path, monkeypatch):
    # crewai persists pending feedback to the default SQLite backend in the cwd
    # (./flow_states.db). chdir to a per-test tmp dir so the pending store is
    # isolated and cleaned up automatically.
    monkeypatch.chdir(tmp_path)
    return tmp_path


async def _run_kickoff(flow, input_data, options):
    flow_copy = ep._copy_flow(flow)
    inputs = {"messages": [], "id": input_data.thread_id}
    chunks = await _collect(
        ep._run_flow_frame_stream(
            flow_copy=flow_copy,
            encoder=EventEncoder(),
            input_data=input_data,
            inputs=inputs,
            timeout=30,
            hitl_options=options,
        )
    )
    return _decode(chunks)


async def _run_resume(flow, input_data, options):
    chunks = await _collect(
        ep._run_flow_resume_stream(
            flow=flow,
            encoder=EventEncoder(),
            input_data=input_data,
            timeout=30,
            hitl_options=options,
        )
    )
    return _decode(chunks)


def _assert_event_balance(events):
    """Mini AG-UI-client verifyEvents: STEP_STARTED / STEP_FINISHED must
    balance, and RUN_FINISHED must not fire while a step is still active. The
    real @ag-ui/client rejects a stream that violates either (an interrupt that
    pauses a method mid-flight leaves its step open otherwise)."""
    active = []
    for e in events:
        t = e.get("type")
        if t == "STEP_STARTED":
            active.append(e.get("stepName"))
        elif t == "STEP_FINISHED":
            name = e.get("stepName")
            assert name in active, (
                f"STEP_FINISHED {name!r} with no open STEP_STARTED; active={active}"
            )
            active.remove(name)
        elif t == "RUN_FINISHED":
            assert not active, f"RUN_FINISHED while steps still active: {active}"


async def test_e2e_step_balance_across_interrupt(_isolated_cwd):
    # Pause must close the paused method's step before RUN_FINISHED; resume must
    # re-open the continuing method's step so its STEP_FINISHED is not an orphan.
    flow = _DemoInterruptFlow()
    paused = await _run_kickoff(
        flow, _mk_input("bal"), HITLOptions(emit_interrupt_outcome=True)
    )
    _assert_event_balance(paused)
    resume = [ResumeEntry(interrupt_id="bal", status="resolved", payload="approved")]
    resumed = await _run_resume(
        flow, _mk_input("bal", resume=resume), HITLOptions(emit_interrupt_outcome=True)
    )
    _assert_event_balance(resumed)


async def test_e2e_kickoff_pause_default_opts(_isolated_cwd):
    flow = _DemoInterruptFlow()
    events = await _run_kickoff(flow, _mk_input("thr-a"), HITLOptions())
    types = _types(events)
    assert types[0] == "RUN_STARTED"
    assert types[-1] == "RUN_FINISHED"
    on_interrupt = [
        e for e in events if e.get("type") == "CUSTOM" and e.get("name") == "on_interrupt"
    ]
    assert len(on_interrupt) == 1
    assert on_interrupt[0]["value"]["id"] == "thr-a"
    # Default keeps the structured outcome OFF (legacy channel carries it).
    finished = [e for e in events if e.get("type") == "RUN_FINISHED"][-1]
    assert finished.get("outcome") is None


async def test_e2e_kickoff_pause_outcome_opt_in(_isolated_cwd):
    flow = _DemoInterruptFlow()
    events = await _run_kickoff(
        flow, _mk_input("thr-b"), HITLOptions(emit_interrupt_outcome=True)
    )
    finished = [e for e in events if e.get("type") == "RUN_FINISHED"][-1]
    interrupt = finished["outcome"]["interrupts"][0]
    assert finished["outcome"]["type"] == "interrupt"
    assert interrupt["id"] == "thr-b"
    # The reviewed method output round-trips into the interrupt metadata so the
    # client can render what the human is approving.
    assert interrupt["metadata"]["crewai"]["output"] == {"plan": ["a", "b"]}


class _ResumeEmitFlow(Flow[_DemoState]):
    """Pauses on ``propose``; the RESUMED ``apply`` method calls emit_state, so
    the resume driver must honour emit-time snapshot-suppression too."""

    @start()
    @human_feedback(message="Approve?", provider=agui_feedback_provider)
    def propose(self):
        return {"plan": ["a"]}

    @listen(propose)
    async def apply(self, feedback):
        from ag_ui_crewai.sdk import copilotkit_emit_state

        self.state.result = "authoritative"
        await copilotkit_emit_state({"result": "emit"})


async def test_e2e_resume_emit_state_suppressed_on_resume_driver(_isolated_cwd):
    # The resume driver must wire flow_provider + emit-time capture too: the
    # resumed apply's emit_state must survive method-finish (node-exit
    # STATE_SNAPSHOT suppressed), with the authoritative state redelivered as a
    # terminal snapshot. Deleting the capture wiring on the resume sink regresses
    # this (the node-exit rebuild clobbers 'emit' and no terminal is owed).
    flow = _ResumeEmitFlow()
    await _run_kickoff(flow, _mk_input("thr-remit"), HITLOptions())
    resume = [ResumeEntry(interrupt_id="thr-remit", status="resolved", payload="ok")]
    events = await _run_resume(flow, _mk_input("thr-remit", resume=resume), HITLOptions())
    types = _types(events)
    # apply's node-exit STATE_SNAPSHOT is suppressed: none sits between apply's
    # (the last) MESSAGES_SNAPSHOT and the STEP_FINISHED that follows it.
    mi = len(types) - 1 - types[::-1].index("MESSAGES_SNAPSHOT")
    sf = types.index("STEP_FINISHED", mi)
    assert "STATE_SNAPSHOT" not in types[mi:sf], types
    # The authoritative state is redelivered as the terminal snapshot.
    assert types[-2:] == ["STATE_SNAPSHOT", "RUN_FINISHED"], types
    results = [e.get("snapshot", {}).get("result") for e in events if e.get("type") == "STATE_SNAPSHOT"]
    assert "emit" in results and results[-1] == "authoritative", results


async def test_e2e_resume_completes_run(_isolated_cwd):
    flow = _DemoInterruptFlow()
    # Pause first so a pending state is persisted for this thread.
    await _run_kickoff(flow, _mk_input("thr-c"), HITLOptions())
    resume = [ResumeEntry(interrupt_id="thr-c", status="resolved", payload="looks good")]
    events = await _run_resume(flow, _mk_input("thr-c", resume=resume), HITLOptions())
    types = _types(events)
    assert types[0] == "RUN_STARTED"
    assert types[-1] == "RUN_FINISHED"
    assert sum(1 for t in types if t == "RUN_FINISHED") == 1
    # The applied feedback reaches the final state snapshot.
    snapshots = [e for e in events if e.get("type") == "STATE_SNAPSHOT"]
    assert any(
        "looks good" in json.dumps(s.get("snapshot", {})) for s in snapshots
    )


async def test_e2e_resume_starts_before_content(_isolated_cwd):
    # RUN_STARTED must be the first event of the resumed run, ahead of any
    # step/state event, regardless of when crewai emits flow_started.
    flow = _DemoInterruptFlow()
    await _run_kickoff(flow, _mk_input("thr-order"), HITLOptions())
    resume = [ResumeEntry(interrupt_id="thr-order", status="resolved", payload="ok")]
    events = await _run_resume(flow, _mk_input("thr-order", resume=resume), HITLOptions())
    types = _types(events)
    assert types[0] == "RUN_STARTED"
    # RUN_STARTED appears exactly once and before the first STEP/STATE event.
    assert types.count("RUN_STARTED") == 1
    first_content = next(
        (i for i, t in enumerate(types) if t in ("STEP_STARTED", "STEP_FINISHED", "STATE_SNAPSHOT")),
        None,
    )
    assert first_content is not None and first_content > 0


async def test_e2e_resume_cancelled_completes(_isolated_cwd):
    flow = _DemoInterruptFlow()
    await _run_kickoff(flow, _mk_input("thr-cancel"), HITLOptions())
    resume = [ResumeEntry(interrupt_id="thr-cancel", status="cancelled")]
    events = await _run_resume(flow, _mk_input("thr-cancel", resume=resume), HITLOptions())
    types = _types(events)
    assert types[0] == "RUN_STARTED"
    assert types[-1] == "RUN_FINISHED"
    assert sum(1 for t in types if t == "RUN_FINISHED") == 1


async def test_e2e_resume_repause_emits_second_interrupt(_isolated_cwd):
    flow = _DoubleInterruptFlow()
    # First pause.
    k = await _run_kickoff(
        flow, _mk_input("thr-re"), HITLOptions(emit_interrupt_outcome=True)
    )
    assert [e for e in k if e.get("type") == "RUN_FINISHED"][-1]["outcome"]["type"] == "interrupt"
    # Resume once: the flow pauses AGAIN at the second feedback point, so the
    # resumed run must itself terminate with an interrupt (re-pause), not a
    # plain completion.
    resume = [ResumeEntry(interrupt_id="thr-re", status="resolved", payload="step1 ok")]
    r = await _run_resume(
        flow, _mk_input("thr-re", resume=resume), HITLOptions(emit_interrupt_outcome=True)
    )
    types = _types(r)
    assert types[0] == "RUN_STARTED"
    assert types[-1] == "RUN_FINISHED"
    finished = [e for e in r if e.get("type") == "RUN_FINISHED"][-1]
    assert finished["outcome"]["type"] == "interrupt"


async def test_e2e_resume_no_pending_errors(_isolated_cwd):
    flow = _DemoInterruptFlow()
    resume = [ResumeEntry(interrupt_id="ghost", status="resolved", payload="hi")]
    events = await _run_resume(flow, _mk_input("ghost", resume=resume), HITLOptions())
    assert len(events) == 1
    assert events[0]["type"] == "RUN_ERROR"
    assert events[0]["code"] == "AGUI_CREWAI_NO_PENDING_FEEDBACK"


async def test_e2e_frame_driver_propagated_pause_is_interrupt_not_error(_isolated_cwd):
    # If HumanFeedbackPending PROPAGATES out of astream before any flow_started
    # frame, the driver must still open the run and emit the interrupt tail, not
    # a RUN_ERROR and not an empty stream.
    pending_cls = caps.HumanFeedbackPending

    class _RaisingAstreamFlow:
        state: dict = {}

        def astream(self, inputs=None):
            return self

        def __aiter__(self):
            return self

        async def __anext__(self):
            raise pending_cls(
                context=SimpleNamespace(
                    flow_id="thr-prop",
                    message="Approve?",
                    method_name="step",
                    method_output=None,
                    emit=None,
                )
            )

    events = _decode(
        await _collect(
            ep._run_flow_frame_stream(
                flow_copy=_RaisingAstreamFlow(),
                encoder=EventEncoder(),
                input_data=_mk_input("thr-prop"),
                inputs={"id": "thr-prop"},
                timeout=30,
                hitl_options=HITLOptions(emit_interrupt_outcome=True),
            )
        )
    )
    types = _types(events)
    assert types[0] == "RUN_STARTED"
    assert types[-1] == "RUN_FINISHED"
    assert not any(t == "RUN_ERROR" for t in types)
    finished = [e for e in events if e.get("type") == "RUN_FINISHED"][-1]
    assert finished["outcome"]["type"] == "interrupt"
    assert finished["outcome"]["interrupts"][0]["id"] == "thr-prop"


async def test_e2e_resume_ceiling_is_flow_timeout():
    # A resume whose resume_async idles past the ceiling must report
    # AGUI_CREWAI_FLOW_TIMEOUT (our ceiling), NOT AGUI_CREWAI_UPSTREAM_TIMEOUT.
    import asyncio

    class _HangingResumeFlow:
        state: dict = {}

        @classmethod
        def from_pending(cls, flow_id, persistence=None):
            return cls()

        async def resume_async(self, feedback=""):
            await asyncio.sleep(10)

    resume = [ResumeEntry(interrupt_id="t-to", status="resolved", payload="ok")]
    events = _decode(
        await _collect(
            ep._run_flow_resume_stream(
                flow=_HangingResumeFlow(),
                encoder=EventEncoder(),
                input_data=_mk_input("t-to", resume=resume),
                timeout=0.05,
                hitl_options=HITLOptions(),
            )
        )
    )
    types = _types(events)
    assert types[0] == "RUN_STARTED"
    errors = [e for e in events if e.get("type") == "RUN_ERROR"]
    assert len(errors) == 1
    assert errors[0]["code"] == "AGUI_CREWAI_FLOW_TIMEOUT"


async def test_e2e_crew_endpoint_rejects_resume():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from ag_ui_crewai.examples.crew_chat import CrewChatCrew

    app = FastAPI()
    ep.add_crewai_crew_fastapi_endpoint(app=app, crew=CrewChatCrew(), path="/crew")
    client = TestClient(app)
    payload = _mk_input("t-crew", resume=[ResumeEntry(interrupt_id="i", status="resolved")])
    resp = client.post("/crew", json=payload.model_dump(by_alias=True))
    body = resp.text
    assert "AGUI_CREWAI_RESUME_UNSUPPORTED" in body


async def test_e2e_reject_unsupported_resume():
    events = _decode(
        await _collect(
            ep._reject_unsupported_resume(_mk_input("x"), EventEncoder())
        )
    )
    assert len(events) == 1
    assert events[0]["type"] == "RUN_ERROR"
    assert events[0]["code"] == "AGUI_CREWAI_RESUME_UNSUPPORTED"
