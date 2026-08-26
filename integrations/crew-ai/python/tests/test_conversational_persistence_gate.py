"""The write gate an abandoned CrewAI conversational turn cannot get around.

Persistence is keyed by CONVERSATION, not by run, so a save from a turn whose
client has gone is a silent rollback once a newer turn has stored its state.
crewai reaches a backend in three ways, and they are not equally reachable:

* explicit constructor ``persistence=``, which the wrapped attribute covers,
* LAZY creation on ``HumanFeedbackPending`` (``self.persistence =
  default_flow_persistence()``), which happens AFTER the overlay was installed
  and is the configuration the shipped pausing flow actually reaches,
* the ``@persist`` decorator, whose writes resolve out of
  ``flow._persist_backends`` and never read ``flow.persistence`` at all unless
  persistence was instance-supplied. NOT gated, deliberately, and warned about
  instead: seeding that private cache leaves an already-resolved entry able to
  win, and no shipped flow uses ``@persist``.

The flows here are REAL ``crewai.flow.flow.Flow`` subclasses driven through
crewai's own ``_persist_method_completion``: a hand-injected spy on
``flow.persistence`` would prove nothing about the bypasses, since bypassing
that attribute is the whole point.
"""

import asyncio
import contextlib
import contextvars
import inspect
import logging
import threading
from types import SimpleNamespace

import pytest
from pydantic import Field

from crewai.flow.flow import Flow, start
from crewai.flow.persistence import persist
from crewai.flow.persistence.base import FlowPersistence

import ag_ui_crewai
from ag_ui_crewai import endpoint
from ag_ui_crewai._conversation import (
    _PERSIST_WARNED_ATTR,
    AbandonmentSignal,
    ConversationThreadBusy,
    ConversationWorkerAborted,
    SyncStreamSessionAdapter,
    abandoned_conversational_run_for_thread,
    acquire_conversation_worker,
    conversation_worker_stats,
    conversational_thread_busy_detail,
    overlay_conversational_persistence,
    prepare_conversational_turn,
)

from ag_ui.core import RunAgentInput, UserMessage
from ag_ui.encoder import EventEncoder

from .conftest import (
    ParkedSession,
    PublishParkingSignal,
    WORKER_GUARD,
    WORKER_WAIT,
)


# Generous enough for a loaded CI box, short enough that a stuck worker fails
# the test instead of hanging the suite.
_WAIT = WORKER_WAIT


class _GateSpyPersistence(FlowPersistence):
    """A real crewai backend, so crewai's own resolution accepts it.

    Named per file, not ``_SpyPersistence``: ``FlowPersistence.__init_subclass__``
    registers every subclass in a process-wide registry keyed by CLASS NAME, so two
    test modules defining the same name leave whichever imported last serving both.
    """

    writes: list = Field(default_factory=list)
    stored: dict = Field(default_factory=dict)

    def init_db(self) -> None:
        pass

    def save_state(self, flow_uuid, method_name, state_data):
        self.writes.append(("save_state", method_name))
        self.stored[flow_uuid] = dict(state_data)

    def load_state(self, flow_uuid):
        return dict(self.stored.get(flow_uuid, {"id": flow_uuid}))

    def save_pending_feedback(self, flow_uuid, context, state_data):
        self.writes.append(("save_pending_feedback", flow_uuid))
        self.stored[flow_uuid] = dict(state_data)

    def load_pending_feedback(self, flow_uuid):
        return ("loaded", flow_uuid)

    def clear_pending_feedback(self, flow_uuid):
        self.writes.append(("clear_pending_feedback", flow_uuid))
        self.stored.pop(flow_uuid, None)


# Backends named by a decorator are captured at DECORATION time, so they have to
# be module level. Each test gets a fresh flow instance (and therefore a fresh
# ``_persist_backends`` cache); the fixture below resets the recorded writes.
_FLOW_LEVEL_SPY = _GateSpyPersistence()
_METHOD_LEVEL_SPY = _GateSpyPersistence()


@persist(persistence=_FLOW_LEVEL_SPY)
class _FlowLevelPersistFlow(Flow[dict]):
    """``@persist`` on the CLASS: crewai resolves the backend at construction."""

    @start()
    def step(self):
        return "ok"


class _MethodLevelPersistFlow(Flow[dict]):
    """``@persist`` on ONE method: crewai resolves the backend on first save."""

    @start()
    @persist(persistence=_METHOD_LEVEL_SPY)
    def step(self):
        return "ok"


class _PlainFlow(Flow[dict]):
    """No persistence of any kind. Must stay that way after the overlay."""

    @start()
    def step(self):
        return "ok"


@pytest.fixture(autouse=True)
def _reset_decorator_spies():
    for spy in (_FLOW_LEVEL_SPY, _METHOD_LEVEL_SPY):
        spy.writes.clear()
        spy.stored.clear()
    # The @persist warning is deduped per flow CLASS (it describes the class's own
    # configuration, and repeating it per turn buries it). These classes are module
    # level, so without this the first test to trip the latch silences every later
    # test that asserts the same warning -- the same reason conftest clears the env
    # and alias latches.
    for flow_type in (_FlowLevelPersistFlow, _MethodLevelPersistFlow):
        try:
            type.__delattr__(flow_type, _PERSIST_WARNED_ATTR)
        except AttributeError:
            pass
    yield


def _overlay(flow, signal):
    overlay_conversational_persistence(
        flow, {"id": "thread-1", "document": "incoming"}, abandonment=signal
    )


# --------------------------------------------------------------------------
# The configuration the wrapped attribute does not cover, and the one it cannot.
# --------------------------------------------------------------------------


def test_a_flow_level_persist_write_is_documented_as_ungated():
    """``@persist`` on the class: the write never reads ``flow.persistence``.

    crewai resolves the flow-level definition into ``_persist_backends`` during
    post-init and, because that backend was NOT instance-supplied,
    ``_persist_method_completion`` re-reads it from that cache. Reaching into
    that private cache to gate it was tried and withdrawn: the seeded entry sits
    beside an already-resolved one that can still win, and no shipped flow uses
    ``@persist``. So the write lands, and the overlay says so (see
    ``test_a_persist_decorated_flow_is_told_its_writes_are_not_gated``).
    """
    flow = _FlowLevelPersistFlow()
    signal = AbandonmentSignal()
    _overlay(flow, signal)

    flow._persist_method_completion("step")
    assert _FLOW_LEVEL_SPY.writes == [("save_state", "step")]

    signal.abandon()
    flow._persist_method_completion("step")

    assert _FLOW_LEVEL_SPY.writes == [
        ("save_state", "step"),
        ("save_state", "step"),
    ]


def test_a_method_level_persist_write_is_documented_as_ungated():
    """``@persist`` on a method: the backend does not exist yet at overlay time.

    Nothing is in ``_persist_backends`` until the first completion, and
    ``flow.persistence`` stays ``None`` for the whole turn, so this
    configuration has no wrapped attribute to bypass in the first place either.
    """
    flow = _MethodLevelPersistFlow()
    signal = AbandonmentSignal()
    assert flow.persistence is None
    _overlay(flow, signal)

    signal.abandon()
    flow._persist_method_completion("step")

    assert _METHOD_LEVEL_SPY.writes == [("save_state", "step")]


def test_method_level_persist_write_from_a_live_turn_still_lands():
    """The gate must drop abandoned writes only. Over-gating loses real state."""
    flow = _MethodLevelPersistFlow()
    _overlay(flow, AbandonmentSignal())

    flow._persist_method_completion("step")

    assert _METHOD_LEVEL_SPY.writes == [("save_state", "step")]


def test_lazily_created_pause_persistence_is_gated():
    """crewai creates the pause backend by ASSIGNMENT, after the overlay ran.

    On ``HumanFeedbackPending`` with no persistence configured, crewai does
    ``self.persistence = default_flow_persistence()`` and then saves the pause
    checkpoint through it. The overlay was installed while the attribute was
    still ``None``, so the assignment itself has to be the interception point.
    """
    flow = _PlainFlow()
    signal = AbandonmentSignal()
    assert flow.persistence is None
    _overlay(flow, signal)

    # The exact statement crewai executes at each of its three pause sites.
    flow.persistence = _GateSpyPersistence()
    backend = flow.persistence

    signal.abandon()
    backend.save_pending_feedback("thread-1", None, {"document": "turn one, paused"})
    backend.save_state("thread-1", "finalize", {"document": "turn one, late"})

    assert backend.writes == []
    # Reads stay overlaid, so a session restore still sees the request's state.
    assert backend.load_state("thread-1")["document"] == "incoming"


def test_lazily_created_persistence_serves_a_live_turn_normally():
    flow = _PlainFlow()
    _overlay(flow, AbandonmentSignal())

    flow.persistence = _GateSpyPersistence()
    flow.persistence.save_state("thread-1", "draft", {"document": "turn one"})

    assert flow.persistence.writes == [("save_state", "draft")]


def test_a_second_overlay_repoints_the_lazy_guard():
    """Re-overlaying must not leave the previous run's signal wired in.

    The class is swapped once; a guard held in the override's closure would
    keep gating a later turn on a signal that belongs to an earlier one.
    """
    flow = _PlainFlow()
    stale = AbandonmentSignal()
    current = AbandonmentSignal()
    _overlay(flow, stale)
    _overlay(flow, current)

    stale.abandon()
    flow.persistence = _GateSpyPersistence()
    flow.persistence.save_state("thread-1", "draft", {"document": "live"})
    assert flow.persistence.writes == [("save_state", "draft")]

    current.abandon()
    flow.persistence.save_state("thread-1", "late", {"document": "late"})
    assert flow.persistence.writes == [("save_state", "draft")]


def test_overlay_installs_no_backend_where_crewai_had_none():
    """No eager construction: an unconfigured flow must stay unconfigured.

    Installing a backend up front would flip crewai's
    ``_checkpoint_state_for_ask`` from a no-op into a real ``save_state`` on
    EVERY ``ask()``, on non-abandoned runs too. That is a new write, not a gate.
    """
    flow = _PlainFlow()
    _overlay(flow, AbandonmentSignal())

    assert flow.persistence is None
    # crewai's own probe for "is persistence configured": still answers no.
    flow._checkpoint_state_for_ask()
    assert flow.persistence is None


def test_overlay_leaves_a_conversational_flow_conversational():
    """The interception swaps ``__class__``; the flow must not notice.

    crewai reads ``type(self)._is_conversational()`` and
    ``type(self).flow_definition()`` during a turn. A synthesized subclass that
    re-derived its own definition would answer both differently.
    """
    from agents.conversational import CONVERSATIONAL_FLOW_TYPES

    flow_type = CONVERSATIONAL_FLOW_TYPES["agentic_chat"]
    flow = flow_type()
    definition = flow._definition
    _overlay(flow, AbandonmentSignal())

    assert isinstance(flow, flow_type)
    assert type(flow)._is_conversational() is True
    assert type(flow).flow_definition() is definition
    assert callable(flow.stream_turn)


def test_crewai_persistence_seams_are_still_present():
    """Fail LOUDLY if a future crewai moves the seams this gate depends on.

    Every probe below is something the gate reads at runtime. Silent rot here
    means abandoned writes quietly land again, which is exactly the failure the
    gate exists to prevent.
    """
    import crewai
    from crewai.flow import runtime as crewai_runtime

    where = f"crewai {crewai.__version__}"

    flow = _MethodLevelPersistFlow()
    assert "persistence" in type(flow).model_fields, (
        f"{where}: Flow.persistence is no longer a pydantic field; the "
        "__setattr__ interception may no longer see crewai's assignment"
    )
    assert issubclass(_GateSpyPersistence, FlowPersistence), (
        f"{where}: FlowPersistence is no longer the backend base class; the "
        "gate wrapper can no longer be one, and the flow's own serializer "
        "rejects anything else"
    )

    definition = flow._definition
    assert hasattr(definition, "persist"), f"{where}: FlowDefinition.persist is gone"
    assert getattr(definition.methods["step"], "persist", None) is not None, (
        f"{where}: method-scoped @persist no longer lands on "
        "FlowDefinition.methods[*].persist, so the ungated-write warning can no "
        "longer tell an operator that their flow has one"
    )

    # How the guard has to read the definition it carries onto its subclass.
    graph = inspect.getsource(type(flow).flow_definition.__func__)
    assert '__dict__.get("_flow_definition")' in graph, (
        f"{where}: Flow.flow_definition no longer caches per class in "
        "cls.__dict__; the guarded subclass may now answer with a different "
        "method graph than the flow's own"
    )

    lazy = inspect.getsource(crewai_runtime)
    assert "self.persistence = default_flow_persistence()" in lazy, (
        f"{where}: crewai no longer creates its pause backend by assigning "
        "self.persistence; the __setattr__ interception is now dead code"
    )
    assert "Cannot serialize Flow.persistence of type" in lazy, (
        f"{where}: Flow.persistence is no longer serialized through a "
        "type-checked serializer; the reason the gate wrapper must be a real "
        "FlowPersistence may have changed"
    )


# --------------------------------------------------------------------------
# The destructive call that falls through ``__getattr__``.
# --------------------------------------------------------------------------


def test_clear_pending_feedback_from_an_abandoned_turn_is_dropped():
    """crewai clears the pause checkpoint on resume; an abandoned turn must not.

    This one DELETES: an abandoned worker reaching it wipes the pause a newer
    turn is waiting to be resumed from.
    """
    spy = _GateSpyPersistence()
    flow = _PlainFlow()
    signal = AbandonmentSignal()
    _overlay(flow, signal)
    flow.persistence = spy

    signal.abandon()
    flow.persistence.clear_pending_feedback("thread-1")

    assert spy.writes == []


def test_a_run_that_keeps_dropping_writes_warns_once_per_kind(caplog):
    """A disconnect-heavy deployment drops a write per frame.

    One WARNING each buries every other line in the log, so the first is loud
    and the rest are counted at DEBUG. Per KIND, because a dropped pause
    checkpoint and a dropped state write are different news.
    """
    caplog.set_level(logging.WARNING, logger="ag_ui_crewai._conversation")
    spy = _GateSpyPersistence()
    flow = _PlainFlow()
    signal = AbandonmentSignal()
    _overlay(flow, signal)
    flow.persistence = spy
    signal.abandon()

    for index in range(5):
        flow.persistence.save_state("thread-1", f"step-{index}", {})
    flow.persistence.save_pending_feedback("thread-1", None, {})

    assert spy.writes == []
    assert caplog.text.count("dropped a state write") == 1
    assert caplog.text.count("dropped a pause checkpoint") == 1


def test_reads_are_never_gated():
    """Dropping writes must not break session restore or resume."""
    spy = _GateSpyPersistence()
    flow = _PlainFlow()
    signal = AbandonmentSignal()
    _overlay(flow, signal)
    flow.persistence = spy
    signal.abandon()

    assert flow.persistence.load_state("thread-1")["document"] == "incoming"
    assert flow.persistence.load_pending_feedback("thread-1") == (
        "loaded",
        "thread-1",
    )


# --------------------------------------------------------------------------
# Adapter-level containment.
# --------------------------------------------------------------------------


def _session(frames=("f0", "f1", "f2"), *, block_at=1):
    """The shared parked session, labelled for this file's guard failures."""
    return ParkedSession(frames, block_at=block_at, what="persistence gate session")


class _HeldLease:
    """Lease whose release blocks, pinning the worker thread alive.

    The adapter releases from the worker's own exit, so blocking there is the
    deterministic way to have ``aclose()`` observe a still-alive thread on a
    turn that in fact completed. The block is a guard-registered park, so a test
    that forgets to open the gate fails instead of stranding the worker.
    """

    def __init__(self):
        self._park = WORKER_GUARD.park("_HeldLease release")
        self.released = False

    @property
    def gate(self):
        return self._park.released

    def open_gate(self):
        self._park.release()

    def release(self):
        self._park.wait(_WAIT)
        self.released = True


async def _wait(event):
    assert await asyncio.to_thread(event.wait, _WAIT), "timed out waiting on the worker"


async def _finalize(aiter, pending):
    """Cancel the in-flight read, then finalize the generator behind it.

    A suspended async generator is otherwise finalized by the loop at GC time,
    so its ``finally`` (``aclose`` plus the plumbing release) runs during whichever
    test happens to be executing then.
    """
    pending.cancel()
    try:
        with pytest.raises(asyncio.CancelledError):
            await pending
    finally:
        await aiter.aclose()


async def _settle(predicate, what):
    """Poll until the worker thread has caught up, or fail saying what did not."""
    deadline = asyncio.get_running_loop().time() + _WAIT
    while asyncio.get_running_loop().time() < deadline:
        if predicate():
            return
        await asyncio.sleep(0.02)
    raise AssertionError(what)


@pytest.mark.asyncio
async def test_aclose_returns_the_pool_slot_when_close_raises(caplog):
    """A raising ``close()`` must not cost the pool a slot forever.

    The caller swallows teardown errors at DEBUG, so a leak here is invisible
    and permanent; enough of them wedge all conversational traffic.
    """
    caplog.set_level(logging.DEBUG, logger="ag_ui_crewai._conversation")

    class _CloseFailingSession:
        def __iter__(self):
            return iter(())

        def close(self):
            raise RuntimeError("close failed")

    signal = AbandonmentSignal()
    lease = acquire_conversation_worker(
        flow_key="tests.CloseFailingFlow",
        thread_id="thread-close",
        run_id="run-close",
        signal=signal,
    )
    adapter = SyncStreamSessionAdapter(
        _CloseFailingSession(), abandonment=signal, lease=lease
    )

    # No worker was ever started, so ``aclose`` owns the release.
    await adapter.aclose()

    assert lease.released
    assert conversation_worker_stats().active == 0
    # Surfaced rather than propagated, since the caller would swallow a raise.
    assert "failed to close a conversational StreamSession" in caplog.text
    assert "close failed" in caplog.text


@pytest.mark.asyncio
async def test_a_worker_that_never_starts_still_closes_the_crewai_session(monkeypatch):
    """Nothing else can close the session on this path.

    The failure is raised out of the start BEFORE the iteration's own teardown
    exists, so the worker never runs its ``finally`` and ``aclose()`` is never
    reached. An unclosed CrewAI session keeps its producer thread and its
    unbounded frame queue alive for the rest of the process.
    """
    session = _session(block_at=0)
    signal = AbandonmentSignal()
    lease = acquire_conversation_worker(
        flow_key="tests.NoStartFlow",
        thread_id="thread-nostart",
        run_id="run-nostart",
        signal=signal,
    )

    def _refuse(_self):
        raise RuntimeError("can't start new thread")

    monkeypatch.setattr(threading.Thread, "start", _refuse)
    adapter = SyncStreamSessionAdapter(session, abandonment=signal, lease=lease)

    aiter = adapter.__aiter__()
    try:
        with pytest.raises(RuntimeError, match="can't start new thread"):
            await aiter.__anext__()
    finally:
        await aiter.aclose()

    assert session.closed
    assert not adapter.worker_alive
    assert lease.released
    assert conversation_worker_stats().active == 0

    # And a second iteration must not silently restart on that closed session.
    # Without the refusal it builds fresh plumbing, starts a worker on a session
    # crewai has already closed, and an empty stream is what the driver finalizes
    # into a SUCCESSFUL run.
    monkeypatch.undo()
    retried = adapter.__aiter__()
    with pytest.raises(ConversationWorkerAborted):
        await retried.__anext__()
    await retried.aclose()
    assert conversation_worker_stats().active == 0


@pytest.mark.asyncio
async def test_a_baseexception_abort_is_not_a_clean_end_of_stream(monkeypatch):
    """A truncated turn must not surface as natural exhaustion.

    ``except Exception`` does not catch a ``BaseException`` abort, so the
    completion published in ``finally`` would tell the driver the turn ended
    normally and it would finalize a successful RUN_FINISHED on a partial turn.
    """
    monkeypatch.setattr(threading, "excepthook", lambda args: None)

    class _AbortingSession:
        def __iter__(self):
            yield "f0"
            raise KeyboardInterrupt("worker aborted")

        def close(self):
            pass

    adapter = SyncStreamSessionAdapter(_AbortingSession())
    aiter = adapter.__aiter__()

    try:
        assert await aiter.__anext__() == "f0"
        with pytest.raises(ConversationWorkerAborted):
            await aiter.__anext__()
    finally:
        await aiter.aclose()


@pytest.mark.asyncio
async def test_re_iterating_a_torn_down_adapter_is_loud_not_empty(caplog):
    """An empty stream is what the driver finalizes into a successful run.

    Once the first consumer unwound, the turn's frames are gone: a second
    iteration has nothing to yield and returning quietly would report a
    completed turn that nobody ever streamed.
    """
    caplog.set_level(logging.WARNING, logger="ag_ui_crewai._conversation")

    class _Session:
        def __iter__(self):
            yield "f0"

        def close(self):
            pass

    adapter = SyncStreamSessionAdapter(_Session())
    assert [frame async for frame in adapter] == ["f0"]

    with pytest.raises(ConversationWorkerAborted):
        _ = [frame async for frame in adapter]
    assert "refused to re-iterate" in caplog.text


@pytest.mark.asyncio
async def test_a_successful_turn_logs_no_cancellation_warning(caplog):
    """The cancellation WARNING must mean something when operators see it."""
    caplog.set_level(logging.WARNING, logger="ag_ui_crewai._conversation")

    class _Session:
        def __iter__(self):
            yield "f0"

        def close(self):
            pass

    lease = _HeldLease()
    adapter = SyncStreamSessionAdapter(_Session(), lease=lease)

    try:
        assert [frame async for frame in adapter] == ["f0"]
        # The worker is still alive here, pinned in its blocked release.
        assert adapter.worker_alive
        assert "requested cooperative cancellation" not in caplog.text
    finally:
        # In a ``finally``: a failing assertion above would otherwise leave the
        # worker pinned in its release for the rest of the session.
        lease.open_gate()


@pytest.mark.asyncio
async def test_a_failed_turn_reports_itself_finished_before_it_publishes():
    """An ordinary failure is not a worker stuck mid-turn, and must not read as one.

    The error frame is what wakes the consumer, and the consumer tears the adapter
    down from there. So the "the producer is done" flag has to be set BEFORE the
    error is published: read as still-unfinished, an ordinary failure logs the
    cooperative-cancellation warning about a worker that is already on its way out.
    Pinned on the ordering rather than on the absence of the log, because the gap
    between publishing and setting is a scheduling race that a test cannot lose
    reliably.
    """

    class _FailingSession:
        def __iter__(self):
            yield "f0"
            raise RuntimeError("provider exploded")

        def close(self):
            pass

    adapter = SyncStreamSessionAdapter(_FailingSession())
    aiter = adapter.__aiter__()
    assert await aiter.__anext__() == "f0"
    with pytest.raises(RuntimeError, match="provider exploded"):
        await aiter.__anext__()

    assert adapter._producer_finished.is_set()
    await aiter.aclose()


@pytest.mark.asyncio
async def test_a_failed_turn_publishes_no_completion_behind_its_error():
    """A failure's terminal item is the error, not a ``done`` behind it.

    ``_iterate`` raises on the error and never reads further, so this is only
    visible to something consuming the queue directly -- where a trailing
    completion reads as a turn that finished.
    """

    class _FailingSession:
        def __iter__(self):
            yield "f0"
            raise RuntimeError("provider exploded")

        def close(self):
            pass

    adapter = SyncStreamSessionAdapter(_FailingSession())
    aiter = adapter.__aiter__()
    assert await aiter.__anext__() == "f0"
    queue = adapter._queue
    with pytest.raises(RuntimeError, match="provider exploded"):
        await aiter.__anext__()

    await _settle(lambda: not adapter.worker_alive, "the worker never exited")
    assert queue.empty(), "a completion was published behind the failure"
    await aiter.aclose()


@pytest.mark.asyncio
async def test_an_abandoned_turn_still_logs_the_cancellation_warning(caplog):
    """The same warning must still fire when a worker really is stuck."""
    caplog.set_level(logging.WARNING, logger="ag_ui_crewai._conversation")

    session = _session(block_at=0)
    adapter = SyncStreamSessionAdapter(session)
    aiter = adapter.__aiter__()
    pending = asyncio.create_task(aiter.__anext__())
    await _wait(session.parked)

    await adapter.aclose()

    assert "requested cooperative cancellation" in caplog.text
    session.release()
    await _finalize(aiter, pending)


@pytest.mark.asyncio
async def test_aclose_declares_abandonment_only_for_a_signal_it_owns():
    """A close is the abandonment when nobody above the adapter decides it.

    With no signal supplied there is no request driver, so ``aclose()`` is the
    only place the sink-and-persistence gate could ever be closed from.
    """
    session = _session(block_at=0)
    adapter = SyncStreamSessionAdapter(session)
    aiter = adapter.__aiter__()
    pending = asyncio.create_task(aiter.__anext__())
    await _wait(session.parked)
    assert not adapter._abandonment.abandoned

    await adapter.aclose()

    assert adapter._abandonment.abandoned
    assert adapter._abandonment.abandoned_at is not None
    session.release()
    await _finalize(aiter, pending)


@pytest.mark.asyncio
async def test_aclose_does_not_overrule_a_caller_owned_signal():
    """A caller's terminal decision must survive the adapter's own teardown.

    ``aclose()`` is reached after a completed RUN_FINISHED too, with the worker
    still appending the assistant message and running its terminal handlers. A
    unilateral abandonment there drops that tail's persistence writes and gets
    the next message on the conversation refused as busy, so the driver that
    knows whether the run finished is the only one allowed to decide.
    """
    session = _session(block_at=0)
    signal = AbandonmentSignal()
    adapter = SyncStreamSessionAdapter(session, abandonment=signal)
    aiter = adapter.__aiter__()
    pending = asyncio.create_task(aiter.__anext__())
    await _wait(session.parked)

    await adapter.aclose()

    assert not signal.abandoned
    # This adapter still stops publishing: that part is its own to decide.
    assert adapter._abandoned
    session.release()
    await _finalize(aiter, pending)


@pytest.mark.asyncio
async def test_no_cancellation_warning_for_a_run_its_driver_called_terminal(caplog):
    """The tail of a finished turn must not be reported as a cancellation."""
    caplog.set_level(logging.WARNING, logger="ag_ui_crewai._conversation")

    session = _session(block_at=0)
    adapter = SyncStreamSessionAdapter(session, abandonment=AbandonmentSignal())
    aiter = adapter.__aiter__()
    pending = asyncio.create_task(aiter.__anext__())
    await _wait(session.parked)

    await adapter.aclose()

    assert "requested cooperative cancellation" not in caplog.text
    session.release()
    await _finalize(aiter, pending)


@pytest.mark.asyncio
async def test_a_completed_turns_discarded_tail_is_not_reported_as_abandoned(caplog):
    """A terminal turn discards its tail because the REQUEST is gone.

    ``aclose()`` sets the adapter's own stop flag on every terminal turn, so a
    message keyed off that flag tells operators a run was abandoned when it
    completed normally, and sends them hunting a cancellation that never was.
    """
    caplog.set_level(logging.INFO, logger="ag_ui_crewai._conversation")
    session = _session(block_at=1)
    signal = AbandonmentSignal()
    adapter = SyncStreamSessionAdapter(session, abandonment=signal)
    aiter = adapter.__aiter__()

    assert await aiter.__anext__() == "f0"
    await _wait(session.parked)
    await aiter.aclose()
    session.release()
    await _wait(session.exhausted)
    await _settle(
        lambda: "drained and discarded" in caplog.text,
        "the drain never reported its discarded frames",
    )

    assert not signal.abandoned
    assert "drained and discarded 2 frame(s)" in caplog.text
    assert "abandoned conversational turn" not in caplog.text


@pytest.mark.asyncio
async def test_consumer_unwind_drops_the_plumbing_but_the_drain_completes():
    """Undelivered frames must not stay reachable for the rest of the turn.

    The drain has to keep running to exhaustion regardless: breaking out leaves
    crewai's generator suspended and its own ``join`` blocking behind a growing
    queue.
    """
    session = _session(block_at=1)
    signal = AbandonmentSignal()
    adapter = SyncStreamSessionAdapter(session, abandonment=signal)
    aiter = adapter.__aiter__()

    assert await aiter.__anext__() == "f0"
    await _wait(session.parked)
    await aiter.aclose()

    assert adapter._loop is None
    assert adapter._queue is None

    session.release()
    await _wait(session.exhausted)
    assert session.pulled == ["f0", "f1", "f2"]


# --------------------------------------------------------------------------
# Happy path: abandoning on exhaustion must not eat a real write.
# --------------------------------------------------------------------------


class _WritingSession:
    """Session that persists on its way out, like a pause checkpoint does."""

    def __init__(self, flow):
        self._flow = flow
        self.closed = False

    def __iter__(self):
        yield from ()
        self._flow.persistence.save_pending_feedback(
            "thread-exhaust", None, {"document": "final"}
        )

    def close(self):
        self.closed = True


class _FakeConversationalFlow:
    conversational = True

    def __init__(self, persistence):
        self._state = {}
        self.persistence = persistence
        self.turns = []

    @property
    def state(self):
        return self._state

    def stream_turn(self, message, *, session_id=None):
        self.turns.append((message, session_id))
        return _WritingSession(self)


@pytest.mark.asyncio
async def test_a_turn_that_runs_to_exhaustion_keeps_its_final_write():
    """Exhaustion reaches ``aclose()``, which now abandons. Nothing may be lost.

    By the time the completion is delivered crewai's turn is over, so every
    write it was going to make has already happened -- asserted here rather
    than assumed.
    """
    spy = _GateSpyPersistence()
    flow = _FakeConversationalFlow(spy)
    input_data = RunAgentInput(
        thread_id="thread-exhaust",
        run_id="run-exhaust",
        state={},
        messages=[UserMessage(id="u1", role="user", content="hello")],
        tools=[],
        context=[],
        forwarded_props={},
    )

    body = "".join(
        [
            chunk
            async for chunk in endpoint._run_flow_frame_stream(
                flow_copy=flow,
                encoder=EventEncoder(),
                input_data=input_data,
                inputs={"id": input_data.thread_id, "messages": []},
                timeout=None,
                conversational_turn=prepare_conversational_turn(input_data.messages),
            )
        ]
    )

    assert spy.writes == [("save_pending_feedback", "thread-exhaust")]
    assert "RUN_ERROR" not in body


def _conversational_stream(flow, thread_id, run_id):
    """The real kickoff driver, in conversational mode, for one turn."""
    input_data = RunAgentInput(
        thread_id=thread_id,
        run_id=run_id,
        state={},
        messages=[UserMessage(id="u1", role="user", content="hello")],
        tools=[],
        context=[],
        forwarded_props={},
    )
    return endpoint._run_flow_frame_stream(
        flow_copy=flow,
        encoder=EventEncoder(),
        input_data=input_data,
        inputs={"id": thread_id, "messages": []},
        timeout=None,
        conversational_turn=prepare_conversational_turn(input_data.messages),
    )


class _ParkedWritingSession:
    """Parks mid-turn, then writes state from the WORKER thread once released."""

    def __init__(self, flow, label):
        self._flow = flow
        self._label = label
        self._park = WORKER_GUARD.park(f"writing session {label}")
        self.wrote = threading.Event()

    def __iter__(self):
        if not self._park.wait(WORKER_WAIT):
            return
        yield SimpleNamespace(id=f"frame-{self._label}")
        self._flow.persistence.save_state(
            "thread-worker", self._label, {"document": self._label}
        )
        self.wrote.set()

    @property
    def parked(self):
        return self._park.parked

    def release(self):
        self._park.release()

    def close(self):
        pass


@pytest.mark.asyncio
async def test_each_workers_own_run_gates_it_through_the_real_driver():
    """The end-to-end shape of the two-run defect, with real worker threads.

    One flow instance, therefore one shared write gate, and two runs alive at the
    same time: the first is abandoned with its worker still inside the turn, the
    second is live. Each worker writes from its own thread, whose context the
    adapter copied when it started. The abandoned one must be refused and the live
    one must land, which no single binding on the wrapper can deliver.
    """
    spy = _GateSpyPersistence()
    sessions = {}

    class _TwoRunFlow:
        conversational = True

        def __init__(self):
            self._state = {}
            self.persistence = spy

        @property
        def state(self):
            return self._state

        def stream_turn(self, message, *, session_id=None):
            label = "abandoned" if session_id == "thread-a" else "live"
            sessions[label] = _ParkedWritingSession(self, label)
            return sessions[label]

    flow = _TwoRunFlow()

    async def _parked(label):
        """The session for ``label``, once its worker is inside the turn."""
        await _settle(lambda: label in sessions, f"the {label} turn never opened")
        await _wait(sessions[label].parked)
        return sessions[label]

    abandoned_run = _conversational_stream(flow, "thread-a", "run-abandoned")
    first = asyncio.create_task(abandoned_run.__anext__())
    await _parked("abandoned")
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first

    # A second conversation on the same flow object, served while the first
    # worker is still parked. A different thread id, because the same one would be
    # refused as busy -- which is the other half of this change.
    live_run = _conversational_stream(flow, "thread-b", "run-live")

    # Driven to exhaustion inside ONE task, rather than one ``__anext__`` per
    # step. The driver sets its contextvar tokens in whichever context first
    # advances it, so advancing it here and closing it there would reset those
    # tokens from a context that never set them.
    live_body: list = []

    async def _drain_live():
        async for chunk in live_run:
            live_body.append(chunk)

    live = asyncio.create_task(_drain_live())
    await _parked("live")

    sessions["live"].release()
    await _wait(sessions["live"].wrote)
    assert spy.writes == [("save_state", "live")], "the live run's write was gated"

    sessions["abandoned"].release()
    await _wait(sessions["abandoned"].wrote)
    assert spy.writes == [("save_state", "live")], (
        "the abandoned run's write went through the shared gate ungated"
    )

    # The live turn's session is exhausted by now, so the stream ends. It still
    # owes the client a terminal event, even though no frame it carried was
    # translatable.
    await live
    assert any("RUN_STARTED" in chunk for chunk in live_body)
    await abandoned_run.aclose()
    await _settle(
        lambda: conversation_worker_stats().active == 0,
        "a worker never released its slot",
    )


# --------------------------------------------------------------------------
# The abandonment stamp, and the per-conversation busy query.
# --------------------------------------------------------------------------


def test_abandon_keeps_a_single_timestamp_under_concurrent_callers():
    """The "first timestamp wins" claim has to hold when the callers collide.

    The readers include worker threads that report how long a run has been
    abandoned, so a second caller moving the stamp backwards or forwards
    silently corrupts that number.

    Cardinality is asserted alongside agreement. ``len(set(observed)) == 1`` holds
    for a SINGLE observation too, so a barrier that broke and left one racer alive
    reports perfect agreement about a value nothing raced for. The barrier failure
    itself is recorded rather than raised, because it happens on a racer thread
    where nothing would carry it back here.
    """
    racers = 8
    for _ in range(200):
        signal = AbandonmentSignal()
        barrier = threading.Barrier(racers)
        observed = []

        def race():
            try:
                barrier.wait(timeout=_WAIT)
            except threading.BrokenBarrierError:
                WORKER_GUARD.record("the abandon race barrier broke")
                return
            signal.abandon()
            observed.append(signal.abandoned_at)

        threads = [threading.Thread(target=race) for _ in range(racers)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=_WAIT)

        assert not [thread for thread in threads if thread.is_alive()]
        assert len(observed) == racers, "not every racer reached the abandon"
        assert len(set(observed)) == 1, "concurrent abandon moved the timestamp"
        assert observed[0] is not None


def test_the_per_conversation_busy_query_answers_off_the_live_lease_list():
    """The gates need "is THIS conversation still busy", not process-wide stats.

    Answering it from outside the registry means reaching past its lock, so the
    query lives here and shares the kickoff gate's own conflict predicate. One
    conversation is one FLOW's thread: the same client-chosen id on another flow is
    another conversation, and refusing across the two refuses unrelated work.
    """
    signal = AbandonmentSignal()
    lease = acquire_conversation_worker(
        flow_key="tests.QueryFlow",
        thread_id="thread-query",
        run_id="run-query",
        signal=signal,
    )

    assert abandoned_conversational_run_for_thread("thread-query") is None

    signal.abandon()
    assert abandoned_conversational_run_for_thread("thread-query") == "run-query"
    assert (
        abandoned_conversational_run_for_thread(
            "thread-query", flow_key="tests.QueryFlow"
        )
        == "run-query"
    )
    # Scoped to the conversation, not the process: another thread, and the same
    # thread on another flow, are both free.
    assert abandoned_conversational_run_for_thread("thread-other") is None
    assert (
        abandoned_conversational_run_for_thread(
            "thread-query", flow_key="tests.OtherFlow"
        )
        is None
    )

    # The same conflict the kickoff gate refuses, reported the same way.
    with pytest.raises(ConversationThreadBusy) as refused:
        acquire_conversation_worker(
            flow_key="tests.QueryFlow",
            thread_id="thread-query",
            run_id="run-next",
            signal=AbandonmentSignal(),
        )
    assert refused.value.args[0] == conversational_thread_busy_detail(
        thread_id="thread-query", run_id="run-query"
    )

    # ...and another flow's turn on that same thread is admitted.
    other = acquire_conversation_worker(
        flow_key="tests.OtherFlow",
        thread_id="thread-query",
        run_id="run-other",
        signal=AbandonmentSignal(),
    )
    other.release()

    lease.release()
    assert abandoned_conversational_run_for_thread("thread-query") is None


def test_the_new_conversational_error_types_are_exported():
    """The RUN_ERROR codes are catchable only if the types are reachable."""
    for name in ("ConversationCapacityExceeded", "ConversationThreadBusy"):
        assert name in ag_ui_crewai.__all__
        assert issubclass(getattr(ag_ui_crewai, name), RuntimeError)


# --------------------------------------------------------------------------
# A wrapper carried over from a previous run, and what crewai does with it.
# --------------------------------------------------------------------------


def test_a_carried_over_wrapper_is_repointed_at_the_live_run():
    """Two SEQUENTIAL runs sharing ONE wrapper: run two's writes must land.

    A per-request ``flow_copy`` does not guarantee a per-request persistence
    object: the crewai 1.15.x deep-copy fallback pins values it cannot copy by
    reference (this wrapper holds an event and a lock, so it is one), so a flow
    whose ``persistence`` already carries one hands the SAME wrapper to the next
    turn, as does any caller driving one flow instance across turns. Returned
    unchanged it still carries the PREVIOUS run's signal and inputs, so once that
    run was abandoned every write of the live run is dropped and ``load_state``
    overlays stale inputs. Single-run coverage cannot see this at all.
    """
    spy = _GateSpyPersistence()

    first = _PlainFlow()
    first_signal = AbandonmentSignal()
    overlay_conversational_persistence(
        first, {"id": "thread-1", "document": "turn one"}, abandonment=first_signal
    )
    first.persistence = spy
    carried = first.persistence
    first_signal.abandon()

    # The pin-and-share path: the next request's copy holds the SAME object.
    second = _PlainFlow()
    object.__setattr__(second, "persistence", carried)
    second_signal = AbandonmentSignal()
    overlay_conversational_persistence(
        second, {"id": "thread-1", "document": "turn two"}, abandonment=second_signal
    )

    assert second.persistence is carried
    second.persistence.save_state("thread-1", "draft", {"document": "turn two"})

    assert spy.writes == [("save_state", "draft")]
    assert second.persistence.load_state("thread-1")["document"] == "turn two"
    # Identity of the run the wrapper is gating, so this cannot regress silently.
    assert second.persistence.agui_run is second_signal

    # And the live run can still be abandoned in its own right.
    second_signal.abandon()
    second.persistence.save_state("thread-1", "late", {"document": "late"})
    assert spy.writes == [("save_state", "draft")]


def test_a_shared_wrapper_gates_each_run_by_its_own_context():
    """One wrapper, TWO runs: each caller gated by ITS OWN run, in BOTH directions.

    The mirror of the test above, and why the decision cannot live on the wrapper.
    An abandoned run's worker thread is still executing while it shares the
    wrapper with the live run that replaced it. One binding on the wrapper is
    wrong whichever way it points: at the live run it lets the abandoned worker
    write ungated and overlays the live run's inputs onto its restores; at the
    abandoned run it drops the live run's writes. Both directions are asserted
    here, because a check on one of them is what let this through twice.

    The abandoned run is driven through a COPY of the context its overlay ran in,
    which is exactly what its worker thread holds
    (``SyncStreamSessionAdapter._start`` copies the context before spawning, and
    crewai's own frame thread copies it again from there).
    """
    spy = _GateSpyPersistence()

    first = _PlainFlow()
    first_signal = AbandonmentSignal()
    overlay_conversational_persistence(
        first, {"id": "thread-1", "document": "turn one"}, abandonment=first_signal
    )
    first.persistence = spy
    carried = first.persistence
    first_worker_context = contextvars.copy_context()
    first_signal.abandon()

    second = _PlainFlow()
    object.__setattr__(second, "persistence", carried)
    second_signal = AbandonmentSignal()
    overlay_conversational_persistence(
        second, {"id": "thread-1", "document": "turn two"}, abandonment=second_signal
    )
    assert second.persistence is carried

    # (a) the live run writes through the shared wrapper ...
    second.persistence.save_state("thread-1", "live", {"document": "turn two"})
    assert spy.writes == [("save_state", "live")]
    assert second.persistence.load_state("thread-1")["document"] == "turn two"

    # (b) ... and the abandoned run, from its own worker context, does not.
    first_worker_context.run(
        carried.save_state, "thread-1", "late", {"document": "turn one, late"}
    )
    first_worker_context.run(carried.save_pending_feedback, "thread-1", None, {})
    first_worker_context.run(carried.clear_pending_feedback, "thread-1")
    assert spy.writes == [("save_state", "live")]
    # And its restores still overlay ITS OWN inputs, not the newer run's.
    assert (
        first_worker_context.run(carried.load_state, "thread-1")["document"]
        == "turn one"
    )


def test_a_caller_with_no_run_in_scope_gets_the_newest_run():
    """The fallback must point FORWARD, never at a run that already ended.

    Not every caller carries a run: crewai can touch the backend from a context
    copied before the overlay, and a flow serialization touches it from nowhere in
    particular. Those get the wrapper's bound fallback, and the whole original
    defect was a wrapper answering a live caller with a previous run's abandoned
    signal. So the fallback follows the newest run, which can only ever be too
    permissive for a stranger rather than silently discarding real state.
    """
    spy = _GateSpyPersistence()
    flow = _PlainFlow()
    flow.persistence = spy
    first_signal = AbandonmentSignal()
    _overlay(flow, first_signal)
    first_signal.abandon()

    second_signal = AbandonmentSignal()
    overlay_conversational_persistence(
        flow, {"id": "thread-1", "document": "turn two"}, abandonment=second_signal
    )
    wrapper = flow.persistence

    # An EMPTY context: no run of any kind is in scope here.
    stranger = contextvars.Context()
    stranger.run(wrapper.save_state, "thread-1", "stranger", {"document": "x"})

    assert spy.writes == [("save_state", "stranger")]
    assert stranger.run(lambda: wrapper.agui_run) is second_signal


def test_the_write_gate_is_a_crewai_backend_the_flow_can_still_serialize():
    """``Flow.persistence`` is serialized through a type-checked serializer.

    crewai annotates the field with a serializer that RAISES on anything that is
    not a ``FlowPersistence``, so a duck-typed wrapper turns every
    ``model_dump_json()`` of the flow into a ``TypeError``. Nothing in the gate
    is worth that: the wrapper can simply be a real backend.
    """
    flow = _PlainFlow()
    _overlay(flow, AbandonmentSignal())
    flow.persistence = _GateSpyPersistence()

    assert isinstance(flow.persistence, FlowPersistence)
    # Reports the wrapped backend rather than the wrapper's own empty shape, in
    # BOTH modes. Only json mode goes through crewai's PlainSerializer and so
    # through the wrapper's ``model_dump``; python mode serializes the instance,
    # whose declared fields are one, and dropped the backend's configuration.
    for mode in ("json", "python"):
        assert flow.persistence.model_dump(mode=mode) == (
            flow.persistence.agui_backend.model_dump(mode=mode)
        )
        # Through the FLOW, which is how crewai reaches it.
        assert flow.model_dump(mode=mode)["persistence"] == (
            flow.persistence.agui_backend.model_dump(mode=mode)
        )
    assert '"persistence"' in flow.model_dump_json()


# --------------------------------------------------------------------------
# The lazy guard's own failure modes.
# --------------------------------------------------------------------------


class _AncestorDefinitionFlow(Flow[dict]):
    """Parent whose class-level definition cache is populated by the test."""

    @start()
    def ancestor_step(self):
        return "ok"


class _DerivedDefinitionFlow(_AncestorDefinitionFlow):
    """Child with its OWN method graph, which the guard must not replace."""

    @start()
    def step(self):
        return "ok"


class _OwnDefinitionFlow(Flow[dict]):
    @start()
    def step(self):
        return "ok"


def _forget_class_definition(flow_type):
    """Drop crewai's class-level definition cache for ``flow_type``.

    Recreates the state the guard has to cope with: an instance whose definition
    did not come from (and was not cached on) its own class. crewai populates the
    cache during construction today, so this is the honest way to exercise the
    path without depending on it staying that way.
    """
    type.__delattr__(flow_type, "_flow_definition")


def test_the_guarded_subclass_is_built_once_and_keeps_the_flow_s_name():
    """One pydantic model class per FLOW CLASS, not per conversational turn.

    And the name is not cosmetic: crewai reports ``self.__class__.__name__`` as
    the ``flow_name`` of its conversation-turn events whenever a flow carries no
    explicit name, so a synthesized name lands in telemetry.
    """
    first = _PlainFlow()
    second = _PlainFlow()
    _overlay(first, AbandonmentSignal())
    _overlay(second, AbandonmentSignal())

    assert type(first) is not _PlainFlow
    assert type(first) is type(second)
    assert type(first).__name__ == _PlainFlow.__name__
    assert type(first).__qualname__ == _PlainFlow.__qualname__
    assert type(first).__module__ == _PlainFlow.__module__


def test_the_lazy_guard_declines_rather_than_stamp_an_ancestors_definition(caplog):
    """crewai reads ``cls.__dict__``; a ``getattr`` walks the MRO instead.

    Reading it the loose way stamps the ANCESTOR's definition (a different name,
    a different method graph) onto the synthesized subclass, which is then what
    crewai reads mid-turn.
    """
    caplog.set_level(logging.WARNING, logger="ag_ui_crewai._conversation")
    _AncestorDefinitionFlow.flow_definition()
    flow = _DerivedDefinitionFlow()
    assert "step" in flow._definition.methods
    _forget_class_definition(_DerivedDefinitionFlow)

    _overlay(flow, AbandonmentSignal())

    assert type(flow) is _DerivedDefinitionFlow
    assert "step" in flow._definition.methods
    assert "could not carry" in caplog.text


def test_the_lazy_guard_declines_rather_than_ship_an_empty_method_graph(caplog):
    """A synthesized subclass rebuilds its graph from its OWN namespace.

    Which is empty, so every ``@start`` / ``@listen`` silently stops firing. An
    ungated pause checkpoint is a bad outcome; a flow whose steps never run is a
    far worse one, so the guard declines and says so.
    """
    caplog.set_level(logging.WARNING, logger="ag_ui_crewai._conversation")
    flow = _OwnDefinitionFlow()
    _forget_class_definition(_OwnDefinitionFlow)

    _overlay(flow, AbandonmentSignal())

    assert list(type(flow).flow_definition().methods) == ["step"]
    assert "could not carry" in caplog.text


def test_a_persist_decorated_flow_is_told_its_writes_are_not_gated(caplog):
    """The one configuration the gate cannot reach must not look guarded.

    ``@persist`` writes resolve a backend out of a private per-definition cache
    instead of reading ``flow.persistence``, and seeding that cache leaves the
    already-resolved entry able to win. So the write lands, and the deployment
    hears about it once per turn rather than being told a gate it does not have.
    """
    caplog.set_level(logging.WARNING, logger="ag_ui_crewai._conversation")
    flow = _FlowLevelPersistFlow()
    signal = AbandonmentSignal()

    _overlay(flow, signal)

    assert "@persist" in caplog.text
    assert "NOT gated" in caplog.text
    assert "thread-1" in caplog.text

    signal.abandon()
    flow._persist_method_completion("step")
    assert _FLOW_LEVEL_SPY.writes == [("save_state", "step")]


def test_an_instance_supplied_backend_gates_persist_and_says_nothing(caplog):
    """With persistence handed to the constructor, ``@persist`` IS gated.

    crewai picks ``self.persistence`` for a ``@persist`` write whenever
    persistence was instance-supplied (``flow/runtime/__init__.py:2942-2946``), and
    that attribute is the wrapped one. The warning has to be silent here: telling
    an operator a working guarantee is void is the same defect as promising one
    that is not there.
    """
    caplog.set_level(logging.WARNING, logger="ag_ui_crewai._conversation")
    spy = _GateSpyPersistence()

    @persist(persistence=_FLOW_LEVEL_SPY)
    class _InstanceBackedPersistFlow(Flow[dict]):
        @start()
        def step(self):
            return "ok"

    flow = _InstanceBackedPersistFlow(persistence=spy)
    assert flow._instance_persistence, "crewai stopped recording the constructor arg"
    signal = AbandonmentSignal()
    _overlay(flow, signal)

    assert "@persist" not in caplog.text

    flow._persist_method_completion("step")
    assert spy.writes == [("save_state", "step")]

    signal.abandon()
    flow._persist_method_completion("step")

    assert spy.writes == [("save_state", "step")]
    assert _FLOW_LEVEL_SPY.writes == []


def test_a_flow_without_persist_gets_no_warning(caplog):
    """The limitation warning must stay meaningful for the flows that have it."""
    caplog.set_level(logging.WARNING, logger="ag_ui_crewai._conversation")

    _overlay(_PlainFlow(), AbandonmentSignal())

    assert "@persist" not in caplog.text


# --------------------------------------------------------------------------
# The drain against a request that has already released its plumbing.
#
# The signal that parks inside ``publish`` lives in ``conftest``, shared with the
# lifecycle-gate suite: it is the only deterministic way either of them can hold a
# worker between ``publish``'s test of the shared fields and its dereference of
# them.
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_the_drain_survives_the_request_releasing_its_plumbing():
    """Releasing the loop and the queue mid-publish must not break the drain.

    Reading them, testing them, and THEN dereferencing them lets the request
    teardown null both in between, and the ``AttributeError`` escapes
    ``publish``, aborts the drain, and reaches the worker's ``close()`` while
    CrewAI's generator is still suspended at its ``yield`` -- so its own
    ``thread.join()`` blocks for the rest of the turn while our pool slot is
    still held. That is the exact deadlock the drain exists to prevent, and an
    ordinary terminal turn reaches it.
    """
    session = _session(frames=("f0", "f1", "f2"), block_at=None)
    signal = PublishParkingSignal()
    adapter = SyncStreamSessionAdapter(session, abandonment=signal)
    aiter = adapter.__aiter__()
    pending = asyncio.create_task(aiter.__anext__())

    await _wait(signal.reading)
    adapter._release_consumer_plumbing()
    signal.resume.set()

    await _wait(session.exhausted)
    assert session.pulled == ["f0", "f1", "f2"]

    pending.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await pending
    await aiter.aclose()
