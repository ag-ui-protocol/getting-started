#!/usr/bin/env python
"""Test concurrent execution limits in ADKAgent."""

import pytest
import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

from ag_ui.core import (
    RunAgentInput, BaseEvent, EventType, Tool as AGUITool,
    UserMessage, RunStartedEvent, RunFinishedEvent, RunErrorEvent
)

from ag_ui_adk import ADKAgent
from tests.constants import LIVE_TEST_MODEL


class TestConcurrentLimits:
    """Test cases for concurrent execution limits."""


    @pytest.fixture
    def mock_adk_agent(self):
        """Create a mock ADK agent."""
        from google.adk.agents import LlmAgent
        return LlmAgent(
            name="test_agent",
            model=LIVE_TEST_MODEL,
            instruction="Test agent for concurrent testing"
        )

    @pytest.fixture
    def adk_middleware(self, mock_adk_agent):
        """Create ADK middleware with low concurrent limits."""
        return ADKAgent(
            adk_agent=mock_adk_agent,
            user_id="test_user",
            execution_timeout_seconds=60,
            tool_timeout_seconds=30,
            max_concurrent_executions=2  # Low limit for testing
        )

    @pytest.fixture
    def sample_input(self):
        """Create sample run input."""
        return RunAgentInput(
            thread_id="thread_1",
            run_id="run_1",
            messages=[
                UserMessage(id="1", role="user", content="Hello")
            ],
            tools=[],
            context=[],
            state={},
            forwarded_props={}
        )

    @pytest.mark.asyncio
    async def test_concurrent_execution_limit_enforcement(self, adk_middleware):
        """Test that concurrent execution limits are enforced."""
        # Use lighter mocking - just mock the ADK runner to avoid external dependencies
        async def mock_run_adk_in_background(*args, **_kwargs):
            # Simulate a long-running background task
            await asyncio.sleep(10)  # Long enough to test concurrency

        with patch.object(adk_middleware, '_run_adk_in_background', side_effect=mock_run_adk_in_background):
            # Start first execution
            input1 = RunAgentInput(
                thread_id="thread_1", run_id="run_1",
                messages=[UserMessage(id="1", role="user", content="First")],
                tools=[], context=[], state={}, forwarded_props={}
            )

            # Start execution as a task (don't await - let it run in background)
            async def consume_events(execution_generator):
                events = []
                async for event in execution_generator:
                    events.append(event)
                    # Consume a few events to let execution get stored
                    if len(events) >= 3:
                        break
                return events

            task1 = asyncio.create_task(
                consume_events(adk_middleware._start_new_execution(input1))
            )

            # Wait for first execution to start and be stored
            await asyncio.sleep(0.1)

            # Start second execution
            input2 = RunAgentInput(
                thread_id="thread_2", run_id="run_2",
                messages=[UserMessage(id="2", role="user", content="Second")],
                tools=[], context=[], state={}, forwarded_props={}
            )

            task2 = asyncio.create_task(
                consume_events(adk_middleware._start_new_execution(input2))
            )

            # Wait for second execution to start
            await asyncio.sleep(0.1)

            # Should have 2 active executions now
            print(f"Active executions: {len(adk_middleware._active_executions)}")
            print(f"Execution keys: {list(adk_middleware._active_executions.keys())}")

            # Try third execution - should fail due to limit
            input3 = RunAgentInput(
                thread_id="thread_3", run_id="run_3",
                messages=[UserMessage(id="3", role="user", content="Third")],
                tools=[], context=[], state={}, forwarded_props={}
            )

            events = []
            async for event in adk_middleware._start_new_execution(input3):
                events.append(event)
                # Look for error events
                if any(isinstance(e, RunErrorEvent) for e in events):
                    break
                if len(events) >= 5:  # Safety limit
                    break

            # Should get an error about max concurrent executions
            error_events = [e for e in events if isinstance(e, RunErrorEvent)]
            if not error_events:
                print(f"No error events found. Events: {[type(e).__name__ for e in events]}")
                print(f"Active executions after third attempt: {len(adk_middleware._active_executions)}")

            assert len(error_events) >= 1, f"Expected error event, got events: {[type(e).__name__ for e in events]}"
            assert "Maximum concurrent executions" in error_events[0].message

            # Clean up
            task1.cancel()
            task2.cancel()
            try:
                await task1
            except asyncio.CancelledError:
                pass
            try:
                await task2
            except asyncio.CancelledError:
                pass

    @pytest.mark.asyncio
    async def test_stale_execution_cleanup_frees_slots(self, adk_middleware):
        """Test that cleaning up stale executions frees slots for new ones."""
        # Create stale executions manually
        mock_execution1 = MagicMock()
        mock_execution1.thread_id = "stale_thread_1"
        mock_execution1.is_stale.return_value = True
        mock_execution1.cancel = AsyncMock()

        mock_execution2 = MagicMock()
        mock_execution2.thread_id = "stale_thread_2"
        mock_execution2.is_stale.return_value = True
        mock_execution2.cancel = AsyncMock()

        # Add to active executions
        adk_middleware._active_executions[("stale_thread_1", "test_user")] = mock_execution1
        adk_middleware._active_executions[("stale_thread_2", "test_user")] = mock_execution2

        # Should be at limit
        assert len(adk_middleware._active_executions) == 2

        # Cleanup should remove stale executions
        await adk_middleware._cleanup_stale_executions()

        # Should be empty now
        assert len(adk_middleware._active_executions) == 0

        # Should have called cancel on both
        mock_execution1.cancel.assert_called_once()
        mock_execution2.cancel.assert_called_once()

    @pytest.mark.asyncio
    async def test_mixed_stale_and_active_executions(self, adk_middleware):
        """Test cleanup with mix of stale and active executions."""
        # Create one stale and one active execution
        stale_execution = MagicMock()
        stale_execution.thread_id = "stale_thread"
        stale_execution.is_stale.return_value = True
        stale_execution.cancel = AsyncMock()

        active_execution = MagicMock()
        active_execution.thread_id = "active_thread"
        active_execution.is_stale.return_value = False
        active_execution.cancel = AsyncMock()

        adk_middleware._active_executions[("stale_thread", "test_user")] = stale_execution
        adk_middleware._active_executions[("active_thread", "test_user")] = active_execution

        await adk_middleware._cleanup_stale_executions()

        # Only stale should be removed
        assert ("stale_thread", "test_user") not in adk_middleware._active_executions
        assert ("active_thread", "test_user") in adk_middleware._active_executions

        # Only stale should be cancelled
        stale_execution.cancel.assert_called_once()
        active_execution.cancel.assert_not_called()

    @pytest.mark.asyncio
    async def test_zero_concurrent_limit(self):
        """Test behavior with zero concurrent execution limit."""
        # Create ADK middleware with zero limit
        from google.adk.agents import LlmAgent
        mock_agent = LlmAgent(name="test", model=LIVE_TEST_MODEL, instruction="test")

        zero_limit_middleware = ADKAgent(
            adk_agent=mock_agent,
            user_id="test_user",
            max_concurrent_executions=0
        )

        input_data = RunAgentInput(
            thread_id="thread_1", run_id="run_1",
            messages=[UserMessage(id="1", role="user", content="Test")],
            tools=[], context=[], state={}, forwarded_props={}
        )

        # Should immediately fail
        events = []
        async for event in zero_limit_middleware._start_new_execution(input_data):
            events.append(event)
            if len(events) >= 2:
                break

        error_events = [e for e in events if isinstance(e, RunErrorEvent)]
        assert len(error_events) >= 1
        assert "Maximum concurrent executions (0) reached" in error_events[0].message

    @pytest.mark.asyncio
    async def test_execution_completion_frees_slot(self, adk_middleware):
        """Test that completing an execution frees up a slot."""
        # Use lighter mocking - just mock the ADK background execution
        async def mock_run_adk_in_background(*args, **_kwargs):
            # Put completion events in queue then signal completion
            execution = args[0]
            await execution.event_queue.put(RunStartedEvent(type=EventType.RUN_STARTED, thread_id="thread_1", run_id="run_1"))
            await execution.event_queue.put(RunFinishedEvent(type=EventType.RUN_FINISHED, thread_id="thread_1", run_id="run_1"))
            await execution.event_queue.put(None)  # Completion signal

        with patch.object(adk_middleware, '_run_adk_in_background', side_effect=mock_run_adk_in_background):
            input_data = RunAgentInput(
                thread_id="thread_1", run_id="run_1",
                messages=[UserMessage(id="1", role="user", content="Test")],
                tools=[], context=[], state={}, forwarded_props={}
            )

            # Execute and collect events
            events = []
            async for event in adk_middleware._start_new_execution(input_data):
                events.append(event)

            # Should have completed successfully
            assert len(events) == 2
            assert isinstance(events[0], RunStartedEvent)
            assert isinstance(events[1], RunFinishedEvent)

            # Execution should be cleaned up (not in active executions)
            assert len(adk_middleware._active_executions) == 0

    @pytest.mark.asyncio
    async def test_execution_with_pending_tools_not_cleaned(self, adk_middleware):
        """Test that executions with pending tools are not cleaned up."""
        mock_execution = MagicMock()
        mock_execution.thread_id = "thread_1"
        mock_execution.is_complete = True
        mock_execution.has_pending_tools.return_value = True  # Still has pending tools

        adk_middleware._active_executions[("thread_1", "test_user")] = mock_execution

        # Simulate end of _start_new_execution method
        # The finally block should not clean up executions with pending tools
        input_data = RunAgentInput(
            thread_id="thread_1", run_id="run_1",
            messages=[UserMessage(id="1", role="user", content="Test")],
            tools=[], context=[], state={}, forwarded_props={}
        )

        # Manually trigger the cleanup logic from the finally block
        exec_key = (input_data.thread_id, "test_user")
        async with adk_middleware._execution_lock:
            if exec_key in adk_middleware._active_executions:
                execution = adk_middleware._active_executions[exec_key]
                if execution.is_complete and not execution.has_pending_tools():
                    del adk_middleware._active_executions[exec_key]

        # Should still be in active executions
        assert ("thread_1", "test_user") in adk_middleware._active_executions

    @pytest.mark.asyncio
    async def test_high_concurrent_limit(self):
        """Test behavior with very high concurrent limit."""
        from google.adk.agents import LlmAgent
        mock_agent = LlmAgent(name="test", model=LIVE_TEST_MODEL, instruction="test")

        high_limit_middleware = ADKAgent(
            adk_agent=mock_agent,
            user_id="test_user",
            max_concurrent_executions=1000  # Very high limit
        )

        # Should be able to start many executions (limited by other factors)
        assert high_limit_middleware._max_concurrent == 1000

        # Add some mock executions
        for i in range(10):
            mock_execution = MagicMock()
            mock_execution.is_stale.return_value = False
            high_limit_middleware._active_executions[(f"thread_{i}", "test_user")] = mock_execution

        # Should not hit the limit
        assert len(high_limit_middleware._active_executions) == 10
        assert len(high_limit_middleware._active_executions) < high_limit_middleware._max_concurrent

    @pytest.mark.asyncio
    async def test_cleanup_during_limit_check(self, adk_middleware):
        """Test that cleanup is triggered when limit is reached."""
        # Create real ExecutionState objects that will actually be stale
        import time
        from ag_ui_adk.execution_state import ExecutionState

        # Create stale executions
        for i in range(2):  # At the limit (max_concurrent_executions=2)
            mock_task = MagicMock()
            mock_queue = AsyncMock()
            execution = ExecutionState(
                task=mock_task,
                thread_id=f"stale_{i}",
                event_queue=mock_queue
            )
            # Make them stale by setting an old start time
            execution.start_time = time.time() - 1000  # 1000 seconds ago, definitely stale
            execution.cancel = AsyncMock()  # Mock the cancel method
            adk_middleware._active_executions[(f"stale_{i}", "test_user")] = execution

        # Use lighter mocking - just mock the ADK background execution
        async def mock_run_adk_in_background(*args, **_kwargs):
            # Put a simple event to show it started
            execution = args[0]
            await execution.event_queue.put(RunStartedEvent(type=EventType.RUN_STARTED, thread_id="new_thread", run_id="run_1"))
            await execution.event_queue.put(None)  # Completion signal

        with patch.object(adk_middleware, '_run_adk_in_background', side_effect=mock_run_adk_in_background):
            input_data = RunAgentInput(
                thread_id="new_thread", run_id="run_1",
                messages=[UserMessage(id="1", role="user", content="Test")],
                tools=[], context=[], state={}, forwarded_props={}
            )

            # This should trigger cleanup and then succeed
            events = []
            async for event in adk_middleware._start_new_execution(input_data):
                events.append(event)

            # Should succeed (cleanup freed up space)
            assert len(events) >= 1
            assert isinstance(events[0], RunStartedEvent)

            # Old stale executions should be gone
            assert ("stale_0", "test_user") not in adk_middleware._active_executions
            assert ("stale_1", "test_user") not in adk_middleware._active_executions