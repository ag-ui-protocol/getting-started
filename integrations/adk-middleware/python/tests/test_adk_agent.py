# tests/test_adk_agent.py

"""Tests for ADKAgent middleware."""
from ag_ui_adk.client_proxy_toolset import ClientProxyToolset
from typing import AsyncGenerator
from ag_ui.core import BaseEvent
from ag_ui_adk.agui_toolset import AGUIToolset

import pytest
import asyncio
from types import SimpleNamespace
from unittest.mock import Mock, MagicMock, AsyncMock, patch


from ag_ui_adk import ADKAgent, SessionManager
from ag_ui_adk.event_translator import EventTranslator
from ag_ui.core import (
    RunAgentInput, EventType, UserMessage, Context,
    RunStartedEvent, RunFinishedEvent, TextMessageChunkEvent, SystemMessage,
    TextMessageContentEvent, ToolCallResultEvent
)
from google.adk.agents import Agent


class TestADKAgent:
    """Test cases for ADKAgent."""

    @pytest.fixture
    def mock_agent(self):
        """Create a mock ADK agent."""
        agent = Mock(spec=Agent)
        agent.name = "test_agent"
        return agent


    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        """Reset session manager before each test."""
        try:
            SessionManager.reset_instance()
        except RuntimeError:
            # Event loop may be closed - ignore
            pass
        yield
        # Cleanup after test
        try:
            SessionManager.reset_instance()
        except RuntimeError:
            # Event loop may be closed - ignore
            pass

    @pytest.fixture
    def adk_agent(self, mock_agent):
        """Create an ADKAgent instance."""
        return ADKAgent(
            adk_agent=mock_agent,
            app_name="test_app",
            user_id="test_user",
            use_in_memory_services=True
        )

    @pytest.fixture
    def sample_input(self):
        """Create a sample RunAgentInput."""
        return RunAgentInput(
            thread_id="test_thread",
            run_id="test_run",
            messages=[
                UserMessage(
                    id="msg1",
                    role="user",
                    content="Hello, test!"
                )
            ],
            context=[
                Context(description="test", value="true")
            ],
            state={},
            tools=[],
            forwarded_props={}
        )

    @pytest.mark.asyncio
    async def test_agent_initialization(self, adk_agent):
        """Test ADKAgent initialization."""
        assert adk_agent._static_user_id == "test_user"
        assert adk_agent._static_app_name == "test_app"
        assert adk_agent._session_manager is not None

    @pytest.mark.asyncio
    async def test_user_extraction(self, adk_agent, sample_input):
        """Test user ID extraction."""
        # Test static user ID
        assert adk_agent._get_user_id(sample_input) == "test_user"

        # Test custom extractor
        def custom_extractor(input):
            return "custom_user"

        # Create a test agent for the custom instance
        test_agent_custom = Mock(spec=Agent)
        test_agent_custom.name = "custom_test_agent"

        adk_agent_custom = ADKAgent(adk_agent=test_agent_custom, app_name="test_app", user_id_extractor=custom_extractor)
        assert adk_agent_custom._get_user_id(sample_input) == "custom_user"

    @pytest.mark.asyncio
    async def test_adk_agent_has_direct_reference(self, adk_agent, sample_input):
        """Test that ADK agent has direct reference to underlying agent."""
        # Test that the agent is directly accessible
        assert adk_agent._adk_agent is not None
        assert adk_agent._adk_agent.name == "test_agent"

    @pytest.mark.asyncio
    async def test_run_basic_flow(self, adk_agent, sample_input, mock_agent):
        """Test basic run flow with mocked runner."""
        with patch.object(adk_agent, '_create_runner') as mock_create_runner:
            # Create a mock runner
            mock_runner = AsyncMock()
            mock_runner.close = AsyncMock()
            mock_event = Mock()
            mock_event.id = "event1"
            mock_event.author = "test_agent"
            mock_event.content = Mock()
            mock_event.content.parts = [Mock(text="Hello from agent!")]
            mock_event.partial = False
            mock_event.actions = None
            mock_event.get_function_calls = Mock(return_value=[])
            mock_event.get_function_responses = Mock(return_value=[])

            # Configure mock runner to yield our mock event
            async def mock_run_async(*args, **kwargs):
                yield mock_event

            mock_runner.run_async = mock_run_async
            mock_create_runner.return_value = mock_runner

            # Collect events
            events = []
            async for event in adk_agent.run(sample_input):
                events.append(event)

            # Verify events
            assert len(events) >= 2  # At least RUN_STARTED and RUN_FINISHED
            assert events[0].type == EventType.RUN_STARTED
            assert events[-1].type == EventType.RUN_FINISHED
            mock_runner.close.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_runner_close_called_on_run_error(self, adk_agent, sample_input):
        """Runner.close should still be awaited when execution errors."""

        with patch.object(adk_agent, '_create_runner') as mock_create_runner:
            mock_runner = AsyncMock()
            mock_runner.close = AsyncMock()

            async def failing_run_async(*args, **kwargs):
                if False:  # pragma: no cover - keep async generator semantics
                    yield None
                raise RuntimeError("boom")

            mock_runner.run_async = failing_run_async
            mock_create_runner.return_value = mock_runner

            events = []
            async for event in adk_agent.run(sample_input):
                events.append(event)

            # Ensure RUN_ERROR emitted and runner closed
            assert any(event.type == EventType.RUN_ERROR for event in events)
            mock_runner.close.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_turn_complete_falls_back_to_streaming_translator(
        self,
        adk_agent,
        sample_input,
    ):
        """Ensure turn_complete=False triggers streaming translation path."""

        streaming_calls = []
        lro_calls = []

        async def fake_translate(self, adk_event, thread_id, run_id):
            streaming_calls.append((adk_event, thread_id, run_id))
            yield TextMessageChunkEvent(
                message_id=adk_event.id,
                role="assistant",
                delta="streamed chunk",
            )

        async def fake_translate_lro(self, adk_event):
            lro_calls.append(adk_event)
            if False:  # pragma: no cover - required to keep async generator signature
                yield None

        mock_event = Mock()
        mock_event.id = "event_stream"
        mock_event.author = "assistant"
        mock_event.partial = False
        mock_event.turn_complete = False
        mock_event.finish_reason = "STOP"
        mock_event.usage_metadata = {"tokens": 5}
        mock_event.is_final_response = Mock(return_value=True)
        mock_event.content = Mock()
        mock_event.content.parts = [Mock(text="Final response chunk")]
        mock_event.actions = None
        mock_event.get_function_calls = Mock(return_value=[])
        mock_event.get_function_responses = Mock(return_value=[])
        mock_event.custom_data = None

        class DummyRunner:
            async def run_async(self, *args, **kwargs):
                yield mock_event

        with patch.object(adk_agent, '_create_runner', return_value=DummyRunner()), \
             patch.object(EventTranslator, 'translate', new=fake_translate), \
             patch.object(EventTranslator, 'translate_lro_function_calls', new=fake_translate_lro):

            events = []
            async for event in adk_agent.run(sample_input):
                events.append(event)

        # Verify run lifecycle events emitted
        assert events[0].type == EventType.RUN_STARTED
        assert events[-1].type == EventType.RUN_FINISHED

        # Ensure streaming translator branch handled the event
        chunk_events = [event for event in events if isinstance(event, TextMessageChunkEvent)]
        assert chunk_events, "Expected translated chunk event"
        assert chunk_events[0].delta == "streamed chunk"

        # Confirm branch selection
        assert len(streaming_calls) == 1
        assert lro_calls == []

    @pytest.mark.asyncio
    async def test_partial_final_chunk_uses_streaming_translation(self, adk_agent, sample_input):
        """Ensure partial chunks marked as final still use streaming translation."""

        translate_calls = 0
        lro_calls = 0

        async def fake_translate(self, adk_event, thread_id, run_id):
            nonlocal translate_calls
            translate_calls += 1
            yield TextMessageChunkEvent(
                type=EventType.TEXT_MESSAGE_CHUNK,
                message_id=adk_event.id,
                delta="chunk"
            )

        async def fake_translate_lro(self, adk_event):
            nonlocal lro_calls
            lro_calls += 1
            if False:
                yield  # pragma: no cover - keeps this an async generator

        adk_event = SimpleNamespace(
            id="event-final-chunk",
            author="assistant",
            content=SimpleNamespace(parts=[SimpleNamespace(text="hello")]),
            partial=True,
            turn_complete=True,
            usage_metadata={"tokens": 1},
            finish_reason="STOP",
            actions=None,
            custom_data=None,
            get_function_calls=lambda: [],
            get_function_responses=lambda: [],
            is_final_response=lambda: True
        )

        class FakeRunner:
            async def run_async(self, *args, **kwargs):
                yield adk_event

        with patch("ag_ui_adk.adk_agent.EventTranslator.translate", new=fake_translate), \
             patch("ag_ui_adk.adk_agent.EventTranslator.translate_lro_function_calls", new=fake_translate_lro), \
             patch.object(adk_agent, "_create_runner", return_value=FakeRunner()):
            events = [event async for event in adk_agent.run(sample_input)]

        assert any(isinstance(event, TextMessageChunkEvent) for event in events)
        assert translate_calls == 1
        assert lro_calls == 0

    @pytest.mark.asyncio
    async def test_streaming_finish_reason_fallback(self, adk_agent, sample_input):
        """Ensure streaming translator handles final responses missing finish_reason."""

        text_part = SimpleNamespace(text="Hello from stream", function_call=None)
        streaming_event = SimpleNamespace(
            id="event-stream",
            author="assistant",
            content=SimpleNamespace(parts=[text_part]),
            partial=False,
            turn_complete=True,
            usage_metadata={"tokens": 9},
            finish_reason=None,
            actions=None,
            custom_data=None,
            long_running_tool_ids=[],
        )
        streaming_event.is_final_response = lambda: False
        streaming_event.get_function_calls = Mock(return_value=[])
        streaming_event.get_function_responses = Mock(return_value=[])

        function_call = SimpleNamespace(id="tool-1", name="long_tool", args={"foo": "bar"})
        function_part = SimpleNamespace(text=None, function_call=function_call)
        lro_event = SimpleNamespace(
            id="event-lro",
            author="assistant",
            content=SimpleNamespace(parts=[function_part]),
            partial=False,
            turn_complete=True,
            usage_metadata={"tokens": 1},
            finish_reason="STOP",
            actions=None,
            custom_data=None,
            long_running_tool_ids=[function_call.id],
        )
        lro_event.is_final_response = lambda: True
        lro_event.get_function_calls = Mock(return_value=[])
        lro_event.get_function_responses = Mock(return_value=[])

        events_to_yield = [streaming_event, lro_event]

        class DummyRunner:
            async def run_async(self, *args, **kwargs):
                for event in events_to_yield:
                    yield event

        captured_stream_events = []
        captured_lro_events = []

        original_translate = EventTranslator.translate
        original_translate_lro = EventTranslator.translate_lro_function_calls

        async def translate_spy(self, adk_event, thread_id, run_id):
            translate_spy.call_count += 1
            translate_spy.adk_events.append(adk_event)
            async for event in original_translate(self, adk_event, thread_id, run_id):
                captured_stream_events.append(event)
                yield event

        translate_spy.call_count = 0
        translate_spy.adk_events = []

        async def translate_lro_spy(self, adk_event):
            translate_lro_spy.call_count += 1
            translate_lro_spy.adk_events.append(adk_event)
            async for event in original_translate_lro(self, adk_event):
                captured_lro_events.append(event)
                yield event

        translate_lro_spy.call_count = 0
        translate_lro_spy.adk_events = []

        dummy_runner = DummyRunner()

        with patch.object(EventTranslator, "translate", translate_spy), \
             patch.object(EventTranslator, "translate_lro_function_calls", translate_lro_spy), \
             patch.object(adk_agent, "_create_runner", return_value=dummy_runner):

            emitted_events = []
            async for event in adk_agent.run(sample_input):
                emitted_events.append(event)

        # Assert streaming translator was used for the first event
        assert translate_spy.call_count == 1
        assert translate_spy.adk_events[0] is streaming_event

        # Confirm streaming content flowed through as expected
        text_events = [event for event in emitted_events if isinstance(event, TextMessageContentEvent)]
        assert text_events and text_events[0].delta == "Hello from stream"
        assert any(isinstance(event, TextMessageContentEvent) for event in captured_stream_events)

        # Long-running translation should be invoked only for the STOP event
        assert translate_lro_spy.call_count == 1
        assert translate_lro_spy.adk_events[0] is lro_event

        # Ensure we produced a tool call event to guard against regressions
        assert any(event.type == EventType.TOOL_CALL_END for event in captured_lro_events)

    @pytest.mark.asyncio
    async def test_session_management(self, adk_agent):
        """Test session lifecycle management."""
        session_mgr = adk_agent._session_manager

        # Create a session through get_or_create_session
        # Note: thread_id is used as the lookup key, backend may generate different session_id
        session1, backend_id1 = await session_mgr.get_or_create_session(
            thread_id="thread1",
            app_name="agent1",
            user_id="user1"
        )

        assert session_mgr.get_session_count() == 1

        # Add another session
        session2, backend_id2 = await session_mgr.get_or_create_session(
            thread_id="thread2",
            app_name="agent1",
            user_id="user1"
        )
        assert session_mgr.get_session_count() == 2

    @pytest.mark.asyncio
    async def test_error_handling(self, adk_agent, sample_input):
        """Test error handling in run method."""
        # Force an error by making the underlying agent fail
        adk_agent._adk_agent.side_effect = Exception('test exception')  # This will cause an error

        events = []
        async for event in adk_agent.run(sample_input):
            events.append(event)

        # Should get RUN_STARTED then RUN_ERROR, and NO trailing RUN_FINISHED.
        # The AG-UI spec allows at most one terminal event per run; emitting
        # RUN_FINISHED after RUN_ERROR makes @ag-ui/client's state machine throw
        # ("The run has already errored"). See issue #1892.
        assert len(events) == 2
        assert events[0].type == EventType.RUN_STARTED
        assert events[1].type == EventType.RUN_ERROR
        # Check that it's an error with meaningful content
        assert len(events[1].message) > 0
        assert events[1].code == 'BACKGROUND_EXECUTION_ERROR'

    @pytest.mark.asyncio
    async def test_errored_run_emits_single_terminal_event(self, adk_agent, sample_input):
        """A run that errors mid-stream must emit exactly one terminal event.

        Regression test for issue #1892: the background queue path emits
        RUN_ERROR, after which the consumer loop must NOT fall through to its
        unconditional RUN_FINISHED. Two terminal events violate the AG-UI spec
        and are rejected by @ag-ui/client.
        """
        adk_agent._adk_agent.side_effect = Exception('boom mid-stream')

        events = [event async for event in adk_agent.run(sample_input)]

        terminal_types = [
            e.type for e in events
            if e.type in (EventType.RUN_FINISHED, EventType.RUN_ERROR)
        ]
        assert terminal_types == [EventType.RUN_ERROR], (
            f"expected a single RUN_ERROR terminal event, got {terminal_types}"
        )

    @pytest.mark.asyncio
    async def test_cleanup(self, adk_agent):
        """Test cleanup method."""
        # Add a mock execution
        mock_execution = Mock()
        mock_execution.cancel = AsyncMock()

        async with adk_agent._execution_lock:
            adk_agent._active_executions[("test_thread", "test_user")] = mock_execution

        await adk_agent.close()

        # Verify execution was cancelled and cleaned up
        mock_execution.cancel.assert_called_once()
        assert len(adk_agent._active_executions) == 0

    @pytest.mark.asyncio
    async def test_system_message_appended_to_instructions(self):
        """Test that SystemMessage as first message gets appended to agent instructions."""
        # Create an agent with initial instructions
        mock_agent = Agent(
            name="test_agent",
            instruction="You are a helpful assistant."
        )

        adk_agent = ADKAgent(adk_agent=mock_agent, app_name="test_app", user_id="test_user")

        # Create input with SystemMessage as first message
        system_input = RunAgentInput(
            thread_id="test_thread",
            run_id="test_run",
            messages=[
                SystemMessage(id="sys_1", role="system", content="Be very concise in responses."),
                UserMessage(id="msg_1", role="user", content="Hello")
            ],
            context=[],
            state={},
            tools=[],
            forwarded_props={}
        )

        # Mock the background execution to capture the modified agent
        captured_agent = None
        original_run_background = adk_agent._run_adk_in_background

        async def mock_run_background(input, adk_agent, user_id, app_name, event_queue, client_proxy_toolsets, long_running_tool_ids=None, tool_results=None, message_batch=None):
            nonlocal captured_agent
            captured_agent = adk_agent
            # Just put a completion event in the queue and return
            await event_queue.put(None)

        with patch.object(adk_agent, '_run_adk_in_background', side_effect=mock_run_background):
            # Start execution to trigger agent modification
            execution = await adk_agent._start_background_execution(system_input)

            # Wait briefly for the background task to start
            await asyncio.sleep(0.01)

        # Verify the agent's instruction was modified
        assert captured_agent is not None
        expected_instruction = "You are a helpful assistant.\n\nBe very concise in responses."
        assert captured_agent.instruction == expected_instruction

    @pytest.mark.asyncio
    async def test_system_message_appended_to_instruction_provider(self):
        """Test that SystemMessage as first message gets appended to agent instructions
        when they are set via instruction provider."""
        # Create an agent with initial instructions
        received_context = None

        async def instruction_provider(context) -> str:
            nonlocal received_context
            received_context = context
            return "You are a helpful assistant."

        mock_agent = Agent(
            name="test_agent",
            instruction=instruction_provider
        )

        adk_agent = ADKAgent(adk_agent=mock_agent, app_name="test_app", user_id="test_user")

        # Create input with SystemMessage as first message
        system_input = RunAgentInput(
            thread_id="test_thread",
            run_id="test_run",
            messages=[
                SystemMessage(id="sys_1", role="system", content="Be very concise in responses."),
                UserMessage(id="msg_1", role="user", content="Hello")
            ],
            context=[],
            state={},
            tools=[],
            forwarded_props={}
        )

        # Mock the background execution to capture the modified agent
        captured_agent = None
        original_run_background = adk_agent._run_adk_in_background

        async def mock_run_background(input, adk_agent, user_id, app_name, event_queue, client_proxy_toolsets, long_running_tool_ids=None, tool_results=None, message_batch=None):
            nonlocal captured_agent
            captured_agent = adk_agent
            # Just put a completion event in the queue and return
            await event_queue.put(None)

        with patch.object(adk_agent, '_run_adk_in_background', side_effect=mock_run_background):
            # Start execution to trigger agent modification
            execution = await adk_agent._start_background_execution(system_input)

            # Wait briefly for the background task to start
            await asyncio.sleep(0.01)

        # Verify the agent's instruction was wrapped correctly
        assert captured_agent is not None
        assert callable(captured_agent.instruction) is True

        # Test that the context object received in instruction provider is the same
        test_context = {"test": "value"}
        expected_instruction = "You are a helpful assistant.\n\nBe very concise in responses."
        agent_instruction = await captured_agent.instruction(test_context)
        assert agent_instruction == expected_instruction
        assert received_context is test_context

    @pytest.mark.asyncio
    async def test_system_message_appended_to_instruction_provider_with_none(self):
        """Test that SystemMessage as first message gets appended to agent instructions
        when they are set via instruction provider."""
        # Create an agent with initial instructions, but return None
        async def instruction_provider(context) -> str:
            return None

        mock_agent = Agent(
            name="test_agent",
            instruction=instruction_provider
        )

        adk_agent = ADKAgent(adk_agent=mock_agent, app_name="test_app", user_id="test_user")

        # Create input with SystemMessage as first message
        system_input = RunAgentInput(
            thread_id="test_thread",
            run_id="test_run",
            messages=[
                SystemMessage(id="sys_1", role="system", content="Be very concise in responses."),
                UserMessage(id="msg_1", role="user", content="Hello")
            ],
            context=[],
            state={},
            tools=[],
            forwarded_props={}
        )

        # Mock the background execution to capture the modified agent
        captured_agent = None
        original_run_background = adk_agent._run_adk_in_background

        async def mock_run_background(input, adk_agent, user_id, app_name, event_queue, client_proxy_toolsets, long_running_tool_ids=None, tool_results=None, message_batch=None):
            nonlocal captured_agent
            captured_agent = adk_agent
            # Just put a completion event in the queue and return
            await event_queue.put(None)

        with patch.object(adk_agent, '_run_adk_in_background', side_effect=mock_run_background):
            # Start execution to trigger agent modification
            execution = await adk_agent._start_background_execution(system_input)

            # Wait briefly for the background task to start
            await asyncio.sleep(0.01)

        # Verify the agent's instruction was wrapped correctly
        assert captured_agent is not None
        assert callable(captured_agent.instruction) is True

        # No empty new lines should be added before the instructions
        expected_instruction = "Be very concise in responses."
        agent_instruction = await captured_agent.instruction({})
        assert agent_instruction == expected_instruction

    @pytest.mark.asyncio
    async def test_system_message_appended_to_sync_instruction_provider(self):
        """Test that SystemMessage as first message gets appended to agent instructions
        when they are set via sync instruction provider."""
        # Create an agent with initial instructions
        received_context = None

        def instruction_provider(context) -> str:
            nonlocal received_context
            received_context = context
            return "You are a helpful assistant."

        mock_agent = Agent(
            name="test_agent",
            instruction=instruction_provider
        )

        adk_agent = ADKAgent(adk_agent=mock_agent, app_name="test_app", user_id="test_user")

        # Create input with SystemMessage as first message
        system_input = RunAgentInput(
            thread_id="test_thread",
            run_id="test_run",
            messages=[
                SystemMessage(id="sys_1", role="system", content="Be very concise in responses."),
                UserMessage(id="msg_1", role="user", content="Hello")
            ],
            context=[],
            state={},
            tools=[],
            forwarded_props={}
        )

        # Mock the background execution to capture the modified agent
        captured_agent = None
        original_run_background = adk_agent._run_adk_in_background

        async def mock_run_background(input, adk_agent, user_id, app_name, event_queue, client_proxy_toolsets, long_running_tool_ids=None, tool_results=None, message_batch=None):
            nonlocal captured_agent
            captured_agent = adk_agent
            # Just put a completion event in the queue and return
            await event_queue.put(None)

        with patch.object(adk_agent, '_run_adk_in_background', side_effect=mock_run_background):
            # Start execution to trigger agent modification
            execution = await adk_agent._start_background_execution(system_input)

            # Wait briefly for the background task to start
            await asyncio.sleep(0.01)

        # Verify agent was captured
        assert captured_agent is not None
        assert callable(captured_agent.instruction)

        # Test that the context object received in instruction provider is the same
        test_context = {"test": "value"}
        expected_instruction = "You are a helpful assistant.\n\nBe very concise in responses."
        agent_instruction = captured_agent.instruction(test_context)  # Note: no await for sync function
        assert agent_instruction == expected_instruction
        assert received_context is test_context

    @pytest.mark.asyncio
    async def test_system_message_not_first_ignored(self):
        """Test that SystemMessage not as first message is ignored."""
        mock_agent = Agent(
            name="test_agent",
            instruction="You are a helpful assistant."
        )

        adk_agent = ADKAgent(adk_agent=mock_agent, app_name="test_app", user_id="test_user")

        # Create input with SystemMessage as second message
        system_input = RunAgentInput(
            thread_id="test_thread",
            run_id="test_run",
            messages=[
                UserMessage(id="msg_1", role="user", content="Hello"),
                SystemMessage(id="sys_1", role="system", content="Be very concise in responses.")
            ],
            context=[],
            state={},
            tools=[],
            forwarded_props={}
        )

        # Mock the background execution to capture the agent
        captured_agent = None

        async def mock_run_background(input, adk_agent, user_id, app_name, event_queue, client_proxy_toolsets, long_running_tool_ids=None, tool_results=None, message_batch=None):
            nonlocal captured_agent
            captured_agent = adk_agent
            await event_queue.put(None)

        with patch.object(adk_agent, '_run_adk_in_background', side_effect=mock_run_background):
            execution = await adk_agent._start_background_execution(system_input)
            await asyncio.sleep(0.01)

        # Verify the agent's instruction was NOT modified
        assert captured_agent.instruction == "You are a helpful assistant."

    @pytest.mark.asyncio
    async def test_system_message_with_no_existing_instruction(self):
        """Test SystemMessage handling when agent has no existing instruction."""
        mock_agent = Agent(name="test_agent")  # No instruction

        adk_agent = ADKAgent(adk_agent=mock_agent, app_name="test_app", user_id="test_user")

        system_input = RunAgentInput(
            thread_id="test_thread",
            run_id="test_run",
            messages=[
                SystemMessage(id="sys_1", role="system", content="You are a math tutor.")
            ],
            context=[],
            state={},
            tools=[],
            forwarded_props={}
        )

        captured_agent = None

        async def mock_run_background(input, adk_agent, user_id, app_name, event_queue, client_proxy_toolsets, long_running_tool_ids=None, tool_results=None, message_batch=None):
            nonlocal captured_agent
            captured_agent = adk_agent
            await event_queue.put(None)

        with patch.object(adk_agent, '_run_adk_in_background', side_effect=mock_run_background):
            execution = await adk_agent._start_background_execution(system_input)
            await asyncio.sleep(0.01)

        # Verify the SystemMessage became the instruction
        assert captured_agent.instruction == "You are a math tutor."

    @pytest.mark.asyncio
    async def test_final_response_after_backend_tool_emits_text(self, adk_agent, sample_input):
        """Test that final response with content after backend tool is properly emitted.

        This is a regression test for issue #796: when a backend (non-LRO) tool completes
        and the model generates a final response with finish_reason set, the text content
        must still be translated and emitted to the client.

        Previously, the condition excluded events with finish_reason set, causing them to
        go through translate_lro_function_calls() which silently dropped the text content.
        """
        translate_calls = 0
        lro_calls = 0

        async def fake_translate(self, adk_event, thread_id, run_id):
            nonlocal translate_calls
            translate_calls += 1
            yield TextMessageContentEvent(
                type=EventType.TEXT_MESSAGE_CONTENT,
                message_id="msg-final",
                delta="Final response after tool"
            )

        async def fake_translate_lro(self, adk_event):
            nonlocal lro_calls
            lro_calls += 1
            if False:
                yield  # pragma: no cover - keeps this an async generator

        # Simulate a final response after backend tool completion:
        # - is_final_response() = True
        # - finish_reason = "STOP"
        # - has_content = True
        # - NO long_running_tool_ids (it was a backend tool, not client/LRO tool)
        final_event = SimpleNamespace(
            id="event-final-after-backend-tool",
            author="assistant",
            content=SimpleNamespace(parts=[SimpleNamespace(text="The weather in NYC is 72°F")]),
            partial=False,
            turn_complete=True,
            usage_metadata={"tokens": 10},
            finish_reason="STOP",
            actions=None,
            custom_data=None,
            long_running_tool_ids=[],  # No LRO tools - this was a backend tool
            get_function_calls=lambda: [],
            get_function_responses=lambda: [],
            is_final_response=lambda: True
        )

        class FakeRunner:
            async def run_async(self, *args, **kwargs):
                yield final_event

        with patch("ag_ui_adk.adk_agent.EventTranslator.translate", new=fake_translate), \
             patch("ag_ui_adk.adk_agent.EventTranslator.translate_lro_function_calls", new=fake_translate_lro), \
             patch.object(adk_agent, "_create_runner", return_value=FakeRunner()):
            events = [event async for event in adk_agent.run(sample_input)]

        # The key assertion: translate() should be called (not translate_lro_function_calls)
        # This means the text content is properly emitted
        assert translate_calls == 1, f"Expected translate() to be called once, got {translate_calls}"
        assert lro_calls == 0, f"Expected translate_lro_function_calls() not to be called, got {lro_calls}"

        # Verify we got the text content event
        content_events = [e for e in events if isinstance(e, TextMessageContentEvent)]
        assert len(content_events) == 1, "Expected one TextMessageContentEvent"
        assert content_events[0].delta == "Final response after tool"

    @pytest.mark.asyncio
    async def test_skip_summarization_routes_through_translate_for_tool_result(self, adk_agent, sample_input):
        """Test that skip_summarization scenario routes through translate() to emit ToolCallResultEvent.

        This is a regression test for issue #765: when skip_summarization=True is set,
        the model returns a final response with:
        - No text content (has_content=False)
        - Function responses containing the tool result

        Previously, the routing logic at line 1395 would send this to the LRO branch
        because `(is_streaming_chunk or has_content)` was False. This caused
        ToolCallResultEvent to not be emitted.

        The fix adds `has_function_responses` to the routing condition.
        """
        translate_calls = 0
        lro_calls = 0

        async def fake_translate(self, adk_event, thread_id, run_id):
            nonlocal translate_calls
            translate_calls += 1
            yield ToolCallResultEvent(
                type=EventType.TOOL_CALL_RESULT,
                message_id="msg-result",
                tool_call_id="tool-skip-sum",
                content='{"success": true}'
            )

        async def fake_translate_lro(self, adk_event):
            nonlocal lro_calls
            lro_calls += 1
            if False:
                yield  # pragma: no cover - keeps this an async generator

        # Simulate skip_summarization scenario:
        # - is_final_response() = True
        # - has_content = False (no text parts - this is the key!)
        # - has function_responses (tool result)
        # - NO long_running_tool_ids (backend tool)
        func_response = SimpleNamespace(id="tool-skip-sum", response={"success": True})
        skip_sum_event = SimpleNamespace(
            id="event-skip-summarization",
            author="assistant",
            content=SimpleNamespace(parts=[]),  # Empty parts - no text!
            partial=False,
            turn_complete=True,
            usage_metadata={"tokens": 5},
            finish_reason="STOP",
            actions=None,
            custom_data=None,
            long_running_tool_ids=[],
            get_function_calls=lambda: [],
            get_function_responses=lambda: [func_response],  # Has function response!
            is_final_response=lambda: True
        )

        class FakeRunner:
            async def run_async(self, *args, **kwargs):
                yield skip_sum_event

        with patch("ag_ui_adk.adk_agent.EventTranslator.translate", new=fake_translate), \
             patch("ag_ui_adk.adk_agent.EventTranslator.translate_lro_function_calls", new=fake_translate_lro), \
             patch.object(adk_agent, "_create_runner", return_value=FakeRunner()):
            events = [event async for event in adk_agent.run(sample_input)]

        # KEY ASSERTION: translate() should be called to emit ToolCallResultEvent
        # If this fails, the routing logic is incorrectly sending to LRO branch
        assert translate_calls == 1, (
            f"Expected translate() to be called once for skip_summarization event, got {translate_calls}. "
            "Events with function_responses but no content must route through translate()."
        )
        assert lro_calls == 0, (
            f"Expected translate_lro_function_calls() NOT to be called, got {lro_calls}. "
            "skip_summarization events should not go through LRO path."
        )

        # Verify ToolCallResultEvent was emitted
        tool_results = [e for e in events if isinstance(e, ToolCallResultEvent)]
        assert len(tool_results) == 1, "Expected one ToolCallResultEvent"
        assert tool_results[0].tool_call_id == "tool-skip-sum"

    @pytest.mark.asyncio
    async def test_agui_tools_properly_converted_in_subagents(self):
        deep_agent = Agent(
            name="deep_agent",
            instruction="An agent deep in the hierarchy",
            tools=[AGUIToolset(tool_filter=['deep_tool'])]
        )

        hello_agent = Agent(
            name="hello_agent",
            instruction="Says hello",
            tools=[AGUIToolset(tool_filter=['hello_tool'])],
            sub_agents=[deep_agent]
        )

        goodbye_agent = Agent(
            name="goodbye_agent",
            instruction="Says goodbye",
            tools=[AGUIToolset(tool_filter=['goodbye_tool'])]
        )

        root_agent = Agent(
            name="root_agent",
            instruction="Root agent that delegates to sub-agents",
            sub_agents=[hello_agent, goodbye_agent]
        )
        with patch.object(ADKAgent, "_run_adk_in_background") as submethod_mocked:

            async def empty_async_generator() -> AsyncGenerator[BaseEvent, None]:
                """An async generator that is always empty."""
                if False:
                    yield # Required to make it an async generator
                return # The function simply returns, ending iteration

            adk_agent = ADKAgent(
                adk_agent=root_agent,
                app_name="test_app",
                user_id="test_user",
                use_in_memory_services=True
            )
            input = RunAgentInput(
                thread_id="test_thread",
                run_id="test_run",
                messages=[
                    UserMessage(id="msg_1", role="user", content="Start conversation")
                ],
                context=[],
                state={},
                tools=[],
                forwarded_props={}
            )
            async for e in adk_agent.run(input):
                if not isinstance(e, RunStartedEvent):
                    break  # We only care about tool registration side effects so stop after the RunStartedEvent

            submethod_mocked.assert_called_once()
            agent_under_test = submethod_mocked.call_args.kwargs['adk_agent']

            # assert the base agent has no tools, and has two sub-agents
            assert isinstance(agent_under_test, Agent)
            assert agent_under_test.tools == []
            assert len(agent_under_test.sub_agents) == 2

            # AGUIToolset placeholders are replaced per-run by a
            # ClientProxyToolset carrying the declared tool_filter, on the
            # per-run agent copy (the originals are left untouched).

            # hello_agent: AGUIToolset(hello_tool) -> ClientProxyToolset(hello_tool)
            assert agent_under_test.sub_agents[0].name == "hello_agent"
            assert len(agent_under_test.sub_agents[0].tools) == 1
            hello_toolset = agent_under_test.sub_agents[0].tools[0]
            assert isinstance(hello_toolset, ClientProxyToolset)
            assert hello_toolset.tool_filter == ['hello_tool']

            # deep_agent: AGUIToolset(deep_tool) -> ClientProxyToolset(deep_tool)
            assert agent_under_test.sub_agents[0].sub_agents[0].name == "deep_agent"
            assert len(agent_under_test.sub_agents[0].sub_agents[0].tools) == 1
            deep_toolset = agent_under_test.sub_agents[0].sub_agents[0].tools[0]
            assert isinstance(deep_toolset, ClientProxyToolset)
            assert deep_toolset.tool_filter == ['deep_tool']

            # goodbye_agent: AGUIToolset(goodbye_tool) -> ClientProxyToolset(goodbye_tool)
            assert agent_under_test.sub_agents[1].name == "goodbye_agent"
            assert len(agent_under_test.sub_agents[1].tools) == 1
            goodbye_toolset = agent_under_test.sub_agents[1].tools[0]
            assert isinstance(goodbye_toolset, ClientProxyToolset)
            assert goodbye_toolset.tool_filter == ['goodbye_tool']

    @pytest.mark.asyncio
    async def test_non_deepcopyable_tool_does_not_crash(self):
        """Agents with non-deep-copyable tools (e.g. McpToolset) must not crash.

        Regression test for https://github.com/ag-ui-protocol/ag-ui/issues/1264
        """
        import sys
        from google.adk.tools.base_toolset import BaseToolset as ADKBaseToolset

        class UnpicklableToolset(ADKBaseToolset):
            """Mock toolset that holds an unpicklable attribute like McpToolset."""
            def __init__(self):
                super().__init__()
                self.errlog = sys.stderr  # _io.TextIOWrapper – cannot be pickled

            async def get_tools(self, readonly_context=None):
                return []

        unpicklable = UnpicklableToolset()

        root_agent = Agent(
            name="root_agent",
            instruction="Root agent",
            tools=[AGUIToolset(), unpicklable],
        )

        with patch.object(ADKAgent, "_run_adk_in_background") as submethod_mocked:
            adk_agent = ADKAgent(
                adk_agent=root_agent,
                app_name="test_app",
                user_id="test_user",
                use_in_memory_services=True,
            )
            input = RunAgentInput(
                thread_id="test_thread",
                run_id="test_run",
                messages=[
                    UserMessage(id="msg_1", role="user", content="Hello")
                ],
                context=[],
                state={},
                tools=[],
                forwarded_props={},
            )
            # Should not raise TypeError: cannot pickle 'TextIOWrapper' instances
            async for e in adk_agent.run(input):
                if not isinstance(e, RunStartedEvent):
                    break

            submethod_mocked.assert_called_once()
            agent_under_test = submethod_mocked.call_args.kwargs['adk_agent']

            # The AGUIToolset is replaced per-run by a ClientProxyToolset; the
            # unpicklable toolset is preserved by reference (shared, not copied),
            # so both tools are present and no pickling occurred.
            assert len(agent_under_test.tools) == 2
            assert not any(isinstance(t, AGUIToolset) for t in agent_under_test.tools)

            proxies = [
                t for t in agent_under_test.tools if isinstance(t, ClientProxyToolset)
            ]
            assert len(proxies) == 1

            others = [
                t for t in agent_under_test.tools
                if not isinstance(t, ClientProxyToolset)
            ]
            assert len(others) == 1
            assert others[0] is unpicklable
            assert others[0].errlog is sys.stderr

    @pytest.mark.asyncio
    async def test_original_agent_not_mutated_after_run(self):
        """Running the agent must not mutate the original ADK agent."""
        root_agent = Agent(
            name="root_agent",
            instruction="Original instruction",
            tools=[AGUIToolset()],
            sub_agents=[
                Agent(
                    name="child",
                    instruction="Child instruction",
                    tools=[AGUIToolset(tool_filter=['child_tool'])],
                )
            ],
        )
        original_instruction = root_agent.instruction
        original_tools = list(root_agent.tools)
        original_child_tools = list(root_agent.sub_agents[0].tools)

        with patch.object(ADKAgent, "_run_adk_in_background"):
            adk_agent = ADKAgent(
                adk_agent=root_agent,
                app_name="test_app",
                user_id="test_user",
                use_in_memory_services=True,
            )
            input = RunAgentInput(
                thread_id="test_thread",
                run_id="test_run",
                messages=[
                    SystemMessage(id="sys_1", role="system", content="Extra instruction"),
                    UserMessage(id="msg_1", role="user", content="Hello"),
                ],
                context=[],
                state={},
                tools=[],
                forwarded_props={},
            )
            async for e in adk_agent.run(input):
                if not isinstance(e, RunStartedEvent):
                    break

        # Original agent must be unmodified
        assert root_agent.instruction == original_instruction
        assert root_agent.tools == original_tools
        assert all(isinstance(t, AGUIToolset) for t in root_agent.tools)
        assert root_agent.sub_agents[0].tools == original_child_tools
        assert all(isinstance(t, AGUIToolset) for t in root_agent.sub_agents[0].tools)

    def test_shallow_copy_reparents_sub_agents(self):
        """Copied sub-agents must point at the copied parent, not the original.

        Regression for issue #1719: without re-parenting, ADK's
        transfer_to_agent walks parent_agent up to the original tree whose
        tools were never replaced, so the per-run copy is bypassed.
        """
        child = Agent(name="child", instruction="child")
        root = Agent(name="root", instruction="root", sub_agents=[child])

        assert child.parent_agent is root

        copied_root = ADKAgent._shallow_copy_agent_tree(root)
        copied_child = copied_root.sub_agents[0]

        assert copied_root is not root
        assert copied_child is not child
        assert copied_child.parent_agent is copied_root
        # Original tree must remain untouched.
        assert child.parent_agent is root


class TestSessionManagerDispatch:
    """Regression tests for session_manager / session_service dispatch (issue #1601)."""

    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        try:
            SessionManager.reset_default()
        except RuntimeError:
            pass
        yield
        try:
            SessionManager.reset_default()
        except RuntimeError:
            pass

    @pytest.fixture
    def mock_agent(self):
        agent = Mock(spec=Agent)
        agent.name = "test_agent"
        return agent

    def test_distinct_session_services_get_distinct_managers(self, mock_agent):
        """Two ADKAgents with distinct session_services no longer share a manager (#1601)."""
        from google.adk.sessions import InMemorySessionService
        from ag_ui_adk.request_state_service import RequestStateSessionService

        svc1 = InMemorySessionService()
        svc2 = InMemorySessionService()

        agent1 = ADKAgent(adk_agent=mock_agent, app_name="a", user_id="u", session_service=svc1)
        agent2 = ADKAgent(adk_agent=mock_agent, app_name="a", user_id="u", session_service=svc2)

        assert agent1._session_manager is not agent2._session_manager

        # The wrapped service inside each manager should point to the caller's service.
        wrapped1 = agent1._session_manager._session_service
        wrapped2 = agent2._session_manager._session_service
        assert isinstance(wrapped1, RequestStateSessionService)
        assert isinstance(wrapped2, RequestStateSessionService)
        assert wrapped1.inner is svc1
        assert wrapped2.inner is svc2

    def test_no_session_service_uses_shared_default(self, mock_agent):
        """Multiple ADKAgents without explicit services share the process-wide default."""
        agent1 = ADKAgent(adk_agent=mock_agent, app_name="a", user_id="u")
        agent2 = ADKAgent(adk_agent=mock_agent, app_name="a", user_id="u")
        assert agent1._session_manager is agent2._session_manager
        assert agent1._session_manager is SessionManager.get_default()

    def test_explicit_session_manager_is_used_as_is(self, mock_agent):
        """A pre-built SessionManager passed in is honored."""
        manager = SessionManager()
        agent = ADKAgent(adk_agent=mock_agent, app_name="a", user_id="u", session_manager=manager)
        assert agent._session_manager is manager

    def test_session_manager_and_session_service_together_raises(self, mock_agent):
        """Passing both session_manager and session_service is rejected."""
        from google.adk.sessions import InMemorySessionService
        manager = SessionManager()
        with pytest.raises(ValueError, match="Cannot specify both"):
            ADKAgent(
                adk_agent=mock_agent,
                app_name="a",
                user_id="u",
                session_manager=manager,
                session_service=InMemorySessionService(),
            )

    def test_direct_construction_yields_distinct_instances(self):
        """SessionManager() is no longer a singleton: each call returns a new instance."""
        m1 = SessionManager()
        m2 = SessionManager()
        assert m1 is not m2

    def test_get_default_returns_same_instance_on_repeated_calls(self):
        """The shared default is sticky once built."""
        m1 = SessionManager.get_default()
        m2 = SessionManager.get_default()
        assert m1 is m2

    def test_reset_default_and_alias_clear_shared_default(self):
        """reset_default() and the reset_instance alias both let a new default be built."""
        m1 = SessionManager.get_default()
        SessionManager.reset_default()
        m2 = SessionManager.get_default()
        assert m1 is not m2

        m3 = SessionManager.get_default()
        SessionManager.reset_instance()  # legacy alias
        m4 = SessionManager.get_default()
        assert m3 is not m4


class TestThreadIdSessionIdMapping:
    """Test cases for thread_id to session_id mapping and initial state."""

    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        """Reset session manager before each test."""
        try:
            SessionManager.reset_instance()
        except RuntimeError:
            pass
        yield
        try:
            SessionManager.reset_instance()
        except RuntimeError:
            pass

    @pytest.fixture
    def mock_agent(self):
        """Create a mock ADK agent."""
        agent = Mock(spec=Agent)
        agent.name = "test_agent"
        agent.instruction = "Test instruction"
        agent.tools = []
        return agent

    @pytest.fixture
    def adk_agent(self, mock_agent):
        """Create an ADKAgent instance."""
        return ADKAgent(
            adk_agent=mock_agent,
            app_name="test_app",
            user_id="test_user",
            use_in_memory_services=True
        )

    @pytest.mark.asyncio
    async def test_thread_id_becomes_session_id(self, adk_agent):
        """Test that thread_id from RunAgentInput is used as session_id in ADK session."""
        test_thread_id = "my-unique-thread-123"

        input_data = RunAgentInput(
            thread_id=test_thread_id,
            run_id="run_001",
            messages=[
                UserMessage(id="msg1", role="user", content="Hello")
            ],
            context=[],
            state={},
            tools=[],
            forwarded_props={}
        )

        # Track calls to _ensure_session_exists
        ensure_session_calls = []
        original_ensure_session = adk_agent._ensure_session_exists

        async def tracking_ensure_session(app_name, user_id, session_id, initial_state):
            ensure_session_calls.append({
                "app_name": app_name,
                "user_id": user_id,
                "session_id": session_id,
                "initial_state": initial_state
            })
            return await original_ensure_session(app_name, user_id, session_id, initial_state)

        with patch.object(adk_agent, '_ensure_session_exists', side_effect=tracking_ensure_session), \
             patch.object(adk_agent, '_create_runner') as mock_create_runner:

            # Create a mock runner that yields a simple event
            mock_runner = AsyncMock()
            mock_runner.close = AsyncMock()

            async def mock_run_async(*args, **kwargs):
                mock_event = Mock()
                mock_event.id = "event1"
                mock_event.author = "test_agent"
                mock_event.content = Mock()
                mock_event.content.parts = [Mock(text="Response")]
                mock_event.partial = False
                mock_event.actions = None
                mock_event.get_function_calls = Mock(return_value=[])
                mock_event.get_function_responses = Mock(return_value=[])
                yield mock_event

            mock_runner.run_async = mock_run_async
            mock_create_runner.return_value = mock_runner

            # Run the agent
            events = [event async for event in adk_agent.run(input_data)]

        # Verify _ensure_session_exists was called with thread_id as session_id
        assert len(ensure_session_calls) == 1
        assert ensure_session_calls[0]["session_id"] == test_thread_id

    @pytest.mark.asyncio
    async def test_initial_state_passed_to_session(self, adk_agent):
        """Test that state from RunAgentInput is passed as initial_state to session."""
        initial_state = {
            "user_preferences": {"theme": "dark", "language": "en"},
            "selected_document": "doc-456",
            "context_data": {"project_id": "proj-123"}
        }

        input_data = RunAgentInput(
            thread_id="session_with_state",
            run_id="run_001",
            messages=[
                UserMessage(id="msg1", role="user", content="Hello")
            ],
            context=[],
            state=initial_state,
            tools=[],
            forwarded_props={}
        )

        # Track calls to _ensure_session_exists
        ensure_session_calls = []
        original_ensure_session = adk_agent._ensure_session_exists

        async def tracking_ensure_session(app_name, user_id, session_id, state):
            ensure_session_calls.append({
                "app_name": app_name,
                "user_id": user_id,
                "session_id": session_id,
                "initial_state": state
            })
            return await original_ensure_session(app_name, user_id, session_id, state)

        with patch.object(adk_agent, '_ensure_session_exists', side_effect=tracking_ensure_session), \
             patch.object(adk_agent, '_create_runner') as mock_create_runner:

            mock_runner = AsyncMock()
            mock_runner.close = AsyncMock()

            async def mock_run_async(*args, **kwargs):
                mock_event = Mock()
                mock_event.id = "event1"
                mock_event.author = "test_agent"
                mock_event.content = Mock()
                mock_event.content.parts = [Mock(text="Response")]
                mock_event.partial = False
                mock_event.actions = None
                mock_event.get_function_calls = Mock(return_value=[])
                mock_event.get_function_responses = Mock(return_value=[])
                yield mock_event

            mock_runner.run_async = mock_run_async
            mock_create_runner.return_value = mock_runner

            events = [event async for event in adk_agent.run(input_data)]

        # Verify _ensure_session_exists was called with the initial state
        assert len(ensure_session_calls) == 1
        assert ensure_session_calls[0]["initial_state"] == initial_state

    @pytest.mark.asyncio
    async def test_state_synced_via_update_session_state(self, adk_agent):
        """Test that state is synced to backend via update_session_state on each request."""
        state_to_sync = {
            "counter": 42,
            "items": ["a", "b", "c"]
        }

        input_data = RunAgentInput(
            thread_id="session_sync_test",
            run_id="run_001",
            messages=[
                UserMessage(id="msg1", role="user", content="Hello")
            ],
            context=[],
            state=state_to_sync,
            tools=[],
            forwarded_props={}
        )

        # Track calls to update_session_state
        update_state_calls = []

        async def tracking_update_state(session_id, app_name, user_id, state):
            update_state_calls.append({
                "session_id": session_id,
                "app_name": app_name,
                "user_id": user_id,
                "state": state
            })
            return True

        with patch.object(adk_agent._session_manager, 'update_session_state', side_effect=tracking_update_state), \
             patch.object(adk_agent, '_create_runner') as mock_create_runner:

            mock_runner = AsyncMock()
            mock_runner.close = AsyncMock()

            async def mock_run_async(*args, **kwargs):
                mock_event = Mock()
                mock_event.id = "event1"
                mock_event.author = "test_agent"
                mock_event.content = Mock()
                mock_event.content.parts = [Mock(text="Response")]
                mock_event.partial = False
                mock_event.actions = None
                mock_event.get_function_calls = Mock(return_value=[])
                mock_event.get_function_responses = Mock(return_value=[])
                yield mock_event

            mock_runner.run_async = mock_run_async
            mock_create_runner.return_value = mock_runner

            events = [event async for event in adk_agent.run(input_data)]

        # Verify update_session_state was called with the state
        # Note: session_id is the backend-generated ID, which may differ from thread_id
        # There may be 2 calls: one for state sync, one for invocation_id storage
        assert len(update_state_calls) >= 1
        assert update_state_calls[0]["session_id"] is not None  # Backend generates session_id
        assert update_state_calls[0]["state"] == state_to_sync

    @pytest.mark.asyncio
    async def test_empty_initial_state(self, adk_agent):
        """Test that empty state is handled correctly."""
        input_data = RunAgentInput(
            thread_id="empty_state_session",
            run_id="run_001",
            messages=[
                UserMessage(id="msg1", role="user", content="Hello")
            ],
            context=[],
            state={},
            tools=[],
            forwarded_props={}
        )

        ensure_session_calls = []
        original_ensure_session = adk_agent._ensure_session_exists

        async def tracking_ensure_session(app_name, user_id, session_id, state):
            ensure_session_calls.append({
                "session_id": session_id,
                "initial_state": state
            })
            return await original_ensure_session(app_name, user_id, session_id, state)

        with patch.object(adk_agent, '_ensure_session_exists', side_effect=tracking_ensure_session), \
             patch.object(adk_agent, '_create_runner') as mock_create_runner:

            mock_runner = AsyncMock()
            mock_runner.close = AsyncMock()

            async def mock_run_async(*args, **kwargs):
                mock_event = Mock()
                mock_event.id = "event1"
                mock_event.author = "test_agent"
                mock_event.content = Mock()
                mock_event.content.parts = [Mock(text="Response")]
                mock_event.partial = False
                mock_event.actions = None
                mock_event.get_function_calls = Mock(return_value=[])
                mock_event.get_function_responses = Mock(return_value=[])
                yield mock_event

            mock_runner.run_async = mock_run_async
            mock_create_runner.return_value = mock_runner

            events = [event async for event in adk_agent.run(input_data)]

        # Verify empty state is passed
        assert len(ensure_session_calls) == 1
        assert ensure_session_calls[0]["initial_state"] == {}



    @pytest.mark.asyncio
    async def test_hydrates_session_cache_from_db_simple(self, adk_agent):
        """Minimal test: run() should hydrate `_session_lookup_cache` from DB."""
        class DummySession:
            def __init__(self, id_):
                self.id = id_

        class DummySessionManager:
            async def _find_session_by_thread_id(self, app_name, user_id, thread_id):
                return DummySession("session-1")

        # Replace the session manager with our dummy
        adk_agent._session_manager = DummySessionManager()

        # Make _get_unseen_messages return empty so run() short-circuits into _start_new_execution
        async def fake_get_unseen(input):
            return []

        # Provide a no-op async generator for _start_new_execution
        async def fake_start_new_execution(input, message_batch=None, tool_results=None):
            if False:
                yield None

        class Input:
            def __init__(self, thread_id):
                self.thread_id = thread_id
                self.run_id = "run1"
                self.messages = []

        inp = Input("thread-123")

        with patch.object(adk_agent, "_get_unseen_messages", new=fake_get_unseen), \
             patch.object(adk_agent, "_start_new_execution", new=fake_start_new_execution):
            # Consume the run generator (will yield nothing) to trigger hydration logic
            _ = [e async for e in adk_agent.run(inp)]

        user_id = adk_agent._get_user_id(inp)
        cache_key = (inp.thread_id, user_id)

        assert cache_key in adk_agent._session_lookup_cache
        session_id, app_name, uid = adk_agent._session_lookup_cache[cache_key]
        assert session_id == "session-1"
        assert uid == user_id

    @pytest.mark.asyncio
    async def test_hydration_miss_records_cache_checked_key(self, adk_agent):
        """When hydration finds no session, _cache_checked_keys is populated
        so _ensure_session_exists skips the redundant _find_session_by_thread_id."""
        class DummySessionManager:
            async def _find_session_by_thread_id(self, app_name, user_id, thread_id):
                return None  # no existing session

        adk_agent._session_manager = DummySessionManager()

        async def fake_get_unseen(input):
            return []

        async def fake_start_new_execution(input, message_batch=None, tool_results=None):
            if False:
                yield None

        class Input:
            def __init__(self):
                self.thread_id = "new-thread"
                self.run_id = "run1"
                self.messages = []

        inp = Input()

        with patch.object(adk_agent, "_get_unseen_messages", new=fake_get_unseen), \
             patch.object(adk_agent, "_start_new_execution", new=fake_start_new_execution):
            _ = [e async for e in adk_agent.run(inp)]

        user_id = adk_agent._get_user_id(inp)
        cache_key = (inp.thread_id, user_id)
        assert cache_key in adk_agent._cache_checked_keys

    @pytest.mark.asyncio
    async def test_stale_pending_calls_cleared_on_first_access(self, adk_agent):
        """_verify_pending_tool_calls clears stale calls when no active execution."""
        # Pre-populate cache to simulate hydrated session
        cache_key = ("thread-1", "test_user")
        adk_agent._session_lookup_cache[cache_key] = ("session-1", "test_app", "test_user")

        # Set up session manager to return pending calls
        get_state_calls = []
        set_state_calls = []

        async def mock_get_state(session_id, app_name, user_id, key, default=None):
            get_state_calls.append(key)
            if key == "pending_tool_calls":
                return ["stale-tool-1", "stale-tool-2"]
            return default

        async def mock_set_state(session_id, app_name, user_id, key, value):
            set_state_calls.append((key, value))
            return True

        adk_agent._session_manager.get_state_value = mock_get_state
        adk_agent._session_manager.set_state_value = mock_set_state

        # No active execution for this thread
        assert cache_key not in adk_agent._active_executions

        await adk_agent._verify_pending_tool_calls(cache_key, "session-1", "test_app", "test_user")

        # Should have cleared the stale calls
        assert ("pending_tool_calls", []) in set_state_calls
        # Should be marked as verified
        assert cache_key in adk_agent._sessions_verified_locally

    @pytest.mark.asyncio
    async def test_pending_calls_preserved_with_active_execution(self, adk_agent):
        """_verify_pending_tool_calls does NOT clear calls when execution is active."""
        cache_key = ("thread-1", "test_user")
        adk_agent._session_lookup_cache[cache_key] = ("session-1", "test_app", "test_user")

        set_state_calls = []

        async def mock_get_state(session_id, app_name, user_id, key, default=None):
            if key == "pending_tool_calls":
                return ["active-tool-1"]
            return default

        async def mock_set_state(session_id, app_name, user_id, key, value):
            set_state_calls.append((key, value))
            return True

        adk_agent._session_manager.get_state_value = mock_get_state
        adk_agent._session_manager.set_state_value = mock_set_state

        # Simulate active execution
        mock_execution = Mock()
        mock_execution.is_complete = False
        adk_agent._active_executions[cache_key] = mock_execution

        await adk_agent._verify_pending_tool_calls(cache_key, "session-1", "test_app", "test_user")

        # Should NOT have cleared anything
        assert len(set_state_calls) == 0
        # Should still be marked as verified
        assert cache_key in adk_agent._sessions_verified_locally

    @pytest.mark.asyncio
    async def test_verify_pending_calls_runs_only_once(self, adk_agent):
        """_verify_pending_tool_calls is a no-op on subsequent calls for same key."""
        cache_key = ("thread-1", "test_user")
        get_state_calls = []

        async def mock_get_state(session_id, app_name, user_id, key, default=None):
            get_state_calls.append(key)
            return default

        adk_agent._session_manager.get_state_value = mock_get_state

        # First call — should check state
        await adk_agent._verify_pending_tool_calls(cache_key, "session-1", "test_app", "test_user")
        assert len(get_state_calls) == 1

        # Second call — should be a no-op
        await adk_agent._verify_pending_tool_calls(cache_key, "session-1", "test_app", "test_user")
        assert len(get_state_calls) == 1  # no additional call

    @pytest.mark.asyncio
    async def test_ensure_session_passes_skip_find_after_hydration_miss(self, adk_agent):
        """_ensure_session_exists passes skip_find=True when _cache_checked_keys has the key."""
        cache_key = ("new-thread", "test_user")
        adk_agent._cache_checked_keys.add(cache_key)

        class FakeSession:
            id = "created-session"

        get_or_create_calls = []
        original_get_or_create = adk_agent._session_manager.get_or_create_session

        async def tracking_get_or_create(**kwargs):
            get_or_create_calls.append(kwargs)
            return FakeSession(), "created-session"

        adk_agent._session_manager.get_or_create_session = tracking_get_or_create

        # Mock _verify_pending_tool_calls to avoid side effects
        async def noop_verify(*args):
            pass
        adk_agent._verify_pending_tool_calls = noop_verify

        await adk_agent._ensure_session_exists("test_app", "test_user", "new-thread", {})

        assert len(get_or_create_calls) == 1
        assert get_or_create_calls[0]["skip_find"] is True
        # Key should be consumed
        assert cache_key not in adk_agent._cache_checked_keys

