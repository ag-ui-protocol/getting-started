# tests/test_multi_instance_hitl.py

"""
Multi-instance ADK deployment HITL test.

Simulates two ADKAgent instances (pods) sharing a common session store
(InMemorySessionService acting as a shared database). Verifies that when
Instance A creates a session with pending HITL tool calls, Instance B
(with a cold cache) can discover and process them correctly.
"""

import asyncio

import pytest
from unittest.mock import patch

from ag_ui.core import (
    RunAgentInput, UserMessage, AssistantMessage, ToolMessage,
    ToolCall, FunctionCall, Tool as AGUITool,
    ToolCallStartEvent, ToolCallArgsEvent, ToolCallEndEvent,
    ToolCallResultEvent,
    EventType, RunErrorEvent,
)
from google.adk.agents import LlmAgent
from google.adk.sessions import InMemorySessionService

from ag_ui_adk import ADKAgent
from ag_ui_adk.session_manager import SessionManager
from tests.constants import LIVE_TEST_MODEL


class TestMultiInstanceHITL:
    """Test HITL tool flow across simulated multi-instance deployment."""

    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        """Reset the SessionManager singleton between tests."""
        SessionManager.reset_instance()
        yield
        SessionManager.reset_instance()

    @pytest.fixture
    def shared_session_service(self):
        """Shared InMemorySessionService acting as the database."""
        return InMemorySessionService()

    @pytest.fixture
    def sample_tool(self):
        return AGUITool(
            name="approve_plan",
            description="Approval tool",
            parameters={
                "type": "object",
                "properties": {"approved": {"type": "boolean"}},
            },
        )

    @pytest.fixture
    def instance_a(self, shared_session_service):
        """First ADKAgent instance (Pod A). Initializes the SessionManager singleton."""
        agent = LlmAgent(name="test_agent", model=LIVE_TEST_MODEL, instruction="Test")
        return ADKAgent(
            adk_agent=agent,
            app_name="test_app",
            user_id="test_user",
            session_service=shared_session_service,
        )

    @pytest.fixture
    def instance_b(self, shared_session_service, instance_a):
        """Second ADKAgent instance (Pod B). Depends on instance_a for singleton order."""
        agent = LlmAgent(name="test_agent", model=LIVE_TEST_MODEL, instruction="Test")
        return ADKAgent(
            adk_agent=agent,
            app_name="test_app",
            user_id="test_user",
            session_service=shared_session_service,
        )

    @pytest.mark.asyncio
    async def test_cross_instance_hitl_tool_result_flow(
        self, instance_a, instance_b, sample_tool,
    ):
        """End-to-end: A emits tool call, B (cold cache) processes tool result."""
        thread_id = "multi_pod_thread"
        tool_call_id = "tool_call_abc123"

        # --- Phase 1: Instance A creates session and pending tool call ---

        # Pre-create the session so the cache is populated before the mock
        # replaces _run_adk_in_background (which normally calls _ensure_session_exists).
        await instance_a._ensure_session_exists(
            app_name="test_app", user_id="test_user",
            thread_id=thread_id, initial_state={},
        )

        input_a = RunAgentInput(
            thread_id=thread_id,
            run_id="run_1",
            messages=[UserMessage(id="msg_1", role="user", content="Plan something")],
            tools=[sample_tool],
            context=[],
            state={},
            forwarded_props={},
        )

        async def mock_run_a(*args, **kwargs):
            eq = kwargs["event_queue"]
            # Real producers register HITL tool call IDs in the shared
            # long_running_tool_ids set BEFORE enqueuing TOOL_CALL_END so
            # the deferring queue can identify the HITL end at put time
            # (issues #1652, #1755).
            kwargs["long_running_tool_ids"].add(tool_call_id)
            await eq.put(ToolCallStartEvent(
                type=EventType.TOOL_CALL_START,
                tool_call_id=tool_call_id,
                tool_call_name="approve_plan",
            ))
            await eq.put(ToolCallArgsEvent(
                type=EventType.TOOL_CALL_ARGS,
                tool_call_id=tool_call_id,
                delta="{}",
            ))
            await eq.put(ToolCallEndEvent(
                type=EventType.TOOL_CALL_END,
                tool_call_id=tool_call_id,
            ))
            # Simulate the real producer's pre-None persistence step
            # (#1755 moved this work from the consumer to the producer).
            for hitl_id in list(getattr(eq, "deferred_hitl_ids", [])):
                await instance_a._add_pending_tool_call_with_context(
                    thread_id, hitl_id, "test_app", "test_user"
                )
            await eq.put(None)

        with patch.object(instance_a, "_run_adk_in_background", side_effect=mock_run_a):
            async for _ in instance_a.run(input_a):
                pass

        # Verify A stored pending tool call and B's cache is cold
        assert await instance_a._has_pending_tool_calls(thread_id, "test_user")
        assert (thread_id, "test_user") not in instance_b._session_lookup_cache

        # --- Phase 2: Instance B receives tool result ---
        input_b = RunAgentInput(
            thread_id=thread_id,
            run_id="run_2",
            messages=[
                UserMessage(id="msg_1", role="user", content="Plan something"),
                AssistantMessage(
                    id="msg_tc",
                    role="assistant",
                    content=None,
                    tool_calls=[ToolCall(
                        id=tool_call_id,
                        function=FunctionCall(name="approve_plan", arguments="{}"),
                    )],
                ),
                ToolMessage(
                    id="msg_tr",
                    role="tool",
                    content='{"approved": true}',
                    tool_call_id=tool_call_id,
                ),
            ],
            tools=[sample_tool],
            context=[],
            state={},
            forwarded_props={},
        )

        captured_kwargs = {}

        async def mock_run_b(*args, **kwargs):
            captured_kwargs.update(kwargs)
            eq = kwargs["event_queue"]
            await eq.put(None)

        with patch.object(instance_b, "_run_adk_in_background", side_effect=mock_run_b):
            events_b = []
            async for event in instance_b.run(input_b):
                events_b.append(event)

        # --- Assertions ---
        # B hydrated its cache
        assert (thread_id, "test_user") in instance_b._session_lookup_cache

        # B took the HITL path (tool_results passed to _run_adk_in_background)
        assert "tool_results" in captured_kwargs, \
            "Instance B should route through HITL path"
        tool_results = captured_kwargs["tool_results"]
        assert len(tool_results) >= 1
        submitted_ids = [tr["message"].tool_call_id for tr in tool_results]
        assert tool_call_id in submitted_ids

        # No errors
        assert not any(isinstance(e, RunErrorEvent) for e in events_b)

        # Pending calls cleared after processing
        assert not await instance_b._has_pending_tool_calls(thread_id, "test_user")

    @pytest.mark.asyncio
    async def test_cache_hydration_discovers_other_instances_session(
        self, instance_a, instance_b,
    ):
        """Instance B discovers Instance A's session via DB hydration."""
        thread_id = "hydration_thread"

        # Pre-create session so A's cache is populated
        await instance_a._ensure_session_exists(
            app_name="test_app", user_id="test_user",
            thread_id=thread_id, initial_state={},
        )

        input_a = RunAgentInput(
            thread_id=thread_id,
            run_id="run_1",
            messages=[UserMessage(id="msg_1", role="user", content="Hello")],
            tools=[],
            context=[],
            state={},
            forwarded_props={},
        )

        async def mock_run(*args, **kwargs):
            eq = kwargs["event_queue"]
            await eq.put(None)

        with patch.object(instance_a, "_run_adk_in_background", side_effect=mock_run):
            async for _ in instance_a.run(input_a):
                pass

        cached_a = instance_a._session_lookup_cache.get((thread_id, "test_user"))
        assert cached_a is not None
        session_id_a = cached_a[0]

        # B's cache is cold
        assert (thread_id, "test_user") not in instance_b._session_lookup_cache

        # B runs on the same thread
        input_b = RunAgentInput(
            thread_id=thread_id,
            run_id="run_2",
            messages=[
                UserMessage(id="msg_1", role="user", content="Hello"),
                UserMessage(id="msg_2", role="user", content="Follow-up"),
            ],
            tools=[],
            context=[],
            state={},
            forwarded_props={},
        )

        with patch.object(instance_b, "_run_adk_in_background", side_effect=mock_run):
            async for _ in instance_b.run(input_b):
                pass

        # B found the same session
        cached_b = instance_b._session_lookup_cache.get((thread_id, "test_user"))
        assert cached_b is not None
        assert cached_b[0] == session_id_a, "Instance B should find Instance A's session"

    @pytest.mark.asyncio
    async def test_pending_tool_call_registered_before_tool_call_end_event_yielded(
        self, instance_a, sample_tool,
    ):
        """Regression test for #1581.

        The pending tool call ID must be persisted to the shared session store
        the moment a `ToolCallEndEvent` is delivered to the consumer. Otherwise
        a continuation request routed to another pod will see an empty
        pending_tool_calls list and silently drop the tool result.

        We verify via ``instance_a._has_pending_tool_calls`` (warm cache),
        which reads through to the shared session service — proving the write
        has reached the backing store before the event reached the consumer.
        """
        thread_id = "race_condition_thread"
        tool_call_id = "tool_call_race_xyz"

        await instance_a._ensure_session_exists(
            app_name="test_app", user_id="test_user",
            thread_id=thread_id, initial_state={},
        )

        input_a = RunAgentInput(
            thread_id=thread_id,
            run_id="run_race",
            messages=[UserMessage(id="msg_1", role="user", content="Plan something")],
            tools=[sample_tool],
            context=[],
            state={},
            forwarded_props={},
        )

        async def mock_run_a(*args, **kwargs):
            eq = kwargs["event_queue"]
            # See note in test_cross_instance_hitl_tool_result_flow above.
            kwargs["long_running_tool_ids"].add(tool_call_id)
            await eq.put(ToolCallStartEvent(
                type=EventType.TOOL_CALL_START,
                tool_call_id=tool_call_id,
                tool_call_name="approve_plan",
            ))
            await eq.put(ToolCallArgsEvent(
                type=EventType.TOOL_CALL_ARGS,
                tool_call_id=tool_call_id,
                delta="{}",
            ))
            await eq.put(ToolCallEndEvent(
                type=EventType.TOOL_CALL_END,
                tool_call_id=tool_call_id,
            ))
            # Simulate the real producer's pre-None persistence step.
            # The _HitlDeferringQueue holds the TCE until the producer
            # persists pending_tool_calls; ``put(None)`` then triggers
            # an implicit flush of buffered TCEs. See issue #1755.
            for hitl_id in list(getattr(eq, "deferred_hitl_ids", [])):
                await instance_a._add_pending_tool_call_with_context(
                    thread_id, hitl_id, "test_app", "test_user"
                )
            await eq.put(None)

        observed_end = False
        with patch.object(instance_a, "_run_adk_in_background", side_effect=mock_run_a):
            async for event in instance_a.run(input_a):
                if isinstance(event, ToolCallEndEvent):
                    observed_end = True
                    assert await instance_a._has_pending_tool_calls(
                        thread_id, "test_user"
                    ), (
                        "pending_tool_calls must be persisted before "
                        "ToolCallEndEvent is yielded (issue #1581)"
                    )

        assert observed_end, "Test setup error: never observed ToolCallEndEvent"

    @pytest.mark.asyncio
    async def test_pending_tool_call_waits_for_runner_before_tool_call_end_event(
        self, instance_a, sample_tool,
    ):
        """Regression test for #1732 and #1755.

        DatabaseSessionService in ADK 1.27+ rejects mid-run session writes.
        With the producer-side persistence design from #1755, the producer
        buffers the HITL TCE in ``_HitlDeferringQueue`` and persists the id
        only AFTER ``runner.run_async`` exits. The TCE is then flushed onto
        the queue before the completion sentinel, so the client sees the
        event with persistence already complete.
        """
        thread_id = "stale_session_thread"
        tool_call_id = "tool_call_stale_session"

        await instance_a._ensure_session_exists(
            app_name="test_app",
            user_id="test_user",
            thread_id=thread_id,
            initial_state={},
        )

        input_a = RunAgentInput(
            thread_id=thread_id,
            run_id="run_stale_session",
            messages=[UserMessage(id="msg_1", role="user", content="Plan something")],
            tools=[sample_tool],
            context=[],
            state={},
            forwarded_props={},
        )

        runner_can_finish = asyncio.Event()
        pending_persisted = asyncio.Event()
        tool_call_end_seen = asyncio.Event()
        producer_finished = False

        async def mock_run_a(*args, **kwargs):
            nonlocal producer_finished
            eq = kwargs["event_queue"]
            kwargs["long_running_tool_ids"].add(tool_call_id)
            await eq.put(ToolCallEndEvent(
                type=EventType.TOOL_CALL_END,
                tool_call_id=tool_call_id,
            ))
            await runner_can_finish.wait()
            producer_finished = True
            # Simulate the real producer's pre-None persistence step.
            # _HitlDeferringQueue buffered the TCE above; the real
            # producer iterates ``deferred_hitl_ids`` and persists each
            # before ``put(None)`` flushes the buffered events. See #1755.
            for hitl_id in list(getattr(eq, "deferred_hitl_ids", [])):
                await instance_a._add_pending_tool_call_with_context(
                    thread_id, hitl_id, "test_app", "test_user"
                )
            await eq.put(None)

        async def mock_add_pending(thread_id_arg, tool_call_id_arg, app_name, user_id):
            assert thread_id_arg == thread_id
            assert tool_call_id_arg == tool_call_id
            assert producer_finished, (
                "pending_tool_calls should not be persisted until the ADK runner "
                "has finished its in-flight session append"
            )
            pending_persisted.set()

        async def collect_events():
            events = []
            async for event in instance_a.run(input_a):
                events.append(event)
                if isinstance(event, ToolCallEndEvent):
                    tool_call_end_seen.set()
            return events

        with patch.object(instance_a, "_run_adk_in_background", side_effect=mock_run_a), \
             patch.object(
                 instance_a,
                 "_add_pending_tool_call_with_context",
                 side_effect=mock_add_pending,
             ):
            collector = asyncio.create_task(collect_events())
            await asyncio.sleep(0.05)

            assert not pending_persisted.is_set()
            assert not tool_call_end_seen.is_set()

            runner_can_finish.set()
            events = await asyncio.wait_for(collector, timeout=3)

        assert pending_persisted.is_set()
        assert any(isinstance(event, ToolCallEndEvent) for event in events)

    @pytest.mark.asyncio
    async def test_non_hitl_events_stream_live_after_hitl_tce(
        self, instance_a, sample_tool,
    ):
        """Streaming-fidelity regression test for issue #1755.

        PR #1735 fixed #1732 by gating the consumer until the producer
        finishes, but that buffered EVERY event after the first HITL
        ``ToolCallEndEvent`` in ``event_queue`` until ``runner.run_async``
        exited. For resumable HITL with parallel tool calls or post-LRO
        text, that turned a smooth stream into a burst at the end.

        The #1755 fix defers ONLY the HITL TCE (in
        ``_HitlDeferringQueue``); non-HITL events stream through the
        underlying queue unblocked. This test asserts: a non-HITL event
        enqueued AFTER a HITL TCE reaches the client BEFORE the producer
        finishes. With PR #1735's gate in place (and without the #1755
        wrapper), this would time out.
        """
        thread_id = "streaming_thread"
        hitl_tool_call_id = "hitl_tcid"
        non_hitl_tool_call_id = "non_hitl_tcid"

        await instance_a._ensure_session_exists(
            app_name="test_app", user_id="test_user",
            thread_id=thread_id, initial_state={},
        )

        input_a = RunAgentInput(
            thread_id=thread_id,
            run_id="run_streaming",
            messages=[UserMessage(id="msg_1", role="user", content="Do stuff")],
            tools=[sample_tool],
            context=[],
            state={},
            forwarded_props={},
        )

        producer_should_finish = asyncio.Event()
        non_hitl_event_observed = asyncio.Event()

        async def mock_run(*args, **kwargs):
            eq = kwargs["event_queue"]
            kwargs["long_running_tool_ids"].add(hitl_tool_call_id)
            # HITL TCE — deferred by the wrapper.
            await eq.put(ToolCallEndEvent(
                type=EventType.TOOL_CALL_END,
                tool_call_id=hitl_tool_call_id,
            ))
            # Non-HITL event emitted AFTER the HITL TCE — must flow
            # through the underlying queue immediately so the consumer
            # can yield it to the client without waiting for the
            # producer to exit.
            await eq.put(ToolCallStartEvent(
                type=EventType.TOOL_CALL_START,
                tool_call_id=non_hitl_tool_call_id,
                tool_call_name="non_hitl_tool",
            ))
            # Hold the producer open until the test confirms the
            # non-HITL event reached the client.
            await producer_should_finish.wait()
            # Simulate the real producer's pre-None persistence step
            # (#1755 moves this from the consumer to the producer).
            for hitl_id in list(getattr(eq, "deferred_hitl_ids", [])):
                await instance_a._add_pending_tool_call_with_context(
                    thread_id, hitl_id, "test_app", "test_user"
                )
            await eq.put(None)

        received_events: list = []

        async def collect():
            async for event in instance_a.run(input_a):
                received_events.append(event)
                if (
                    isinstance(event, ToolCallStartEvent)
                    and event.tool_call_id == non_hitl_tool_call_id
                ):
                    non_hitl_event_observed.set()

        with patch.object(instance_a, "_run_adk_in_background", side_effect=mock_run):
            collector = asyncio.create_task(collect())

            # Wait up to 1s for the non-HITL event. With PR #1735's
            # consumer-side gate (and without the #1755 wrapper) this
            # would time out because the consumer would be blocked
            # awaiting execution.task.
            await asyncio.wait_for(
                non_hitl_event_observed.wait(), timeout=1.0
            )

            # HITL TCE must NOT have reached the client yet —
            # persistence hasn't happened.
            hitl_tce_already_seen = any(
                isinstance(e, ToolCallEndEvent)
                and e.tool_call_id == hitl_tool_call_id
                for e in received_events
            )
            assert not hitl_tce_already_seen, (
                "HITL ToolCallEndEvent must be deferred until "
                "pending_tool_calls is persisted (PR #1581's invariant)."
            )

            # Release the producer; it persists then puts None which
            # implicitly flushes the deferred TCE.
            producer_should_finish.set()
            await asyncio.wait_for(collector, timeout=3.0)

        # HITL TCE was eventually delivered.
        hitl_indices = [
            i for i, e in enumerate(received_events)
            if isinstance(e, ToolCallEndEvent)
            and e.tool_call_id == hitl_tool_call_id
        ]
        assert hitl_indices, (
            "HITL ToolCallEndEvent must reach the client after the "
            "producer persists pending_tool_calls and flushes the buffer."
        )

        non_hitl_indices = [
            i for i, e in enumerate(received_events)
            if isinstance(e, ToolCallStartEvent)
            and e.tool_call_id == non_hitl_tool_call_id
        ]
        assert non_hitl_indices, (
            "Test setup error: non-HITL event was never received."
        )

        # Order: non-HITL streamed live (early); HITL TCE flushed at end.
        assert non_hitl_indices[0] < hitl_indices[0], (
            f"Non-HITL event should be delivered before the deferred HITL "
            f"TCE; got non_hitl_idx={non_hitl_indices[0]}, "
            f"hitl_idx={hitl_indices[0]}."
        )

    @pytest.mark.asyncio
    async def test_backend_tool_result_clears_pending_before_stream_ends(
        self, instance_a, sample_tool,
    ):
        """Backend ADK tools complete in-stream and must not leave a stale
        entry in pending_tool_calls. The just-registered ID is removed when
        the corresponding ToolCallResultEvent is observed.
        """
        thread_id = "backend_tool_thread"
        tool_call_id = "tool_call_backend_456"

        await instance_a._ensure_session_exists(
            app_name="test_app", user_id="test_user",
            thread_id=thread_id, initial_state={},
        )

        input_a = RunAgentInput(
            thread_id=thread_id,
            run_id="run_backend",
            messages=[UserMessage(id="msg_1", role="user", content="Do a backend thing")],
            tools=[sample_tool],
            context=[],
            state={},
            forwarded_props={},
        )

        async def mock_run_backend_tool(*args, **kwargs):
            eq = kwargs["event_queue"]
            await eq.put(ToolCallStartEvent(
                type=EventType.TOOL_CALL_START,
                tool_call_id=tool_call_id,
                tool_call_name="server_side_tool",
            ))
            await eq.put(ToolCallArgsEvent(
                type=EventType.TOOL_CALL_ARGS,
                tool_call_id=tool_call_id,
                delta="{}",
            ))
            await eq.put(ToolCallEndEvent(
                type=EventType.TOOL_CALL_END,
                tool_call_id=tool_call_id,
            ))
            await eq.put(ToolCallResultEvent(
                type=EventType.TOOL_CALL_RESULT,
                message_id="msg_result",
                tool_call_id=tool_call_id,
                content='{"ok": true}',
            ))
            await eq.put(None)

        with patch.object(instance_a, "_run_adk_in_background", side_effect=mock_run_backend_tool):
            async for _ in instance_a.run(input_a):
                pass

        assert not await instance_a._has_pending_tool_calls(thread_id, "test_user"), (
            "Backend tool result should clear the pending tool call entry"
        )

    @pytest.mark.asyncio
    async def test_independent_caches_shared_session_service(
        self, instance_a, instance_b,
    ):
        """Each instance has an independent cache but shares the session service."""
        thread_id = "independence_thread"

        session_a, sid_a = await instance_a._ensure_session_exists(
            app_name="test_app",
            user_id="test_user",
            thread_id=thread_id,
            initial_state={},
        )

        # A has it cached, B does not
        assert (thread_id, "test_user") in instance_a._session_lookup_cache
        assert (thread_id, "test_user") not in instance_b._session_lookup_cache

        # B can find it via the shared session service
        found = await instance_b._session_manager._find_session_by_thread_id(
            "test_app", "test_user", thread_id,
        )
        assert found is not None
        assert found.id == sid_a
