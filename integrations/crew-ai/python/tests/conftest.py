"""Shared pytest fixtures for the ag_ui_crewai tests.

Primary concern: isolate the module-level ``QUEUES`` mapping (and the
global crewai event-bus listener singleton) from test-to-test leakage. A
ghost queue from one test is harmless in isolation, but in a long test
suite it can obscure the provenance of flaky teardown races.

Intentionally we do NOT swallow the import error. If
``ag_ui_crewai.endpoint`` cannot be imported, every downstream test will
fail with the same traceback — a clearer diagnostic than a confused test
suite running against a half-initialised module.
"""

import asyncio
import copy
import functools
import inspect
import os
import pathlib
import shutil
import sys
import tempfile
import threading
import time
from types import SimpleNamespace

import pytest

from ag_ui.encoder import EventEncoder

# crewai telemetry is opt-OUT and defaults to on, so any test that runs a real
# Crew talks to crewai's collector. Set unconditionally rather than via
# setdefault: an inherited ``CREWAI_DISABLE_TELEMETRY=false`` would otherwise
# survive, and a test suite must never phone home. crewai re-reads this on every
# telemetry operation (``Telemetry._is_telemetry_disabled``), so setting it here
# covers the whole session.
os.environ["CREWAI_DISABLE_TELEMETRY"] = "true"

# Redirect crewai's on-disk storage root BEFORE anything imports crewai.
#
# crewai resolves its storage root at MODULE-IMPORT time (``crewai.rag.chromadb.
# constants`` calls ``db_storage_path()``, which ``mkdir(parents=True)``s the
# directory), so merely importing the bridge writes into the developer's home
# directory and a per-test fixture would already be too late. The root comes from
# ``CREWAI_STORAGE_DIR``, which MUST be absolute: ``db_storage_path`` treats a
# relative value as an appdirs *app name* (landing back in ``$HOME``) while
# ``LanceDBStorage`` treats it as a *directory* (landing in the cwd).
#
# This only makes the TEST RUN hermetic. The import-time write itself is crewai's
# behaviour, not the bridge's, and cannot be suppressed from library code without
# setting environment variables on the user's behalf.
_OWNED_STORAGE_DIR = None
if not os.environ.get("CREWAI_STORAGE_DIR"):
    _OWNED_STORAGE_DIR = tempfile.mkdtemp(prefix="ag-ui-crewai-tests-")
    os.environ["CREWAI_STORAGE_DIR"] = _OWNED_STORAGE_DIR

from ag_ui_crewai import endpoint as ep  # noqa: E402
from ag_ui_crewai import _config as _config_module  # noqa: E402
from ag_ui_crewai._conversation import (  # noqa: E402
    CONVERSATION_WORKERS,
    AbandonmentSignal,
    _ACTIVE_GATE,
    conversation_worker_stats,
    prepare_conversational_turn,
)

# The crewai global event bus — used below to clear handlers registered by our
# listener singleton so they don't accumulate across tests.
# The bus moved from ``crewai.utilities.events`` (0.x) to
# ``crewai.events`` (1.x); ``_capabilities`` resolves whichever exists.
from ag_ui_crewai._capabilities import (  # noqa: E402
    CAPABILITIES,
    crewai_event_bus as _crewai_event_bus,
)


@pytest.fixture(scope="session", autouse=True)
def _cleanup_crewai_storage_dir():
    """Remove the temporary crewai storage root this session created, if any."""
    yield
    if _OWNED_STORAGE_DIR:
        shutil.rmtree(_OWNED_STORAGE_DIR, ignore_errors=True)

# crewai 1.0.0 split the single ``_handlers`` mapping into
# ``_sync_handlers`` / ``_async_handlers``. The autouse fixture below snapshots
# whichever handler dict(s) the installed crewai exposes so listener isolation
# keeps working across BOTH the 0.x single-dict and the 1.x split-dict shapes.
_HANDLER_ATTRS = ("_sync_handlers", "_async_handlers", "_handlers")


def _clear_warn_once_latches():
    """Reset the module-level "warn once" dedup sets.

    Both latches are per-PROCESS, so the first test to trip one silences the
    warning for every test after it. ``_ENV_WARN_SEEN`` matters as much as the
    alias one: a test that resolves a knob from a bad env value burns that
    ``(var, value)`` key, and a later test asserting the operator-facing warning
    then sees nothing and cannot tell a suppressed warning from a missing one.
    """
    for owner, attr in ((ep, "_ALIAS_WARN_SEEN"), (_config_module, "_ENV_WARN_SEEN")):
        try:
            getattr(owner, attr).clear()
        except AttributeError:  # pragma: no cover - symbol removed in refactor
            pass


@pytest.fixture(autouse=True)
def _clear_conversation_worker_registry():
    """Isolate the process-wide conversational worker pool between tests.

    Cleared on TEARDOWN only, deliberately. A test that leaks a lease must fail
    in its own assertions, not be papered over on the way in; clearing after the
    fact keeps that diagnosis local while stopping one test's leak from
    exhausting capacity for every test that follows.
    """
    yield
    CONVERSATION_WORKERS.clear()


@pytest.fixture(autouse=True)
def _reset_active_gate():
    """Unset the persistence gate's caller binding around every test.

    Production never needs this: the binding is a context variable, each request
    runs in its own asyncio task, and a task's context is its own. A test is the
    one caller that installs a binding on the plain main thread and then leaves
    it there, so the NEXT test's main-thread writes resolve the previous run's
    gate. Left alone, the abandoned rows of the lifecycle matrix accept a write
    the gate should drop, and the suite passes or fails on the order the files
    happen to run in.
    """
    token = _ACTIVE_GATE.set(None)
    try:
        yield
    finally:
        _ACTIVE_GATE.reset(token)


@pytest.fixture(autouse=True)
def _clear_endpoint_queues():
    """Ensure the module-level QUEUES dict and listener singleton are
    isolated between tests.

    The crewai global event bus retains registered listeners for the
    lifetime of the process; the endpoint module caches its listener in
    ``GLOBAL_EVENT_LISTENER`` to avoid double-registration. Between
    tests we clear the QUEUES dict, clear the event-bus handlers
    registered by the listener (they accumulate otherwise, since nulling
    the reference alone lets older handlers keep firing), and reset the
    listener reference so a test that patches or probes
    ``GLOBAL_EVENT_LISTENER`` starts from a known-clean baseline.

    Nulling ``GLOBAL_EVENT_LISTENER`` only drops our Python-side
    reference — the handlers it registered on the bus persist for the
    process lifetime, so over a long suite duplicate listeners
    accumulate. Reaching into the private ``_handlers`` dict directly is
    a pragmatic workaround; crewai exposes no public teardown API. crewai
    1.0.0 further split ``_handlers`` into ``_sync_handlers`` /
    ``_async_handlers``, so the snapshot/restore helpers below iterate
    ``_HANDLER_ATTRS`` to keep isolation working across both shapes.
    """

    # ``handlers.clear()`` on the process-wide event bus wipes ALL
    # handlers — including any registered by another library importing
    # crewai in the same process. Snapshot the handlers at setup and
    # restore on teardown so we only drop what tests registered, not
    # pre-existing subscribers. Copy each list because crewai mutates it
    # in-place via ``append`` during listener registration — a shallow
    # ``dict(...)`` snapshot would still observe our appends post-setup.
    def _snapshot_handlers():
        if _crewai_event_bus is None:
            return None
        snapshot = {}
        for attr in _HANDLER_ATTRS:
            handlers = getattr(_crewai_event_bus, attr, None)
            if handlers is None:
                continue
            try:
                # crewai 1.x stores handlers as ``frozenset`` (the bus does
                # set-union on registration); ``copy.copy`` preserves that
                # container type, whereas a ``list(...)`` snapshot would
                # corrupt it and break ``_register_handler`` on restore.
                snapshot[attr] = {k: copy.copy(v) for k, v in handlers.items()}
            except Exception:  # pragma: no cover - defensive
                continue
        return snapshot or None

    def _restore_handlers(snapshot):
        if _crewai_event_bus is None or not snapshot:
            return
        for attr, per_attr in snapshot.items():
            handlers = getattr(_crewai_event_bus, attr, None)
            if handlers is None:
                continue
            try:
                handlers.clear()
                for k, v in per_attr.items():
                    handlers[k] = copy.copy(v)
            except Exception:  # pragma: no cover - defensive
                # Unexpected handler-store shape; skip rather than crash.
                pass

    handlers_snapshot = _snapshot_handlers()

    ep.QUEUES.clear()
    # Clear the "warn once" dedup sets alongside ``QUEUES`` so a prior test that
    # tripped one does not suppress the warning (and its log assertion) in a
    # later test.
    _clear_warn_once_latches()
    # Reset singleton; the next test that calls ``add_crewai_*`` will
    # create a fresh FastAPICrewFlowEventListener. Also restore the
    # event-bus handlers from the pre-test snapshot so stale listeners
    # from prior tests don't keep firing and skewing queue counts,
    # while leaving any pre-existing subscribers from other libraries
    # untouched.
    ep.GLOBAL_EVENT_LISTENER = None
    _restore_handlers(handlers_snapshot)
    try:
        yield
    finally:
        ep.QUEUES.clear()
        _clear_warn_once_latches()
        ep.GLOBAL_EVENT_LISTENER = None
        _restore_handlers(handlers_snapshot)


# --------------------------------------------------------------------------
# Assertions a conversational worker thread cannot make for itself.
#
# An ``assert`` inside a sync ``StreamSession`` runs on the WORKER thread, where
# ``produce``'s ``except Exception`` catches it and the abandonment gate then
# discards it, so the test it belongs to passes no matter what the worker saw.
# Three mechanisms let that happen and each round of review found new instances,
# so the recorder and the leak guard live HERE rather than in one test module:
# every conversational test file inherits them, and a file that grows a new
# worker-thread stand-in cannot forget to opt in.
# --------------------------------------------------------------------------

# Generous enough that a loaded CI box does not fail on scheduling, short enough
# that a genuinely stuck worker fails its test instead of hanging the suite.
WORKER_WAIT = 5.0

# Imported, not copied. The leak guard below matches worker threads by name, so a
# duplicated literal would leave it matching nothing after a rename and report every
# test as leak-free.
from ag_ui_crewai._conversation import WORKER_THREAD_NAME  # noqa: E402


def _live_worker_threads():
    return {
        thread
        for thread in threading.enumerate()
        if thread.name == WORKER_THREAD_NAME and thread.is_alive()
    }


def _settle_sync(predicate, timeout=WORKER_WAIT):
    """Poll a worker-thread-driven condition, bounded. True once it holds."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return predicate()


class _Park:
    """One place a worker thread is blocked, and how that park ended.

    ``timed_out`` is recorded rather than raised, for the reason above: the wait
    happens on the worker thread. The guard fixture reads it afterwards.
    """

    __slots__ = ("what", "parked", "released", "timed_out")

    def __init__(self, what, released=None):
        self.what = what
        self.parked = threading.Event()
        # A caller that already owns the event it releases the worker with hands
        # it in, so the guard's release and the test's own are one event rather
        # than two that can disagree.
        self.released = threading.Event() if released is None else released
        self.timed_out = threading.Event()

    def wait(self, timeout):
        """Block the worker until the test releases. False if it never did."""
        self.parked.set()
        if self.released.wait(timeout=timeout):
            return True
        self.timed_out.set()
        return False

    def release(self):
        self.released.set()

    @property
    def stranded(self):
        return self.parked.is_set() and not self.released.is_set()


class WorkerGuard:
    """Per-test registry of worker-thread parks and swallowed failures."""

    def __init__(self):
        self._lock = threading.Lock()
        self._parks = []
        self._failures = []

    def reset(self):
        with self._lock:
            self._parks = []
            self._failures = []

    def park(self, what, released=None):
        """Register a park a worker thread is about to block in."""
        park = _Park(what, released)
        with self._lock:
            self._parks.append(park)
        return park

    def record(self, detail):
        """Record a failure observed on a worker thread, to be raised later."""
        with self._lock:
            self._failures.append(detail)

    @property
    def parks(self):
        with self._lock:
            return list(self._parks)

    @property
    def failures(self):
        with self._lock:
            return list(self._failures)


WORKER_GUARD = WorkerGuard()


MUTATION_BACKUP_SUFFIX = ".mutation-backup"
# Set by the mutation harness on the child runs it judges each guard by. Those
# children run WITH a backup on disk on purpose, because their parent is alive and
# holding the mutation; repairing it there would undo the very guard under test.
MUTATION_IN_FLIGHT_ENV_VAR = "AGUI_CREWAI_MUTATION_IN_FLIGHT"
PACKAGE_DIR = pathlib.Path(ep.__file__).parent

# Filled by ``pytest_configure`` below, read by the session guard.
_REPAIRED_BY_CONFIGURE: list = []


def pytest_configure(config):
    config.addinivalue_line(
        "markers",
        "mutation: neutralizes a containment guard and reruns the suite; slow, "
        "opt in with -m mutation",
    )
    # The mutation suite edits the package IN PLACE and restores it in a
    # ``finally``, which a hard kill (a timeout, a Ctrl-C at the wrong moment, an
    # OOM) does not run. What is left behind is a NEUTRALIZED guard in the working
    # tree, and every run after it reports a pass for a guard that is switched
    # off. So the backup is a file rather than a variable, and it is honoured here
    # in EVERY run: before collection, so the repair lands before anything imports
    # the package, and in the default run rather than only under ``-m mutation``,
    # since the default run is what is usually live when the kill happens.
    #
    # Skipped only for the harness's own child runs, whose parent is alive and
    # deliberately holding a mutation: repairing there would restore the guard the
    # child exists to judge, and every guard would report as untested.
    if os.environ.get(MUTATION_IN_FLIGHT_ENV_VAR):
        return
    for backup in sorted(PACKAGE_DIR.glob("*" + MUTATION_BACKUP_SUFFIX)):
        source = backup.with_suffix("")
        source.write_text(backup.read_text())
        backup.unlink()
        _REPAIRED_BY_CONFIGURE.append(source.name)
    if _REPAIRED_BY_CONFIGURE:
        # Refused here rather than as a failing test: the tree just changed under
        # the operator, and a repair nobody was told about is the whole defect
        # repeating one level up. ``UsageError`` because it stops the run before a
        # single test executes and prints the reason, where an assertion inside a
        # fixture would let ``--collect-only`` and anything else that skips
        # fixtures carry on quietly.
        raise pytest.UsageError(
            "a mutation run died before restoring the package; these files were "
            f"repaired from their backups just now: {_REPAIRED_BY_CONFIGURE}. "
            "Confirm with git that they match what you expect, then re-run."
        )


def pytest_collection_modifyitems(config, items):
    """Deselect the mutation suite unless it was asked for by marker.

    It reruns the whole suite once per mutation, so leaving it in the default
    run would multiply CI time. Selected with ``-m mutation``.
    """
    if "mutation" in (config.option.markexpr or ""):
        return
    # Deselected rather than skipped, so the default run's skip count keeps
    # meaning "a capability this crewai does not have".
    deselected = [item for item in items if "mutation" in item.keywords]
    if not deselected:
        return
    items[:] = [item for item in items if "mutation" not in item.keywords]
    config.hook.pytest_deselected(items=deselected)


@pytest.fixture(autouse=True)
def _no_stranded_worker_and_no_swallowed_assertion():
    """Fail the test that stranded a worker, leaked a slot, or lost a failure.

    Three checks, one fixture, because all three are invisible from where they
    happen: a worker-thread assertion is swallowed by the adapter, a park nobody
    released only shows up as a hang somewhere else, and a leaked pool slot shows
    up as a capacity refusal in an unrelated test later on.
    """
    WORKER_GUARD.reset()
    inherited = _live_worker_threads()
    yield
    parks = WORKER_GUARD.parks
    stranded = [park.what for park in parks if park.stranded]
    timed_out = [park.what for park in parks if park.timed_out.is_set()]
    # Released before the assertions so a stranded worker cannot keep its thread
    # (or the pool slot behind it) for the rest of the session.
    for park in parks:
        park.release()
    settled = _settle_sync(
        lambda: not (_live_worker_threads() - inherited)
        and conversation_worker_stats().active == 0
    )
    failures = WORKER_GUARD.failures
    assert not failures, "a worker thread recorded a failure: " + "; ".join(failures)
    assert not timed_out, f"a parked worker waited out its release: {timed_out}"
    assert not stranded, f"the test left a worker parked and never released it: {stranded}"
    assert settled, (
        "a conversational worker was still running when its test ended: "
        f"{sorted(thread.name for thread in _live_worker_threads() - inherited)}, "
        f"active={conversation_worker_stats().active}"
    )


# --------------------------------------------------------------------------
# Stand-ins every conversational suite needs, in one place for one reason: each
# had drifted between its copies, and in the case of the sink wrapper the copy
# that drifted was the one carrying the floor guard.
# --------------------------------------------------------------------------

# The scoped stream-sink API does not exist on the declared floor (crewai 1.0-1.5,
# where ``add_stream_sink`` is ``None`` and the bridge uses the legacy bus-listener
# path). Skipped rather than faked there: a wrapper standing in for a missing
# symbol reports a pass for a path the installed crewai cannot reach.
requires_stream_frames = pytest.mark.skipif(
    not CAPABILITIES.stream_frame_available,
    reason="crewai>=1.6 StreamFrame contract required for the scoped stream sink",
)


def _conversational_turn_api():
    """Why the public conversational turn API is unusable here, or ``None``.

    Its own probe, not an inference from the stream-frame one: the two surfaces
    arrived in different crewai releases, and a suite that skips on the frame
    contract alone still fails on the floor when it goes on to decorate a real
    Flow with ``ConversationConfig``.
    """
    try:
        import crewai
        from crewai.experimental.conversational import ConversationConfig  # noqa: F401
    except Exception as exc:  # noqa: BLE001 - capability probe
        return f"crewai.experimental.conversational is unavailable ({exc})"
    if not callable(getattr(getattr(crewai, "Flow", None), "stream_turn", None)):
        return "crewai Flow has no public stream_turn"
    return None


requires_conversational_turn_api = pytest.mark.skipif(
    _conversational_turn_api() is not None,
    reason=_conversational_turn_api() or "",
)


def capture_stream_sink(monkeypatch):
    """Capture the scoped raw-event sink the driver registers. Returns the dict.

    The ``callable`` guard is why this is shared rather than copied: on the
    declared floor ``add_stream_sink`` is ``None``, the driver itself guards on
    that, and a wrapper that delegates unconditionally turns the floor into a
    TypeError raised from inside the worker thread. Two of the three copies of
    this wrapper carried the guard and the third did not.
    """
    captured = {}
    real_add_sink = ep.add_stream_sink

    def _capturing_add_sink(sink):
        captured["sink"] = sink
        return real_add_sink(sink) if callable(real_add_sink) else None

    monkeypatch.setattr(ep, "add_stream_sink", _capturing_add_sink)
    return captured


def sink_closure(captured):
    """The request-owned buffers the captured sink parks into."""
    assert "sink" in captured, "the driver never registered its raw-event sink"
    return inspect.getclosurevars(captured["sink"]).nonlocals


def run_abandonment_signal(captured):
    """The RUN's own abandonment signal, read off the sink closure that shares it.

    The population counters are no substitute: a lease that has already been
    released leaves ``abandoned_active`` at zero whether or not the run it
    belonged to was abandoned, so a test asserting on the counter passes even
    when the run it is about really was abandoned.
    """
    return sink_closure(captured)["abandonment"]


@functools.lru_cache(maxsize=1)
def completing_conversational_flow_type():
    """A real conversational Flow whose turn just finishes, built on first use.

    Built lazily, with every crewai import inside the function, because
    ``crewai.experimental.conversational`` does not exist on the declared crewai
    floor: importing it at module level fails a whole file before any skipif can
    apply, so the floor claim its skips make would be false.
    """
    from crewai.experimental.conversational import ConversationConfig
    from crewai.flow.flow import Flow, listen, start

    from ag_ui_crewai.sdk import CopilotKitState

    @ConversationConfig(defer_trace_finalization=False)
    class _CompletingConversationalFlow(Flow[CopilotKitState]):
        conversational = True

        @start()
        def chat(self):
            return None

        def route_turn(self, _context):
            return "ag_ui_complete"

        @listen("ag_ui_complete")
        def finish_ag_ui_turn(self):
            return None

    return _CompletingConversationalFlow


class SpyBackend:
    """Records writes and answers reads, so a gated write is observable."""

    def __init__(self):
        self.writes = []

    def load_state(self, flow_uuid):
        return {"id": flow_uuid}

    def save_state(self, flow_uuid, method_name, state_data):
        self.writes.append(("save_state", method_name))

    def save_pending_feedback(self, flow_uuid, context, state_data):
        self.writes.append(("save_pending_feedback", flow_uuid))

    def clear_pending_feedback(self, flow_uuid):
        self.writes.append(("clear_pending_feedback", flow_uuid))


class ParkedSession:
    """Sync ``StreamSession`` stand-in that parks mid-turn until released.

    ``block_at`` is the frame index the park sits in FRONT of, so ``0`` parks
    before the turn produces anything and ``None`` parks nowhere. An index equal to
    the frame count parks after the last frame, which is how a session that
    produces nothing at all is spelled: ``frames=(), block_at=0``.

    The park is registered with the shared guard rather than asserted here. This
    runs on the WORKER thread, where an ``AssertionError`` lands in ``produce``'s
    handler and the abandonment gate then discards it, so the test it belongs to
    would pass however the park ended.
    """

    def __init__(self, frames=("f0", "f1", "f2"), *, block_at=1, what="parked session"):
        self._frames = list(frames)
        self._block_at = block_at
        self.pulled = []
        self.closed = False
        self.exhausted = threading.Event()
        self._park = WORKER_GUARD.park(what)

    def __iter__(self):
        for index, frame in enumerate(self._frames):
            if index == self._block_at and not self._park.wait(WORKER_WAIT):
                return
            self.pulled.append(frame)
            yield frame
        if self._block_at == len(self._frames) and not self._park.wait(WORKER_WAIT):
            return
        self.exhausted.set()

    @property
    def parked(self):
        return self._park.parked

    def release(self):
        self._park.release()

    def close(self):
        self.closed = True


def driver_frames(count):
    """Frames shaped enough for the real driver, which looks up ``frame.id``."""
    return [SimpleNamespace(id=f"frame-{index}") for index in range(count)]


def frame_stream(flow, input_data, *, timeout=None, emit_raw_events=False):
    """The real conversational driver over one flow and one request."""
    return ep._run_flow_frame_stream(
        flow_copy=flow,
        encoder=EventEncoder(),
        input_data=input_data,
        inputs={"id": input_data.thread_id, "messages": []},
        timeout=timeout,
        emit_raw_events=emit_raw_events,
        conversational_turn=prepare_conversational_turn(input_data.messages),
    )


def drain_in_task(agen, collected: list):
    """Drive an already-built driver stream to exhaustion inside ONE task.

    Tests that need a turn parked in the background cannot simply iterate the
    driver, so they hand its advance to a task. The driver sets its contextvar
    tokens in whichever context first advances it and resets them where it
    unwinds, so advancing it in a task and then closing it from the test's own
    context resets tokens that context never set. Draining it inside one task
    keeps set and reset together, and leaves nothing for the test to close.
    """

    async def _drain():
        async for chunk in agen:
            collected.append(chunk)

    return asyncio.create_task(_drain())


class TailedSession:
    """A real turn's session plus the tail a completed turn genuinely has.

    CrewAI keeps working after its terminal frame (assistant append, terminal
    turn handlers, thread join), so the post-terminal drain routinely runs out its
    grace on a perfectly healthy run. Held open by an event the test releases
    rather than by a duration, so assertions land while the tail is demonstrably
    still running.

    The hold is REGISTERED with the guard, like every other worker-thread park.
    The tail runs on a worker thread, so a tail the test never releases is
    invisible from the test: it holds its pool slot for the whole wait, which is
    also how long the guard's own settle is willing to wait for it.
    """

    def __init__(self, session, gate):
        self._session = session
        # The caller's gate IS the park's release, so the test releases the tail
        # exactly as before and the guard can release it too.
        self._park = WORKER_GUARD.park("completed turn tail", released=gate)
        self.tail_reached = threading.Event()
        self.tail_released = threading.Event()

    def _hold_the_tail(self):
        """Block in the tail until the test releases it. False if it never did."""
        self.tail_reached.set()
        if not self._park.wait(WORKER_WAIT):
            return False
        self.tail_released.set()
        return True

    def __iter__(self):
        yield from self._session
        self._hold_the_tail()

    def close(self):
        close = getattr(self._session, "close", None)
        if callable(close):
            close()


def _inside_publish():
    """True when the calling read is the one the adapter's ``publish`` makes.

    Walks out to the nearest of the two frames that matter. ``produce``'s own
    pre-frame check is not the seam, so it answers False there.
    """
    frame = sys._getframe(1)
    while frame is not None:
        if frame.f_code.co_name == "publish":
            return True
        if frame.f_code.co_name == "produce":
            return False
        frame = frame.f_back
    return False


class PublishParkingSignal(AbandonmentSignal):
    """Signal whose read inside ``publish`` parks, holding the worker there.

    ``publish`` takes the plumbing snapshot, tests it, tests this signal, and only
    then dereferences the snapshot, while the request teardown nulls it from the
    loop thread. Parking the one read that sits between that test and that
    dereference turns the interleaving from a race into a certainty. Parking any
    other read would prove nothing, hence the caller check: if ``publish`` stops
    reading the signal there, the test times out rather than passing vacuously.
    """

    def __init__(self):
        super().__init__()
        self.reading = threading.Event()
        self.resume = threading.Event()

    @property
    def abandoned(self) -> bool:
        if _inside_publish() and not self.reading.is_set():
            self.reading.set()
            if not self.resume.wait(timeout=WORKER_WAIT):
                WORKER_GUARD.record("the test never resumed the parked publish read")
        return super().abandoned
