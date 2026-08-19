"""Containment of CrewAI Conversational Flow workers that outlive their request.

CrewAI exposes no async turn stream, so ``conversational=True`` drives its
SYNCHRONOUS ``StreamSession`` on a background thread. Python cannot kill a
running thread, so hard cancellation is not on the table. What IS on the table is
that an abandoned turn publishes nothing, writes nothing, parks nothing, and
cannot be joined by an unbounded crowd of its peers.
"""

import asyncio
import inspect
import logging
import threading
from types import SimpleNamespace

import pytest

from ag_ui.core import RunAgentInput, UserMessage

from ag_ui_crewai import endpoint
from ag_ui_crewai._config import (
    DEFAULT_MAX_CONVERSATION_WORKERS,
    MAX_CONVERSATION_WORKERS_ENV_VAR,
    resolve_max_conversation_workers,
)
from ag_ui_crewai._conversation import (
    AbandonmentSignal,
    SyncStreamSessionAdapter,
    abandoned_conversational_run_for_thread,
    conversation_worker_stats,
    overlay_conversational_persistence,
)
from .conftest import (
    TailedSession,
    WORKER_GUARD,
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

# Generous enough that a loaded CI box does not fail on scheduling, short enough
# that a genuinely stuck worker fails the test instead of hanging the suite.
_WAIT = WORKER_WAIT


class _ParkableSession:
    """Park/release plumbing shared by the sync ``StreamSession`` stand-ins.

    ``parked`` fires once the worker is inside the turn and blocked, which is the
    only moment at which a cancellation reproduces the real bug: the request is
    gone while an unkillable thread sits in a provider call.
    """

    def __init__(self):
        self.pulled = []
        self.closed = False
        self.exhausted = threading.Event()
        # Registered with the shared guard, which fails the test that strands
        # this park or lets it wait out its release. Both outcomes are recorded
        # rather than raised: the wait runs on the WORKER thread, where
        # ``produce`` catches the exception and the abandonment gate discards it.
        self._park_record = WORKER_GUARD.park(type(self).__name__)

    def _park(self) -> bool:
        """Block until the test releases; False if it never did."""
        return self._park_record.wait(_WAIT)

    @property
    def parked(self):
        return self._park_record.parked

    def release(self):
        self._park_record.release()

    def close(self):
        self.closed = True


class _BlockingSyncSession(_ParkableSession):
    """Sync ``StreamSession`` stand-in that parks mid-turn until released."""

    def __init__(self, frames=None, *, error=None, block_at=1):
        super().__init__()
        self._frames = list(frames if frames is not None else driver_frames(3))
        self._error = error
        self._block_at = block_at

    def __iter__(self):
        for index, frame in enumerate(self._frames):
            if index == self._block_at and not self._park():
                return
            self.pulled.append(frame)
            yield frame
        self.exhausted.set()
        if self._error is not None:
            raise self._error


class _FloodingSyncSession(_ParkableSession):
    """Parks once, then pushes real volume through the request's raw-event sink.

    Each emit is followed by a reading of the request-owned buffers taken on the
    WORKER thread, so what ``peak_parked`` records is their size DURING the
    drain rather than whatever survived teardown.
    """

    def __init__(self, volume):
        super().__init__()
        self._volume = volume
        self.peak_parked = 0
        self.emit = None
        self.buffers = None

    def __iter__(self):
        if not self._park():
            return
        for index in range(self._volume):
            self.emit(index)
            self.peak_parked = max(self.peak_parked, self.parked_now())
            frame = SimpleNamespace(id=f"flood-{index}")
            self.pulled.append(frame)
            yield frame
        self.exhausted.set()

    def parked_now(self) -> int:
        return sum(len(self.buffers[name]) for name in ("raw_events", "foreign_events"))


class _FlowStandIn:
    """The least a flow can be for the persistence overlay, on a MUTABLE class.

    Not ``SimpleNamespace``: the bridge latches its "declined to guard this flow's
    pause checkpoint" warning by setting an attribute on ``type(flow)``, and a
    C-implemented type refuses it, so the warning it means to log once per class is
    logged on every single call instead.
    """

    def __init__(self, persistence):
        self.persistence = persistence
        self._state = {}


class _FakeConversationalFlow:
    """Minimal conversational flow: records turns, hands back a fake session."""

    conversational = True

    def __init__(self, sessions):
        self._state = {}
        self.persistence = None
        self._sessions = list(sessions)
        self.turns = []

    @property
    def state(self):
        return self._state

    def stream_turn(self, message, *, session_id=None):
        # Guarded rather than left to ``pop`` an empty list: a turn the test did
        # not stage is the thing several of these tests assert never happens, and
        # an IndexError from inside the driver is mapped to a RUN_ERROR that
        # reads like an unrelated bridge failure.
        assert self._sessions, "the flow was asked to open a turn the test never staged"
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
    assert await asyncio.to_thread(event.wait, _WAIT), "timed out waiting on the worker"


async def _settle(predicate, what):
    """Poll until a worker-thread-driven condition holds, or fail saying which."""
    for _ in range(int(_WAIT * 100)):
        if predicate():
            return
        await asyncio.sleep(0.01)
    raise AssertionError(f"never settled: {what}")


def _capture_conversational_adapters(monkeypatch, *, adapter_class=None):
    """``(adapters, iterators)`` the driver builds, recorded and HELD.

    The iterators are held for the length of the test on purpose: dropping the
    last reference lets asyncio's async-generator finalizer close one for us,
    which is the collector standing in for the driver and would report a pass for
    a release the driver never performed.
    """
    adapters: list = []
    iterators: list = []
    real_adapter = adapter_class or endpoint.SyncStreamSessionAdapter

    def _capturing_adapter(*args, **kwargs):
        adapter = real_adapter(*args, **kwargs)
        adapters.append(adapter)
        opened = adapter.__aiter__

        def _capture():
            iterators.append(opened())
            return iterators[-1]

        adapter.__aiter__ = _capture
        return adapter

    monkeypatch.setattr(endpoint, "SyncStreamSessionAdapter", _capturing_adapter)
    return adapters, iterators


async def _disconnect_mid_turn(flow, input_data, session):
    """Drive one conversational run to a client disconnect while it is parked.

    Returns the spent generator, leaving its sync worker still inside the turn --
    which is precisely the state every containment guard has to hold under.
    """
    agen = frame_stream(flow, input_data)
    first = asyncio.create_task(agen.__anext__())
    await _wait(session.parked)
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first
    return agen


@pytest.mark.asyncio
async def test_abandoned_adapter_drains_session_instead_of_publishing():
    """Consume the sync session to exhaustion, publish none of it.

    Breaking out of the read loop instead leaves CrewAI's generator suspended at
    its ``yield``, so ``close()`` throws GeneratorExit into it and its own
    ``finally: thread.join()`` blocks while an unbounded queue fills behind us.
    """
    session = _BlockingSyncSession(["f0", "f1", "f2"], block_at=1)
    signal = AbandonmentSignal()
    adapter = SyncStreamSessionAdapter(session, abandonment=signal)
    aiter = adapter.__aiter__()

    assert await aiter.__anext__() == "f0"
    await _wait(session.parked)
    signal.abandon()
    session.release()
    await _wait(session.exhausted)

    # Drained: every frame after the abandonment came off CrewAI's queue.
    assert session.pulled == ["f0", "f1", "f2"]
    # Discarded: none of them, and no completion, reached the request. Asserted
    # on the queue the adapter publishes THROUGH rather than on a read that
    # times out: once the worker is gone nothing further can be enqueued, so an
    # empty queue is proof, where "nothing arrived within 250ms" is a guess that
    # a loaded box turns into a false pass.
    await _settle(lambda: not adapter.worker_alive, "the drain worker never exited")
    assert adapter._queue.empty()
    await aiter.aclose()


@pytest.mark.asyncio
async def test_abandoned_adapter_discards_a_late_producer_error():
    """A failure of a run nobody is reading must not be raised into a request."""
    session = _BlockingSyncSession(
        ["f0", "f1"], error=RuntimeError("late upstream failure"), block_at=1
    )
    signal = AbandonmentSignal()
    adapter = SyncStreamSessionAdapter(session, abandonment=signal)
    aiter = adapter.__aiter__()

    assert await aiter.__anext__() == "f0"
    await _wait(session.parked)
    signal.abandon()
    session.release()
    await _wait(session.exhausted)

    await _settle(lambda: not adapter.worker_alive, "the drain worker never exited")
    assert adapter._queue.empty()
    assert session.closed
    await aiter.aclose()


@requires_stream_frames
@pytest.mark.asyncio
async def test_abandonment_stops_the_sink_parking_and_clears_request_buffers(
    monkeypatch,
):
    """The worker keeps our sink in its copied context; the signal is the gate.

    Resetting the sink token unregisters us from the REQUEST context only, so an
    abandoned worker goes on calling the sink. Without the signal check its parks
    accumulate in buffers this generator will never read again.
    """
    captured = capture_stream_sink(monkeypatch)
    parked_calls = []

    def _spy_capture(event, flow):
        parked_calls.append(getattr(event, "event_id", None))

    monkeypatch.setattr(endpoint, "capture_method_emit_context", _spy_capture)

    session = _BlockingSyncSession(block_at=0)
    flow = _FakeConversationalFlow([session])
    input_data = _input("thread-sink", "run-sink")

    agen = frame_stream(flow, input_data)
    first = asyncio.create_task(agen.__anext__())
    await _wait(session.parked)
    buffers = sink_closure(captured)

    # Control: while the request is live the sink parks, as it always has.
    captured["sink"](
        flow, SimpleNamespace(event_id="live", type="method_execution_finished")
    )
    assert parked_calls == ["live"]
    assert list(buffers["raw_events"]) == ["live"]

    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first

    # Teardown dropped what the request owned...
    assert buffers["raw_events"] == {}
    assert buffers["foreign_events"] == {}
    # ...and the still-running worker can no longer refill it.
    captured["sink"](
        flow, SimpleNamespace(event_id="late", type="method_execution_finished")
    )
    assert parked_calls == ["live"]
    assert buffers["raw_events"] == {}

    session.release()
    await agen.aclose()


@requires_stream_frames
@pytest.mark.asyncio
async def test_high_volume_abandoned_turn_keeps_request_buffers_bounded(monkeypatch):
    """Volume through an abandoned turn must not accumulate WHILE it drains.

    The drain is the dangerous window, not the teardown: it lasts as long as the
    provider call that ends the turn, and the worker emits through the request's
    sink for all of it. ``raw_events`` has no cap of its own -- the abandonment
    gate is the only thing bounding it -- so a turn that keeps parking grows one
    dict entry per event for the rest of the turn.
    """
    volume = 4000
    captured = capture_stream_sink(monkeypatch)

    session = _FloodingSyncSession(volume)
    flow = _FakeConversationalFlow([session])
    input_data = _input("thread-flood", "run-flood")

    # RAW passthrough on so the flood reaches BOTH request-owned buffers: an
    # outer-flow event parks in ``raw_events``, a foreign-source one in
    # ``foreign_events``.
    agen = frame_stream(flow, input_data, emit_raw_events=True)
    first = asyncio.create_task(agen.__anext__())
    await _wait(session.parked)
    session.buffers = sink_closure(captured)
    foreign_source = SimpleNamespace(name="a nested crew")

    def _emit(index):
        captured["sink"](
            flow if index % 2 else foreign_source,
            SimpleNamespace(event_id=f"flood-{index}", type="text_stream_chunk"),
        )

    session.emit = _emit

    # Control: the same emits park while the request is live, so a peak of zero
    # after the disconnect means the gate stopped them, not that they never
    # reached a buffer.
    _emit(0)
    _emit(1)
    assert session.parked_now() == 2, "the flood must reach both request buffers"

    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first

    session.release()
    await _wait(session.exhausted)

    assert len(session.pulled) == volume, "the flood never reached full volume"
    assert session.peak_parked == 0, (
        "an abandoned turn parked events for a request that is gone; peak buffer "
        f"size during the drain was {session.peak_parked}"
    )
    await agen.aclose()


def test_abandoned_turn_cannot_overwrite_newer_conversation_state():
    """The persistence overlay drops writes from a turn the client abandoned.

    Persistence is keyed by CONVERSATION, not by run. An abandoned worker's
    remaining saves land after a newer turn has already stored its state, so
    letting them through is a silent rollback of the conversation.
    """
    stored = {}

    class _SpyPersistence:
        def __init__(self):
            self.writes = []

        def load_state(self, flow_uuid):
            return dict(stored.get(flow_uuid, {"id": flow_uuid}))

        def save_state(self, flow_uuid, method_name, state_data):
            self.writes.append((flow_uuid, method_name))
            stored[flow_uuid] = dict(state_data)

        def save_pending_feedback(self, flow_uuid, context, state_data):
            self.writes.append((flow_uuid, "pending"))
            stored[flow_uuid] = dict(state_data)

    spy = _SpyPersistence()
    signal = AbandonmentSignal()
    flow = _FlowStandIn(spy)
    overlay_conversational_persistence(
        flow,
        {"id": "thread-1", "document": "incoming"},
        abandonment=signal,
    )

    # The live turn writes normally.
    flow.persistence.save_state(
        flow_uuid="thread-1", method_name="draft", state_data={"document": "turn one"}
    )
    assert stored["thread-1"] == {"document": "turn one"}

    # The client leaves; a NEWER turn for the same conversation stores its state.
    signal.abandon()
    stored["thread-1"] = {"document": "turn two"}

    # The abandoned worker finally gets around to its own writes.
    flow.persistence.save_state(
        flow_uuid="thread-1",
        method_name="finalize",
        state_data={"document": "turn one, late"},
    )
    flow.persistence.save_pending_feedback(
        flow_uuid="thread-1", context=None, state_data={"document": "turn one, paused"}
    )

    assert stored["thread-1"] == {"document": "turn two"}
    assert spy.writes == [("thread-1", "draft")]
    # Reads stay overlaid: dropping writes must not break session restore.
    assert flow.persistence.load_state("thread-1")["document"] == "incoming"


@pytest.mark.asyncio
async def test_new_run_is_rejected_while_an_abandoned_run_holds_the_thread(caplog):
    """Two turns for one conversation must not execute at the same time.

    A resource bound alone would not catch this: the abandoned worker is still
    writing this conversation's state, and it finishes last as often as not. The
    refusal lasts exactly as long as the residual worker does -- a conversation
    that stayed busy forever would be worse than the race it prevents -- so the
    third turn here proves the thread comes back.
    """
    caplog.set_level(logging.WARNING, logger="ag_ui_crewai._conversation")
    abandoned_session = _BlockingSyncSession(block_at=0)
    # The later turn never parks: it has to run all the way through to prove the
    # conversation was handed back rather than merely accepted.
    later_session = _BlockingSyncSession(block_at=None)
    flow = _FakeConversationalFlow([abandoned_session, later_session])

    agen = await _disconnect_mid_turn(
        flow, _input("thread-shared", "run-first"), abandoned_session
    )
    assert conversation_worker_stats().abandoned_active == 1
    assert abandoned_conversational_run_for_thread("thread-shared") == "run-first"

    body = "".join(
        [
            chunk
            async for chunk in frame_stream(
                flow, _input("thread-shared", "run-second")
            )
        ]
    )

    assert "AGUI_CREWAI_CONVERSATION_THREAD_BUSY" in body
    assert '"threadId":"thread-shared"' in body
    assert '"runId":"run-second"' in body
    # No second turn was opened, so no second unkillable thread exists.
    assert len(flow.turns) == 1
    # Counted and logged, not merely refused: a deployment whose conversations
    # keep colliding has no other signal that it is happening.
    assert conversation_worker_stats().thread_conflict_rejections == 1
    assert "reason=thread-busy-rejected" in caplog.text

    abandoned_session.release()
    await _settle(
        lambda: conversation_worker_stats().active == 0,
        "the abandoned worker never released its slot",
    )
    await agen.aclose()

    # The residual worker is gone, so the conversation is free again.
    assert abandoned_conversational_run_for_thread("thread-shared") is None
    later_body = "".join(
        [
            chunk
            async for chunk in frame_stream(flow, _input("thread-shared", "run-third"))
        ]
    )

    assert "AGUI_CREWAI_CONVERSATION_THREAD_BUSY" not in later_body
    assert "RUN_ERROR" not in later_body
    assert len(flow.turns) == 2
    assert later_session.exhausted.is_set()
    assert conversation_worker_stats().thread_conflict_rejections == 1


def test_an_adapter_refuses_a_lease_whose_signal_is_not_the_runs():
    """The gate above reads the LEASE's signal, so a mismatch voids it silently.

    An adapter handed a lease but no signal mints its own, abandons that one, and
    leaves the lease's signal clear forever: the pool goes on reporting the slot as
    a live turn, and the conversation's next message is admitted alongside the
    abandoned worker still writing its state. There is no correct behavior to fall
    back to, so the pairing is refused where it is made.
    """
    from ag_ui_crewai._conversation import acquire_conversation_worker

    signal = AbandonmentSignal()
    lease = acquire_conversation_worker(
        flow_key="tests.PairingFlow",
        thread_id="thread-pairing",
        run_id="run-pairing",
        signal=signal,
    )
    session = _BlockingSyncSession(block_at=None)

    with pytest.raises(ValueError, match="same AbandonmentSignal"):
        SyncStreamSessionAdapter(session, lease=lease)
    with pytest.raises(ValueError, match="same AbandonmentSignal"):
        SyncStreamSessionAdapter(
            session, abandonment=AbandonmentSignal(), lease=lease
        )

    # The run's own signal is accepted, and nothing was started by the refusals.
    adapter = SyncStreamSessionAdapter(session, abandonment=signal, lease=lease)
    assert adapter._abandonment is lease.signal
    assert adapter._thread is None
    lease.release()
    session.release()


class _OtherFakeConversationalFlow(_FakeConversationalFlow):
    """A DIFFERENT conversational flow class, i.e. a different endpoint.

    The registry is process-wide and a deployment serves many flows from one
    process (the dojo serves about fifteen), so "one conversation" has to mean one
    flow's conversation. A key of ``threadId`` alone makes every endpoint that
    happens to share a client-chosen id one conversation.
    """


@pytest.mark.asyncio
async def test_an_abandoned_turn_does_not_refuse_an_unrelated_flows_turn():
    """A busy conversation on flow A must not refuse flow B's own conversation."""
    abandoned_session = _BlockingSyncSession(block_at=0)
    flow_a = _FakeConversationalFlow([abandoned_session])
    agen = await _disconnect_mid_turn(
        flow_a, _input("thread-shared-id", "run-a"), abandoned_session
    )
    assert conversation_worker_stats().abandoned_active == 1

    unrelated_session = _BlockingSyncSession(block_at=None)
    flow_b = _OtherFakeConversationalFlow([unrelated_session])
    body = "".join(
        [
            chunk
            async for chunk in frame_stream(
                flow_b, _input("thread-shared-id", "run-b")
            )
        ]
    )

    assert "AGUI_CREWAI_CONVERSATION_THREAD_BUSY" not in body
    assert len(flow_b.turns) == 1
    assert unrelated_session.exhausted.is_set()

    abandoned_session.release()
    await _settle(
        lambda: conversation_worker_stats().active == 0,
        "the abandoned worker never released its slot",
    )
    await agen.aclose()


@pytest.mark.asyncio
async def test_worker_pool_is_capped_and_recovers_its_slots(monkeypatch):
    """The cap refuses a turn rather than spawning a thread it cannot reclaim."""
    monkeypatch.setenv(MAX_CONVERSATION_WORKERS_ENV_VAR, "1")

    held_session = _BlockingSyncSession(block_at=0)
    flow = _FakeConversationalFlow([held_session])

    live = frame_stream(flow, _input("thread-a", "run-a"))
    live_body: list = []
    pending = drain_in_task(live, live_body)
    await _wait(held_session.parked)
    assert conversation_worker_stats().active == 1

    body = "".join(
        [chunk async for chunk in frame_stream(flow, _input("thread-b", "run-b"))]
    )

    assert "AGUI_CREWAI_CONVERSATION_CAPACITY" in body
    assert '"runId":"run-b"' in body
    assert len(flow.turns) == 1
    assert conversation_worker_stats().capacity_rejections == 1

    # The held worker runs to completion: its slot comes back.
    held_session.release()
    # These frames are untranslatable stand-ins, so the stream exhausts without
    # the translator ever opening the run. The driver still owes the client a
    # correlated terminal event, so the response opens and closes the run rather
    # than answering an empty 200 the client's run never ends on.
    await pending
    assert any("RUN_STARTED" in chunk for chunk in live_body)
    await _settle(
        lambda: conversation_worker_stats().active == 0,
        "the finished worker never released its slot",
    )

    # A turn that fails before its worker exists must give the slot back too, or
    # one bad flow permanently shrinks the pool.
    class _RaisingFlow(_FakeConversationalFlow):
        def stream_turn(self, message, *, session_id=None):
            raise RuntimeError("turn could not be opened")

    failed = "".join(
        [
            chunk
            async for chunk in frame_stream(_RaisingFlow([]), _input("thread-c", "run-c"))
        ]
    )
    assert "AGUI_CREWAI_FLOW_ERROR_RUNTIMEERROR" in failed
    assert conversation_worker_stats().active == 0


@requires_stream_frames
@requires_conversational_turn_api
@pytest.mark.asyncio
async def test_completed_turn_always_gives_back_its_permit_and_thread():
    """A turn that finished is terminal, so its slot and its thread come back.

    Not inferable from the abandoned path, and the interesting case is the one
    staged here: the worker is STILL RUNNING when the request ends, because the
    post-terminal drain ran out its grace. That is what a healthy completed turn
    looks like. Reading it as abandonment would hold the pool slot, drop the
    turn's persistence writes, and refuse the conversation's next message as
    busy -- while the run it belongs to already reported success.
    """
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
                    _TailingFlow(), _input("thread-done", "run-done")
                )
            ]
        )

        assert "RUN_FINISHED" in body
        assert "RUN_ERROR" not in body
        # The request is over and the worker is still inside the turn: exactly the
        # state the abandonment gate must NOT claim.
        await _wait(tails[0].tail_reached)
        held = conversation_worker_stats()
        assert held.active == 1, "the slot is held until the thread really ends"
        assert held.abandoned_active == 0
        assert held.oldest_abandoned_age_seconds is None
        # The per-thread lease is the one a completed turn is most likely to
        # strand: nothing about it is observable until the conversation's NEXT
        # message is refused as busy.
        assert abandoned_conversational_run_for_thread("thread-done") is None

        next_body = "".join(
            [
                chunk
                async for chunk in frame_stream(
                    _TailingFlow(), _input("thread-done", "run-done-2")
                )
            ]
        )
        assert "AGUI_CREWAI_CONVERSATION_THREAD_BUSY" not in next_body
        assert "RUN_FINISHED" in next_body
    finally:
        gate.set()

    await _settle(
        lambda: conversation_worker_stats().active == 0,
        "a completed turn never released its worker slot",
    )
    settled = conversation_worker_stats()
    assert settled.abandoned_active == 0
    assert settled.capacity_rejections == 0
    assert settled.thread_conflict_rejections == 0
    # Cardinality first: ``all`` over an empty list is True, so a flow that never
    # opened a turn would report every tail as released.
    assert len(tails) == 2
    assert all(tail.tail_released.is_set() for tail in tails)


@requires_stream_frames
@requires_conversational_turn_api
@pytest.mark.asyncio
async def test_a_disconnect_at_a_yield_unwinds_the_frame_iterator(monkeypatch):
    """The driver closes the frame iterator it opened rather than leaving it to GC.

    A client that goes away while the driver is suspended at a ``yield`` throws
    GeneratorExit into the DRIVER, and nothing reaches the adapter's own generator,
    which is suspended one frame behind it. That generator's ``finally`` is what
    drops the request's loop and queue, and they keep every undelivered frame
    reachable, so leaving it suspended defers the release to whenever the
    collector runs.
    """
    adapters, iterators = _capture_conversational_adapters(monkeypatch)

    flow = completing_conversational_flow_type()()
    agen = frame_stream(flow, _input("thread-unwind", "run-unwind"))
    first = await agen.__anext__()
    assert "RUN_STARTED" in first
    # The client disconnects with the driver parked at that yield.
    await agen.aclose()

    assert adapters, "the driver never opened a conversational adapter"
    assert inspect.getasyncgenstate(iterators[0]) == "AGEN_CLOSED", (
        "the driver left the frame iterator it opened suspended"
    )
    assert adapters[0]._plumbing is None, (
        "the request's loop and queue stayed reachable after the request had gone"
    )


@requires_stream_frames
@requires_conversational_turn_api
@pytest.mark.asyncio
async def test_a_cancel_during_the_session_close_still_unwinds_it(monkeypatch):
    """The session close is cancellable, and must not take the iterator with it.

    ``_aclose_stream_session`` re-raises ``CancelledError`` deliberately, and a
    session close really can be cancelled: it awaits, so a cancellation delivered
    while it is suspended lands inside it (crewai's async session awaits its own
    iterator's ``aclose`` at ``types/streaming.py:271``). Reached as a sequential
    statement behind that, the frame iterator's close is skipped on exactly the
    disconnect path it was added for, and the adapter's loop and queue -- holding
    every undelivered frame -- stay reachable until the collector gets to them.
    """
    inside_the_close = asyncio.Event()
    never_released = asyncio.Event()
    real_adapter = endpoint.SyncStreamSessionAdapter

    class _SuspendingCloseAdapter(real_adapter):
        """An adapter whose session close suspends, as an async session's does.

        Only the FIRST close suspends: the same teardown goes on to close the frame
        iterator, whose own unwind calls this again and has to complete.
        """

        async def aclose(self):
            if not inside_the_close.is_set():
                inside_the_close.set()
                await never_released.wait()
            await super().aclose()

    adapters, iterators = _capture_conversational_adapters(
        monkeypatch, adapter_class=_SuspendingCloseAdapter
    )

    flow = completing_conversational_flow_type()()
    agen = frame_stream(flow, _input("thread-cancel-close", "run-cancel-close"))

    async def _serve():
        # ONE task opens the stream and tears it down, which is the shape a server
        # has -- and the only shape in which the driver's contextvar token is
        # reset in the context that set it.
        assert "RUN_STARTED" in await agen.__anext__()
        # The client goes away with the driver parked at that yield.
        await agen.aclose()

    serving = asyncio.create_task(_serve())
    # Cancelled while the teardown is inside the session close: a shutdown landing
    # on a disconnect already in flight.
    await asyncio.wait_for(inside_the_close.wait(), _WAIT)
    serving.cancel()
    with pytest.raises(asyncio.CancelledError):
        await serving

    assert adapters, "the driver never opened a conversational adapter"
    assert inspect.getasyncgenstate(iterators[0]) == "AGEN_CLOSED", (
        "a cancelled session close skipped the frame iterator's own close"
    )
    assert adapters[0]._plumbing is None, (
        "the request's loop and queue stayed reachable after the request had gone"
    )


@requires_stream_frames
@requires_conversational_turn_api
@pytest.mark.asyncio
async def test_a_failing_abandonment_report_still_closes_what_the_driver_opened(
    monkeypatch,
):
    """The abandonment report is bookkeeping; the closes are the containment.

    Reporting the population reads the registry and logs, so it can raise. Reached
    before the closes and outside them, a raise there costs the run every one of
    them: the worker is never asked to stop, the session is never closed, and a
    worker that never started never gets its pool slot back.
    """
    real_adapter = endpoint.SyncStreamSessionAdapter

    class _LiveWorkerAdapter(real_adapter):
        """Forces the report path, which otherwise depends on worker timing."""

        @property
        def worker_alive(self):
            return True

    adapters, iterators = _capture_conversational_adapters(
        monkeypatch, adapter_class=_LiveWorkerAdapter
    )

    def _raising_report(**_kwargs):
        raise RuntimeError("the registry blew up while reporting")

    monkeypatch.setattr(endpoint, "report_conversational_abandonment", _raising_report)

    flow = completing_conversational_flow_type()()
    agen = frame_stream(flow, _input("thread-report-raise", "run-report-raise"))

    async def _serve():
        assert "RUN_STARTED" in await agen.__anext__()
        await agen.aclose()

    with pytest.raises(RuntimeError, match="the registry blew up"):
        await _serve()

    assert adapters, "the driver never opened a conversational adapter"
    assert inspect.getasyncgenstate(iterators[0]) == "AGEN_CLOSED", (
        "a raising abandonment report skipped the frame iterator's close"
    )
    assert adapters[0]._plumbing is None, (
        "the request's loop and queue stayed reachable after the request had gone"
    )


class _FloodingTailSession(TailedSession):
    """A completed turn whose tail keeps emitting after the request unwound.

    The tail is the request-teardown analogue of the abandoned drain, and it runs
    on the COMMON path: RUN_FINISHED is already on the wire, so nothing marks the
    turn abandoned, while the worker goes on emitting through the sink it kept in
    its copied context. Buffer sizes are read on the WORKER thread so
    ``peak_parked`` is their size DURING the tail rather than after it.
    """

    def __init__(self, session, gate, volume):
        super().__init__(session, gate)
        self._volume = volume
        self.peak_parked = 0
        self.flooded = threading.Event()
        self.emit = None
        self.buffers = None

    def __iter__(self):
        yield from self._session
        if not self._hold_the_tail():
            return
        for index in range(self._volume):
            self.emit(index)
            self.peak_parked = max(self.peak_parked, self.parked_now())
        self.flooded.set()

    def parked_now(self) -> int:
        return sum(len(self.buffers[name]) for name in ("raw_events", "foreign_events"))


@requires_stream_frames
@requires_conversational_turn_api
@pytest.mark.asyncio
async def test_completed_turn_tail_cannot_refill_the_request_buffers(monkeypatch):
    """A finished turn is never abandoned, so the sink needs its own gate.

    Abandonment answers "may this publish and persist", and a completed turn's
    tail must keep both. What the tail may NOT keep is the request's raw-event
    buffers: the generator has unwound and cleared them, and nothing will ever
    read them again. Gating the sink on abandonment alone leaves the tail parking
    one uncapped dict entry per event for the rest of the turn, on every healthy
    run whose tail outlives the post-terminal drain grace.
    """
    volume = 4000
    captured = {}
    real_add_sink = endpoint.add_stream_sink

    def _capturing_add_sink(sink):
        captured["sink"] = sink
        return real_add_sink(sink) if callable(real_add_sink) else None

    monkeypatch.setattr(endpoint, "add_stream_sink", _capturing_add_sink)

    gate = threading.Event()
    tails = []

    class _TailingFlow(completing_conversational_flow_type()):
        conversational = True

        def stream_turn(self, message, *, session_id=None):
            tail = _FloodingTailSession(
                super().stream_turn(message, session_id=session_id), gate, volume
            )
            tails.append(tail)
            return tail

    flow = _TailingFlow()
    foreign_source = SimpleNamespace(name="a nested crew")

    def _emit(index):
        captured["sink"](
            flow if index % 2 else foreign_source,
            SimpleNamespace(event_id=f"tail-{index}", type="text_stream_chunk"),
        )

    buffers = None
    body = []
    # RAW passthrough on so the flood reaches BOTH request-owned buffers: an
    # outer-flow event parks in ``raw_events``, a foreign-source one in
    # ``foreign_events``.
    stream = frame_stream(
        flow, _input("thread-tail", "run-tail"), emit_raw_events=True
    )
    try:
        async for chunk in stream:
            body.append(chunk)
            if buffers is None and "sink" in captured:
                buffers = inspect.getclosurevars(captured["sink"]).nonlocals
                # Control: the same emits park while the request is live, so an
                # empty buffer during the tail means the gate stopped them rather
                # than that they never reached a buffer.
                _emit(0)
                _emit(1)
                assert "tail-1" in buffers["raw_events"]
                assert "tail-0" in buffers["foreign_events"]

        joined = "".join(body)
        assert "RUN_FINISHED" in joined
        assert "RUN_ERROR" not in joined
        assert buffers is not None, "the driver never registered its sink"

        tail = tails[0]
        await _wait(tail.tail_reached)
        # Teardown dropped what the request owned...
        assert buffers["raw_events"] == {}
        assert buffers["foreign_events"] == {}
        tail.buffers = buffers
        tail.emit = _emit
    finally:
        # ...and only now does the tail run, entirely after the request is gone.
        gate.set()

    await _wait(tails[0].flooded)
    assert tails[0].peak_parked == 0, (
        "a completed turn's tail parked events for a request that is gone; peak "
        f"buffer size during the tail was {tails[0].peak_parked}"
    )


@pytest.mark.asyncio
async def test_agui_ceiling_abandons_the_turn_and_still_reports_the_timeout(caplog):
    """The request-side ceiling ends the response; the worker keeps running.

    So the ceiling has to do both things at once: tell the client the run timed
    out, and mark the run abandoned so the thread behind it stops publishing and
    the conversation refuses a concurrent turn. Reporting the timeout without
    abandoning would leave a worker publishing into a finished response.
    """
    caplog.set_level(logging.WARNING, logger="ag_ui_crewai._conversation")
    session = _BlockingSyncSession(block_at=0)
    flow = _FakeConversationalFlow([session])

    body = "".join(
        [
            chunk
            async for chunk in frame_stream(
                flow, _input("thread-ceiling", "run-ceiling"), timeout=0.05
            )
        ]
    )

    assert "AGUI_CREWAI_FLOW_TIMEOUT" in body
    assert '"runId":"run-ceiling"' in body
    # Abandoned, not merely timed out: the worker is still inside the turn.
    assert abandoned_conversational_run_for_thread("thread-ceiling") == "run-ceiling"
    assert conversation_worker_stats().abandoned_active == 1
    assert "reason=abandoned" in caplog.text

    session.release()
    await _settle(
        lambda: conversation_worker_stats().active == 0,
        "the abandoned worker never released its slot",
    )


@pytest.mark.asyncio
async def test_worker_population_is_reported_for_operators(monkeypatch, caplog):
    """Active turns, still-running abandoned turns, oldest age, rejections."""
    monkeypatch.setenv(MAX_CONVERSATION_WORKERS_ENV_VAR, "1")
    caplog.set_level("DEBUG", logger="ag_ui_crewai._conversation")

    session = _BlockingSyncSession(block_at=0)
    flow = _FakeConversationalFlow([session])

    agen = await _disconnect_mid_turn(flow, _input("thread-ops", "run-ops"), session)

    abandoned = conversation_worker_stats()
    assert abandoned.max_workers == 1
    assert abandoned.active == 1
    assert abandoned.abandoned_active == 1
    assert abandoned.oldest_abandoned_age_seconds is not None
    assert abandoned.oldest_abandoned_age_seconds >= 0
    assert "reason=abandoned" in caplog.text
    assert "abandoned_active=1" in caplog.text
    # The line that says a worker outlived its request has to name the run it
    # belongs to and the thread an operator would look for in a dump. All three
    # lived in ``extra=`` or nowhere, which default formatters do not print.
    from ag_ui_crewai._conversation import WORKER_THREAD_NAME

    assert "requested cooperative cancellation" in caplog.text
    assert "thread=thread-ops run=run-ops" in caplog.text
    assert f"worker_thread={WORKER_THREAD_NAME}" in caplog.text

    # A refusal while the pool is saturated is counted, not merely refused.
    _ = [chunk async for chunk in frame_stream(flow, _input("thread-ops2", "run-ops2"))]
    assert conversation_worker_stats().capacity_rejections == 1
    assert "reason=capacity-rejected" in caplog.text

    session.release()
    # Settled on the LOG, not on the population: the lease is dropped inside the
    # registry lock and the line below is written after it, so a settle on
    # ``active == 0`` can return before the message this asserts on exists.
    await _settle(
        lambda: "abandoned conversational worker terminated after" in caplog.text,
        "the abandoned worker never reported its termination",
    )
    settled = conversation_worker_stats()
    assert settled.active == 0
    assert settled.abandoned_active == 0
    assert settled.oldest_abandoned_age_seconds is None
    await agen.aclose()


def test_worker_cap_cannot_be_disabled_by_a_bad_value(monkeypatch, caplog):
    """A cap that a typo can switch off is not a cap."""
    monkeypatch.setenv(MAX_CONVERSATION_WORKERS_ENV_VAR, "3")
    assert resolve_max_conversation_workers() == 3

    for bad in ("0", "-1", "nope", ""):
        monkeypatch.setenv(MAX_CONVERSATION_WORKERS_ENV_VAR, bad)
        with caplog.at_level(logging.WARNING, logger="ag_ui_crewai._config"):
            assert resolve_max_conversation_workers() == DEFAULT_MAX_CONVERSATION_WORKERS

    monkeypatch.delenv(MAX_CONVERSATION_WORKERS_ENV_VAR)
    assert resolve_max_conversation_workers() == DEFAULT_MAX_CONVERSATION_WORKERS

    # Falling back is right; falling back SILENTLY is not: the operator sees the
    # default and no reason for it. An explicit ``0`` is reported as refused
    # rather than as a typo, because it parsed fine.
    refusal = next(
        record for record in caplog.records if "refused" in record.getMessage()
    )
    assert MAX_CONVERSATION_WORKERS_ENV_VAR in refusal.getMessage()
    assert "'0'" in refusal.getMessage()
    assert any("nope" in record.getMessage() for record in caplog.records), caplog.text
    # An empty value is documented as "unset", so it is not a typo to report.
    assert not any("''" in record.getMessage() for record in caplog.records)


# The shipped examples' provider bounds are audited in
# ``test_examples_provider_bounds.py``: on this path the provider bound is what
# ends a worker at all, and the audit there refuses every shape that loses it.


@pytest.mark.asyncio
async def test_abandoned_drain_reports_how_much_it_discarded(caplog):
    """The drain's own count is the operator's evidence it drained, not broke.

    The publish gate already stops late frames reaching the request, so removing
    this inner gate is invisible on the wire. What it costs is the count, which is
    the only signal distinguishing "consumed the tail to exhaustion" from "broke
    out and left CrewAI's queue to fill". Pinned so the layer cannot be dropped as
    apparently-redundant.
    """
    caplog.set_level(logging.INFO, logger="ag_ui_crewai._conversation")
    session = _BlockingSyncSession(driver_frames(4), block_at=1)
    signal = AbandonmentSignal()
    adapter = SyncStreamSessionAdapter(session, abandonment=signal)
    aiter = adapter.__aiter__()

    await aiter.__anext__()
    await _wait(session.parked)
    signal.abandon()
    session.release()
    await _wait(session.exhausted)
    await _settle(
        lambda: "drained and discarded" in caplog.text,
        "the drain never reported its discarded frames",
    )

    assert "drained and discarded 3 frame(s)" in caplog.text
    assert len(session.pulled) == 4
    await aiter.aclose()


@pytest.mark.asyncio
async def test_a_closed_request_loop_says_what_it_could_not_deliver(caplog):
    """The one drop the abandonment gate did not decide has to be audible.

    A closed request loop refuses the hand-off, and the run was never marked
    abandoned, so what falls there is a frame the driver was still owed -- and
    then the turn's terminal item, whose loss is a run that simply stops. Counted
    and logged rather than returned from in silence.
    """
    caplog.set_level(logging.WARNING, logger="ag_ui_crewai._conversation")

    class _ClosedLoop:
        def call_soon_threadsafe(self, *_args):
            raise RuntimeError("Event loop is closed")

    session = _BlockingSyncSession(["f0", "f1"], block_at=1)
    adapter = SyncStreamSessionAdapter(session, abandonment=AbandonmentSignal())
    aiter = adapter.__aiter__()

    assert await aiter.__anext__() == "f0"
    await _wait(session.parked)
    # The request's loop closes under the still-running worker.
    adapter._plumbing = (_ClosedLoop(), adapter._plumbing[1])
    session.release()
    await _wait(session.exhausted)
    await _settle(lambda: not adapter.worker_alive, "the worker never exited")

    # The undelivered frame AND the terminal completion behind it.
    assert adapter._undeliverable == 2
    assert "could not hand a conversational item to its request" in caplog.text
    await aiter.aclose()


# A worker the OS refuses to start is covered by
# ``test_conversational_persistence_gate.test_a_worker_that_never_starts_still_
# closes_the_crewai_session``, which drives the identical setup and asserts a
# strict superset: the slot returned and the lease released, plus the crewai
# session closed and a re-iteration refused rather than silently restarted.


async def test_the_leak_guards_worker_thread_name_is_the_one_the_bridge_uses():
    """The leak guard matches worker threads BY NAME, so the name must be real.

    ``conftest`` imports the bridge's own constant rather than copying it, which
    rules out drift between two literals. What that cannot rule out is the bridge
    naming its thread something else entirely: the guard would then match nothing,
    and a guard that matches nothing reports every test as leak-free. So assert
    against a thread the bridge actually spawned.
    """
    session = _BlockingSyncSession(block_at=0)
    adapter = SyncStreamSessionAdapter(session, abandonment=AbandonmentSignal())
    aiter = adapter.__aiter__()
    pending = asyncio.create_task(aiter.__anext__())
    try:
        from ag_ui_crewai._conversation import WORKER_THREAD_NAME

        await _wait(session.parked)
        named = [
            thread
            for thread in threading.enumerate()
            if thread.name == WORKER_THREAD_NAME and thread.is_alive()
        ]
        assert named, (
            f"the bridge spawned no thread named {WORKER_THREAD_NAME!r}, so the leak "
            "guard matches nothing and every test would report as leak-free"
        )
    finally:
        session.release()
        pending.cancel()
        await asyncio.gather(pending, return_exceptions=True)
        await aiter.aclose()
