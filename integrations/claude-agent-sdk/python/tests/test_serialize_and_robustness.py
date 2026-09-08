"""Tests for the run-admission serialization + robustness hardening.

These cover four changes (see the reviewed Notion proposal):

  Fix 1 — SERIALIZE concurrent same-thread run() invocations behind a dedicated
          per-thread run-admission lock (``_run_locks``), held from admission
          (before ``worker.query()`` / before ``RUN_STARTED``) through
          ``RUN_FINISHED`` and released on EVERY exit path. Different thread_ids
          stay concurrent.
  Fix 2 — ``query_timeout_seconds`` defaults to a generous 300s (was None →
          unbounded hang on a dead/slow worker), still overridable.
  Fix 3 — worker-death fan-out: ``SessionWorker`` signals a terminal
          WorkerError + None sentinel to ALL in-flight output queues on fatal
          worker death, so a queued/peer consumer cannot hang.
  Fix 4 — ``_per_thread_result`` is per-run, keyed by (thread_id, run_id), so a
          run's RUN_FINISHED.result reflects its OWN ResultMessage.

The dedicated ``_run_locks`` MUST be distinct from ``_state_locks`` (which is
acquired mid-stream on the state-update-tool path); reusing it would self-
deadlock the instant the model emits a state-update tool call. Scenario (c)
exercises run-lock + inner state-lock together to prove no deadlock.
"""

import asyncio

import pytest

from ag_ui.core import EventType
from ag_ui_claude_sdk.adapter import ClaudeAgentAdapter
from ag_ui_claude_sdk.config import STATE_MANAGEMENT_TOOL_FULL_NAME

from .conftest import stream_event, aiter


def _types(events):
    return [e.type for e in events]


async def _drive(adapter, inp):
    return [e async for e in adapter.run(inp)]


async def _wait_for(predicate, *, tries=2000):
    for _ in range(tries):
        if predicate():
            return True
        await asyncio.sleep(0)
    return False


# ---------------------------------------------------------------------------
# Fake workers used to drive run() deterministically without an LLM.
# ---------------------------------------------------------------------------


class _GatedTextWorker:
    """Worker whose query() streams a tiny text run, but only after a per-call
    gate is released. Tracks the order in which RUN_STARTED-able streams begin so
    a test can assert serialization ordering.

    A shared ``log`` list records (event, run_marker) tuples for ordering checks.
    """

    def __init__(self, *a, **kw):
        pass

    async def start(self):
        pass

    def is_alive(self):
        return True

    async def stop(self):
        pass


def _make_text_stream():
    return [
        stream_event({"type": "message_start"}),
        stream_event(
            {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "hi"}}
        ),
        stream_event({"type": "message_stop"}),
    ]


class TestSerializeSameThread:
    @pytest.mark.asyncio
    async def test_two_same_thread_runs_are_serialized(self, make_input, monkeypatch):
        # (a) Two overlapping same-thread runs: B's RUN_STARTED must be emitted
        # only AFTER A's RUN_FINISHED. The run-admission lock holds A's slot
        # across its whole run; B waits at admission.
        order = []  # records ("A"/"B", event_type)
        a_gate = asyncio.Event()  # released to let A's stream complete

        class _OrderedWorker:
            calls = 0

            def __init__(self, *a, **kw):
                pass

            async def start(self):
                pass

            def is_alive(self):
                return True

            def query(self, prompt, session_id="default"):
                idx = _OrderedWorker.calls
                _OrderedWorker.calls += 1

                async def _gen_first():
                    # A: hold the stream open so, IF B were not serialized, B
                    # would be able to emit RUN_STARTED while A is mid-run.
                    await a_gate.wait()
                    for ev in _make_text_stream():
                        yield ev

                async def _gen_second():
                    for ev in _make_text_stream():
                        yield ev

                return _gen_first() if idx == 0 else _gen_second()

            async def stop(self):
                pass

        adapter = ClaudeAgentAdapter(name="t")
        monkeypatch.setattr("ag_ui_claude_sdk.adapter.SessionWorker", _OrderedWorker)

        inp_a = make_input(thread_id="shared", run_id="A",
                           messages=[{"id": "1", "role": "user", "content": "hi"}])
        inp_b = make_input(thread_id="shared", run_id="B",
                           messages=[{"id": "2", "role": "user", "content": "yo"}])

        async def drive(inp, marker):
            async for e in adapter.run(inp):
                if e.type in (EventType.RUN_STARTED, EventType.RUN_FINISHED):
                    order.append((marker, e.type))

        t_a = asyncio.create_task(drive(inp_a, "A"))
        # Ensure A has acquired the run-lock and emitted RUN_STARTED first.
        await _wait_for(lambda: ("A", EventType.RUN_STARTED) in order)
        t_b = asyncio.create_task(drive(inp_b, "B"))

        # Give B ample scheduling opportunity; while A holds the run-lock, B must
        # NOT have emitted RUN_STARTED yet.
        for _ in range(50):
            await asyncio.sleep(0)
        assert ("B", EventType.RUN_STARTED) not in order, (
            "B's RUN_STARTED was emitted before A finished — runs are not serialized"
        )

        # Release A; it finishes, releasing the run-lock so B can proceed.
        a_gate.set()
        await asyncio.gather(t_a, t_b)

        # Both completed.
        assert ("A", EventType.RUN_FINISHED) in order
        assert ("B", EventType.RUN_FINISHED) in order
        # Ordering: A RUN_FINISHED strictly precedes B RUN_STARTED.
        idx_a_fin = order.index(("A", EventType.RUN_FINISHED))
        idx_b_start = order.index(("B", EventType.RUN_STARTED))
        assert idx_a_fin < idx_b_start, f"not serialized: {order}"

        await adapter.shutdown()

    @pytest.mark.asyncio
    async def test_run_lock_not_orphaned_by_eviction_in_release_acquire_window(
        self, make_input, monkeypatch
    ):
        # (a2) ORPHAN REGRESSION (Fix 1): the run-admission lock must NOT be
        # coupled to worker eviction. Reproduce the hole:
        #   1. Run A admits, holds the run-lock L1, runs on a fresh worker.
        #   2. Run B parks on ``L1.acquire()`` (waiter on L1).
        #   3. A finishes and releases L1 — but B has not yet woken. The worker
        #      is now idle (active_runs==0) and thus TTL-evictable.
        #   4. Eviction fires (worker_ttl_seconds=0). If eviction POPS
        #      ``_run_locks[thread_id]`` (the bug), L1 is orphaned: B is still a
        #      waiter on it, but a later run D will ``setdefault`` a FRESH lock
        #      L2 and run on its own brand-new worker.
        #   5. D and B then hold DIFFERENT locks → they run CONCURRENTLY on the
        #      same thread_id. Serialization defeated.
        # With the fix (lock NOT popped + identity re-validation after acquire),
        # B and D share the SAME current lock entry, so they serialize: their two
        # runs never overlap (refcount on the shared worker never exceeds 1, and
        # RUN_STARTED events never interleave).
        order = []  # (marker, event_type) for RUN_STARTED / RUN_FINISHED
        a_gate = asyncio.Event()       # release A's stream so A can finish
        b_gate = asyncio.Event()       # hold B's stream open so B is mid-flight
                                       # when D arrives (so an orphan → overlap)
        b_proceeded = asyncio.Event()  # set when B wakes from acquire()
        max_overlap = {"n": 0}
        # True concurrency gauge: number of runs that have emitted RUN_STARTED
        # but not yet RUN_FINISHED, counted across ALL drive() coroutines (not
        # tied to a single _workers slot, which two distinct workers can overwrite).
        live_runs = {"n": 0, "max": 0}

        class _OrphanWorker:
            calls = 0

            def __init__(self, *a, **kw):
                pass

            async def start(self):
                pass

            def is_alive(self):
                return True

            def query(self, prompt, session_id="default"):
                idx = _OrphanWorker.calls
                _OrphanWorker.calls += 1

                async def _gen_a():
                    # A (idx 0): hold open until released, so B can park on the
                    # run-lock and we can fire eviction in the release→acquire
                    # window.
                    await a_gate.wait()
                    for ev in _make_text_stream():
                        yield ev

                async def _gen_b():
                    # B (idx 1): hold open until released, so B is still mid-flight
                    # when D arrives. If B's lock was orphaned by eviction, D will
                    # acquire a FRESH lock and run concurrently with B → the
                    # serialization violation this test is designed to catch.
                    await b_gate.wait()
                    for ev in _make_text_stream():
                        yield ev

                async def _gen_other():
                    for ev in _make_text_stream():
                        yield ev

                if idx == 0:
                    return _gen_a()
                if idx == 1:
                    return _gen_b()
                return _gen_other()

            async def stop(self):
                pass

        adapter = ClaudeAgentAdapter(name="t", worker_ttl_seconds=0.0)
        monkeypatch.setattr("ag_ui_claude_sdk.adapter.SessionWorker", _OrphanWorker)

        inp_a = make_input(thread_id="shared", run_id="A",
                           messages=[{"id": "1", "role": "user", "content": "hi"}])
        inp_b = make_input(thread_id="shared", run_id="B",
                           messages=[{"id": "2", "role": "user", "content": "yo"}])
        inp_d = make_input(thread_id="shared", run_id="D",
                           messages=[{"id": "3", "role": "user", "content": "sup"}])

        def _record_overlap():
            entry = adapter._workers.get("shared")
            if entry:
                max_overlap["n"] = max(max_overlap["n"], entry.get("active_runs", 0))

        async def drive(inp, marker, evict_after=False):
            async for e in adapter.run(inp):
                _record_overlap()
                if e.type == EventType.RUN_STARTED:
                    live_runs["n"] += 1
                    live_runs["max"] = max(live_runs["max"], live_runs["n"])
                    order.append((marker, e.type))
                    if marker == "B":
                        b_proceeded.set()
                elif e.type == EventType.RUN_FINISHED:
                    live_runs["n"] -= 1
                    order.append((marker, e.type))
            # CRITICAL: fire eviction in the SAME coroutine step in which A's
            # run() generator was exhausted — A's ``finally`` has just run
            # ``run_lock.release()``, scheduling B's parked acquire to wake on the
            # NEXT loop iteration, but we have not yielded control yet. So B is
            # still a waiter on L1 when eviction runs. With the bug, eviction pops
            # L1 here → B is orphaned on a lock no longer in ``_run_locks``.
            if evict_after:
                adapter._evict_workers()

        # 1+2: A admits and holds L1; B parks on L1.acquire().
        t_a = asyncio.create_task(drive(inp_a, "A", evict_after=True))
        await _wait_for(lambda: ("A", EventType.RUN_STARTED) in order)
        l1 = adapter._run_locks["shared"]
        t_b = asyncio.create_task(drive(inp_b, "B"))
        # Let B reach the parked acquire() on L1.
        await _wait_for(lambda: l1.locked() and len(l1._waiters or []) >= 1)

        # 3: release A; A finishes, releases L1, and (in A's own coroutine step,
        # before B wakes) fires eviction (evict_after=True). The now-idle worker
        # is popped; with the BUG L1 is popped too, orphaning B's wait.
        a_gate.set()
        # B wakes, acquires (its now-orphaned, under the bug) lock, emits
        # RUN_STARTED, and blocks in its gated stream — still in-flight.
        await _wait_for(lambda: b_proceeded.is_set())

        # 5: D arrives WHILE B is still mid-flight. With the bug, ``_run_locks``
        # was emptied by eviction, so D ``setdefault``s a FRESH lock + fresh
        # worker and runs immediately — concurrently with B. With the fix, the
        # lock entry survived (B still holds the current entry), so D parks until
        # B releases.
        t_d = asyncio.create_task(drive(inp_d, "D"))
        # Give D ample opportunity to (incorrectly) start before B is released.
        for _ in range(100):
            await asyncio.sleep(0)

        # Now release B; everything drains.
        b_gate.set()
        await asyncio.wait_for(asyncio.gather(t_a, t_b, t_d), timeout=10.0)

        # SERIALIZATION INVARIANT: never were two same-thread runs simultaneously
        # in-flight (RUN_STARTED-but-not-yet-RUN_FINISHED). Counted across all
        # drive() coroutines so it catches B and D running on DISTINCT workers
        # (the orphan symptom: each gets its own worker, so the per-entry refcount
        # can't see the overlap, but the run-lock was supposed to prevent it).
        assert live_runs["max"] <= 1, (
            f"run-lock orphaned: {live_runs['max']} same-thread runs were "
            f"concurrently in-flight (B and D overlapped). order={order}"
        )
        # All three completed.
        for m in ("A", "B", "D"):
            assert (m, EventType.RUN_FINISHED) in order, f"{m} did not finish: {order}"
        # B and D never interleave their RUN_STARTED/RUN_FINISHED: one fully
        # precedes the other.
        b_fin = order.index(("B", EventType.RUN_FINISHED))
        d_start = order.index(("D", EventType.RUN_STARTED))
        b_start = order.index(("B", EventType.RUN_STARTED))
        d_fin = order.index(("D", EventType.RUN_FINISHED))
        assert b_fin < d_start or d_fin < b_start, (
            f"B and D interleaved — not serialized: {order}"
        )

        await adapter.shutdown()

    @pytest.mark.asyncio
    async def test_run_admission_revalidate_retry_relooops_on_swapped_lock(
        self, make_input, monkeypatch
    ):
        # (a3) RETRY-BRANCH COVERAGE (Fix 1): the run-admission loop in ``run()``
        #
        #     while True:
        #         run_lock = self._run_locks.setdefault(thread_id, Lock())
        #         await run_lock.acquire()
        #         if self._run_locks.get(thread_id) is run_lock:
        #             break
        #         run_lock.release()   # <-- this RETRY branch
        #
        # is defensive: eviction no longer pops ``_run_locks``, so in production
        # the identity check passes on the first pass and the ``release()`` +
        # re-loop branch never executes (the suite stays green even if that
        # branch is deleted and replaced with a plain ``break``). This white-box
        # test FORCES the retry branch purely test-side: monkeypatch
        # ``asyncio.Lock.acquire`` so the FIRST acquire against the adapter's
        # run-lock swaps ``_run_locks[thread_id]`` to a DIFFERENT live lock before
        # returning. The identity check then fails, the run must ``release()`` the
        # stale lock and re-loop onto the now-current entry. We assert the run
        # ends up holding the CURRENT ``_run_locks[thread_id]`` (i.e. it re-looped
        # rather than running on a stale lock) and completes correctly.
        #
        # Red-green: if the RETRY branch is removed (left as a plain ``break``),
        # the run keeps the stale L1 while the live entry is L2, so the final
        # ``adapter._run_locks[thread_id] is acquired_lock`` assertion FAILS.
        adapter = ClaudeAgentAdapter(name="t")
        monkeypatch.setattr(
            "ag_ui_claude_sdk.adapter.SessionWorker", _GatedTextWorker
        )

        def _query(self, prompt, session_id="default"):
            async def _gen():
                for ev in _make_text_stream():
                    yield ev
            return _gen()

        _GatedTextWorker.query = _query

        thread_id = "swap"
        # ``acquired_locks`` records, in order, every Lock object the run
        # actually acquires; the live entry is read at assert time.
        acquired_locks = []
        swapped = {"done": False}

        real_acquire = asyncio.Lock.acquire

        async def _acquire(self):
            result = await real_acquire(self)
            # Only react to the run-admission lock for our thread, and only the
            # FIRST time: swap the live entry to a brand-new (unlocked) lock so
            # the identity re-validation fails and the run must re-loop.
            if (
                not swapped["done"]
                and adapter._run_locks.get(thread_id) is self
            ):
                swapped["done"] = True
                adapter._run_locks[thread_id] = asyncio.Lock()
            acquired_locks.append(self)
            return result

        monkeypatch.setattr(asyncio.Lock, "acquire", _acquire)

        inp = make_input(
            thread_id=thread_id, run_id="R",
            messages=[{"id": "1", "role": "user", "content": "hi"}],
        )
        events = await _drive(adapter, inp)

        # The swap fired (so the retry branch was actually exercised), and the
        # run acquired at least two distinct lock objects (stale L1, then the
        # live L2) — proof it re-looped.
        assert swapped["done"], "the lock swap never fired; retry branch untested"
        assert len(acquired_locks) >= 2, (
            f"run did not re-acquire after swap: acquired={acquired_locks}"
        )
        # The run released the stale lock and ended holding the CURRENT entry.
        live_lock = adapter._run_locks[thread_id]
        assert acquired_locks[-1] is live_lock, (
            "run is not holding the current _run_locks entry — it failed to "
            "re-loop onto the swapped-in lock (retry branch broken)"
        )
        # The stale first lock was released (not left orphaned/locked).
        stale_lock = acquired_locks[0]
        assert stale_lock is not live_lock, "no swap occurred; test is inert"
        assert not stale_lock.locked(), "stale run-lock was not released on retry"
        # And the run completed correctly end-to-end.
        assert EventType.RUN_STARTED in _types(events)
        assert EventType.RUN_FINISHED in _types(events)

        await adapter.shutdown()

    @pytest.mark.asyncio
    async def test_different_threads_run_concurrently(self, make_input, monkeypatch):
        # (b) Two DIFFERENT-thread runs must still overlap (lock is per-thread).
        both_started = asyncio.Event()
        started = {"n": 0}
        release = asyncio.Event()

        class _ConcurrentWorker:
            def __init__(self, *a, **kw):
                pass

            async def start(self):
                pass

            def is_alive(self):
                return True

            def query(self, prompt, session_id="default"):
                async def _gen():
                    started["n"] += 1
                    if started["n"] >= 2:
                        both_started.set()
                    # Hold until both have started — proving genuine overlap. If
                    # the lock were global (not per-thread), the second run could
                    # never start and this would deadlock/time out.
                    await release.wait()
                    for ev in _make_text_stream():
                        yield ev

                return _gen()

            async def stop(self):
                pass

        adapter = ClaudeAgentAdapter(name="t")
        monkeypatch.setattr("ag_ui_claude_sdk.adapter.SessionWorker", _ConcurrentWorker)

        inp1 = make_input(thread_id="t1", run_id="r1",
                          messages=[{"id": "1", "role": "user", "content": "hi"}])
        inp2 = make_input(thread_id="t2", run_id="r2",
                          messages=[{"id": "2", "role": "user", "content": "yo"}])

        t1 = asyncio.create_task(_drive(adapter, inp1))
        t2 = asyncio.create_task(_drive(adapter, inp2))

        overlapped = await _wait_for(both_started.is_set)
        assert overlapped, "different-thread runs did not overlap — lock is not per-thread"

        release.set()
        e1, e2 = await asyncio.gather(t1, t2)
        assert EventType.RUN_FINISHED in _types(e1)
        assert EventType.RUN_FINISHED in _types(e2)

        await adapter.shutdown()

    @pytest.mark.asyncio
    async def test_state_update_tool_does_not_deadlock_with_run_lock(self, make_input, monkeypatch):
        # (c) A run whose stream includes a state-update tool call must NOT
        # deadlock: the run-lock (outer) and state-lock (inner, acquired mid-
        # stream at adapter.py state-management path) are DISTINCT locks. If the
        # run incorrectly reused _state_locks for admission, this would self-
        # deadlock the instant the state-update tool fires.
        class _StateToolWorker:
            def __init__(self, *a, **kw):
                pass

            async def start(self):
                pass

            def is_alive(self):
                return True

            def query(self, prompt, session_id="default"):
                async def _gen():
                    yield stream_event({"type": "message_start"})
                    yield stream_event({
                        "type": "content_block_start",
                        "content_block": {
                            "type": "tool_use",
                            "id": "tc1",
                            "name": STATE_MANAGEMENT_TOOL_FULL_NAME,
                        },
                    })
                    yield stream_event({
                        "type": "content_block_delta",
                        "delta": {
                            "type": "input_json_delta",
                            "partial_json": '{"state_updates": {"count": 7}}',
                        },
                    })
                    yield stream_event({"type": "content_block_stop"})
                    yield stream_event({"type": "message_stop"})

                return _gen()

            async def stop(self):
                pass

        adapter = ClaudeAgentAdapter(name="t")
        monkeypatch.setattr("ag_ui_claude_sdk.adapter.SessionWorker", _StateToolWorker)
        inp = make_input(thread_id="sd", run_id="r1", state={"count": 0},
                         messages=[{"id": "1", "role": "user", "content": "hi"}])

        # Must complete (no deadlock) within a generous bound.
        events = await asyncio.wait_for(_drive(adapter, inp), timeout=5.0)
        assert EventType.RUN_FINISHED in _types(events)
        # State-update tool path actually ran (mid-stream state-lock acquired).
        assert EventType.STATE_SNAPSHOT in _types(events)
        assert adapter._per_thread_state["sd"] == {"count": 7}

        await adapter.shutdown()

    @pytest.mark.asyncio
    async def test_run_lock_released_on_error_path(self, make_input, monkeypatch):
        # (d) A run that raises must still release the run-lock so a subsequent
        # same-thread run can proceed (not hang on a never-released lock).
        class _FailThenSucceedWorker:
            calls = 0

            def __init__(self, *a, **kw):
                pass

            async def start(self):
                pass

            def is_alive(self):
                return True

            def query(self, prompt, session_id="default"):
                idx = _FailThenSucceedWorker.calls
                _FailThenSucceedWorker.calls += 1

                async def _fail():
                    raise RuntimeError("boom")
                    yield  # pragma: no cover

                async def _ok():
                    for ev in _make_text_stream():
                        yield ev

                return _fail() if idx == 0 else _ok()

            async def stop(self):
                pass

        adapter = ClaudeAgentAdapter(name="t")
        monkeypatch.setattr("ag_ui_claude_sdk.adapter.SessionWorker", _FailThenSucceedWorker)

        inp1 = make_input(thread_id="errthread", run_id="r1",
                          messages=[{"id": "1", "role": "user", "content": "hi"}])
        events1 = await asyncio.wait_for(_drive(adapter, inp1), timeout=5.0)
        assert EventType.RUN_ERROR in _types(events1)

        # The run-lock must have been released — a second same-thread run runs.
        inp2 = make_input(thread_id="errthread", run_id="r2",
                          messages=[{"id": "2", "role": "user", "content": "yo"}])
        events2 = await asyncio.wait_for(_drive(adapter, inp2), timeout=5.0)
        assert EventType.RUN_FINISHED in _types(events2)

        await adapter.shutdown()


class TestQueryTimeoutDefault:
    def test_default_query_timeout_is_non_none(self):
        # Fix 2: constructed with no query_timeout_seconds → a non-None default
        # (300s) so a dead/slow worker cannot hang a run forever.
        adapter = ClaudeAgentAdapter(name="t")
        assert adapter._query_timeout_seconds is not None
        assert adapter._query_timeout_seconds == 300

    def test_query_timeout_override_still_honored(self):
        adapter = ClaudeAgentAdapter(name="t", query_timeout_seconds=12.0)
        assert adapter._query_timeout_seconds == 12.0
        # Explicit None still disables it.
        adapter2 = ClaudeAgentAdapter(name="t", query_timeout_seconds=None)
        assert adapter2._query_timeout_seconds is None

    @pytest.mark.asyncio
    async def test_unresponsive_worker_times_out_not_hang(self, make_input, monkeypatch):
        # A worker that never yields must surface RUN_ERROR (timeout), not hang.
        # Use a short override to keep the test fast.
        class _HangingWorker:
            def __init__(self, *a, **kw):
                pass

            async def start(self):
                pass

            def is_alive(self):
                return True

            def query(self, prompt, session_id="default"):
                async def _gen():
                    await asyncio.sleep(3600)  # never responds within the test
                    yield  # pragma: no cover

                return _gen()

            async def stop(self):
                pass

        adapter = ClaudeAgentAdapter(name="t", query_timeout_seconds=0.05)
        monkeypatch.setattr("ag_ui_claude_sdk.adapter.SessionWorker", _HangingWorker)
        inp = make_input(thread_id="slow", run_id="r1",
                         messages=[{"id": "1", "role": "user", "content": "hi"}])
        events = await asyncio.wait_for(_drive(adapter, inp), timeout=5.0)
        types = _types(events)
        assert EventType.RUN_ERROR in types
        assert EventType.RUN_FINISHED not in types

        await adapter.shutdown()


class TestPerRunResult:
    # Fix 4 keys ``_per_run_result`` by ``(thread_id, run_id)`` rather than a
    # bare per-thread slot. Under run-admission serialization (Fix 1) same-thread
    # runs are sequential, so a bare per-thread slot would NOT actually bleed
    # across runs at RUN_FINISHED time — which means the two ordering-only tests
    # below (``..._reflects_own_result_message`` /
    # ``..._serialized_runs_each_get_own_result``) are DEFENSE-IN-DEPTH: they
    # would still pass against a thread-keyed implementation. The dedicated
    # ``test_result_dict_is_run_keyed_not_thread_keyed`` below is the LOAD-BEARING
    # guard: it inspects ``_per_run_result`` directly and fails if the result is
    # stored under a bare ``thread_id`` key instead of the ``(thread_id, run_id)``
    # tuple — i.e. it genuinely guards the keying that Fix 4 introduced.
    @pytest.mark.asyncio
    async def test_result_dict_is_run_keyed_not_thread_keyed(self, make_input, monkeypatch):
        # LOAD-BEARING keying guard. Pause run A mid-stream, AFTER its
        # ResultMessage has been recorded into ``_per_run_result`` but BEFORE A
        # emits RUN_FINISHED (and its ``finally`` drops the slot). Then assert the
        # live entry is keyed by the (thread_id, run_id) TUPLE — never by the bare
        # thread_id. A thread-keyed implementation (the regression Fix 4 guards
        # against) would fail this directly.
        from claude_agent_sdk import ResultMessage

        after_result_gate = asyncio.Event()  # release A's stream after ResultMessage

        class _PausingResultWorker:
            def __init__(self, *a, **kw):
                pass

            async def start(self):
                pass

            def is_alive(self):
                return True

            def query(self, prompt, session_id="default"):
                async def _gen():
                    yield stream_event({"type": "message_start"})
                    yield stream_event({
                        "type": "content_block_delta",
                        "delta": {"type": "text_delta", "text": "hi"},
                    })
                    yield stream_event({"type": "message_stop"})
                    yield ResultMessage(
                        subtype="success",
                        duration_ms=7,
                        duration_api_ms=1,
                        is_error=False,
                        num_turns=1,
                        session_id="sess",
                        total_cost_usd=0.0,
                        usage={},
                        result="hi",
                    )
                    # Suspend HERE: the adapter has recorded the result under this
                    # run's key, but has not yet exhausted the stream / emitted
                    # RUN_FINISHED / popped the slot.
                    await after_result_gate.wait()

                return _gen()

            async def stop(self):
                pass

        adapter = ClaudeAgentAdapter(name="t")
        monkeypatch.setattr("ag_ui_claude_sdk.adapter.SessionWorker", _PausingResultWorker)

        inp = make_input(thread_id="kt", run_id="RUNX",
                         messages=[{"id": "1", "role": "user", "content": "hi"}])

        events = []

        async def drive():
            async for e in adapter.run(inp):
                events.append(e)

        t = asyncio.create_task(drive())
        # Wait until A's ResultMessage has been recorded into _per_run_result.
        await _wait_for(lambda: adapter._per_run_result.get(("kt", "RUNX")) is not None)

        # LOAD-BEARING ASSERTIONS — these fail against a thread-keyed store.
        # 1. The entry exists under the (thread_id, run_id) tuple key.
        assert ("kt", "RUNX") in adapter._per_run_result
        assert adapter._per_run_result[("kt", "RUNX")]["duration_ms"] == 7
        # 2. Every live key is a (thread_id, run_id) tuple — never a bare string
        #    thread_id (which is what a thread-keyed regression would produce).
        for k in adapter._per_run_result:
            assert isinstance(k, tuple) and len(k) == 2, (
                f"_per_run_result key is not (thread_id, run_id): {k!r}"
            )
        assert "kt" not in adapter._per_run_result, (
            "result stored under bare thread_id — keying regressed to per-thread"
        )

        after_result_gate.set()
        await asyncio.wait_for(t, timeout=5.0)
        fin = next(e for e in events if e.type == EventType.RUN_FINISHED)
        assert fin.result["duration_ms"] == 7

        await adapter.shutdown()

    @pytest.mark.asyncio
    async def test_run_finished_result_reflects_own_result_message(self, make_input, monkeypatch):
        # Fix 4 (defense-in-depth, ordering): RUN_FINISHED.result reflects THIS
        # run's own ResultMessage. (Sequential under serialization, so this would
        # also pass thread-keyed; the load-bearing guard is
        # ``test_result_dict_is_run_keyed_not_thread_keyed``.)
        from claude_agent_sdk import ResultMessage

        class _ResultWorker:
            calls = 0

            def __init__(self, *a, **kw):
                pass

            async def start(self):
                pass

            def is_alive(self):
                return True

            def query(self, prompt, session_id="default"):
                idx = _ResultWorker.calls
                _ResultWorker.calls += 1

                async def _gen():
                    yield stream_event({"type": "message_start"})
                    yield stream_event({
                        "type": "content_block_delta",
                        "delta": {"type": "text_delta", "text": "hi"},
                    })
                    yield stream_event({"type": "message_stop"})
                    yield ResultMessage(
                        subtype="success",
                        duration_ms=idx,  # distinct per run
                        duration_api_ms=1,
                        is_error=False,
                        num_turns=idx + 1,
                        session_id="sess",
                        total_cost_usd=0.0,
                        usage={},
                        result="hi",
                    )

                return _gen()

            async def stop(self):
                pass

        adapter = ClaudeAgentAdapter(name="t")
        monkeypatch.setattr("ag_ui_claude_sdk.adapter.SessionWorker", _ResultWorker)

        inp1 = make_input(thread_id="shared", run_id="r1",
                          messages=[{"id": "1", "role": "user", "content": "hi"}])
        events1 = await _drive(adapter, inp1)
        fin1 = next(e for e in events1 if e.type == EventType.RUN_FINISHED)
        assert fin1.result is not None
        assert fin1.result["duration_ms"] == 0
        assert fin1.result["num_turns"] == 1

        inp2 = make_input(thread_id="shared", run_id="r2",
                          messages=[{"id": "2", "role": "user", "content": "yo"}])
        events2 = await _drive(adapter, inp2)
        fin2 = next(e for e in events2 if e.type == EventType.RUN_FINISHED)
        assert fin2.result is not None
        # Run 2 gets its OWN result, not run 1's.
        assert fin2.result["duration_ms"] == 1
        assert fin2.result["num_turns"] == 2

        await adapter.shutdown()

    @pytest.mark.asyncio
    async def test_two_serialized_runs_each_get_own_result(self, make_input, monkeypatch):
        # Two serialized same-thread runs each carry their own ResultMessage even
        # when launched overlapping (serialize keeps them ordered; result must
        # not bleed across).
        from claude_agent_sdk import ResultMessage

        class _SeqResultWorker:
            calls = 0

            def __init__(self, *a, **kw):
                pass

            async def start(self):
                pass

            def is_alive(self):
                return True

            def query(self, prompt, session_id="default"):
                idx = _SeqResultWorker.calls
                _SeqResultWorker.calls += 1

                async def _gen():
                    yield stream_event({"type": "message_start"})
                    yield stream_event({
                        "type": "content_block_delta",
                        "delta": {"type": "text_delta", "text": "x"},
                    })
                    yield stream_event({"type": "message_stop"})
                    yield ResultMessage(
                        subtype="success",
                        duration_ms=100 + idx,
                        duration_api_ms=1,
                        is_error=False,
                        num_turns=1,
                        session_id="sess",
                        total_cost_usd=0.0,
                        usage={},
                        result="x",
                    )

                return _gen()

            async def stop(self):
                pass

        adapter = ClaudeAgentAdapter(name="t")
        monkeypatch.setattr("ag_ui_claude_sdk.adapter.SessionWorker", _SeqResultWorker)

        inp_a = make_input(thread_id="shared", run_id="A",
                           messages=[{"id": "1", "role": "user", "content": "hi"}])
        inp_b = make_input(thread_id="shared", run_id="B",
                           messages=[{"id": "2", "role": "user", "content": "yo"}])

        t_a = asyncio.create_task(_drive(adapter, inp_a))
        t_b = asyncio.create_task(_drive(adapter, inp_b))
        events_a, events_b = await asyncio.gather(t_a, t_b)

        fin_a = next(e for e in events_a if e.type == EventType.RUN_FINISHED)
        fin_b = next(e for e in events_b if e.type == EventType.RUN_FINISHED)
        # Each run has a distinct, own result (the two calls produced 100 / 101).
        assert {fin_a.result["duration_ms"], fin_b.result["duration_ms"]} == {100, 101}

        await adapter.shutdown()


class TestSequentialStateReset:
    @pytest.mark.asyncio
    async def test_run2_fresh_state_replaces_run1(self, make_input, monkeypatch):
        # Regression guard: run 1 then run 2 (sequential) on the same thread,
        # where run 2 sends fresh input_data.state. Run 2's state must REPLACE
        # run 1's (documented reset). Serialize must not turn the per-run re-seed
        # into "inherit/ignore".
        class _NoopWorker:
            def __init__(self, *a, **kw):
                pass

            async def start(self):
                pass

            def is_alive(self):
                return True

            def query(self, prompt, session_id="default"):
                async def _gen():
                    for ev in _make_text_stream():
                        yield ev

                return _gen()

            async def stop(self):
                pass

        adapter = ClaudeAgentAdapter(name="t")
        monkeypatch.setattr("ag_ui_claude_sdk.adapter.SessionWorker", _NoopWorker)

        inp1 = make_input(thread_id="shared", run_id="r1", state={"count": 1},
                          messages=[{"id": "1", "role": "user", "content": "hi"}])
        await _drive(adapter, inp1)
        assert adapter._per_thread_state["shared"] == {"count": 1}

        inp2 = make_input(thread_id="shared", run_id="r2", state={"other": 99},
                          messages=[{"id": "2", "role": "user", "content": "yo"}])
        await _drive(adapter, inp2)
        # Fresh state from run 2 REPLACED run 1's (reset semantics preserved).
        assert adapter._per_thread_state["shared"] == {"other": 99}

        await adapter.shutdown()


class TestWorkerDeathFanout:
    @pytest.mark.asyncio
    async def test_waiting_consumer_gets_terminal_signal_on_worker_death(self):
        # Fix 3: SessionWorker must fan out WorkerError + None to ALL in-flight
        # output queues on fatal worker death, so a queued/peer consumer does not
        # hang. Drive the REAL SessionWorker with a scripted ClaudeSDKClient that
        # dies in connect() AFTER queries have been enqueued — the fatal-error
        # branch must terminate every registered consumer.
        import claude_agent_sdk
        from ag_ui_claude_sdk.session import SessionWorker

        connect_gate = asyncio.Event()

        class _DyingClient:
            def __init__(self, options=None, **kwargs):
                self.options = options

            async def connect(self):
                # Wait until consumers have enqueued their queries, THEN die.
                await connect_gate.wait()
                raise RuntimeError("client connect boom")

            async def query(self, prompt, session_id="default"):  # pragma: no cover
                pass

            async def receive_response(self):  # pragma: no cover
                if False:
                    yield None

            async def disconnect(self):
                pass

            async def interrupt(self):
                pass

        orig = claude_agent_sdk.ClaudeSDKClient
        claude_agent_sdk.ClaudeSDKClient = _DyingClient
        try:
            worker = SessionWorker("th", options=None)
            await worker.start()

            # Enqueue TWO queries while the worker is still blocked in connect().
            # Both register their output queues; on worker death BOTH must get a
            # terminal signal (without the fan-out, the second hangs forever).
            async def consume():
                got_error = False
                try:
                    async for _ in worker.query("p", session_id="th"):
                        pass
                except Exception:
                    got_error = True
                return got_error

            c1 = asyncio.create_task(consume())
            c2 = asyncio.create_task(consume())

            # Let both queries land on the input queue before the worker dies.
            await _wait_for(lambda: worker._input_queue.qsize() >= 2)
            connect_gate.set()

            # Both consumers must terminate (error or clean end) — neither hangs.
            results = await asyncio.wait_for(asyncio.gather(c1, c2), timeout=5.0)
            assert all(r is True for r in results), (
                "a waiting consumer did not receive a terminal error on worker death"
            )
        finally:
            claude_agent_sdk.ClaudeSDKClient = orig
            await worker.stop()

    @pytest.mark.asyncio
    async def test_in_flight_consumer_gets_terminal_error_on_worker_cancellation(self):
        # Fix 3 — cancellation path: ``_on_task_done`` has a branch for the worker task exiting
        # WITHOUT a fatal exception — e.g. cancelled / terminated mid-flight while
        # a query is still being serviced. That branch must fan out a terminal
        # RuntimeError("...terminated while a query was still in flight") + the
        # None sentinel to every in-flight output queue, so the waiting consumer
        # gets a raised error rather than hanging forever. (The existing
        # ``..._on_worker_death`` test only covers the FATAL connect()-raises
        # path; this covers the cancelled/no-exception path.)
        import claude_agent_sdk
        from ag_ui_claude_sdk.session import SessionWorker

        in_connect = asyncio.Event()     # set once connect() is entered
        block_forever = asyncio.Event()  # never set: keeps connect() pending

        class _BlockingConnectClient:
            def __init__(self, options=None, **kwargs):
                self.options = options

            async def connect(self):
                # Block in connect so the enqueued query is registered as
                # in-flight but NEVER dequeued/serviced. Cancelling the worker
                # here raises CancelledError (a BaseException, NOT caught by the
                # fatal ``except Exception`` branch), so ``_run`` exits WITHOUT a
                # fatal exception while the query's output queue is still
                # registered — exactly the no-exception path of _on_task_done.
                in_connect.set()
                await block_forever.wait()

            async def query(self, prompt, session_id="default"):  # pragma: no cover
                pass

            async def receive_response(self):  # pragma: no cover
                if False:
                    yield None

            async def disconnect(self):
                pass

            async def interrupt(self):
                pass

        orig = claude_agent_sdk.ClaudeSDKClient
        claude_agent_sdk.ClaudeSDKClient = _BlockingConnectClient
        worker = SessionWorker("th", options=None)
        try:
            await worker.start()

            terminal_error = {"exc": None}

            async def consume():
                try:
                    async for _ in worker.query("p", session_id="th"):
                        pass
                except Exception as e:  # noqa: BLE001 — capture the terminal error
                    terminal_error["exc"] = e

            c = asyncio.create_task(consume())

            # The query is enqueued + its output queue registered as in-flight,
            # while the worker is blocked in connect() (query never dequeued).
            await _wait_for(
                lambda: in_connect.is_set() and len(worker._inflight_queues) == 1
            )

            # Cancel the worker task while it sits in connect(). CancelledError is
            # a BaseException, so ``_run``'s ``except Exception`` fatal fan-out is
            # NOT taken; the task ends with no fatal exception while the consumer's
            # queue is still registered. The done-callback's no-exception branch
            # must terminate that consumer.
            worker._task.cancel()

            # The consumer must terminate with a raised terminal error — not hang.
            await asyncio.wait_for(c, timeout=5.0)
            assert terminal_error["exc"] is not None, (
                "in-flight consumer hung instead of receiving a terminal error "
                "on worker cancellation"
            )
            assert "terminated while a query was still in flight" in str(
                terminal_error["exc"]
            ), f"unexpected terminal error: {terminal_error['exc']!r}"
        finally:
            claude_agent_sdk.ClaudeSDKClient = orig
            block_forever.set()
            # The worker task was cancelled above; awaiting it via stop() would
            # re-raise CancelledError. Just await the already-cancelled task,
            # suppressing the cancellation, to clean up without masking the test.
            from contextlib import suppress
            if worker._task is not None:
                with suppress(asyncio.CancelledError):
                    await worker._task
