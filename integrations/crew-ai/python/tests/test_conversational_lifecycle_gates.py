"""Every request-lifecycle state crossed with every gated behavior.

The conversational driver has four request-lifecycle states and three behaviors
that are gated on them, encoded as flags spread across two modules: an
``AbandonmentSignal`` shared with the worker, a ``request_torn_down`` event owned
by the request, and the adapter's own stop flag. Nothing enumerated the product,
so each new gate picked whichever flag was nearest and picking wrong was
invisible on the wire. That is where the terminal-predicate regression, the
sink-refill leak, and a misleading "abandoned" log all came from.

So the product is enumerated here, once, as a table. The states are DERIVED by
driving the real ``_run_flow_frame_stream`` rather than by setting flags, and the
behaviors are exercised through the real gate functions the driver installed:
the adapter's own ``publish`` closure, the driver's scoped raw-event sink, and the
persistence wrapper on the flow.

The publish column is not equally discriminating in every state: after teardown
the run's plumbing is released, so a publish is refused before it reaches the
abandonment check. ``abandoned_mid_run`` is the state that pins the abandonment
check itself, because there the plumbing is still live and the flag is the only
thing refusing.
"""

import asyncio
import contextlib
import inspect
import threading
from types import SimpleNamespace

import pytest

from ag_ui.core import RunAgentInput, UserMessage

from ag_ui_crewai import endpoint
from ag_ui_crewai._conversation import (
    SyncStreamSessionAdapter,
)

from .conftest import (
    ParkedSession,
    PublishParkingSignal,
    SpyBackend,
    TailedSession,
    WORKER_WAIT,
    completing_conversational_flow_type,
    frame_stream,
    requires_conversational_turn_api,
    requires_stream_frames,
)


# --------------------------------------------------------------------------
# The truth table.
# --------------------------------------------------------------------------

# state -> {behavior: may it happen}. Every cell is asserted; a state whose row
# is wrong fails with the whole row, naming the cell that moved.
LIFECYCLE_MATRIX = {
    # The request is live and the run is neither terminal nor abandoned.
    "running": {
        "publish_to_wire": True,
        "park_into_request_buffers": True,
        "write_persistence": True,
    },
    # Abandoned while the request generator is still up: the plumbing is live, so
    # each gate's abandonment check is the only thing refusing.
    "abandoned_mid_run": {
        "publish_to_wire": False,
        "park_into_request_buffers": False,
        "write_persistence": False,
    },
    # RUN_FINISHED went out and the generator unwound, while the worker is still
    # running its tail. Persistence stays OPEN: the turn still owes those writes,
    # and refusing them is what the terminal-predicate regression did.
    "terminal_tail": {
        "publish_to_wire": False,
        "park_into_request_buffers": False,
        "write_persistence": True,
    },
    # The client went away: teardown ran and the run was declared abandoned.
    "abandoned_after_teardown": {
        "publish_to_wire": False,
        "park_into_request_buffers": False,
        "write_persistence": False,
    },
}


class _Probe:
    """One derived lifecycle state plus the real gates to exercise it through."""

    def __init__(self, *, flow, sink, adapter, publish, queue, backend):
        self.flow = flow
        self.sink = sink
        self.adapter = adapter
        self.publish = publish
        # Every put the worker's publish made onto the run's queue. Counted at
        # the queue rather than read off its depth: the live request has a getter
        # waiting on it, so a delivered frame is consumed as fast as it lands.
        self.puts = queue
        self.backend = backend
        self._emits = 0

    @property
    def buffers(self):
        return inspect.getclosurevars(self.sink).nonlocals

    @property
    def torn_down(self):
        return self.buffers["request_torn_down"]

    @property
    def abandonment(self):
        """The run's own signal, read off the adapter the driver handed it to.

        Read here rather than out of the sink's closure so that removing the
        sink's abandonment check fails the CELL it breaks rather than this
        accessor.
        """
        return self.adapter._abandonment

    def next_event_id(self):
        self._emits += 1
        return f"probe-{self._emits}"


async def _publish_to_wire(probe):
    """Publish one frame the way the worker does; did it reach the request?"""
    before = len(probe.puts)
    probe.publish("item", SimpleNamespace(id=probe.next_event_id()))
    # The hand-off is a ``call_soon_threadsafe`` onto this loop, so the put runs
    # on a later iteration of this same loop. Yielding is loop bookkeeping, not a
    # wait on another thread.
    for _ in range(3):
        await asyncio.sleep(0)
    return len(probe.puts) > before


async def _park_into_request_buffers(probe):
    """Emit through the driver's own sink; did it park in a request buffer?"""

    def parked():
        buffers = probe.buffers
        return len(buffers["raw_events"]) + len(buffers["foreign_events"])

    before = parked()
    probe.sink(
        probe.flow,
        SimpleNamespace(event_id=probe.next_event_id(), type="text_stream_chunk"),
    )
    return parked() > before


async def _write_persistence(probe):
    """Save state through the wrapper the overlay installed; did it land?"""
    before = len(probe.backend.writes)
    probe.flow.persistence.save_state(
        "thread-matrix", probe.next_event_id(), {"document": "probe"}
    )
    return len(probe.backend.writes) > before


BEHAVIORS = {
    "publish_to_wire": _publish_to_wire,
    "park_into_request_buffers": _park_into_request_buffers,
    "write_persistence": _write_persistence,
}


# --------------------------------------------------------------------------
# Deriving each state from the real driver.
# --------------------------------------------------------------------------


def _session():
    """A session that parks before its first frame and then produces nothing.

    The shared stand-in, labelled for this file's guard failures. Producing nothing
    is what keeps the publish column readable: every put counted below is one this
    file made through the worker's own seam, not one the turn produced.
    """
    return ParkedSession((), block_at=0, what="lifecycle matrix session")


class _FakeConversationalFlow:
    """Minimal conversational flow over one staged session."""

    conversational = True

    def __init__(self, session, backend):
        self._state = {}
        self.persistence = backend
        self._session = session

    @property
    def state(self):
        return self._state

    def stream_turn(self, message, *, session_id=None):
        return self._session


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


class _Instrumentation:
    """Captures the driver's sink, its adapter, and the adapter's publish seam."""

    def __init__(self, monkeypatch):
        self.sink = None
        self.adapter = None
        self.publish = None
        self.puts = []
        real_add_sink = endpoint.add_stream_sink
        outer = self

        def _capturing_add_sink(sink):
            outer.sink = sink
            return real_add_sink(sink) if callable(real_add_sink) else None

        class _CapturingAdapter(SyncStreamSessionAdapter):
            def _start(self):
                super()._start()
                outer.adapter = self
                thread = self._thread
                if thread is not None:
                    # ``produce`` is the thread's argument and ``publish`` is in
                    # its closure. A KeyError here means the worker's publish seam
                    # moved, which must fail loudly rather than quietly skip the
                    # publish column.
                    produce = thread._args[0]
                    outer.publish = inspect.getclosurevars(produce).nonlocals[
                        "publish"
                    ]
                plumbing = self._consumer_plumbing()
                if plumbing is not None:
                    queue = plumbing[1]
                    delivered = queue.put_nowait

                    def _recording_put(item):
                        outer.puts.append(item)
                        delivered(item)

                    # Recorded at the queue, so a frame the live request consumes
                    # immediately still counts as delivered.
                    queue.put_nowait = _recording_put

        monkeypatch.setattr(endpoint, "add_stream_sink", _capturing_add_sink)
        monkeypatch.setattr(endpoint, "SyncStreamSessionAdapter", _CapturingAdapter)

    def probe(self, *, flow, backend):
        assert self.sink is not None, "the driver never registered its sink"
        assert self.publish is not None, "the worker's publish seam was not captured"
        return _Probe(
            flow=flow,
            sink=self.sink,
            adapter=self.adapter,
            publish=self.publish,
            queue=self.puts,
            backend=backend,
        )


async def _wait(event):
    assert await asyncio.to_thread(
        event.wait, WORKER_WAIT
    ), "timed out waiting on the worker"


class _Request:
    """The driver generator plus the read in flight, so teardown is orderly."""

    def __init__(self, agen, pending=None):
        self.agen = agen
        self.pending = pending

    async def unwind(self):
        if self.pending is not None and not self.pending.done():
            self.pending.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.pending
        await self.agen.aclose()


async def _running_probe(instrumentation, releases):
    """A live request whose worker is parked inside the turn."""
    backend = SpyBackend()
    session = _session()
    releases.append(session.release)
    flow = _FakeConversationalFlow(session, backend)
    agen = frame_stream(flow, _input("thread-running", "run-running"))
    pending = asyncio.create_task(agen.__anext__())
    await _wait(session.parked)
    probe = instrumentation.probe(flow=flow, backend=backend)
    assert not probe.torn_down.is_set()
    assert not probe.abandonment.abandoned
    return probe, _Request(agen, pending)


async def _abandoned_mid_run_probe(instrumentation, releases):
    """The same live request, with the run's own signal declared abandoned.

    Not a simulated flag: it is the signal the driver created for this run, set
    the way the driver sets it, while the request buffers and the loop hand-off
    are still in place.
    """
    probe, request = await _running_probe(instrumentation, releases)
    probe.abandonment.abandon()
    assert not probe.torn_down.is_set()
    return probe, request


async def _abandoned_after_teardown_probe(instrumentation, releases):
    """A client disconnect: the generator unwound with the run non-terminal."""
    probe, request = await _running_probe(instrumentation, releases)
    # Cancelling the read in flight is the disconnect: it unwinds the driver
    # generator through its ``finally``, which is where both flags are set.
    request.pending.cancel()
    with pytest.raises(asyncio.CancelledError):
        await request.pending
    assert probe.torn_down.is_set()
    assert probe.abandonment.abandoned
    return probe, request


async def _terminal_tail_probe(instrumentation, releases):
    """A completed turn whose worker is still inside its tail."""
    backend = SpyBackend()
    gate = threading.Event()
    tails = []

    class _TailingFlow(completing_conversational_flow_type()):
        conversational = True

        def stream_turn(self, message, *, session_id=None):
            tail = TailedSession(
                super().stream_turn(message, session_id=session_id), gate
            )
            tails.append(tail)
            releases.append(gate.set)
            return tail

    flow = _TailingFlow()
    flow.persistence = backend
    agen = frame_stream(flow, _input("thread-tail", "run-tail"))
    body = "".join([chunk async for chunk in agen])

    assert "RUN_FINISHED" in body
    assert "RUN_ERROR" not in body
    assert len(tails) == 1
    await _wait(tails[0].tail_reached)
    probe = instrumentation.probe(flow=flow, backend=backend)
    assert probe.torn_down.is_set()
    assert not probe.abandonment.abandoned, (
        "a turn that reached RUN_FINISHED is terminal, not abandoned"
    )
    return probe, _Request(agen)


_STATE_BUILDERS = {
    "running": _running_probe,
    "abandoned_mid_run": _abandoned_mid_run_probe,
    "terminal_tail": _terminal_tail_probe,
    "abandoned_after_teardown": _abandoned_after_teardown_probe,
}


# The states whose builder needs a crewai the declared floor may not have. Held
# apart from the parametrization so the LIST of states stays derived.
_STATE_MARKS = {
    "terminal_tail": [requires_stream_frames, requires_conversational_turn_api],
}


@pytest.mark.parametrize(
    "state",
    [
        pytest.param(state, marks=_STATE_MARKS.get(state, []))
        for state in _STATE_BUILDERS
    ],
)
@pytest.mark.asyncio
async def test_every_lifecycle_state_gates_every_behavior_as_documented(
    state, monkeypatch
):
    """One row of the matrix, read off the real driver in that state."""
    instrumentation = _Instrumentation(monkeypatch)
    releases = []
    request = None
    try:
        probe, request = await _STATE_BUILDERS[state](instrumentation, releases)
        observed = {
            name: await behavior(probe) for name, behavior in BEHAVIORS.items()
        }
        assert observed == LIFECYCLE_MATRIX[state]
    finally:
        for release in reversed(releases):
            release()
        if request is not None:
            await request.unwind()


def _states_actually_driven():
    """The states the matrix test is parametrized over, read off the test itself.

    An independent observation of what runs, rather than a second transcription of
    the table: while the parametrize list was hand-written, a state added to the
    matrix and to the builders agreed with both and was still never driven.
    """
    driven = test_every_lifecycle_state_gates_every_behavior_as_documented
    marks = [mark for mark in driven.pytestmark if mark.name == "parametrize"]
    assert len(marks) == 1, f"the matrix test is parametrized {len(marks)} times"
    return {param.values[0] for param in marks[0].args[1]}


def test_the_matrix_covers_every_state_and_behavior():
    """A row or column silently dropped from the table would pin nothing."""
    assert set(LIFECYCLE_MATRIX) == set(_STATE_BUILDERS)
    assert _states_actually_driven() == set(LIFECYCLE_MATRIX)
    for state, row in LIFECYCLE_MATRIX.items():
        assert set(row) == set(BEHAVIORS), state


# --------------------------------------------------------------------------
# The cross-thread accessor the states above are read through.
# --------------------------------------------------------------------------


def test_every_reader_of_the_shared_plumbing_goes_through_the_accessor():
    """The loop and the queue may only be reached through one accessor.

    They are nulled by the request loop while the worker thread is still
    publishing, so a reader that checks them and then dereferences them can have
    either one nulled underneath it. That ``AttributeError`` escapes ``publish``,
    aborts the drain, and reaches ``close()`` while CrewAI's generator is
    suspended at its ``yield``, whose own ``thread.join()`` then blocks for the
    rest of the turn with the pool slot still held. A single accessor is the fix;
    this is what keeps it single.
    """
    import ast
    import pathlib

    import ag_ui_crewai._conversation as conversation

    source = pathlib.Path(conversation.__file__).read_text()
    tree = ast.parse(source)

    # The accessor may read it; the two lifecycle points may write it. Anything
    # else touching the attribute is a reader that skipped the accessor.
    readers = {"_consumer_plumbing"}
    writers = {"__init__", "_start", "_release_consumer_plumbing"}
    offenders = []
    for function in ast.walk(tree):
        if not isinstance(function, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for node in ast.walk(function):
            if not isinstance(node, ast.Attribute) or node.attr != "_plumbing":
                continue
            allowed = (
                function.name in readers
                if isinstance(node.ctx, ast.Load)
                else function.name in writers
            )
            if not allowed:
                offenders.append(
                    f"{function.name}:{node.lineno} touches _plumbing directly"
                )

    assert offenders == [], (
        "reach the loop and the queue through _consumer_plumbing(), which returns "
        f"them as one snapshot or None: {offenders}"
    )
    # The walk has to have seen the attribute at all, or it proves nothing.
    assert "_plumbing" in source


@pytest.mark.asyncio
async def test_nulling_the_plumbing_mid_drain_still_frees_the_worker_slot():
    """The pool slot is what a drain broken by a nulled snapshot actually costs.

    The interleaving is forced rather than raced: the worker is held inside
    ``publish``, between its test of the shared fields and its dereference of
    them, while the request nulls them. Without the single-snapshot accessor that
    dereference raises, the exception escapes ``publish``, the drain aborts, and
    CrewAI's generator is left suspended at its ``yield`` so the ``close()`` behind
    it blocks in a join for the rest of the turn. The slot is released from the
    worker's own exit, so a worker that never exits never gives it back and the
    pool reports capacity that does not exist.
    """
    from ag_ui_crewai._conversation import (
        acquire_conversation_worker,
        conversation_worker_stats,
    )

    frames = ["f0", "f1", "f2", "f3"]
    pulled = []
    exhausted = threading.Event()

    class _Session:
        def __iter__(self):
            for frame in frames:
                pulled.append(frame)
                yield frame
            exhausted.set()

        def close(self):
            pass

    signal = PublishParkingSignal()
    lease = acquire_conversation_worker(
        flow_key="tests.DrainFlow",
        thread_id="thread-drain",
        run_id="run-drain",
        signal=signal,
    )
    adapter = SyncStreamSessionAdapter(_Session(), abandonment=signal, lease=lease)
    aiter = adapter.__aiter__()
    pending = asyncio.create_task(aiter.__anext__())

    await _wait(signal.reading)
    assert conversation_worker_stats().active == 1
    adapter._release_consumer_plumbing()
    signal.resume.set()

    await _wait(exhausted)
    assert pulled == frames, "the drain stopped short of exhaustion"
    await asyncio.to_thread(adapter._thread.join, WORKER_WAIT)
    assert lease.released, "the worker exited without releasing its pool slot"
    assert conversation_worker_stats().active == 0

    pending.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await pending
    await aiter.aclose()
