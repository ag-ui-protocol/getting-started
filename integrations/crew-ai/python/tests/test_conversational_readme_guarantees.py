"""One executable check per containment guarantee the README makes.

The README's conversational section is where an operator learns what the bridge
promises about a turn it cannot kill. Every claim there could go false three ways
with nothing failing: a code change, a crewai change, or a capability probe that
started answering no. Two of the most misleading defects in this change were
exactly that. "An abandoned turn writes nothing" was false as shipped (the
``@persist`` path was never gated), and "the provider timeout is what ends an
abandoned worker" was false for a crew-backed flow (crewai multiplies it).

So each test below does two things: it asserts the behavior, and it asserts the
SENTENCE in the README that the behavior is documented by. A claim reworded or
removed without updating its check fails here, and so does a check whose claim
quietly stopped being made.
"""

import asyncio
import logging
import pathlib
import threading
from types import SimpleNamespace

import pytest

from ag_ui.core import RunAgentInput, UserMessage

from ag_ui_crewai import endpoint
from ag_ui_crewai._config import (
    DEFAULT_MAX_CONVERSATION_WORKERS,
    MAX_CONVERSATION_WORKERS_ENV_VAR,
)
from ag_ui_crewai._conversation import (
    AbandonmentSignal,
    SyncStreamSessionAdapter,
    abandoned_conversational_run_for_thread,
    conversation_worker_stats,
    overlay_conversational_persistence,
)

from .conftest import (
    ParkedSession,
    SpyBackend,
    TailedSession,
    WORKER_WAIT,
    capture_stream_sink,
    completing_conversational_flow_type,
    drain_in_task,
    driver_frames,
    frame_stream,
    requires_conversational_turn_api,
    requires_stream_frames,
    sink_closure,
)
from .test_examples_provider_bounds import audit_examples

README = pathlib.Path(endpoint.__file__).parent.parent / "README.md"

CONTAINMENT_HEADING = "#### Cancellation is containment, not termination"
BOUNDS_HEADING = "#### What actually bounds an abandoned worker"


def documented(*claims):
    """Assert the README still makes each claim, verbatim.

    The link between prose and check, in the only direction that can rot silently:
    a claim can be softened or dropped while its test goes on passing about
    behavior nobody promises any more.
    """
    text = README.read_text()
    missing = [claim for claim in claims if claim not in text]
    assert missing == [], (
        "the README no longer makes the claim this test pins; update both "
        f"together: {missing}"
    )


def containment_bullets():
    """The guarantee bullets under the README's containment heading.

    Read out of the README rather than transcribed, which is the point of the
    index below: a guarantee added to that list has to arrive here as a bullet no
    test claims.
    """
    text = README.read_text()
    start = text.index(CONTAINMENT_HEADING)
    section = text[start : text.index(BOUNDS_HEADING, start)]
    return [line[2:].strip() for line in section.splitlines() if line.startswith("- ")]


# --------------------------------------------------------------------------
# Fixtures shaped like a real abandoned turn.
# --------------------------------------------------------------------------


class _FlowStandIn:
    """The least a flow can be for the persistence overlay, on a MUTABLE class.

    Not ``SimpleNamespace``: the bridge latches its "declined to guard this flow's
    pause checkpoint" warning by setting an attribute on ``type(flow)``, and a
    C-implemented type refuses it, so a line meant once per class is logged on
    every call.
    """

    def __init__(self, persistence):
        self.persistence = persistence
        self._state = {}


def _session(frames=None, *, block_at=1):
    """The shared parked session, labelled for this file's guard failures."""
    return ParkedSession(
        driver_frames(3) if frames is None else frames,
        block_at=block_at,
        what="readme guarantee session",
    )


class _FakeConversationalFlow:
    conversational = True

    def __init__(self, sessions, persistence=None):
        self._state = {}
        self.persistence = persistence
        self._sessions = list(sessions)
        self.turns = []

    @property
    def state(self):
        return self._state

    def stream_turn(self, message, *, session_id=None):
        assert self._sessions, "the flow was asked for a turn the test never staged"
        self.turns.append((message, session_id))
        return self._sessions.pop(0)


def _input(thread_id, run_id):
    return RunAgentInput(
        thread_id=thread_id,
        run_id=run_id,
        state={},
        messages=[UserMessage(id="u1", role="user", content="hello")],
        tools=[],
        context=[],
        forwarded_props={},
    )




async def _wait(event):
    assert await asyncio.to_thread(
        event.wait, WORKER_WAIT
    ), "timed out waiting on the worker"


async def _settle(predicate, what):
    for _ in range(int(WORKER_WAIT * 100)):
        if predicate():
            return
        await asyncio.sleep(0.01)
    raise AssertionError(f"never settled: {what}")


async def _disconnect_mid_turn(flow, input_data, session):
    """Drive one turn to a client disconnect while its worker is parked."""
    agen = frame_stream(flow, input_data)
    first = asyncio.create_task(agen.__anext__())
    await _wait(session.parked)
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first
    return agen


# --------------------------------------------------------------------------
# "it publishes nothing - no frames, no errors, no completion reach the wire"
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_an_abandoned_turn_publishes_nothing():
    documented(
        "it publishes nothing", "no completion reach the wire"
    )
    session = _session(("f0", "f1", "f2"), block_at=1)
    signal = AbandonmentSignal()
    adapter = SyncStreamSessionAdapter(session, abandonment=signal)
    aiter = adapter.__aiter__()

    assert await aiter.__anext__() == "f0"
    await _wait(session.parked)
    signal.abandon()
    session.release()
    await _wait(session.exhausted)
    await _settle(lambda: not adapter.worker_alive, "the drain worker never exited")

    # Asserted on the queue the adapter publishes THROUGH: once the worker is gone
    # nothing further can be enqueued, so an empty queue is proof where "nothing
    # arrived within 250ms" is a guess a loaded box turns into a false pass.
    assert adapter._queue.empty()
    await aiter.aclose()


# --------------------------------------------------------------------------
# "it parks nothing into the request's raw-event buffers"
# --------------------------------------------------------------------------


@requires_stream_frames
@pytest.mark.asyncio
async def test_an_abandoned_turn_parks_nothing_into_the_request_buffers(monkeypatch):
    """Skipped by MARKER on the floor, never from inside the body.

    The in-test skip this replaces could not fire: the monkeypatched wrapper is
    itself callable, so the driver always registered it and the sink was always
    captured. Had it fired it would have ERRORED rather than skipped, because it
    skipped while this test still held a worker parked and the leak guard fails
    that. So the floor is refused before the body runs, and a missing sink inside
    the body is now a failure with a reason.
    """
    documented(
        "it parks nothing into the request's raw-event buffers, which are dropped on"
    )
    captured = capture_stream_sink(monkeypatch)

    session = _session(block_at=0)
    flow = _FakeConversationalFlow([session])
    agen = await _disconnect_mid_turn(
        flow, _input("thread-parks", "run-parks"), session
    )
    buffers = sink_closure(captured)

    captured["sink"](
        flow, SimpleNamespace(event_id="late", type="text_stream_chunk")
    )

    assert buffers["raw_events"] == {}
    assert buffers["foreign_events"] == {}
    session.release()
    await agen.aclose()


# --------------------------------------------------------------------------
# "MOST of its writes through CrewAI's persistence are refused" - and the two
# configurations the gate covers.
# --------------------------------------------------------------------------


def test_an_abandoned_turns_gated_persistence_writes_are_refused():
    documented(
        "of its writes through CrewAI's persistence are refused",
        "one you constructed and handed\n  to the Flow, and one CrewAI creates lazily when a turn pauses",
    )
    backend = SpyBackend()
    flow = _FlowStandIn(backend)
    signal = AbandonmentSignal()
    overlay_conversational_persistence(
        flow, {"id": "thread-1", "document": "incoming"}, abandonment=signal
    )

    # A live turn writes normally, so the refusal below is the gate and not a
    # wrapper that never delegates.
    flow.persistence.save_state("thread-1", "draft", {"document": "turn one"})
    assert backend.writes == [("save_state", "draft")]

    signal.abandon()
    flow.persistence.save_state("thread-1", "late", {"document": "late"})
    flow.persistence.save_pending_feedback("thread-1", None, {})
    flow.persistence.clear_pending_feedback("thread-1")

    assert backend.writes == [("save_state", "draft")]
    # Reads stay overlaid: refusing writes must not break a session restore.
    assert flow.persistence.load_state("thread-1")["document"] == "incoming"


def test_the_persist_decorator_limitation_is_warned_about_rather_than_hidden(caplog):
    """The README names this gap; the code has to name it too, at runtime.

    A documented limitation nobody is told about at the moment it applies is a
    limitation an operator reads as a guarantee.
    """
    documented(
        "It does **not**\n  cover decorator-level `@persist`",
        "logs a runtime warning naming the gap, once per Flow class",
        # The other half of the same claim: with an instance-supplied backend the
        # writes ARE gated, so the warning must stay silent. Proven in
        # ``test_conversational_persistence_gate``'s
        # ``test_an_instance_supplied_backend_gates_persist_and_says_nothing``.
        "so those writes **are** gated and no\n  warning is logged",
    )
    caplog.set_level(logging.WARNING, logger="ag_ui_crewai._conversation")

    from crewai.flow.flow import Flow, start
    from crewai.flow.persistence import persist
    from crewai.flow.persistence.base import FlowPersistence
    from pydantic import Field

    class _Backend(FlowPersistence):
        writes: list = Field(default_factory=list)

        def init_db(self) -> None:
            pass

        def save_state(self, flow_uuid, method_name, state_data):
            self.writes.append(("save_state", method_name))

        def load_state(self, flow_uuid):
            return {"id": flow_uuid}

        def save_pending_feedback(self, flow_uuid, context, state_data):
            pass

        def load_pending_feedback(self, flow_uuid):
            return None

        def clear_pending_feedback(self, flow_uuid):
            pass

    backend = _Backend()

    @persist(persistence=backend)
    class _PersistDecoratedFlow(Flow[dict]):
        @start()
        def step(self):
            return "ok"

    flow = _PersistDecoratedFlow()
    signal = AbandonmentSignal()
    overlay_conversational_persistence(
        flow, {"id": "thread-persist"}, abandonment=signal
    )

    assert "@persist" in caplog.text
    assert "NOT gated" in caplog.text
    # And the write really does land, which is what makes the warning honest.
    signal.abandon()
    flow._persist_method_completion("step")
    assert backend.writes == [("save_state", "step")]


# --------------------------------------------------------------------------
# "it keeps draining its session to natural exhaustion"
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_an_abandoned_turn_drains_its_session_to_exhaustion():
    documented("it keeps draining its session to natural exhaustion")
    session = _session(("f0", "f1", "f2", "f3"), block_at=1)
    signal = AbandonmentSignal()
    adapter = SyncStreamSessionAdapter(session, abandonment=signal)
    aiter = adapter.__aiter__()

    assert await aiter.__anext__() == "f0"
    await _wait(session.parked)
    signal.abandon()
    session.release()
    await _wait(session.exhausted)

    assert session.pulled == ["f0", "f1", "f2", "f3"]
    # ``exhausted`` fires from inside the session; the close runs in the worker's
    # own ``finally``, strictly later on that same thread. So the close is settled
    # for the way the containment suite does it, on the worker's exit, rather than
    # read at the instant exhaustion is observed, where it is reliably still False.
    await _settle(lambda: not adapter.worker_alive, "the drain worker never exited")
    assert session.closed
    await aiter.aclose()


# --------------------------------------------------------------------------
# "it holds a slot in a bounded, process-wide worker pool ... until it really
# terminates"
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_the_worker_pool_cap_is_enforced_and_its_slots_come_back(monkeypatch):
    documented(
        "it holds a slot in a bounded, process-wide worker pool",
        "a new turn gets a\ncorrelated `RUN_ERROR` with code `AGUI_CREWAI_CONVERSATION_CAPACITY`",
        "Both messages carry the pool occupancy and the",
        "the capacity refusal names the knob that lifts it",
    )
    monkeypatch.setenv(MAX_CONVERSATION_WORKERS_ENV_VAR, "1")

    held = _session(block_at=0)
    flow = _FakeConversationalFlow([held])
    live = frame_stream(flow, _input("thread-cap-a", "run-cap-a"))
    live_body: list = []
    pending = drain_in_task(live, live_body)
    await _wait(held.parked)
    assert conversation_worker_stats().active == 1

    refused = "".join(
        [
            chunk
            async for chunk in frame_stream(flow, _input("thread-cap-b", "run-cap-b"))
        ]
    )

    assert "AGUI_CREWAI_CONVERSATION_CAPACITY" in refused
    # No second turn was opened, so no second unkillable thread exists.
    assert len(flow.turns) == 1
    assert conversation_worker_stats().capacity_rejections == 1
    # The occupancy the README says BOTH refusals carry, checked on this one too:
    # the sentence is one claim, and a refusal an operator cannot read the pool
    # size out of is the one that reads as a bridge bug rather than a full pool.
    assert "active=1/1" in refused
    assert "oldest-abandoned-age" in refused
    # And the knob, which for this refusal is the one that lifts it.
    assert MAX_CONVERSATION_WORKERS_ENV_VAR in refused

    held.release()
    # These frames are untranslatable stand-ins, so the run never opens off a
    # frame; the driver opens and closes it anyway rather than answering an empty
    # 200 with no lifecycle event for the client to end the run on.
    await pending
    assert any("RUN_STARTED" in chunk for chunk in live_body)
    await _settle(
        lambda: conversation_worker_stats().active == 0,
        "the finished worker never released its slot",
    )


def test_the_worker_cap_default_and_its_refusal_to_be_disabled(monkeypatch, caplog):
    documented(
        "- **Default:** `16`.",
        "Deliberately not disable-able",
    )
    from ag_ui_crewai._config import resolve_max_conversation_workers

    assert DEFAULT_MAX_CONVERSATION_WORKERS == 16
    for refusable in ("0", "-1"):
        monkeypatch.setenv(MAX_CONVERSATION_WORKERS_ENV_VAR, refusable)
        with caplog.at_level(logging.WARNING, logger="ag_ui_crewai._config"):
            assert (
                resolve_max_conversation_workers()
                == DEFAULT_MAX_CONVERSATION_WORKERS
            )
    assert any("refused" in record.getMessage() for record in caplog.records)


# --------------------------------------------------------------------------
# "When an ABANDONED turn for a threadId is still running, a new turn for that
# same conversation gets AGUI_CREWAI_CONVERSATION_THREAD_BUSY"
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_thread_with_an_abandoned_turn_refuses_a_new_run():
    documented(
        "a new turn for that same conversation gets\n`AGUI_CREWAI_CONVERSATION_THREAD_BUSY`",
        "Both messages carry the pool occupancy and the",
    )
    abandoned = _session(block_at=0)
    flow = _FakeConversationalFlow([abandoned])
    agen = await _disconnect_mid_turn(
        flow, _input("thread-busy", "run-busy-first"), abandoned
    )
    assert abandoned_conversational_run_for_thread("thread-busy") == "run-busy-first"

    refused = "".join(
        [
            chunk
            async for chunk in frame_stream(
                flow, _input("thread-busy", "run-busy-second")
            )
        ]
    )

    assert "AGUI_CREWAI_CONVERSATION_THREAD_BUSY" in refused
    assert len(flow.turns) == 1
    # The occupancy and the knob the README says every refusal carries. The
    # holder is counted in it: the pool size is whatever the operator configured,
    # so the assertion is on this conversation's slot rather than on that number.
    assert "active=1/" in refused
    assert "abandoned=1" in refused
    assert "oldest-abandoned-age" in refused
    assert MAX_CONVERSATION_WORKERS_ENV_VAR in refused

    abandoned.release()
    await _settle(
        lambda: conversation_worker_stats().active == 0,
        "the abandoned worker never released its slot",
    )
    await agen.aclose()


def test_a_conversation_is_one_flows_thread_not_the_id_alone():
    """The refusal is scoped to the Flow whose state the abandoned turn writes.

    A process serves many endpoints and the client picks the ``threadId``, so a
    refusal keyed on the id alone refuses unrelated work. The resume half of this
    claim (a paused regular Flow is never refused) is proven end to end by
    ``test_interrupts.test_e2e_resume_of_a_regular_flow_ignores_a_conversational_worker``.
    """
    documented(
        "A conversation here is one **Flow's** `threadId`, not the id on its own.",
        "A paused **regular** Flow's HITL resume is never refused by it either",
    )
    from ag_ui_crewai._conversation import acquire_conversation_worker

    signal = AbandonmentSignal()
    held = acquire_conversation_worker(
        flow_key="tests.FlowA",
        thread_id="thread-two-flows",
        run_id="run-a",
        signal=signal,
    )
    signal.abandon()
    try:
        assert (
            abandoned_conversational_run_for_thread(
                "thread-two-flows", flow_key="tests.FlowA"
            )
            == "run-a"
        )
        # Another flow's turn on that same id is a different conversation.
        other = acquire_conversation_worker(
            flow_key="tests.FlowB",
            thread_id="thread-two-flows",
            run_id="run-b",
            signal=AbandonmentSignal(),
        )
        other.release()
    finally:
        held.release()


@requires_stream_frames
@requires_conversational_turn_api
@pytest.mark.asyncio
async def test_the_documented_limitation_holds_a_completed_tail_is_accepted():
    """The README states this race stays OPEN, so the test pins the gap, not a fix.

    A turn that finished is deliberately never marked abandoned, so the next
    message on its conversation is accepted while its tail still runs. Pinned
    because the alternative reading, refusing it, would block every ordinary
    back-to-back message for up to a full tail.

    The tail has to be REAL or the race is never entered. A turn whose session is
    already exhausted when the response ends leaves nothing running to race, so
    the second message below is sent while the first turn's worker is held inside
    its tail, gated by an event this test opens.
    """
    documented(
        "**Known limitation: the refusal is scoped to abandoned turns, so one persistence",
        "Send the next message on that conversation during the tail and it is\naccepted",
    )
    gate = threading.Event()
    tails = []

    class _TailingFlow(completing_conversational_flow_type()):
        conversational = True

        def stream_turn(self, message, *, session_id=None):
            tail = TailedSession(
                super().stream_turn(message, session_id=session_id), gate
            )
            tails.append(tail)
            return tail

    try:
        body = "".join(
            [
                chunk
                async for chunk in frame_stream(
                    _TailingFlow(), _input("thread-tail", "run-1")
                )
            ]
        )
        assert "RUN_FINISHED" in body
        assert "RUN_ERROR" not in body

        # The state the limitation is about: response complete, worker still
        # inside the turn, and the run deliberately not marked abandoned.
        await _wait(tails[0].tail_reached)
        assert conversation_worker_stats().active == 1
        assert abandoned_conversational_run_for_thread("thread-tail") is None

        followup = "".join(
            [
                chunk
                async for chunk in frame_stream(
                    _TailingFlow(), _input("thread-tail", "run-2")
                )
            ]
        )
        assert "AGUI_CREWAI_CONVERSATION_THREAD_BUSY" not in followup
        assert "RUN_FINISHED" in followup
    finally:
        gate.set()

    await _settle(
        lambda: conversation_worker_stats().active == 0,
        "a completed turn never released its worker slot",
    )
    # Cardinality first: ``all`` over an empty list is True, so a flow that never
    # opened a turn would report every tail as released.
    assert len(tails) == 2
    assert all(tail.tail_released.is_set() for tail in tails)


# --------------------------------------------------------------------------
# "a provider timeout is not the answer for a crew-backed flow"
# --------------------------------------------------------------------------


def test_the_crew_backed_examples_set_the_documented_execution_ceiling():
    documented(
        "the shipped crew-backed\nexamples set it",
        "**The closest thing to a per-turn bound is `Agent(max_execution_time=...)`",
    )
    findings, counts = audit_examples()
    assert findings == []
    assert counts["crewai_agent"] > 0


def test_the_crewai_multipliers_the_README_quotes_are_still_what_crewai_ships():
    """The README multiplies three crewai defaults to size the residual risk.

    They are quoted as measured against a specific crewai, so a crewai that
    changed one of them makes the published arithmetic wrong with nothing else
    failing. This is the probe that notices.
    """
    documented(
        "provider hands the client `max_retries = 2`",
        "`Agent.max_iter = 25`",
        "`Agent.max_retry_limit = 2`",
        "**The closest thing to a per-turn bound is `Agent(max_execution_time=...)`, and it\ndefaults to `None` (no ceiling).**",
    )
    from crewai import Agent

    assert Agent.model_fields["max_iter"].default == 25
    assert Agent.model_fields["max_retry_limit"].default == 2
    assert Agent.model_fields["max_execution_time"].default is None

    from crewai.llms.providers.openai.completion import OpenAICompletion

    assert OpenAICompletion.model_fields["max_retries"].default == 2


def test_the_reported_population_is_the_one_the_README_documents():
    documented(
        "`conversation_worker_stats()` reports the live population",
        "abandoned\nturns still running, the oldest abandoned turn's age, and both rejection counters",
    )
    stats = conversation_worker_stats()
    for field in (
        "active",
        "abandoned_active",
        "oldest_abandoned_age_seconds",
        "capacity_rejections",
        "thread_conflict_rejections",
        "max_workers",
    ):
        assert hasattr(stats, field), field


def test_an_unsupported_flow_is_refused_rather_than_silently_downgraded():
    documented(
        "it never silently falls back\nto a regular Flow kickoff",
        "code `AGUI_CREWAI_CONVERSATIONAL_FLOW_UNSUPPORTED`",
    )
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from crewai.flow.flow import Flow, start

    from ag_ui_crewai.sdk import CopilotKitState

    class _RegularOnlyFlow(Flow[CopilotKitState]):
        @start()
        def run_regular(self):
            raise AssertionError("regular execution must not be used as a fallback")

    app = FastAPI()
    endpoint.add_crewai_flow_fastapi_endpoint(
        app, _RegularOnlyFlow(), path="/conversation", conversational=True
    )
    response = TestClient(app).post(
        "/conversation",
        json=_input("thread-unsupported", "run-unsupported").model_dump(by_alias=True),
    )

    assert response.status_code == 200
    assert "AGUI_CREWAI_CONVERSATIONAL_FLOW_UNSUPPORTED" in response.text


# The containment bullets, keyed by the opening words of the bullet AS THE README
# WRITES IT, so the index is matched against the file rather than against a
# paraphrase of it.
BULLET_GUARANTEES = {
    "it publishes nothing": "test_an_abandoned_turn_publishes_nothing",
    "it parks nothing into the request's raw-event buffers": (
        "test_an_abandoned_turn_parks_nothing_into_the_request_buffers"
    ),
    "**most** of its writes through CrewAI's persistence are refused": (
        "test_an_abandoned_turns_gated_persistence_writes_are_refused"
    ),
    "it keeps draining its session to natural exhaustion": (
        "test_an_abandoned_turn_drains_its_session_to_exhaustion"
    ),
    "it holds a slot in a bounded, process-wide worker pool": (
        "test_the_worker_pool_cap_is_enforced_and_its_slots_come_back"
    ),
}

# Guarantees the README makes in prose rather than in that list, so there is no
# bullet to match them against. Name-checked only; the ``documented`` call inside
# each test is what ties it to its sentence.
PROSE_GUARANTEES = {
    "@persist limitation warns": (
        "test_the_persist_decorator_limitation_is_warned_about_rather_than_hidden"
    ),
    "cap default and refusal": (
        "test_the_worker_cap_default_and_its_refusal_to_be_disabled"
    ),
    "abandoned thread refuses a new run": (
        "test_a_thread_with_an_abandoned_turn_refuses_a_new_run"
    ),
    "the refusal is scoped to one flow": (
        "test_a_conversation_is_one_flows_thread_not_the_id_alone"
    ),
    "completed tail is accepted": (
        "test_the_documented_limitation_holds_a_completed_tail_is_accepted"
    ),
    "execution ceiling in the examples": (
        "test_the_crew_backed_examples_set_the_documented_execution_ceiling"
    ),
    "crewai multipliers": (
        "test_the_crewai_multipliers_the_README_quotes_are_still_what_crewai_ships"
    ),
    "reported population": (
        "test_the_reported_population_is_the_one_the_README_documents"
    ),
    "unsupported flow refused": (
        "test_an_unsupported_flow_is_refused_rather_than_silently_downgraded"
    ),
}


def test_every_documented_guarantee_has_a_test_here():
    """The index, matched against the README it indexes.

    It used to check only that each name existed in this module, which detects a
    renamed test and nothing else: the advertised README-to-test rot detection was
    not in it. Both directions are checked here. A guarantee ADDED to the
    containment list arrives as a bullet no entry claims; a bullet REWORDED or
    dropped arrives as an entry matching no bullet.
    """
    bullets = containment_bullets()
    assert bullets, f"no containment bullets found under {CONTAINMENT_HEADING!r}"

    unclaimed = [
        bullet
        for bullet in bullets
        if not any(bullet.startswith(opening) for opening in BULLET_GUARANTEES)
    ]
    assert unclaimed == [], (
        "the README's containment list makes a guarantee no test here claims: "
        f"{unclaimed}"
    )
    unmatched = [
        opening
        for opening in BULLET_GUARANTEES
        if not any(bullet.startswith(opening) for bullet in bullets)
    ]
    assert unmatched == [], (
        "these entries match no bullet in the README's containment list, so the "
        f"prose moved and the test did not: {unmatched}"
    )

    missing = [
        name
        for name in (*BULLET_GUARANTEES.values(), *PROSE_GUARANTEES.values())
        if name not in globals()
    ]
    assert missing == [], missing
