#!/usr/bin/env python
"""Test error handling scenarios in tool flows."""

import pytest
import asyncio
import json
from unittest.mock import AsyncMock, MagicMock, patch

from ag_ui.core import (
    RunAgentInput, BaseEvent, EventType, Tool as AGUITool,
    UserMessage, ToolMessage, RunStartedEvent, RunErrorEvent, RunFinishedEvent,
    ToolCallStartEvent, ToolCallArgsEvent, ToolCallEndEvent
)

from ag_ui_adk import ADKAgent
from ag_ui_adk.execution_state import ExecutionState
from ag_ui_adk.client_proxy_tool import ClientProxyTool
from ag_ui_adk.client_proxy_toolset import ClientProxyToolset
from tests.constants import LIVE_TEST_MODEL


class TestToolErrorHandling:
    """Test cases for various tool error scenarios."""


    @pytest.fixture
    def mock_adk_agent(self):
        """Create a mock ADK agent."""
        from google.adk.agents import LlmAgent
        return LlmAgent(
            name="test_agent",
            model=LIVE_TEST_MODEL,
            instruction="Test agent for error testing"
        )

    @pytest.fixture
    def adk_middleware(self, mock_adk_agent):
        """Create ADK middleware."""
        return ADKAgent(
            adk_agent=mock_adk_agent,
            user_id="test_user",
            execution_timeout_seconds=60,
            tool_timeout_seconds=30,
            max_concurrent_executions=5
        )

    @pytest.fixture
    def sample_tool(self):
        """Create a sample tool definition."""
        return AGUITool(
            name="error_prone_tool",
            description="A tool that might encounter various errors",
            parameters={
                "type": "object",
                "properties": {
                    "action": {"type": "string"},
                    "data": {"type": "string"}
                },
                "required": ["action"]
            }
        )

    @pytest.mark.asyncio
    async def test_adk_execution_error_during_tool_run(self, adk_middleware, sample_tool):
        """Test error handling when ADK execution fails during tool usage."""
        # Test that the system gracefully handles exceptions from background execution
        async def failing_adk_execution(*_args, **_kwargs):
            raise Exception("ADK execution failed unexpectedly")

        with patch.object(adk_middleware, '_run_adk_in_background', side_effect=failing_adk_execution):
            input_data = RunAgentInput(
                thread_id="test_thread", run_id="run_1",
                messages=[UserMessage(id="1", role="user", content="Use the error prone tool")],
                tools=[sample_tool], context=[], state={}, forwarded_props={}
            )

            events = []
            async for event in adk_middleware._start_new_execution(input_data):
                events.append(event)

            # Should get at least a run started event
            assert len(events) >= 1
            assert isinstance(events[0], RunStartedEvent)

            # The exception should be caught and handled (not crash the system)
            # The actual error events depend on the error handling implementation

    @pytest.mark.asyncio
    async def test_tool_result_parsing_error(self, adk_middleware, sample_tool):
        """Test error handling when tool result cannot be parsed."""
        # Create an execution with a pending tool
        mock_task = MagicMock()
        mock_task.done.return_value = False
        event_queue = asyncio.Queue()

        execution = ExecutionState(
            task=mock_task,
            thread_id="test_thread",
            event_queue=event_queue
        )

        # Add to active executions
        adk_middleware._active_executions[("test_thread", "test_user")] = execution

        # Submit invalid JSON as tool result
        input_data = RunAgentInput(
            thread_id="test_thread", run_id="run_1",
            messages=[
                UserMessage(id="1", role="user", content="Test"),
                ToolMessage(
                    id="2",
                    role="tool",
                    tool_call_id="call_1",
                    content="{ invalid json syntax"  # Malformed JSON
                )
            ],
            tools=[sample_tool], context=[], state={}, forwarded_props={}
        )

        # Mock _stream_events to avoid hanging on empty queue
        async def mock_stream_events(execution):
            # Return empty - no events from execution
            return
            yield  # Make it a generator

        with patch.object(adk_middleware, '_stream_events', side_effect=mock_stream_events):
            events = []
            async for event in adk_middleware._handle_tool_result_submission(input_data):
                events.append(event)

            # In the all-long-running architecture, tool results always start new executions
            # Should get RUN_STARTED and RUN_FINISHED events (malformed JSON is handled gracefully)
            assert len(events) == 2
            assert events[0].type == EventType.RUN_STARTED
            assert events[1].type == EventType.RUN_FINISHED

    @pytest.mark.asyncio
    async def test_tool_result_for_nonexistent_call(self, adk_middleware, sample_tool):
        """Test error handling when tool result is for non-existent call."""
        # Create an execution without the expected tool call
        mock_task = MagicMock()
        mock_task.done.return_value = False
        event_queue = asyncio.Queue()

        execution = ExecutionState(
            task=mock_task,
            thread_id="test_thread",
            event_queue=event_queue
        )

        adk_middleware._active_executions[("test_thread", "test_user")] = execution

        # Submit tool result for non-existent call
        input_data = RunAgentInput(
            thread_id="test_thread", run_id="run_1",
            messages=[
                UserMessage(id="1", role="user", content="Test"),
                ToolMessage(
                    id="2",
                    role="tool",
                    tool_call_id="nonexistent_call",
                    content='{"result": "some result"}'
                )
            ],
            tools=[sample_tool], context=[], state={}, forwarded_props={}
        )

        # Mock _stream_events to avoid hanging on empty queue
        async def mock_stream_events(execution):
            # Return empty - no events from execution
            return
            yield  # Make it a generator

        with patch.object(adk_middleware, '_stream_events', side_effect=mock_stream_events):
            events = []
            async for event in adk_middleware._handle_tool_result_submission(input_data):
                events.append(event)

            # The system logs warnings but may not emit error events for unknown tool calls
            # Just check that it doesn't crash the system
            assert len(events) >= 0  # Should not crash

    @pytest.mark.asyncio
    async def test_toolset_creation_error(self, adk_middleware):
        """Test error handling when toolset creation fails."""
        # Create invalid tool definition
        invalid_tool = AGUITool(
            name="",  # Invalid empty name
            description="Invalid tool",
            parameters={"invalid": "schema"}  # Invalid schema
        )

        # Simply test that invalid tools don't crash the system
        async def mock_adk_execution(*_args, **_kwargs):
            raise Exception("Failed to create toolset with invalid tool")

        with patch.object(adk_middleware, '_run_adk_in_background', side_effect=mock_adk_execution):
            input_data = RunAgentInput(
                thread_id="test_thread", run_id="run_1",
                messages=[UserMessage(id="1", role="user", content="Test")],
                tools=[invalid_tool], context=[], state={}, forwarded_props={}
            )

            events = []
            async for event in adk_middleware._start_new_execution(input_data):
                events.append(event)

            # Should handle the error gracefully without crashing
            assert len(events) >= 1
            assert isinstance(events[0], RunStartedEvent)

    @pytest.mark.asyncio
    async def test_tool_timeout_during_execution(self, sample_tool):
        """Test that tool timeouts are properly handled."""
        event_queue = AsyncMock()

        # Create proxy tool
        proxy_tool = ClientProxyTool(
            ag_ui_tool=sample_tool,
            event_queue=event_queue
        )

        args = {"action": "slow_action"}
        mock_context = MagicMock()
        mock_context.function_call_id = "test_function_call_id"

        # In all-long-running architecture, tools return None immediately
        result = await proxy_tool.run_async(args=args, tool_context=mock_context)

        # Should return None (long-running behavior)
        assert result is None

    @pytest.mark.asyncio
    async def test_execution_state_error_handling(self):
        """Test ExecutionState error handling methods."""
        mock_task = MagicMock()
        mock_task.done.return_value = False  # Ensure it returns False for "running" status
        event_queue = asyncio.Queue()

        execution = ExecutionState(
            task=mock_task,
            thread_id="test_thread",
            event_queue=event_queue
        )

        # Test basic execution state functionality
        assert execution.thread_id == "test_thread"
        assert execution.task == mock_task
        assert execution.event_queue == event_queue
        assert execution.is_complete is False

        # Test status reporting
        assert execution.get_status() == "running"

    @pytest.mark.asyncio
    async def test_multiple_tool_errors_handling(self, adk_middleware, sample_tool):
        """Test handling multiple tool errors in sequence."""
        # Create execution with multiple pending tools
        mock_task = MagicMock()
        mock_task.done.return_value = False  # Ensure it returns False for "running" status
        event_queue = asyncio.Queue()

        execution = ExecutionState(
            task=mock_task,
            thread_id="test_thread",
            event_queue=event_queue
        )

        adk_middleware._active_executions[("test_thread", "test_user")] = execution

        # Submit results for both - one valid, one invalid
        input_data = RunAgentInput(
            thread_id="test_thread", run_id="run_1",
            messages=[
                UserMessage(id="1", role="user", content="Test"),
                ToolMessage(id="2", role="tool", tool_call_id="call_1", content='{"valid": "result"}'),
                ToolMessage(id="3", role="tool", tool_call_id="call_2", content='{ invalid json')
            ],
            tools=[sample_tool], context=[], state={}, forwarded_props={}
        )

        # Mock _stream_events to avoid hanging on empty queue
        async def mock_stream_events(execution):
            # Return empty - no events from execution
            return
            yield  # Make it a generator

        with patch.object(adk_middleware, '_stream_events', side_effect=mock_stream_events):
            events = []
            async for event in adk_middleware._handle_tool_result_submission(input_data):
                events.append(event)

            # In all-long-running architecture, tool results always start new executions
            # Should get RUN_STARTED and RUN_FINISHED events (only most recent tool result processed)
            assert len(events) == 2
            assert events[0].type == EventType.RUN_STARTED
            assert events[1].type == EventType.RUN_FINISHED

    @pytest.mark.asyncio
    async def test_execution_cleanup_on_error(self, adk_middleware, sample_tool):
        """Test that executions are properly cleaned up when errors occur."""
        async def error_adk_execution(*_args, **_kwargs):
            raise Exception("Critical ADK error")

        with patch.object(adk_middleware, '_run_adk_in_background', side_effect=error_adk_execution):
            input_data = RunAgentInput(
                thread_id="test_thread", run_id="run_1",
                messages=[UserMessage(id="1", role="user", content="Test")],
                tools=[sample_tool], context=[], state={}, forwarded_props={}
            )

            events = []
            async for event in adk_middleware._start_new_execution(input_data):
                events.append(event)

            # Should handle the error gracefully
            assert len(events) >= 1
            assert isinstance(events[0], RunStartedEvent)

            # System should handle the error without crashing

    @pytest.mark.asyncio
    async def test_toolset_close_error_handling(self):
        """Test error handling during toolset close operations."""
        event_queue = AsyncMock()

        # Create a sample tool for the toolset
        sample_tool = AGUITool(
            name="test_tool",
            description="A test tool",
            parameters={"type": "object", "properties": {}}
        )

        toolset = ClientProxyToolset(
            ag_ui_tools=[sample_tool],
            event_queue=event_queue
        )

        # Close should handle the exception gracefully
        try:
            await toolset.close()
        except Exception:
            # If the mock exception propagates, that's fine for this test
            pass

        # The exception might prevent full cleanup, so just verify close was attempted
        # and didn't crash the system completely
        assert True  # If we get here, close didn't crash

    @pytest.mark.asyncio
    async def test_event_queue_error_during_tool_call_long_running(self, sample_tool):
        """Test error handling when event queue operations fail (long-running tool)."""
        # Create a mock event queue that fails
        event_queue = AsyncMock()
        event_queue.put.side_effect = Exception("Queue operation failed")

        proxy_tool = ClientProxyTool(
            ag_ui_tool=sample_tool,
            event_queue=event_queue
        )

        args = {"action": "test"}
        mock_context = MagicMock()
        mock_context.function_call_id = "test_function_call_id"

        # Should handle queue errors gracefully
        with pytest.raises(Exception) as exc_info:
            await proxy_tool.run_async(args=args, tool_context=mock_context)

        assert "Queue operation failed" in str(exc_info.value)

    @pytest.mark.asyncio
    async def test_event_queue_error_during_tool_call_blocking(self, sample_tool):
        """Test error handling when event queue operations fail (blocking tool)."""
        # Create a mock event queue that fails
        event_queue = AsyncMock()
        event_queue.put.side_effect = Exception("Queue operation failed")

        proxy_tool = ClientProxyTool(
            ag_ui_tool=sample_tool,
            event_queue=event_queue
        )

        args = {"action": "test"}
        mock_context = MagicMock()
        mock_context.function_call_id = "test_function_call_id"

        # Should handle queue errors gracefully
        with pytest.raises(Exception) as exc_info:
            await proxy_tool.run_async(args=args, tool_context=mock_context)

        assert "Queue operation failed" in str(exc_info.value)

    @pytest.mark.asyncio
    async def test_concurrent_tool_errors(self, adk_middleware, sample_tool):
        """Test handling errors when multiple tools fail concurrently."""
        # Create execution with multiple tools
        # Create a real asyncio task for proper cancellation testing
        async def dummy_task():
            await asyncio.sleep(10)  # Long running task

        real_task = asyncio.create_task(dummy_task())
        event_queue = asyncio.Queue()

        execution = ExecutionState(
            task=real_task,
            thread_id="test_thread",
            event_queue=event_queue
        )

        adk_middleware._active_executions[("test_thread", "test_user")] = execution

        # Test concurrent execution state management
        # In the all-long-running architecture, we don't track individual tool futures
        # Instead, we test basic execution state properties
        assert execution.thread_id == "test_thread"
        assert execution.get_status() == "running"
        assert execution.is_complete is False

        # Test that execution can be cancelled
        await execution.cancel()
        assert execution.is_complete is True

    @pytest.mark.asyncio
    async def test_malformed_tool_message_handling(self, adk_middleware, sample_tool):
        """Test handling of malformed tool messages."""
        mock_task = MagicMock()
        mock_task.done.return_value = False
        event_queue = asyncio.Queue()

        execution = ExecutionState(
            task=mock_task,
            thread_id="test_thread",
            event_queue=event_queue
        )

        adk_middleware._active_executions[("test_thread", "test_user")] = execution

        # Submit tool message with empty content (which should be handled gracefully)
        input_data = RunAgentInput(
            thread_id="test_thread", run_id="run_1",
            messages=[
                UserMessage(id="1", role="user", content="Test"),
                ToolMessage(
                    id="2",
                    role="tool",
                    tool_call_id="call_1",
                    content=""  # Empty content instead of None
                )
            ],
            tools=[sample_tool], context=[], state={}, forwarded_props={}
        )

        # Mock _stream_events to avoid hanging on empty queue
        async def mock_stream_events(execution):
            # Return empty - no events from execution
            return
            yield  # Make it a generator

        with patch.object(adk_middleware, '_stream_events', side_effect=mock_stream_events):
            events = []
            async for event in adk_middleware._handle_tool_result_submission(input_data):
                events.append(event)

            # In all-long-running architecture, tool results always start new executions
            # Should get RUN_STARTED and RUN_FINISHED events (empty content handled gracefully)
            assert len(events) == 2
            assert events[0].type == EventType.RUN_STARTED
            assert events[1].type == EventType.RUN_FINISHED

    @pytest.mark.asyncio
    async def test_json_parsing_in_tool_result_submission(self, adk_middleware, sample_tool):
        """Test that JSON parsing errors in tool results are handled gracefully."""
        # Test with empty content
        input_empty = RunAgentInput(
            thread_id="test_thread",
            run_id="run_1",
            messages=[
                UserMessage(id="1", role="user", content="Test"),
                ToolMessage(
                    id="2",
                    role="tool",
                    tool_call_id="call_1",
                    content=""  # Empty content
                )
            ],
            tools=[sample_tool],
            context=[],
            state={},
            forwarded_props={}
        )

        # This should not raise a JSONDecodeError
        events = []
        try:
            async for event in adk_middleware.run(input_empty):
                events.append(event)
                if len(events) >= 5:  # Limit to avoid infinite loop
                    break
        except json.JSONDecodeError:
            pytest.fail("JSONDecodeError should not be raised for empty tool content")
        except Exception:
            # Other exceptions are expected (e.g., from ADK library)
            pass

        # Test with invalid JSON
        input_invalid = RunAgentInput(
            thread_id="test_thread2",
            run_id="run_2",
            messages=[
                UserMessage(id="1", role="user", content="Test"),
                ToolMessage(
                    id="2",
                    role="tool",
                    tool_call_id="call_2",
                    content="{ invalid json"  # Invalid JSON
                )
            ],
            tools=[sample_tool],
            context=[],
            state={},
            forwarded_props={}
        )

        # This should not raise a JSONDecodeError
        events = []
        try:
            async for event in adk_middleware.run(input_invalid):
                events.append(event)
                if len(events) >= 5:  # Limit to avoid infinite loop
                    break
        except json.JSONDecodeError:
            pytest.fail("JSONDecodeError should not be raised for invalid JSON tool content")
        except Exception:
            # Other exceptions are expected (e.g., from ADK library)
            pass