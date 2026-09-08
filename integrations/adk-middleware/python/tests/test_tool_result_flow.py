#!/usr/bin/env python
"""Test tool result submission flow in ADKAgent."""

import pytest
import json
import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

from ag_ui.core import (
    RunAgentInput, BaseEvent, EventType, Tool as AGUITool,
    UserMessage, ToolMessage, RunStartedEvent, RunFinishedEvent, RunErrorEvent,
    AssistantMessage, ToolCall, FunctionCall,
)

from ag_ui_adk import ADKAgent
from ag_ui_adk.session_manager import SessionManager
from tests.constants import LIVE_TEST_MODEL


class TestToolResultFlow:
    """Test cases for tool result submission flow."""


    @pytest.fixture
    def sample_tool(self):
        """Create a sample tool definition."""
        return AGUITool(
            name="test_tool",
            description="A test tool",
            parameters={
                "type": "object",
                "properties": {
                    "input": {"type": "string"}
                }
            }
        )

    @pytest.fixture
    def mock_adk_agent(self):
        """Create a mock ADK agent."""
        from google.adk.agents import LlmAgent
        return LlmAgent(
            name="test_agent",
            model=LIVE_TEST_MODEL,
            instruction="Test agent for tool flow testing"
        )

    @pytest.fixture
    def ag_ui_adk(self, mock_adk_agent):
        """Create ADK middleware with mocked dependencies."""
        SessionManager.reset_instance()
        agent = ADKAgent(
            adk_agent=mock_adk_agent,
            user_id="test_user",
            execution_timeout_seconds=60,
            tool_timeout_seconds=30
        )
        try:
            yield agent
        finally:
            SessionManager.reset_instance()

    @pytest.mark.asyncio
    async def test_is_tool_result_submission_with_tool_message(self, ag_ui_adk):
        """Test detection of tool result submission."""
        # Input with tool message as last message
        input_with_tool = RunAgentInput(
            thread_id="thread_1",
            run_id="run_1",
            messages=[
                UserMessage(id="1", role="user", content="Do something"),
                ToolMessage(id="2", role="tool", content='{"result": "success"}', tool_call_id="call_1")
            ],
            tools=[],
            context=[],
            state={},
            forwarded_props={}
        )

        assert await ag_ui_adk._is_tool_result_submission(input_with_tool) is True

    @pytest.mark.asyncio
    async def test_is_tool_result_submission_with_user_message(self, ag_ui_adk):
        """Test detection when last message is not a tool result."""
        # Input with user message as last message
        input_without_tool = RunAgentInput(
            thread_id="thread_1",
            run_id="run_1",
            messages=[
                UserMessage(id="1", role="user", content="Hello"),
                UserMessage(id="2", role="user", content="How are you?")
            ],
            tools=[],
            context=[],
            state={},
            forwarded_props={}
        )

        assert await ag_ui_adk._is_tool_result_submission(input_without_tool) is False

    @pytest.mark.asyncio
    async def test_is_tool_result_submission_empty_messages(self, ag_ui_adk):
        """Test detection with empty messages."""
        empty_input = RunAgentInput(
            thread_id="thread_1",
            run_id="run_1",
            messages=[],
            tools=[],
            context=[],
            state={},
            forwarded_props={}
        )

        assert await ag_ui_adk._is_tool_result_submission(empty_input) is False

    @pytest.mark.asyncio
    async def test_is_tool_result_submission_ignores_processed_history(self, ag_ui_adk):
        """Ensure previously processed tool messages are ignored."""
        replay_input = RunAgentInput(
            thread_id="thread_1",
            run_id="run_1",
            messages=[
                UserMessage(id="1", role="user", content="Do something"),
                ToolMessage(id="2", role="tool", content='{"result": "success"}', tool_call_id="call_1")
            ],
            tools=[],
            context=[],
            state={},
            forwarded_props={}
        )

        app_name = ag_ui_adk._get_app_name(replay_input)
        ag_ui_adk._session_manager.mark_messages_processed(app_name, replay_input.thread_id, ["1", "2"])

        assert await ag_ui_adk._is_tool_result_submission(replay_input) is False

    @pytest.mark.asyncio
    async def test_is_tool_result_submission_multiple_tool_messages(self, ag_ui_adk):
        """Detect tool submissions when multiple unseen tool results arrive together."""
        batched_input = RunAgentInput(
            thread_id="thread_1",
            run_id="run_1",
            messages=[
                UserMessage(id="1", role="user", content="First"),
                ToolMessage(id="2", role="tool", content='{"result": "partial"}', tool_call_id="call_1"),
                ToolMessage(id="3", role="tool", content='{"result": "done"}', tool_call_id="call_2")
            ],
            tools=[],
            context=[],
            state={},
            forwarded_props={}
        )

        app_name = ag_ui_adk._get_app_name(batched_input)
        ag_ui_adk._session_manager.mark_messages_processed(app_name, batched_input.thread_id, ["1"])

        assert await ag_ui_adk._is_tool_result_submission(batched_input) is True

    @pytest.mark.asyncio
    async def test_is_tool_result_submission_new_user_after_tool(self, ag_ui_adk):
        """Treat batched updates that end with a user message as non-tool submissions."""
        batched_input = RunAgentInput(
            thread_id="thread_1",
            run_id="run_1",
            messages=[
                UserMessage(id="1", role="user", content="First"),
                ToolMessage(id="2", role="tool", content='{"result": "intermediate"}', tool_call_id="call_1"),
                UserMessage(id="3", role="user", content="Thanks!")
            ],
            tools=[],
            context=[],
            state={},
            forwarded_props={}
        )

        app_name = ag_ui_adk._get_app_name(batched_input)
        ag_ui_adk._session_manager.mark_messages_processed(app_name, batched_input.thread_id, ["1"])

        assert await ag_ui_adk._is_tool_result_submission(batched_input) is False

    @pytest.mark.asyncio
    async def test_extract_tool_results_single_tool(self, ag_ui_adk):
        """Test extraction of single tool result."""
        input_data = RunAgentInput(
            thread_id="thread_1",
            run_id="run_1",
            messages=[
                UserMessage(id="1", role="user", content="Hello"),
                ToolMessage(id="2", role="tool", content='{"result": "success"}', tool_call_id="call_1")
            ],
            tools=[],
            context=[],
            state={},
            forwarded_props={}
        )

        tool_results = await ag_ui_adk._extract_tool_results(input_data, input_data.messages)

        assert len(tool_results) == 1
        assert tool_results[0]['message'].role == "tool"
        assert tool_results[0]['message'].tool_call_id == "call_1"
        assert tool_results[0]['message'].content == '{"result": "success"}'
        assert tool_results[0]['tool_name'] == "unknown"  # No tool_calls in messages

    @pytest.mark.asyncio
    async def test_extract_tool_results_multiple_tools(self, ag_ui_adk):
        """Test extraction of all unseen tool results when multiple exist."""
        input_data = RunAgentInput(
            thread_id="thread_1",
            run_id="run_1",
            messages=[
                UserMessage(id="1", role="user", content="Hello"),
                ToolMessage(id="2", role="tool", content='{"result": "first"}', tool_call_id="call_1"),
                ToolMessage(id="3", role="tool", content='{"result": "second"}', tool_call_id="call_2")
            ],
            tools=[],
            context=[],
            state={},
            forwarded_props={}
        )

        unseen_messages = input_data.messages[1:]
        tool_results = await ag_ui_adk._extract_tool_results(input_data, unseen_messages)

        assert len(tool_results) == 2
        assert [result['message'].tool_call_id for result in tool_results] == ["call_1", "call_2"]

    @pytest.mark.asyncio
    async def test_extract_tool_results_mixed_messages(self, ag_ui_adk):
        """Test extraction when mixed with other message types."""
        input_data = RunAgentInput(
            thread_id="thread_1",
            run_id="run_1",
            messages=[
                UserMessage(id="1", role="user", content="Hello"),
                ToolMessage(id="2", role="tool", content='{"result": "success"}', tool_call_id="call_1"),
                UserMessage(id="3", role="user", content="Thanks"),
                ToolMessage(id="4", role="tool", content='{"result": "done"}', tool_call_id="call_2")
            ],
            tools=[],
            context=[],
            state={},
            forwarded_props={}
        )

        unseen_messages = input_data.messages[3:]
        tool_results = await ag_ui_adk._extract_tool_results(input_data, unseen_messages)

        assert len(tool_results) == 1
        assert tool_results[0]['message'].role == "tool"
        assert tool_results[0]['message'].tool_call_id == "call_2"
        assert tool_results[0]['message'].content == '{"result": "done"}'

    @pytest.mark.asyncio
    async def test_handle_tool_result_submission_no_active_execution(self, ag_ui_adk):
        """Test handling tool result when no active execution exists."""
        input_data = RunAgentInput(
            thread_id="nonexistent_thread",
            run_id="run_1",
            messages=[
                ToolMessage(id="1", role="tool", content='{"result": "success"}', tool_call_id="call_1")
            ],
            tools=[],
            context=[],
            state={},
            forwarded_props={}
        )

        events = []
        async for event in ag_ui_adk._handle_tool_result_submission(input_data):
            events.append(event)

        # In all-long-running architecture, tool results without active execution
        # are treated as standalone results from LongRunningTools and start new executions
        # However, ADK may error if there's no conversation history for the tool result
        assert len(events) >= 1  # At least RUN_STARTED, potentially RUN_ERROR and RUN_FINISHED

    @pytest.mark.asyncio
    async def test_handle_tool_result_submission_no_active_execution_no_tools(self, ag_ui_adk):
        """Test handling tool result when no tool results exist."""
        input_data = RunAgentInput(
            thread_id="nonexistent_thread",
            run_id="run_1",
            messages=[
                UserMessage(id="1", role="user", content="Hello")  # No tool messages
            ],
            tools=[],
            context=[],
            state={},
            forwarded_props={}
        )

        events = []
        async for event in ag_ui_adk._handle_tool_result_submission(input_data):
            events.append(event)

        # When there are no tool results, should emit error for missing tool results
        assert len(events) == 1
        assert isinstance(events[0], RunErrorEvent)
        assert events[0].code == "NO_TOOL_RESULTS"
        assert "No tool results found in submission" in events[0].message

    @pytest.mark.asyncio
    async def test_handle_tool_result_submission_with_active_execution(self, ag_ui_adk):
        """Test handling tool result - starts new execution regardless of existing executions."""
        thread_id = "test_thread"

        # Mock the _stream_events method to simulate new execution
        mock_events = [
            MagicMock(type=EventType.TEXT_MESSAGE_CONTENT),
            MagicMock(type=EventType.TEXT_MESSAGE_END)
        ]

        async def mock_stream_events(execution):
            for event in mock_events:
                yield event

        with patch.object(ag_ui_adk, '_stream_events', side_effect=mock_stream_events):
            input_data = RunAgentInput(
                thread_id=thread_id,
                run_id="run_1",
                messages=[
                    ToolMessage(id="1", role="tool", content='{"result": "success"}', tool_call_id="call_1")
                ],
                tools=[],
                context=[],
                state={},
                forwarded_props={}
            )

            events = []
            async for event in ag_ui_adk._handle_tool_result_submission(input_data):
                events.append(event)

            # Should receive RUN_STARTED + mock events + RUN_FINISHED (4 total)
            assert len(events) == 4
            assert events[0].type == EventType.RUN_STARTED
            assert events[-1].type == EventType.RUN_FINISHED
            # In all-long-running architecture, tool results start new executions

    @pytest.mark.asyncio
    async def test_handle_tool_result_submission_streaming_error(self, ag_ui_adk):
        """Test handling when streaming events fails."""
        thread_id = "test_thread"

        # Mock _stream_events to raise an exception
        async def mock_stream_events(execution):
            raise RuntimeError("Streaming failed")
            yield  # Make it a generator

        with patch.object(ag_ui_adk, '_stream_events', side_effect=mock_stream_events):
            input_data = RunAgentInput(
                thread_id=thread_id,
                run_id="run_1",
                messages=[
                    ToolMessage(id="1", role="tool", content='{"result": "success"}', tool_call_id="call_1")
                ],
                tools=[],
                context=[],
                state={},
                forwarded_props={}
            )

            events = []
            async for event in ag_ui_adk._handle_tool_result_submission(input_data):
                events.append(event)

            # Should emit RUN_STARTED then error event when streaming fails
            assert len(events) == 2
            assert events[0].type == EventType.RUN_STARTED
            assert isinstance(events[1], RunErrorEvent)
            assert events[1].code == "EXECUTION_ERROR"
            assert "Streaming failed" in events[1].message

    @pytest.mark.asyncio
    async def test_handle_tool_result_submission_invalid_json(self, ag_ui_adk):
        """Test handling tool result with invalid JSON content."""
        thread_id = "test_thread"

        input_data = RunAgentInput(
            thread_id=thread_id,
            run_id="run_1",
            messages=[
                ToolMessage(id="1", role="tool", content='invalid json{', tool_call_id="call_1")
            ],
            tools=[],
            context=[],
            state={},
            forwarded_props={}
        )

        events = []
        async for event in ag_ui_adk._handle_tool_result_submission(input_data):
            events.append(event)

        # Should start new execution, handle invalid JSON gracefully, and complete
        # Invalid JSON is handled gracefully in _run_adk_in_background by providing error result
        assert len(events) >= 2  # At least RUN_STARTED and some completion
        assert events[0].type == EventType.RUN_STARTED

    @pytest.mark.asyncio
    async def test_handle_tool_result_submission_multiple_results(self, ag_ui_adk):
        """Test handling multiple tool results in one submission preserves all unseen results."""
        thread_id = "test_thread"

        input_data = RunAgentInput(
            thread_id=thread_id,
            run_id="run_1",
            messages=[
                ToolMessage(id="1", role="tool", content='{"result": "first"}', tool_call_id="call_1"),
                ToolMessage(id="2", role="tool", content='{"result": "second"}', tool_call_id="call_2")
            ],
            tools=[],
            context=[],
            state={},
            forwarded_props={}
        )

        tool_results = await ag_ui_adk._extract_tool_results(input_data, input_data.messages)
        assert len(tool_results) == 2
        assert [result['message'].tool_call_id for result in tool_results] == ["call_1", "call_2"]

    @pytest.mark.asyncio
    async def test_tool_result_flow_integration(self, ag_ui_adk):
        """Test complete tool result flow through run method."""
        # First, simulate a request that would create an execution
        # (This is complex to mock fully, so we test the routing logic)

        # Test tool result routing
        tool_result_input = RunAgentInput(
            thread_id="thread_1",
            run_id="run_1",
            messages=[
                ToolMessage(id="1", role="tool", content='{"result": "success"}', tool_call_id="call_1")
            ],
            tools=[],
            context=[],
            state={},
            forwarded_props={}
        )

        # In the all-long-running architecture, tool result inputs are processed as new executions
        # Mock the background execution to avoid ADK library errors
        async def mock_start_new_execution(input_data, *, tool_results=None, message_batch=None):
            yield RunStartedEvent(
                type=EventType.RUN_STARTED,
                thread_id=input_data.thread_id,
                run_id=input_data.run_id
            )
            # In all-long-running architecture, tool results are processed through ADK sessions
            yield RunFinishedEvent(
                type=EventType.RUN_FINISHED,
                thread_id=input_data.thread_id,
                run_id=input_data.run_id
            )

        with patch.object(ag_ui_adk, '_start_new_execution', side_effect=mock_start_new_execution):
            events = []
            async for event in ag_ui_adk.run(tool_result_input):
                events.append(event)

            # Should get RUN_STARTED and RUN_FINISHED events
            assert len(events) == 2
            assert events[0].type == EventType.RUN_STARTED
            assert events[1].type == EventType.RUN_FINISHED

    @pytest.mark.asyncio
    async def test_run_processes_mixed_unseen_messages(self, ag_ui_adk):
        """Ensure mixed unseen tool and user messages are handled sequentially."""
        input_data = RunAgentInput(
            thread_id="thread_mixed",
            run_id="run_mixed",
            messages=[
                ToolMessage(id="tool_1", role="tool", content='{"result": "value"}', tool_call_id="call_1"),
                UserMessage(id="user_2", role="user", content="Next question"),
            ],
            tools=[],
            context=[],
            state={},
            forwarded_props={},
        )

        start_calls = []

        async def mock_start_new_execution(input_data, *, tool_results=None, message_batch=None):
            start_calls.append((tool_results, message_batch))
            yield RunStartedEvent(
                type=EventType.RUN_STARTED,
                thread_id=input_data.thread_id,
                run_id=input_data.run_id,
            )
            yield RunFinishedEvent(
                type=EventType.RUN_FINISHED,
                thread_id=input_data.thread_id,
                run_id=input_data.run_id,
            )

        # Mock pending tool call check to return True so tool result is accepted
        async def mock_has_pending_tool_calls(*_args, **_kwargs):
            return True

        with patch.object(
            ag_ui_adk,
            '_start_new_execution',
            side_effect=mock_start_new_execution,
        ), patch.object(
            ag_ui_adk,
            '_handle_tool_result_submission',
            wraps=ag_ui_adk._handle_tool_result_submission,
        ) as handle_mock, patch.object(
            ag_ui_adk,
            '_has_pending_tool_calls',
            side_effect=mock_has_pending_tool_calls,
        ), patch.object(
            ag_ui_adk,
            '_remove_pending_tool_call',
            new=AsyncMock(),
        ):
            events = []
            async for event in ag_ui_adk.run(input_data):
                events.append(event)

        # The system optimizes by sending tool result + trailing user message together
        # So we expect ONE run (2 events), not two separate runs (4 events)
        assert len(events) == 2
        assert [event.type for event in events] == [
            EventType.RUN_STARTED,
            EventType.RUN_FINISHED,
        ]

        # Single call with tool results AND the trailing user message
        assert len(start_calls) == 1
        tool_results, message_batch = start_calls[0]
        assert tool_results is not None and len(tool_results) == 1
        assert tool_results[0]['message'].tool_call_id == "call_1"
        # Trailing user message is included in the same invocation
        assert message_batch == [input_data.messages[1]]

        assert handle_mock.call_count == 1
        assert 'tool_messages' in handle_mock.call_args.kwargs
        tool_messages = handle_mock.call_args.kwargs['tool_messages']
        assert len(tool_messages) == 1
        assert getattr(tool_messages[0], 'id', None) == "tool_1"

    @pytest.mark.asyncio
    async def test_run_skips_assistant_history_before_tool_result(self, ag_ui_adk):
        """Assistant tool call history should not trigger a new execution before tool results arrive."""
        assistant_call = AssistantMessage(
            id="assistant_tool",
            role="assistant",
            content=None,
            tool_calls=[
                ToolCall(
                    id="call_1",
                    function=FunctionCall(name="test_tool", arguments="{}"),
                )
            ],
        )

        tool_result = ToolMessage(
            id="tool_result",
            role="tool",
            content='{"result": "value"}',
            tool_call_id="call_1",
        )

        input_data = RunAgentInput(
            thread_id="thread_assistant_tool",
            run_id="run_assistant_tool",
            messages=[
                UserMessage(id="user_initial", role="user", content="Initial question"),
                assistant_call,
                tool_result,
            ],
            tools=[],
            context=[],
            state={},
            forwarded_props={},
        )

        # Mark the initial user message as already processed so only the assistant call and tool result are unseen
        app_name = ag_ui_adk._get_app_name(input_data)
        ag_ui_adk._session_manager.mark_messages_processed(app_name, input_data.thread_id, ["user_initial"])

        start_calls = []

        async def mock_start_new_execution(input_data, *, tool_results=None, message_batch=None):
            start_calls.append((tool_results, message_batch))

            call_id = None
            if tool_results:
                call_id = tool_results[0]['message'].tool_call_id
            elif message_batch:
                for message in message_batch:
                    tool_calls = getattr(message, "tool_calls", None)
                    if tool_calls:
                        call_id = tool_calls[0].id
                        break

            if call_id:
                await ag_ui_adk._add_pending_tool_call_with_context(
                    input_data.thread_id,
                    call_id,
                    ag_ui_adk._get_app_name(input_data),
                    ag_ui_adk._get_user_id(input_data),
                )

            yield RunStartedEvent(
                type=EventType.RUN_STARTED,
                thread_id=input_data.thread_id,
                run_id=input_data.run_id,
            )
            yield RunFinishedEvent(
                type=EventType.RUN_FINISHED,
                thread_id=input_data.thread_id,
                run_id=input_data.run_id,
            )

        with patch.object(
            ag_ui_adk,
            '_start_new_execution',
            side_effect=mock_start_new_execution,
        ) as start_mock, patch.object(
            ag_ui_adk,
            '_handle_tool_result_submission',
            wraps=ag_ui_adk._handle_tool_result_submission,
        ), patch.object(
            ag_ui_adk,
            '_add_pending_tool_call_with_context',
            new_callable=AsyncMock,
        ) as pending_mock:
            events = []
            async for event in ag_ui_adk.run(input_data):
                events.append(event)

        assert [event.type for event in events] == [
            EventType.RUN_STARTED,
            EventType.RUN_FINISHED,
        ]

        assert start_mock.call_count == 1
        assert len(start_calls) == 1
        first_tool_results, first_batch = start_calls[0]
        assert first_tool_results is not None
        assert first_batch is None
        assert first_tool_results[0]['message'].id == "tool_result"

        assert pending_mock.await_count == 1
        pending_call = pending_mock.await_args_list[0]
        assert pending_call.args[1] == "call_1"

        processed_ids = ag_ui_adk._session_manager.get_processed_message_ids(app_name, input_data.thread_id)
        assert "assistant_tool" in processed_ids

    @pytest.mark.asyncio
    async def test_run_preserves_order_for_user_then_tool(self, ag_ui_adk):
        """Verify user updates are handled before subsequent tool messages."""
        input_data = RunAgentInput(
            thread_id="thread_order",
            run_id="run_order",
            messages=[
                UserMessage(id="user_1", role="user", content="Question"),
                ToolMessage(id="tool_2", role="tool", content='{"result": "answer"}', tool_call_id="call_2"),
            ],
            tools=[],
            context=[],
            state={},
            forwarded_props={},
        )

        call_sequence = []

        async def mock_start_new_execution(input_data, *, tool_results=None, message_batch=None):
            call_sequence.append(("start", tool_results, message_batch))
            yield RunStartedEvent(
                type=EventType.RUN_STARTED,
                thread_id=input_data.thread_id,
                run_id=input_data.run_id,
            )
            yield RunFinishedEvent(
                type=EventType.RUN_FINISHED,
                thread_id=input_data.thread_id,
                run_id=input_data.run_id,
            )

        async def mock_handle_tool_result_submission(input_data, *, tool_messages=None, **kwargs):
            call_sequence.append(("tool", tool_messages))
            yield RunStartedEvent(
                type=EventType.RUN_STARTED,
                thread_id=input_data.thread_id,
                run_id=input_data.run_id,
            )
            yield RunFinishedEvent(
                type=EventType.RUN_FINISHED,
                thread_id=input_data.thread_id,
                run_id=input_data.run_id,
            )

        with patch.object(
            ag_ui_adk,
            '_start_new_execution',
            side_effect=mock_start_new_execution,
        ), patch.object(
            ag_ui_adk,
            '_handle_tool_result_submission',
            side_effect=mock_handle_tool_result_submission,
        ):
            events = []
            async for event in ag_ui_adk.run(input_data):
                events.append(event)

        assert [event.type for event in events] == [
            EventType.RUN_STARTED,
            EventType.RUN_FINISHED,
            EventType.RUN_STARTED,
            EventType.RUN_FINISHED,
        ]

        assert call_sequence[0][0] == "start"
        assert call_sequence[0][1] is None
        assert call_sequence[0][2] == [input_data.messages[0]]

        assert call_sequence[1][0] == "tool"
        assert len(call_sequence[1][1]) == 1
        assert getattr(call_sequence[1][1][0], 'id', None) == "tool_2"

    @pytest.mark.asyncio
    async def test_new_execution_routing(self, ag_ui_adk, sample_tool):
        """Test that non-tool messages route to new execution."""
        new_request_input = RunAgentInput(
            thread_id="thread_1",
            run_id="run_1",
            messages=[
                UserMessage(id="1", role="user", content="Hello")
            ],
            tools=[sample_tool],
            context=[],
            state={},
            forwarded_props={}
        )

        # Mock the _start_new_execution method
        mock_events = [
            RunStartedEvent(type=EventType.RUN_STARTED, thread_id="thread_1", run_id="run_1"),
            RunFinishedEvent(type=EventType.RUN_FINISHED, thread_id="thread_1", run_id="run_1")
        ]

        async def mock_start_new_execution(input_data, *, tool_results=None, message_batch=None):
            for event in mock_events:
                yield event

        with patch.object(ag_ui_adk, '_start_new_execution', side_effect=mock_start_new_execution):
            events = []
            async for event in ag_ui_adk.run(new_request_input):
                events.append(event)

            assert len(events) == 2
            assert isinstance(events[0], RunStartedEvent)
            assert isinstance(events[1], RunFinishedEvent)


class TestConfirmChangesFiltering:
    """Test cases for filtering synthetic confirm_changes tool results."""

    @pytest.fixture
    def mock_adk_agent(self):
        """Create a mock ADK agent."""
        from google.adk.agents import LlmAgent
        return LlmAgent(
            name="test_agent",
            model=LIVE_TEST_MODEL,
            instruction="Test agent for confirm_changes filtering"
        )

    @pytest.fixture
    def ag_ui_adk(self, mock_adk_agent):
        """Create ADK middleware with mocked dependencies."""
        SessionManager.reset_instance()
        agent = ADKAgent(
            adk_agent=mock_adk_agent,
            user_id="test_user",
            execution_timeout_seconds=60,
            tool_timeout_seconds=30
        )
        try:
            yield agent
        finally:
            SessionManager.reset_instance()

    @pytest.mark.asyncio
    async def test_extract_tool_results_filters_confirm_changes(self, ag_ui_adk):
        """Test that _extract_tool_results filters out confirm_changes tool results."""
        # Create a message history with a confirm_changes tool call and result
        input_data = RunAgentInput(
            thread_id="thread_1",
            run_id="run_1",
            messages=[
                UserMessage(id="1", role="user", content="Create a document"),
                AssistantMessage(
                    id="2",
                    role="assistant",
                    content=None,
                    tool_calls=[
                        ToolCall(
                            id="call_confirm",
                            function=FunctionCall(name="confirm_changes", arguments="{}")
                        )
                    ]
                ),
                ToolMessage(id="3", role="tool", content='{"approved": true}', tool_call_id="call_confirm")
            ],
            tools=[],
            context=[],
            state={},
            forwarded_props={}
        )

        # Extract tool results - confirm_changes should be filtered out
        tool_results = await ag_ui_adk._extract_tool_results(input_data, input_data.messages)

        # Should return empty list because confirm_changes is filtered
        assert len(tool_results) == 0

    @pytest.mark.asyncio
    async def test_extract_tool_results_keeps_regular_tools(self, ag_ui_adk):
        """Test that _extract_tool_results keeps regular (non-confirm_changes) tool results."""
        # Create a message history with a regular tool call and result
        input_data = RunAgentInput(
            thread_id="thread_1",
            run_id="run_1",
            messages=[
                UserMessage(id="1", role="user", content="Search for something"),
                AssistantMessage(
                    id="2",
                    role="assistant",
                    content=None,
                    tool_calls=[
                        ToolCall(
                            id="call_search",
                            function=FunctionCall(name="search_tool", arguments='{"query": "test"}')
                        )
                    ]
                ),
                ToolMessage(id="3", role="tool", content='{"results": ["item1"]}', tool_call_id="call_search")
            ],
            tools=[],
            context=[],
            state={},
            forwarded_props={}
        )

        # Extract tool results - regular tools should be kept
        tool_results = await ag_ui_adk._extract_tool_results(input_data, input_data.messages)

        # Should return the search_tool result
        assert len(tool_results) == 1
        assert tool_results[0]['tool_name'] == "search_tool"
        assert tool_results[0]['message'].tool_call_id == "call_search"

    @pytest.mark.asyncio
    async def test_extract_tool_results_mixed_tools(self, ag_ui_adk):
        """Test that _extract_tool_results filters confirm_changes but keeps other tools."""
        # Create a message history with both confirm_changes and regular tool results
        input_data = RunAgentInput(
            thread_id="thread_1",
            run_id="run_1",
            messages=[
                UserMessage(id="1", role="user", content="Search and confirm"),
                AssistantMessage(
                    id="2",
                    role="assistant",
                    content=None,
                    tool_calls=[
                        ToolCall(
                            id="call_search",
                            function=FunctionCall(name="search_tool", arguments='{"query": "test"}')
                        ),
                        ToolCall(
                            id="call_confirm",
                            function=FunctionCall(name="confirm_changes", arguments="{}")
                        )
                    ]
                ),
                ToolMessage(id="3", role="tool", content='{"results": ["item1"]}', tool_call_id="call_search"),
                ToolMessage(id="4", role="tool", content='{"approved": true}', tool_call_id="call_confirm")
            ],
            tools=[],
            context=[],
            state={},
            forwarded_props={}
        )

        # Extract tool results
        tool_results = await ag_ui_adk._extract_tool_results(input_data, input_data.messages)

        # Should return only the search_tool result
        assert len(tool_results) == 1
        assert tool_results[0]['tool_name'] == "search_tool"

    @pytest.mark.asyncio
    async def test_handle_tool_result_submission_only_confirm_changes(self, ag_ui_adk):
        """Test _handle_tool_result_submission with only confirm_changes tool results.

        When all tool results are synthetic (confirm_changes), the method should:
        - Mark the tool messages as processed
        - NOT emit an error
        - Simply return without starting a new execution
        """
        input_data = RunAgentInput(
            thread_id="thread_confirm_only",
            run_id="run_1",
            messages=[
                UserMessage(id="1", role="user", content="Create document"),
                AssistantMessage(
                    id="2",
                    role="assistant",
                    content=None,
                    tool_calls=[
                        ToolCall(
                            id="call_confirm",
                            function=FunctionCall(name="confirm_changes", arguments="{}")
                        )
                    ]
                ),
                ToolMessage(id="3", role="tool", content='{"approved": true}', tool_call_id="call_confirm")
            ],
            tools=[],
            context=[],
            state={},
            forwarded_props={}
        )

        # Mark user and assistant messages as processed
        app_name = ag_ui_adk._get_app_name(input_data)
        ag_ui_adk._session_manager.mark_messages_processed(app_name, input_data.thread_id, ["1", "2"])

        events = []
        async for event in ag_ui_adk._handle_tool_result_submission(
            input_data,
            tool_messages=[input_data.messages[2]],  # Just the tool message
        ):
            events.append(event)

        # Should emit RUN_STARTED + RUN_FINISHED (valid terminal stream, no error)
        assert len(events) == 2
        assert events[0].type == EventType.RUN_STARTED
        assert events[1].type == EventType.RUN_FINISHED

        # Confirm_changes tool message should be marked as processed
        processed_ids = ag_ui_adk._session_manager.get_processed_message_ids(app_name, input_data.thread_id)
        assert "3" in processed_ids

    @pytest.mark.asyncio
    async def test_handle_tool_result_submission_confirm_changes_with_trailing_messages(self, ag_ui_adk):
        """Test _handle_tool_result_submission with confirm_changes and trailing user message.

        When all tool results are synthetic but there's a follow-up user message,
        it should start a new execution for that user message.
        """
        input_data = RunAgentInput(
            thread_id="thread_confirm_trailing",
            run_id="run_1",
            messages=[
                UserMessage(id="1", role="user", content="Create document"),
                AssistantMessage(
                    id="2",
                    role="assistant",
                    content=None,
                    tool_calls=[
                        ToolCall(
                            id="call_confirm",
                            function=FunctionCall(name="confirm_changes", arguments="{}")
                        )
                    ]
                ),
                ToolMessage(id="3", role="tool", content='{"approved": true}', tool_call_id="call_confirm"),
                UserMessage(id="4", role="user", content="Now add a title")  # Trailing message
            ],
            tools=[],
            context=[],
            state={},
            forwarded_props={}
        )

        # Mark initial messages as processed
        app_name = ag_ui_adk._get_app_name(input_data)
        ag_ui_adk._session_manager.mark_messages_processed(app_name, input_data.thread_id, ["1", "2"])

        # Mock _start_new_execution to track calls
        start_calls = []

        async def mock_start_new_execution(input_data, *, tool_results=None, message_batch=None):
            start_calls.append({"tool_results": tool_results, "message_batch": message_batch})
            yield RunStartedEvent(
                type=EventType.RUN_STARTED,
                thread_id=input_data.thread_id,
                run_id=input_data.run_id
            )
            yield RunFinishedEvent(
                type=EventType.RUN_FINISHED,
                thread_id=input_data.thread_id,
                run_id=input_data.run_id
            )

        with patch.object(ag_ui_adk, '_start_new_execution', side_effect=mock_start_new_execution):
            events = []
            async for event in ag_ui_adk._handle_tool_result_submission(
                input_data,
                tool_messages=[input_data.messages[2]],  # confirm_changes tool message
                trailing_messages=[input_data.messages[3]],  # Trailing user message
            ):
                events.append(event)

        # Should have started a new execution for the trailing message
        assert len(events) == 2
        assert events[0].type == EventType.RUN_STARTED
        assert events[1].type == EventType.RUN_FINISHED

        # Should have called _start_new_execution with the trailing message, no tool results
        assert len(start_calls) == 1
        assert start_calls[0]["tool_results"] is None
        assert len(start_calls[0]["message_batch"]) == 1
        assert start_calls[0]["message_batch"][0].id == "4"


class TestClientToolResultPersistence:
    """Test that client-side tool results are persisted to the ADK session database."""

    @pytest.fixture
    def mock_adk_agent(self):
        """Create a mock ADK agent."""
        from google.adk.agents import LlmAgent
        return LlmAgent(
            name="test_agent",
            model=LIVE_TEST_MODEL,
            instruction="Test agent for persistence testing"
        )

    @pytest.fixture
    def ag_ui_adk(self, mock_adk_agent):
        """Create ADK middleware with mocked dependencies."""
        SessionManager.reset_instance()
        agent = ADKAgent(
            adk_agent=mock_adk_agent,
            app_name="test_app",
            user_id="test_user",
            execution_timeout_seconds=60,
            tool_timeout_seconds=30
        )
        try:
            yield agent
        finally:
            SessionManager.reset_instance()

    @pytest.mark.asyncio
    async def test_client_tool_result_persisted_to_session_db(self, ag_ui_adk):
        """Test that client-side tool results are persisted to the ADK session database.

        This is a regression test for GitHub issue #568 where client-side tool call
        results were not being persisted to the ADK Session DB when they arrived
        alongside a user message.

        The fix uses append_event() instead of just session.events.append() to ensure
        the FunctionResponse is properly persisted.
        """
        thread_id = "test_thread_persistence"
        tool_call_id = "client_tool_call_123"

        # Create the input with tool result + user message (the problematic scenario)
        input_data = RunAgentInput(
            thread_id=thread_id,
            run_id="run_1",
            messages=[
                UserMessage(id="user_1", role="user", content="Initial request"),
                AssistantMessage(
                    id="assistant_1",
                    role="assistant",
                    content=None,
                    tool_calls=[
                        ToolCall(
                            id=tool_call_id,
                            function=FunctionCall(name="render_items", arguments='{"items": ["a", "b"]}')
                        )
                    ]
                ),
                ToolMessage(
                    id="tool_result_1",
                    role="tool",
                    content='{"status": "success", "rendered": true}',
                    tool_call_id=tool_call_id
                ),
                UserMessage(id="user_2", role="user", content="Thanks, that looks good!")
            ],
            tools=[
                AGUITool(
                    name="render_items",
                    description="Render items in UI",
                    parameters={"type": "object", "properties": {"items": {"type": "array"}}}
                )
            ],
            context=[],
            state={},
            forwarded_props={}
        )

        # Mark initial messages as processed (simulating previous run)
        app_name = ag_ui_adk._get_app_name(input_data)
        ag_ui_adk._session_manager.mark_messages_processed(app_name, thread_id, ["user_1", "assistant_1"])

        # Add the tool call to pending (simulating HITL scenario)
        session, backend_session_id = await ag_ui_adk._ensure_session_exists(
            app_name=app_name,
            user_id="test_user",
            thread_id=thread_id,
            initial_state={}
        )
        await ag_ui_adk._add_pending_tool_call_with_context(
            thread_id, tool_call_id, app_name, "test_user"
        )

        # We need to simulate the FunctionCall being in the session first
        # (this is what the ADK would have stored when the tool was originally called)
        session = await ag_ui_adk._session_manager._session_service.get_session(
            session_id=backend_session_id,
            app_name=app_name,
            user_id="test_user"
        )

        from google.adk.sessions.session import Event
        from google.genai import types
        import time

        # Add the original function call to the session (simulating ADK behavior)
        function_call_content = types.Content(
            parts=[
                types.Part(
                    function_call=types.FunctionCall(
                        id=tool_call_id,
                        name="render_items",
                        args={"items": ["a", "b"]}
                    )
                )
            ],
            role="model"
        )
        function_call_event = Event(
            timestamp=time.time(),
            author="test_agent",
            content=function_call_content
        )
        await ag_ui_adk._session_manager._session_service.append_event(session, function_call_event)

        # Mock the ADK runner to avoid actually calling the LLM
        async def mock_run_async(**kwargs):
            # Just yield nothing - we're testing the persistence, not the LLM response
            if False:
                yield None

        # Create a mock runner class
        class MockRunner:
            def __init__(self, *args, **kwargs):
                pass
            async def run_async(self, **kwargs):
                async def empty_generator():
                    return
                    yield  # Make it a generator
                return empty_generator()

        # Prepare tool results as the code expects
        tool_results = [
            {
                'tool_name': 'render_items',
                'message': input_data.messages[2]  # ToolMessage
            }
        ]
        message_batch = [input_data.messages[3]]  # The trailing user message

        with patch.object(ag_ui_adk, '_create_runner', return_value=MockRunner()):
            event_queue = asyncio.Queue()

            # Call _run_adk_in_background directly to test the persistence logic
            await ag_ui_adk._run_adk_in_background(
                input=input_data,
                adk_agent=ag_ui_adk._adk_agent,
                user_id="test_user",
                app_name=app_name,
                event_queue=event_queue,
                client_proxy_toolsets=[],
                tool_results=tool_results,
                message_batch=message_batch
            )

        # Now verify the FunctionResponse was persisted to the session
        # Use backend_session_id (from _ensure_session_exists earlier) for direct session lookup
        session = await ag_ui_adk._session_manager._session_service.get_session(
            session_id=backend_session_id,
            app_name=app_name,
            user_id="test_user"
        )

        assert session is not None, "Session should exist"

        # Find the FunctionResponse event in the session
        found_function_response = False
        for event in session.events:
            if event.content and hasattr(event.content, 'parts'):
                for part in event.content.parts:
                    if hasattr(part, 'function_response') and part.function_response:
                        fr = part.function_response
                        if hasattr(fr, 'id') and fr.id == tool_call_id:
                            found_function_response = True
                            # Verify the response content
                            assert fr.name == "render_items"
                            assert fr.response is not None
                            break

        assert found_function_response, (
            f"FunctionResponse for tool_call_id={tool_call_id} should be persisted "
            f"in session.events. Found {len(session.events)} events."
        )

    @pytest.mark.asyncio
    async def test_backend_tool_results_not_double_persisted(self, ag_ui_adk):
        """Test that backend tool results are NOT double-persisted.

        Backend tool results are handled internally by the ADK Runner, which
        automatically persists them. Our append_event() fix for client-side tools
        (issue #568) should NOT affect backend tools.

        This test verifies that when a backend tool result comes through as a
        ToolCallResultEvent (via EventTranslator), we don't also persist it
        via append_event() - the paths are distinct.
        """
        thread_id = "test_thread_backend"
        backend_tool_call_id = "backend_tool_call_456"

        # Create input WITHOUT any tool messages (backend tools don't come from client)
        input_data = RunAgentInput(
            thread_id=thread_id,
            run_id="run_1",
            messages=[
                UserMessage(id="user_1", role="user", content="What's the weather?"),
            ],
            tools=[],  # No client-side tools
            context=[],
            state={},
            forwarded_props={}
        )

        app_name = ag_ui_adk._get_app_name(input_data)

        # Ensure session exists
        session, backend_session_id = await ag_ui_adk._ensure_session_exists(
            app_name=app_name,
            user_id="test_user",
            thread_id=thread_id,
            initial_state={}
        )

        # Get initial event count
        session_before = await ag_ui_adk._session_manager._session_service.get_session(
            session_id=backend_session_id,
            app_name=app_name,
            user_id="test_user"
        )
        initial_event_count = len(session_before.events)

        from google.genai import types

        # Create a mock runner that simulates backend tool execution
        # Backend tools emit events through runner.run_async(), not via input.messages
        class MockRunnerWithBackendTool:
            def __init__(self, *args, **kwargs):
                pass

            async def run_async(self, **kwargs):
                from types import SimpleNamespace

                # Simulate backend tool call event
                tool_call_event = SimpleNamespace(
                    id="event-tool-call",
                    author="assistant",
                    content=SimpleNamespace(
                        parts=[
                            SimpleNamespace(
                                function_call=SimpleNamespace(
                                    id=backend_tool_call_id,
                                    name="get_weather",
                                    args={"city": "NYC"}
                                ),
                                text=None,
                                function_response=None
                            )
                        ],
                        role="model"
                    ),
                    partial=False,
                    turn_complete=False,
                    long_running_tool_ids=[],  # Not long-running - backend tool
                    get_function_calls=lambda: [SimpleNamespace(
                        id=backend_tool_call_id,
                        name="get_weather",
                        args={"city": "NYC"}
                    )],
                    get_function_responses=lambda: [],
                    is_final_response=lambda: False
                )

                # Simulate backend tool result event (ADK handles this internally)
                tool_result_event = SimpleNamespace(
                    id="event-tool-result",
                    author="assistant",
                    content=SimpleNamespace(
                        parts=[
                            SimpleNamespace(
                                function_response=SimpleNamespace(
                                    id=backend_tool_call_id,
                                    name="get_weather",
                                    response={"temperature": "72F"}
                                ),
                                text=None,
                                function_call=None
                            )
                        ],
                        role="model"
                    ),
                    partial=False,
                    turn_complete=False,
                    long_running_tool_ids=[],
                    get_function_calls=lambda: [],
                    get_function_responses=lambda: [SimpleNamespace(
                        id=backend_tool_call_id,
                        name="get_weather",
                        response={"temperature": "72F"}
                    )],
                    is_final_response=lambda: False
                )

                # Final text response
                final_event = SimpleNamespace(
                    id="event-final",
                    author="assistant",
                    content=SimpleNamespace(
                        parts=[SimpleNamespace(text="The weather is 72F", function_call=None, function_response=None)],
                        role="model"
                    ),
                    partial=False,
                    turn_complete=True,
                    long_running_tool_ids=[],
                    get_function_calls=lambda: [],
                    get_function_responses=lambda: [],
                    is_final_response=lambda: True
                )

                yield tool_call_event
                yield tool_result_event
                yield final_event

        with patch.object(ag_ui_adk, '_create_runner', return_value=MockRunnerWithBackendTool()):
            event_queue = asyncio.Queue()

            # Call _run_adk_in_background with NO tool_results (backend tools don't come this way)
            await ag_ui_adk._run_adk_in_background(
                input=input_data,
                adk_agent=ag_ui_adk._adk_agent,
                user_id="test_user",
                app_name=app_name,
                event_queue=event_queue,
                client_proxy_toolsets=[],
                tool_results=None,  # No client-side tool results
                message_batch=None
            )

        # Get final session state
        session_after = await ag_ui_adk._session_manager._session_service.get_session(
            session_id=backend_session_id,
            app_name=app_name,
            user_id="test_user"
        )

        # Count FunctionResponse events for our backend tool
        function_response_count = 0
        for event in session_after.events:
            if event.content and hasattr(event.content, 'parts'):
                for part in event.content.parts:
                    if hasattr(part, 'function_response') and part.function_response:
                        fr = part.function_response
                        if hasattr(fr, 'id') and fr.id == backend_tool_call_id:
                            function_response_count += 1

        # Backend tool results should NOT be persisted by our code
        # (they would be persisted by the real ADK Runner, but our mock doesn't do that)
        # The key assertion is that we didn't DOUBLE-persist via our append_event() path
        assert function_response_count == 0, (
            f"Backend tool FunctionResponse should NOT be persisted by our code. "
            f"Found {function_response_count} FunctionResponse events for backend tool. "
            "Our append_event() fix should only apply to client-side tool results."
        )


class TestDatabaseSessionServiceCompatibility:
    """Tests for DatabaseSessionService compatibility fixes.

    These tests verify the fixes for PR #958:
    1. invocation_id is set on function response events
    2. Session is refreshed after state updates to prevent stale session errors

    See: https://github.com/ag-ui-protocol/ag-ui/issues/957
    """

    @pytest.fixture
    def mock_adk_agent(self):
        """Create a mock ADK agent."""
        from google.adk.agents import LlmAgent
        return LlmAgent(
            name="test_agent",
            model=LIVE_TEST_MODEL,
            instruction="Test agent for DatabaseSessionService compatibility"
        )

    @pytest.fixture
    def ag_ui_adk(self, mock_adk_agent):
        """Create ADK middleware with mocked dependencies."""
        SessionManager.reset_instance()
        agent = ADKAgent(
            adk_agent=mock_adk_agent,
            app_name="test_app",
            user_id="test_user",
            execution_timeout_seconds=60,
            tool_timeout_seconds=30
        )
        try:
            yield agent
        finally:
            SessionManager.reset_instance()

    async def _prepare_session_with_pending_tool_call(
        self,
        *,
        ag_ui_adk,
        input_data,
        tool_call_id,
        tool_name,
        tool_args,
        processed_message_ids,
    ):
        """Create session, mark processed messages, add pending tool call, and add a FunctionCall event."""
        from google.adk.sessions.session import Event
        from google.genai import types
        import time

        app_name = ag_ui_adk._get_app_name(input_data)
        if processed_message_ids:
            ag_ui_adk._session_manager.mark_messages_processed(
                app_name, input_data.thread_id, processed_message_ids
            )

        session, backend_session_id = await ag_ui_adk._ensure_session_exists(
            app_name=app_name,
            user_id="test_user",
            thread_id=input_data.thread_id,
            initial_state={},
        )
        await ag_ui_adk._add_pending_tool_call_with_context(
            input_data.thread_id, tool_call_id, app_name, "test_user"
        )

        function_call_content = types.Content(
            parts=[
                types.Part(
                    function_call=types.FunctionCall(
                        id=tool_call_id,
                        name=tool_name,
                        args=tool_args,
                    )
                )
            ],
            role="model",
        )
        function_call_event = Event(
            timestamp=time.time(),
            author="test_agent",
            content=function_call_content,
        )
        await ag_ui_adk._session_manager._session_service.append_event(
            session, function_call_event
        )

        return app_name, backend_session_id

    def _assert_function_response_invocation_id(
        self, session, tool_call_id, expected_run_id
    ):
        """Assert FunctionResponse event has the expected invocation_id."""
        for event in session.events:
            if event.content and hasattr(event.content, "parts"):
                for part in event.content.parts:
                    if hasattr(part, "function_response") and part.function_response:
                        fr = part.function_response
                        if hasattr(fr, "id") and fr.id == tool_call_id:
                            assert hasattr(event, "invocation_id"), (
                                "FunctionResponse event missing invocation_id"
                            )
                            assert event.invocation_id == expected_run_id, (
                                f"Expected invocation_id={expected_run_id}, got {event.invocation_id}"
                            )
                            return

        assert False, (
            f"FunctionResponse event for tool_call_id={tool_call_id} not found"
        )

    @pytest.mark.asyncio
    async def test_invocation_id_set_on_function_response_event(self, ag_ui_adk):
        """Test that invocation_id is set on function response events.

        When client-side tool results arrive, the FunctionResponse event that gets
        appended to the ADK session should have the invocation_id set to the AG-UI
        run_id. This is required for DatabaseSessionService to properly track events.

        Regression test for PR #958.
        """
        thread_id = "test_thread_invocation_id"
        tool_call_id = "tool_call_invocation_test"
        expected_run_id = "run_id_12345"

        # Create input with tool result + user message
        input_data = RunAgentInput(
            thread_id=thread_id,
            run_id=expected_run_id,  # This should become the invocation_id
            messages=[
                UserMessage(id="user_1", role="user", content="Initial request"),
                AssistantMessage(
                    id="assistant_1",
                    role="assistant",
                    content=None,
                    tool_calls=[
                        ToolCall(
                            id=tool_call_id,
                            function=FunctionCall(name="test_tool", arguments='{"arg": "value"}')
                        )
                    ]
                ),
                ToolMessage(
                    id="tool_result_1",
                    role="tool",
                    content='{"status": "success"}',
                    tool_call_id=tool_call_id
                ),
                UserMessage(id="user_2", role="user", content="Continue")
            ],
            tools=[
                AGUITool(
                    name="test_tool",
                    description="Test tool",
                    parameters={"type": "object", "properties": {"arg": {"type": "string"}}}
                )
            ],
            context=[],
            state={},
            forwarded_props={}
        )

        # Arrange test data.
        app_name, backend_session_id = await self._prepare_session_with_pending_tool_call(
            ag_ui_adk=ag_ui_adk,
            input_data=input_data,
            tool_call_id=tool_call_id,
            tool_name="test_tool",
            tool_args={"arg": "value"},
            processed_message_ids=["user_1", "assistant_1"],
        )

        # Mock runner to avoid LLM calls
        class MockRunner:
            async def run_async(self, **kwargs):
                return
                yield

        # Prepare tool results
        tool_results = [
            {
                'tool_name': 'test_tool',
                'message': input_data.messages[2]
            }
        ]
        message_batch = [input_data.messages[3]]

        with patch.object(ag_ui_adk, '_create_runner', return_value=MockRunner()):
            event_queue = asyncio.Queue()

            await ag_ui_adk._run_adk_in_background(
                input=input_data,
                adk_agent=ag_ui_adk._adk_agent,
                user_id="test_user",
                app_name=app_name,
                event_queue=event_queue,
                client_proxy_toolsets=[],
                tool_results=tool_results,
                message_batch=message_batch
            )

        # Assert invocation_id is persisted.
        session = await ag_ui_adk._session_manager._session_service.get_session(
            session_id=backend_session_id,
            app_name=app_name,
            user_id="test_user"
        )
        self._assert_function_response_invocation_id(
            session, tool_call_id, expected_run_id
        )

    @pytest.mark.asyncio
    async def test_explicit_persist_with_null_new_message_for_tool_results_only(self, ag_ui_adk):
        """Test that we explicitly persist function_response but pass new_message=None.

        When tool results arrive WITHOUT a trailing user message, ag-ui-adk MUST:
        1. Explicitly persist the function_response via append_event() - required because
           InMemorySessionService.get_session() returns a deep copy, and ADK's state checks
           happen before its internal persistence. Without pre-appending, HITL resumption fails.
        2. Pass new_message=None to prevent the runner from appending a duplicate.

        This prevents duplicate function_response events while maintaining HITL functionality.

        Related to PR #958 (invocation_id) and duplicate function_response bug fix.
        """
        thread_id = "test_thread_explicit_persist_null_msg"
        tool_call_id = "tool_call_explicit_persist_test"
        expected_run_id = "run_id_explicit_persist_67890"

        # Create input with tool result ONLY (no trailing user message)
        input_data = RunAgentInput(
            thread_id=thread_id,
            run_id=expected_run_id,
            messages=[
                UserMessage(id="user_1", role="user", content="Initial request"),
                AssistantMessage(
                    id="assistant_1",
                    role="assistant",
                    content=None,
                    tool_calls=[
                        ToolCall(
                            id=tool_call_id,
                            function=FunctionCall(name="approve_action", arguments='{}')
                        )
                    ]
                ),
                ToolMessage(
                    id="tool_result_1",
                    role="tool",
                    content='{"approved": true}',
                    tool_call_id=tool_call_id
                )
                # NOTE: No trailing UserMessage - this is the tool-results-only path
            ],
            tools=[
                AGUITool(
                    name="approve_action",
                    description="Approve an action",
                    parameters={"type": "object", "properties": {}}
                )
            ],
            context=[],
            state={},
            forwarded_props={}
        )

        # Arrange test data.
        app_name, backend_session_id = await self._prepare_session_with_pending_tool_call(
            ag_ui_adk=ag_ui_adk,
            input_data=input_data,
            tool_call_id=tool_call_id,
            tool_name="approve_action",
            tool_args={},
            processed_message_ids=["user_1", "assistant_1"],
        )

        # Mock runner to verify correct parameters (regression fix approach)
        class MockRunner:
            async def run_async(self, **kwargs):
                # Regression fix: verify BOTH new_message and invocation_id are provided
                new_msg = kwargs.get('new_message')
                inv_id = kwargs.get('invocation_id')

                # Should pass new_message with function_response content
                assert new_msg is not None, (
                    "new_message should contain function_response (regression fix approach)"
                )
                assert hasattr(new_msg, 'parts'), "new_message should have parts"

                # Should specify invocation_id to prevent ADK auto-generation
                assert inv_id is not None, (
                    "invocation_id should be provided to use client's run_id"
                )
                assert inv_id == expected_run_id, (
                    f"invocation_id should be {expected_run_id}, got {inv_id}"
                )
                return
                yield

        # Prepare tool results WITHOUT message_batch (tool-results-only path)
        tool_results = [
            {
                'tool_name': 'approve_action',
                'message': input_data.messages[2]
            }
        ]

        with patch.object(ag_ui_adk, '_create_runner', return_value=MockRunner()):
            event_queue = asyncio.Queue()

            await ag_ui_adk._run_adk_in_background(
                input=input_data,
                adk_agent=ag_ui_adk._adk_agent,
                user_id="test_user",
                app_name=app_name,
                event_queue=event_queue,
                client_proxy_toolsets=[],
                tool_results=tool_results,
                message_batch=None  # No trailing user message.
            )

        # Note: With the regression fix approach, we pass new_message + invocation_id to ADK.
        # The MockRunner above validates these parameters are correct, including the invocation_id
        # matching the expected run_id. Integration tests with real ADK runners
        # (test_lro_tool_response_persistence.py) validate that only 1 function_response event
        # is persisted with the correct invocation_id.

    @pytest.mark.asyncio
    async def test_session_refreshed_after_state_update(self, ag_ui_adk):
        """Test that session is refreshed after update_session_state.

        When using DatabaseSessionService, the session's last_update_time changes
        after any modification. If we don't refresh the session after calling
        update_session_state, subsequent operations may fail with "stale session" errors.

        This test verifies that get_session is called after update_session_state.

        Regression test for PR #958, see: https://github.com/ag-ui-protocol/ag-ui/issues/957
        """
        thread_id = "test_thread_session_refresh"

        input_data = RunAgentInput(
            thread_id=thread_id,
            run_id="run_refresh_test",
            messages=[
                UserMessage(id="user_1", role="user", content="Hello")
            ],
            tools=[],
            context=[],
            state={"key": "value"},  # State that will be updated
            forwarded_props={}
        )

        app_name = ag_ui_adk._get_app_name(input_data)
        user_id = ag_ui_adk._get_user_id(input_data)

        # Create session first
        session, backend_session_id = await ag_ui_adk._ensure_session_exists(
            app_name=app_name,
            user_id=user_id,
            thread_id=thread_id,
            initial_state={}
        )

        # Track calls to session manager methods
        update_session_state_called = False
        get_session_called_after_update = False
        call_order = []

        original_update_session_state = ag_ui_adk._session_manager.update_session_state
        original_get_session = ag_ui_adk._session_manager.get_session

        async def mock_update_session_state(*args, **kwargs):
            nonlocal update_session_state_called
            update_session_state_called = True
            call_order.append('update_session_state')
            return await original_update_session_state(*args, **kwargs)

        async def mock_get_session(*args, **kwargs):
            nonlocal get_session_called_after_update
            call_order.append('get_session')
            if update_session_state_called:
                get_session_called_after_update = True
            return await original_get_session(*args, **kwargs)

        # Mock runner to avoid LLM calls
        class MockRunner:
            async def run_async(self, **kwargs):
                return
                yield

        with patch.object(ag_ui_adk._session_manager, 'update_session_state', side_effect=mock_update_session_state), \
             patch.object(ag_ui_adk._session_manager, 'get_session', side_effect=mock_get_session), \
             patch.object(ag_ui_adk, '_create_runner', return_value=MockRunner()):

            event_queue = asyncio.Queue()

            await ag_ui_adk._run_adk_in_background(
                input=input_data,
                adk_agent=ag_ui_adk._adk_agent,
                user_id=user_id,
                app_name=app_name,
                event_queue=event_queue,
                client_proxy_toolsets=[],
                tool_results=None,
                message_batch=None
            )

        # Verify the call order: update_session_state should be IMMEDIATELY followed by get_session
        assert update_session_state_called, "update_session_state should be called to sync frontend state"
        assert get_session_called_after_update, (
            "get_session should be called after update_session_state to refresh the session. "
            "This prevents 'stale session' errors when using DatabaseSessionService. "
            f"Call order was: {call_order}"
        )

        # Verify ADJACENCY: get_session must be the immediate next call after update_session_state
        # This ensures the refresh happens right away, not at some arbitrary later point
        update_index = call_order.index('update_session_state')
        assert update_index + 1 < len(call_order), (
            f"No call after update_session_state. Call order: {call_order}"
        )
        assert call_order[update_index + 1] == 'get_session', (
            f"get_session must be called IMMEDIATELY after update_session_state to refresh the session. "
            f"Expected call_order[{update_index + 1}] to be 'get_session', but got '{call_order[update_index + 1]}'. "
            f"Full call order: {call_order}"
        )
