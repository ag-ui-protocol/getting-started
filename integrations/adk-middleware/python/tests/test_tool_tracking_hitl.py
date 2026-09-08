#!/usr/bin/env python
"""Test HITL tool call tracking functionality."""

import pytest
import asyncio
from unittest.mock import MagicMock, AsyncMock, patch

from ag_ui.core import (
    RunAgentInput, UserMessage, Tool as AGUITool,
    ToolCallStartEvent, ToolCallArgsEvent, ToolCallEndEvent,
    RunStartedEvent, RunFinishedEvent, EventType
)

from ag_ui_adk import ADKAgent
from ag_ui_adk.execution_state import ExecutionState
from tests.constants import LIVE_TEST_MODEL


class TestHITLToolTracking:
    """Test cases for HITL tool call tracking."""

    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        """Reset session manager before each test."""
        from ag_ui_adk.session_manager import SessionManager
        SessionManager.reset_instance()
        yield
        SessionManager.reset_instance()

    @pytest.fixture
    def mock_adk_agent(self):
        """Create a mock ADK agent."""
        from google.adk.agents import LlmAgent
        return LlmAgent(
            name="test_agent",
            model=LIVE_TEST_MODEL,
            instruction="Test agent"
        )

    @pytest.fixture
    def adk_middleware(self, mock_adk_agent):
        """Create ADK middleware."""
        return ADKAgent(
            adk_agent=mock_adk_agent,
            app_name="test_app",
            user_id="test_user"
        )

    @pytest.fixture
    def sample_tool(self):
        """Create a sample tool."""
        return AGUITool(
            name="test_tool",
            description="A test tool",
            parameters={
                "type": "object",
                "properties": {
                    "param": {"type": "string"}
                }
            }
        )

    @pytest.mark.asyncio
    async def test_tool_call_tracking(self, adk_middleware, sample_tool):
        """Test that tool calls are tracked in session state."""
        # Create input
        input_data = RunAgentInput(
            thread_id="test_thread",
            run_id="run_1",
            messages=[UserMessage(id="1", role="user", content="Test")],
            tools=[sample_tool],
            context=[],
            state={},
            forwarded_props={}
        )

        # Ensure session exists first (returns tuple: session, backend_session_id)
        session, backend_session_id = await adk_middleware._ensure_session_exists(
            app_name="test_app",
            user_id="test_user",
            thread_id="test_thread",
            initial_state={}
        )

        # Mock background execution to emit tool events
        async def mock_run_adk_in_background(*args, **kwargs):
            event_queue = kwargs['event_queue']

            # Emit some events including a tool call
            await event_queue.put(RunStartedEvent(
                type=EventType.RUN_STARTED,
                thread_id="test_thread",
                run_id="run_1"
            ))

            # Emit tool call events
            tool_call_id = "test_tool_call_123"
            # The real producer (ClientProxyTool) registers HITL tool call IDs
            # in long_running_tool_ids before TOOL_CALL_START is enqueued, so
            # the consumer's gate persists pending_tool_calls (issue #1652).
            kwargs['long_running_tool_ids'].add(tool_call_id)
            await event_queue.put(ToolCallStartEvent(
                type=EventType.TOOL_CALL_START,
                tool_call_id=tool_call_id,
                tool_call_name="test_tool"
            ))
            await event_queue.put(ToolCallArgsEvent(
                type=EventType.TOOL_CALL_ARGS,
                tool_call_id=tool_call_id,
                delta='{"param": "value"}'
            ))
            await event_queue.put(ToolCallEndEvent(
                type=EventType.TOOL_CALL_END,
                tool_call_id=tool_call_id
            ))

            # Simulate the real producer's pre-None persistence step
            # (#1755 moves this from the consumer to the producer).
            for hitl_id in list(getattr(event_queue, "deferred_hitl_ids", [])):
                await adk_middleware._add_pending_tool_call_with_context(
                    "test_thread", hitl_id, "test_app", "test_user"
                )

            # Signal completion
            await event_queue.put(None)

        # Use the mock
        with patch.object(adk_middleware, '_run_adk_in_background', side_effect=mock_run_adk_in_background):
            events = []
            async for event in adk_middleware._start_new_execution(input_data):
                events.append(event)

            # Verify events were emitted
            assert any(isinstance(e, ToolCallEndEvent) for e in events)

            # Check if tool call was tracked
            has_pending = await adk_middleware._has_pending_tool_calls("test_thread", "test_user")
            assert has_pending, "Tool call should be tracked as pending"

            # Verify session state contains the tool call (use backend_session_id)
            session = await adk_middleware._session_manager._session_service.get_session(
                session_id=backend_session_id,
                app_name="test_app",
                user_id="test_user"
            )
            assert session is not None
            assert session.state is not None
            assert "pending_tool_calls" in session.state
            assert "test_tool_call_123" in session.state["pending_tool_calls"]

    @pytest.mark.asyncio
    async def test_execution_not_cleaned_up_with_pending_tools(self, adk_middleware, sample_tool):
        """Test that executions with pending tool calls are not cleaned up."""
        # Create input
        input_data = RunAgentInput(
            thread_id="test_thread",
            run_id="run_1",
            messages=[UserMessage(id="1", role="user", content="Test")],
            tools=[sample_tool],
            context=[],
            state={},
            forwarded_props={}
        )

        # Ensure session exists first (returns tuple: session, backend_session_id)
        session, backend_session_id = await adk_middleware._ensure_session_exists(
            app_name="test_app",
            user_id="test_user",
            thread_id="test_thread",
            initial_state={}
        )

        # Mock background execution to emit tool events
        async def mock_run_adk_in_background(*args, **kwargs):
            event_queue = kwargs['event_queue']

            # Emit tool call events (HITL — see issue #1652)
            tool_call_id = "test_tool_call_456"
            kwargs['long_running_tool_ids'].add(tool_call_id)
            await event_queue.put(ToolCallEndEvent(
                type=EventType.TOOL_CALL_END,
                tool_call_id=tool_call_id
            ))

            # Simulate the real producer's pre-None persistence step (#1755).
            for hitl_id in list(getattr(event_queue, "deferred_hitl_ids", [])):
                await adk_middleware._add_pending_tool_call_with_context(
                    "test_thread", hitl_id, "test_app", "test_user"
                )

            # Signal completion
            await event_queue.put(None)

        # Use the mock
        with patch.object(adk_middleware, '_run_adk_in_background', side_effect=mock_run_adk_in_background):
            events = []
            async for event in adk_middleware._start_new_execution(input_data):
                events.append(event)

            # Execution should NOT be cleaned up due to pending tool call
            assert ("test_thread", "test_user") in adk_middleware._active_executions
            execution = adk_middleware._active_executions[("test_thread", "test_user")]
            assert execution.is_complete

    @pytest.mark.asyncio
    async def test_parent_cleanup_drops_stale_read_cache(
        self, adk_middleware, sample_tool
    ):
        """The parent cleanup read must not use its pre-run session cache."""
        input_data = RunAgentInput(
            thread_id="test_thread",
            run_id="run_1",
            messages=[UserMessage(id="1", role="user", content="Test")],
            tools=[sample_tool],
            context=[],
            state={},
            forwarded_props={},
        )

        cache_disabled = False
        original_disable = (
            adk_middleware._session_manager.disable_session_read_cache
        )

        def disable_session_read_cache():
            nonlocal cache_disabled
            cache_disabled = True
            original_disable()

        async def mock_has_pending_tool_calls(*_args, **_kwargs):
            return cache_disabled

        async def mock_run_adk_in_background(*args, **kwargs):
            await kwargs["event_queue"].put(None)

        with patch.object(
            adk_middleware._session_manager,
            "disable_session_read_cache",
            side_effect=disable_session_read_cache,
        ), patch.object(
            adk_middleware,
            "_has_pending_tool_calls",
            side_effect=mock_has_pending_tool_calls,
        ), patch.object(
            adk_middleware,
            "_run_adk_in_background",
            side_effect=mock_run_adk_in_background,
        ):
            async for _event in adk_middleware._start_new_execution(
                input_data,
            ):
                pass

        assert cache_disabled
        assert ("test_thread", "test_user") in adk_middleware._active_executions

    @pytest.mark.asyncio
    async def test_session_not_cleaned_up_with_pending_tools(self, mock_adk_agent, sample_tool):
        """Test that executions with pending tool calls are not cleaned up."""
        # Create input
        input_data = RunAgentInput(
            thread_id="test_thread",
            run_id="run_1",
            messages=[UserMessage(id="1", role="user", content="Test")],
            tools=[sample_tool],
            context=[],
            state={},
            forwarded_props={}
        )

        adk_middleware = ADKAgent(
            adk_agent=mock_adk_agent,
            app_name="test_app",
            user_id="test_user",
            delete_session_on_cleanup=True,
            session_timeout_seconds=0 # all sessions expire immediately for test
        )

        # Ensure session exists first (returns tuple: session, backend_session_id)
        session, backend_session_id = await adk_middleware._ensure_session_exists(
            app_name="test_app",
            user_id="test_user",
            thread_id="test_thread",
            initial_state={}
        )

        # Mock background execution to emit tool events
        async def mock_run_adk_in_background(*args, **kwargs):
            event_queue = kwargs['event_queue']

            # Emit tool call events (HITL — see issue #1652)
            tool_call_id = "test_tool_call_456"
            kwargs['long_running_tool_ids'].add(tool_call_id)
            await event_queue.put(ToolCallEndEvent(
                type=EventType.TOOL_CALL_END,
                tool_call_id=tool_call_id
            ))

            # Simulate the real producer's pre-None persistence step (#1755).
            for hitl_id in list(getattr(event_queue, "deferred_hitl_ids", [])):
                await adk_middleware._add_pending_tool_call_with_context(
                    "test_thread", hitl_id, "test_app", "test_user"
                )

            # Signal completion
            await event_queue.put(None)

        # Use the mock
        with patch.object(adk_middleware, '_run_adk_in_background', side_effect=mock_run_adk_in_background):
            events = []
            async for event in adk_middleware._start_new_execution(input_data):
                events.append(event)

            # Execution should NOT be cleaned up due to pending tool call
            assert ("test_thread", "test_user") in adk_middleware._active_executions
            execution = adk_middleware._active_executions[("test_thread", "test_user")]
            assert execution.is_complete

        await adk_middleware._session_manager._cleanup_expired_sessions()
        # Session should still exist due to pending tool call
        assert adk_middleware._session_manager.get_session_count() == 1

    @pytest.mark.asyncio
    async def test_session_cleaned_up_with_no_pending_tools(self, mock_adk_agent, sample_tool):
        """Test that executions with no pending tool calls are cleaned up."""
        # Create input
        input_data = RunAgentInput(
            thread_id="test_thread",
            run_id="run_1",
            messages=[UserMessage(id="1", role="user", content="Test")],
            tools=[sample_tool],
            context=[],
            state={},
            forwarded_props={}
        )

        adk_middleware = ADKAgent(
            adk_agent=mock_adk_agent,
            app_name="test_app",
            user_id="test_user",
            delete_session_on_cleanup=True,
            session_timeout_seconds=0 # all sessions expire immediately for test
        )

        # Ensure session exists first (returns tuple: session, backend_session_id)
        session, backend_session_id = await adk_middleware._ensure_session_exists(
            app_name="test_app",
            user_id="test_user",
            thread_id="test_thread",
            initial_state={}
        )

        # Mock background execution to emit tool events
        async def mock_run_adk_in_background(*args, **kwargs):
            event_queue = kwargs['event_queue']

            # Emit NO tool call events

            # Signal completion
            await event_queue.put(None)

        # Use the mock
        with patch.object(adk_middleware, '_run_adk_in_background', side_effect=mock_run_adk_in_background):
            events = []
            async for event in adk_middleware._start_new_execution(input_data):
                events.append(event)

            # Execution should be cleaned up due to NO pending tool call
            assert ("test_thread", "test_user") not in adk_middleware._active_executions

        await adk_middleware._session_manager._cleanup_expired_sessions()
        # Session should not exist due cleanup
        assert adk_middleware._session_manager.get_session_count() == 0

    @pytest.mark.asyncio
    async def test_stale_pending_tool_calls_cleared_on_session_resumption(
        self, adk_middleware
    ):
        """Test that stale pending_tool_calls are cleared when resuming a session after middleware restart.

        This simulates a pod restart scenario where:
        1. Session exists in PostgreSQL with pending_tool_calls from before restart
        2. Middleware's _session_lookup_cache is empty (in-memory, lost on restart)
        3. When _ensure_session_exists is called, it finds the session but clears stale pending_tool_calls
        """
        thread_id = "test_thread_restart"
        app_name = "test_app"
        user_id = "test_user"

        # Step 1: Create a session and add pending_tool_calls (simulating state before restart)
        session, backend_session_id = await adk_middleware._ensure_session_exists(
            app_name=app_name, user_id=user_id, thread_id=thread_id, initial_state={}
        )

        # Add stale pending_tool_calls to the session (simulating HITL state before restart)
        stale_tool_ids = ["stale_tool_1", "stale_tool_2", "stale_tool_3"]
        await adk_middleware._session_manager.set_state_value(
            session_id=backend_session_id,
            app_name=app_name,
            user_id=user_id,
            key="pending_tool_calls",
            value=stale_tool_ids,
        )

        # Verify pending_tool_calls were set
        pending_before = await adk_middleware._session_manager.get_state_value(
            session_id=backend_session_id,
            app_name=app_name,
            user_id=user_id,
            key="pending_tool_calls",
            default=[],
        )
        assert pending_before == stale_tool_ids, "Stale tool calls should be set"

        # Step 2: Simulate middleware restart by clearing all in-memory state
        # This is what happens when the pod restarts
        adk_middleware._session_lookup_cache.clear()
        adk_middleware._sessions_verified_locally.clear()
        adk_middleware._cache_checked_keys.clear()

        # Step 3: Call _ensure_session_exists again (simulating first request after restart)
        # This should find the existing session and clear stale pending_tool_calls
        session_after, session_id_after = await adk_middleware._ensure_session_exists(
            app_name=app_name, user_id=user_id, thread_id=thread_id, initial_state={}
        )

        # Verify the session_id is the same (session was found, not recreated)
        assert session_id_after == backend_session_id, "Should resume existing session"

        # Step 4: Verify pending_tool_calls were cleared
        pending_after = await adk_middleware._session_manager.get_state_value(
            session_id=backend_session_id,
            app_name=app_name,
            user_id=user_id,
            key="pending_tool_calls",
            default=[],
        )
        assert pending_after == [], "Stale pending_tool_calls should be cleared"

        # Verify has_pending_tool_calls returns False
        has_pending = await adk_middleware._has_pending_tool_calls(thread_id, user_id)
        assert not has_pending, "Should have no pending tool calls"

    @pytest.mark.asyncio
    async def test_new_session_has_no_pending_tool_calls_to_clear(self, adk_middleware):
        """Test that new sessions (not resumptions) work correctly without pending_tool_calls."""
        thread_id = "brand_new_thread"
        app_name = "test_app"
        user_id = "test_user"

        # Create a brand new session (no prior state)
        session, backend_session_id = await adk_middleware._ensure_session_exists(
            app_name=app_name, user_id=user_id, thread_id=thread_id, initial_state={}
        )

        # Verify no pending_tool_calls
        pending = await adk_middleware._session_manager.get_state_value(
            session_id=backend_session_id,
            app_name=app_name,
            user_id=user_id,
            key="pending_tool_calls",
            default=[],
        )
        assert pending == [], "New session should have no pending_tool_calls"

        # Verify cache was populated
        assert (thread_id, user_id) in adk_middleware._session_lookup_cache

    @pytest.mark.asyncio
    async def test_session_with_pending_tools_force_deleted_after_hitl_max_wait(self, mock_adk_agent, sample_tool):
        """Test that sessions with pending tool calls are force-deleted after hitl_max_wait_seconds."""
        input_data = RunAgentInput(
            thread_id="test_thread",
            run_id="run_1",
            messages=[UserMessage(id="1", role="user", content="Test")],
            tools=[sample_tool],
            context=[],
            state={},
            forwarded_props={}
        )

        adk_middleware = ADKAgent(
            adk_agent=mock_adk_agent,
            app_name="test_app",
            user_id="test_user",
            delete_session_on_cleanup=True,
            session_timeout_seconds=0,  # all sessions expire immediately
            hitl_max_wait_seconds=10,   # force-delete after 10 seconds
        )

        session, backend_session_id = await adk_middleware._ensure_session_exists(
            app_name="test_app",
            user_id="test_user",
            thread_id="test_thread",
            initial_state={}
        )

        # Simulate pending tool call via background execution (HITL — issue #1652)
        async def mock_run_adk_in_background(*args, **kwargs):
            event_queue = kwargs['event_queue']
            kwargs['long_running_tool_ids'].add("pending_tool_123")
            await event_queue.put(ToolCallEndEvent(
                type=EventType.TOOL_CALL_END,
                tool_call_id="pending_tool_123"
            ))
            # Simulate the real producer's pre-None persistence step (#1755).
            for hitl_id in list(getattr(event_queue, "deferred_hitl_ids", [])):
                await adk_middleware._add_pending_tool_call_with_context(
                    "test_thread", hitl_id, "test_app", "test_user"
                )
            await event_queue.put(None)

        with patch.object(adk_middleware, '_run_adk_in_background', side_effect=mock_run_adk_in_background):
            events = []
            async for event in adk_middleware._start_new_execution(input_data):
                events.append(event)

        sm = adk_middleware._session_manager

        # First cleanup: session preserved (within hitl_max_wait)
        await sm._cleanup_expired_sessions()
        assert sm.get_session_count() == 1

        # Simulate time passing beyond hitl_max_wait_seconds
        session_key = list(sm._hitl_preserved_since.keys())[0]
        sm._hitl_preserved_since[session_key] -= 15  # pretend preserved 15s ago

        # Second cleanup: session should now be force-deleted
        await sm._cleanup_expired_sessions()
        assert sm.get_session_count() == 0

    @pytest.mark.asyncio
    async def test_session_with_pending_tools_preserved_indefinitely_without_hitl_max_wait(self, mock_adk_agent, sample_tool):
        """Test that sessions with pending tool calls are preserved indefinitely when hitl_max_wait_seconds is None (default)."""
        input_data = RunAgentInput(
            thread_id="test_thread",
            run_id="run_1",
            messages=[UserMessage(id="1", role="user", content="Test")],
            tools=[sample_tool],
            context=[],
            state={},
            forwarded_props={}
        )

        adk_middleware = ADKAgent(
            adk_agent=mock_adk_agent,
            app_name="test_app",
            user_id="test_user",
            delete_session_on_cleanup=True,
            session_timeout_seconds=0,  # all sessions expire immediately
            # hitl_max_wait_seconds defaults to None (no limit)
        )

        session, backend_session_id = await adk_middleware._ensure_session_exists(
            app_name="test_app",
            user_id="test_user",
            thread_id="test_thread",
            initial_state={}
        )

        async def mock_run_adk_in_background(*args, **kwargs):
            event_queue = kwargs['event_queue']
            # HITL tool call — see issue #1652.
            kwargs['long_running_tool_ids'].add("pending_tool_456")
            await event_queue.put(ToolCallEndEvent(
                type=EventType.TOOL_CALL_END,
                tool_call_id="pending_tool_456"
            ))
            # Simulate the real producer's pre-None persistence step (#1755).
            for hitl_id in list(getattr(event_queue, "deferred_hitl_ids", [])):
                await adk_middleware._add_pending_tool_call_with_context(
                    "test_thread", hitl_id, "test_app", "test_user"
                )
            await event_queue.put(None)

        with patch.object(adk_middleware, '_run_adk_in_background', side_effect=mock_run_adk_in_background):
            events = []
            async for event in adk_middleware._start_new_execution(input_data):
                events.append(event)

        sm = adk_middleware._session_manager

        # Run cleanup multiple times - session should always be preserved
        for _ in range(5):
            await sm._cleanup_expired_sessions()
            assert sm.get_session_count() == 1
