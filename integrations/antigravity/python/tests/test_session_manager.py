"""SessionManager tests: hot resume, cold resume, eviction, limits."""

import asyncio

import pytest

from ag_ui_antigravity.session_manager import (
    SessionLimitExceeded,
    SessionManager,
    tool_signature,
)
from ag_ui_antigravity.ui_bridge import UIBridge


class FakeAgent:
    """Stands in for google.antigravity.Agent's async context lifecycle."""

    instances = []

    def __init__(self, conversation_id=None):
        self.conversation_id = conversation_id or f"conv-{len(FakeAgent.instances)}"
        self.resumed_from = conversation_id
        self.entered = False
        self.exited = False
        FakeAgent.instances.append(self)

    async def __aenter__(self):
        self.entered = True
        return self

    async def __aexit__(self, *exc):
        self.exited = True
        return False


@pytest.fixture(autouse=True)
def reset_agents():
    FakeAgent.instances = []
    yield
    FakeAgent.instances = []


def factory(bridge: UIBridge, previous_conversation_id):
    return FakeAgent(previous_conversation_id)


class TestResetStream:
    async def test_reset_retires_the_iterator_translator_and_turn_cache(self):
        manager = SessionManager()
        session = await manager.get_or_create(
            "t1", signature=tool_signature([]), factory=factory
        )
        closed = []

        class FakeIterator:
            async def aclose(self):
                closed.append(True)

        session.step_iter = FakeIterator()
        session.pending_step = asyncio.get_running_loop().create_future()
        session.translator = object()
        session.bridge._turn_results["set_theme"] = ({}, _settled("applied"))

        await session.reset_stream()
        assert session.step_iter is None
        assert session.pending_step is None
        assert session.translator is None
        assert session.bridge._turn_results == {}
        assert closed == [True]

    async def test_an_iterator_that_refuses_to_close_is_still_dropped(self):
        manager = SessionManager()
        session = await manager.get_or_create(
            "t1", signature=tool_signature([]), factory=factory
        )

        class AngryIterator:
            async def aclose(self):
                raise RuntimeError("harness went away")

        session.step_iter = AngryIterator()
        await session.reset_stream()
        assert session.step_iter is None

    async def test_reset_on_a_session_with_no_iterator_is_a_no_op(self):
        manager = SessionManager()
        session = await manager.get_or_create(
            "t1", signature=tool_signature([]), factory=factory
        )
        await session.reset_stream()
        assert session.step_iter is None


class TestReuse:
    async def test_same_thread_and_tools_reuses_the_live_session(self):
        manager = SessionManager()
        sig = tool_signature(["a"])
        first = await manager.get_or_create("t1", signature=sig, factory=factory)
        second = await manager.get_or_create("t1", signature=sig, factory=factory)
        assert first is second
        assert len(FakeAgent.instances) == 1

    async def test_distinct_threads_get_distinct_sessions(self):
        manager = SessionManager()
        sig = tool_signature([])
        a = await manager.get_or_create("t1", signature=sig, factory=factory)
        b = await manager.get_or_create("t2", signature=sig, factory=factory)
        assert a is not b

    async def test_tool_signature_is_order_insensitive(self):
        assert tool_signature(["a", "b"]) == tool_signature(["b", "a"])


class TestColdResume:
    async def test_changed_tools_rebuild_and_carry_the_conversation_id(self):
        manager = SessionManager()
        first = await manager.get_or_create(
            "t1", signature=tool_signature(["a"]), factory=factory
        )
        original_id = first.conversation_id

        second = await manager.get_or_create(
            "t1", signature=tool_signature(["a", "b"]), factory=factory
        )
        assert second is not first
        assert first.agent.exited is True
        # The replacement cold-resumes the same Antigravity conversation.
        assert second.agent.resumed_from == original_id


class TestHotResume:
    async def test_parked_session_survives_a_tool_change(self):
        """A suspended coroutine cannot be serialized, so never rebuild it."""
        manager = SessionManager()
        session = await manager.get_or_create(
            "t1", signature=tool_signature(["a"]), factory=factory
        )
        parked = await _park(session.bridge)

        same = await manager.get_or_create(
            "t1", signature=tool_signature(["different"]), factory=factory
        )
        assert same is session
        assert session.agent.exited is False
        parked.cancel()

    async def test_parked_session_is_never_swept(self):
        manager = SessionManager(session_timeout_seconds=0)
        session = await manager.get_or_create(
            "t1", signature=tool_signature([]), factory=factory
        )
        parked = await _park(session.bridge)
        await asyncio.sleep(0.01)

        assert await manager.sweep() == 0
        assert manager.get("t1") is session
        parked.cancel()

    async def test_idle_session_is_swept(self):
        manager = SessionManager(session_timeout_seconds=0)
        await manager.get_or_create("t1", signature=tool_signature([]), factory=factory)
        await asyncio.sleep(0.01)

        assert await manager.sweep() == 1
        assert manager.get("t1") is None
        assert FakeAgent.instances[0].exited is True


class TestLimits:
    async def test_limit_is_enforced_when_nothing_can_be_evicted(self):
        manager = SessionManager(max_sessions=1, session_timeout_seconds=9999)
        await manager.get_or_create("t1", signature=tool_signature([]), factory=factory)
        with pytest.raises(SessionLimitExceeded):
            await manager.get_or_create(
                "t2", signature=tool_signature([]), factory=factory
            )

    async def test_idle_session_is_evicted_to_make_room(self):
        manager = SessionManager(max_sessions=1, session_timeout_seconds=0)
        await manager.get_or_create("t1", signature=tool_signature([]), factory=factory)
        await asyncio.sleep(0.01)
        session = await manager.get_or_create(
            "t2", signature=tool_signature([]), factory=factory
        )
        assert session.thread_id == "t2"


class TestCleanupLoop:
    async def test_the_background_loop_sweeps_idle_sessions(self):
        manager = SessionManager(
            session_timeout_seconds=0, cleanup_interval_seconds=0.01
        )
        manager.start()
        await manager.get_or_create("t1", signature=tool_signature([]), factory=factory)

        for _ in range(100):
            await asyncio.sleep(0.01)
            if manager.get("t1") is None:
                break
        assert manager.get("t1") is None
        await manager.stop()

    async def test_start_is_idempotent(self):
        manager = SessionManager()
        manager.start()
        task = manager._cleanup_task
        manager.start()
        assert manager._cleanup_task is task
        await manager.stop()

    async def test_stop_without_start_is_a_no_op(self):
        manager = SessionManager()
        await manager.stop()
        assert manager.stats()["live_sessions"] == 0

    async def test_a_failing_sweep_does_not_kill_the_loop(self):
        """A dead sweeper would leak every session for the process' lifetime."""
        manager = SessionManager(cleanup_interval_seconds=0.01)
        calls = []

        async def flaky():
            calls.append(1)
            if len(calls) == 1:
                raise RuntimeError("transient")
            return 0

        manager.sweep = flaky
        manager.start()
        for _ in range(100):
            await asyncio.sleep(0.01)
            if len(calls) >= 3:
                break
        await manager.stop()
        assert len(calls) >= 3, calls


class TestTeardown:
    async def test_closing_an_unknown_thread_is_a_no_op(self):
        manager = SessionManager()
        await manager.close("never-existed")
        assert manager.stats()["live_sessions"] == 0

    async def test_a_rebuild_without_a_conversation_id_does_not_cold_resume(self):
        manager = SessionManager()

        def no_id_factory(bridge, previous_conversation_id):
            agent = FakeAgent(previous_conversation_id)
            agent.conversation_id = None
            return agent

        await manager.get_or_create(
            "t1", signature=tool_signature(["a"]), factory=no_id_factory
        )
        second = await manager.get_or_create(
            "t1", signature=tool_signature(["b"]), factory=no_id_factory
        )
        assert second.agent.resumed_from is None

    async def test_a_failing_agent_shutdown_does_not_abort_the_close(self):
        manager = SessionManager()

        def angry_factory(bridge, previous_conversation_id):
            agent = FakeAgent(previous_conversation_id)

            async def boom(*exc):
                raise RuntimeError("harness refused to stop")

            agent.__aexit__ = boom
            return agent

        await manager.get_or_create(
            "t1", signature=tool_signature([]), factory=angry_factory
        )
        await manager.close("t1")
        assert manager.get("t1") is None

    async def test_stats_report_parked_sessions_separately(self):
        manager = SessionManager(max_sessions=7, session_timeout_seconds=42)
        session = await manager.get_or_create(
            "t1", signature=tool_signature([]), factory=factory
        )
        await manager.get_or_create("t2", signature=tool_signature([]), factory=factory)
        parked = await _park(session.bridge)

        assert manager.stats() == {
            "live_sessions": 2,
            "parked_sessions": 1,
            "max_sessions": 7,
            "session_timeout_seconds": 42,
            "parked_timeout_seconds": 7200,
        }
        parked.cancel()

    async def test_close_fails_parked_requests(self):
        manager = SessionManager()
        session = await manager.get_or_create(
            "t1", signature=tool_signature([]), factory=factory
        )
        parked = await _park(session.bridge)
        await manager.close("t1")
        with pytest.raises(RuntimeError):
            await asyncio.wait_for(parked, 1)

    async def test_stop_closes_everything(self):
        manager = SessionManager()
        manager.start()
        await manager.get_or_create("t1", signature=tool_signature([]), factory=factory)
        await manager.get_or_create("t2", signature=tool_signature([]), factory=factory)
        await manager.stop()
        assert manager.stats()["live_sessions"] == 0
        assert all(a.exited for a in FakeAgent.instances)


async def _park(bridge: UIBridge) -> asyncio.Task:
    """Parks a frontend tool on ``bridge`` and returns its still-pending task."""
    from ag_ui.core import Tool as AGUITool

    (tool,) = bridge.build_frontend_tools(
        [AGUITool(name="x", description="", parameters={"type": "object"})]
    )
    task = asyncio.create_task(tool())
    await asyncio.sleep(0.05)
    assert bridge.has_pending, "fixture failed to park"
    return task


def _settled(value):
    """A claim future already carrying its result (see UIBridge._turn_results)."""
    future = asyncio.get_event_loop().create_future()
    future.set_result(value)
    return future


class TestParkedGrace:
    """A parked session is pinned so its suspended coroutine survives a human
    thinking -- not a human who closed the tab and never came back."""

    async def test_a_parked_session_survives_the_normal_idle_timeout(self):
        manager = SessionManager(session_timeout_seconds=0, parked_timeout_seconds=9999)
        session = await manager.get_or_create(
            "t1", signature=tool_signature([]), factory=factory
        )
        parked = await _park(session.bridge)
        await asyncio.sleep(0.01)

        assert await manager.sweep() == 0
        assert manager.get("t1") is session
        parked.cancel()

    async def test_a_parked_session_is_reclaimed_after_its_own_grace(self):
        manager = SessionManager(session_timeout_seconds=0, parked_timeout_seconds=0)
        session = await manager.get_or_create(
            "t1", signature=tool_signature([]), factory=factory
        )
        parked = await _park(session.bridge)
        await asyncio.sleep(0.01)

        assert await manager.sweep() == 1
        assert manager.get("t1") is None
        with pytest.raises(RuntimeError):
            await asyncio.wait_for(parked, 1)

    async def test_the_limit_can_be_recovered_from_by_the_parked_grace(self):
        """Otherwise max_sessions abandoned HITL tabs wedge the server forever."""
        manager = SessionManager(
            max_sessions=1, session_timeout_seconds=0, parked_timeout_seconds=0
        )
        first = await manager.get_or_create(
            "t1", signature=tool_signature([]), factory=factory
        )
        parked = await _park(first.bridge)
        await asyncio.sleep(0.01)

        second = await manager.get_or_create(
            "t2", signature=tool_signature([]), factory=factory
        )
        assert second.thread_id == "t2"
        with pytest.raises(RuntimeError):
            await asyncio.wait_for(parked, 1)


class TestSweepSafety:
    """The sweeper runs concurrently with live runs. Reclaiming a session whose
    run holds the lock cancels the future that run is awaiting, and
    CancelledError is a BaseException -- it escapes every `except Exception`
    between the run loop and the SSE writer, so the client gets no terminal
    event at all."""

    async def test_a_session_with_a_run_in_flight_is_never_reclaimed(self):
        manager = SessionManager(session_timeout_seconds=0)
        session = await manager.get_or_create(
            "t1", signature=tool_signature([]), factory=factory
        )
        await asyncio.sleep(0.01)

        async with session.lock:
            assert await manager.sweep() == 0
            assert manager.get("t1") is session

        # Once the run releases the lock it becomes reclaimable again.
        assert await manager.sweep() == 1

    async def test_the_limit_sweep_also_spares_in_flight_sessions(self):
        manager = SessionManager(max_sessions=1, session_timeout_seconds=0)
        busy = await manager.get_or_create(
            "t1", signature=tool_signature([]), factory=factory
        )
        await asyncio.sleep(0.01)

        async with busy.lock:
            with pytest.raises(SessionLimitExceeded):
                await manager.get_or_create(
                    "t2", signature=tool_signature([]), factory=factory
                )
        assert manager.get("t1") is busy


class TestParkedGraceFloor:
    async def test_parked_grace_is_never_shorter_than_the_idle_timeout(self):
        """Otherwise a long idle timeout would cut parked sessions off early."""
        manager = SessionManager(
            session_timeout_seconds=10_000, parked_timeout_seconds=1
        )
        session = await manager.get_or_create(
            "t1", signature=tool_signature([]), factory=factory
        )
        parked = await _park(session.bridge)
        session.last_activity -= 5_000

        assert await manager.sweep() == 0
        assert manager.get("t1") is session
        parked.cancel()


class TestRebuildSafety:
    """The tool-signature rebuild is a third route into `_close_locked`, and it
    does not go through `_expired`. Tearing down a session whose run is
    streaming cancels the future that run awaits; CancelledError is a
    BaseException and escapes to the SSE writer, so the client gets no terminal
    event at all."""

    async def test_a_tool_change_defers_while_a_run_is_in_flight(self):
        manager = SessionManager()
        session = await manager.get_or_create(
            "t1", signature=tool_signature(["a"]), factory=factory
        )

        async with session.lock:
            same = await manager.get_or_create(
                "t1", signature=tool_signature(["a", "b"]), factory=factory
            )
        assert same is session, "the in-flight run must not be torn down"
        assert session.agent.exited is False

        # Once the run finishes, the next one rebuilds as normal.
        rebuilt = await manager.get_or_create(
            "t1", signature=tool_signature(["a", "b"]), factory=factory
        )
        assert rebuilt is not session
        assert session.agent.exited is True

    async def test_a_cold_resume_carries_the_forwarded_prompts(self):
        """The rebuilt harness restores the same conversation, so those
        prompts are already in its history and must not be re-sent."""
        manager = SessionManager()
        first = await manager.get_or_create(
            "t1", signature=tool_signature(["a"]), factory=factory
        )
        first.forwarded_prompts.update({"m1", "m2"})

        second = await manager.get_or_create(
            "t1", signature=tool_signature(["a", "b"]), factory=factory
        )
        assert second is not first
        assert second.forwarded_prompts == {"m1", "m2"}


class TestReclaimNeverKillsALiveRun:
    """Every reclamation route must refuse a session whose run holds the lock.

    `sweep()` picks its victims and then awaits between closes, so a candidate
    can go live in that window -- the check has to be re-made under the manager
    lock at close time, not only when the list is built."""

    async def test_sweep_re_checks_under_the_lock(self):
        manager = SessionManager(session_timeout_seconds=0)
        session = await manager.get_or_create(
            "t1", signature=tool_signature([]), factory=factory
        )
        await asyncio.sleep(0.01)

        async with session.lock:
            assert await manager.sweep() == 0
            assert manager.get("t1") is session
            assert session.agent.exited is False

    async def test_close_refuses_a_live_run_when_not_forced(self):
        manager = SessionManager()
        session = await manager.get_or_create(
            "t1", signature=tool_signature([]), factory=factory
        )
        async with session.lock:
            await manager.close("t1", force=False)
            assert manager.get("t1") is session

    async def test_shutdown_forces_teardown_so_nothing_leaks(self):
        """stop() must not leave a Go subprocess behind, even mid-run."""
        manager = SessionManager()
        session = await manager.get_or_create(
            "t1", signature=tool_signature([]), factory=factory
        )
        async with session.lock:
            await manager.stop()
        assert manager.stats()["live_sessions"] == 0
        assert session.agent.exited is True
