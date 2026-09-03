"""Tests for surfacing HITL pauses as AG-UI interrupts on RUN_FINISHED.outcome."""

from ag_ui.core import EventType, RunFinishedEvent, RunFinishedInterruptOutcome

from ag_ui_adk.adk_agent import ADKAgent


def test_no_outcome_when_disabled():
    """Feature off → no outcome, even with pending tool calls (legacy shape)."""
    assert (
        ADKAgent._build_interrupt_outcome(["call_1"], emit_interrupts=False) is None
    )


def test_no_outcome_when_no_pending_calls():
    """Feature on but nothing pending → success run, no interrupt outcome."""
    assert ADKAgent._build_interrupt_outcome([], emit_interrupts=True) is None


def test_interrupt_outcome_maps_pending_calls():
    """Feature on + pending calls → one Interrupt per call, ids correlate."""
    outcome = ADKAgent._build_interrupt_outcome(
        ["call_1", "call_2"], emit_interrupts=True
    )
    assert isinstance(outcome, RunFinishedInterruptOutcome)
    assert outcome.type == "interrupt"
    assert [i.tool_call_id for i in outcome.interrupts] == ["call_1", "call_2"]
    # id doubles as the interrupt id the client addresses in `resume`.
    assert [i.id for i in outcome.interrupts] == ["call_1", "call_2"]
    assert all(i.reason == "tool_call" for i in outcome.interrupts)


def test_run_finished_event_carries_interrupt_outcome():
    """The outcome round-trips on a RUN_FINISHED event and serializes."""
    outcome = ADKAgent._build_interrupt_outcome(["call_1"], emit_interrupts=True)
    evt = RunFinishedEvent(
        type=EventType.RUN_FINISHED,
        thread_id="t1",
        run_id="r1",
        outcome=outcome,
    )
    dumped = evt.model_dump(by_alias=True, exclude_none=True)
    assert dumped["outcome"]["type"] == "interrupt"
    assert dumped["outcome"]["interrupts"][0]["toolCallId"] == "call_1"


def test_run_finished_event_without_outcome_is_legacy_shape():
    """outcome=None keeps the pre-interrupt RUN_FINISHED shape (no outcome key)."""
    evt = RunFinishedEvent(
        type=EventType.RUN_FINISHED, thread_id="t1", run_id="r1", outcome=None
    )
    dumped = evt.model_dump(by_alias=True, exclude_none=True)
    assert "outcome" not in dumped
