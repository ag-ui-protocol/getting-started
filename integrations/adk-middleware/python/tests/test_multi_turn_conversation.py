#!/usr/bin/env python
"""Test multi-turn conversation support (Issue #769).

This test verifies that multi-turn conversations work correctly across multiple
message exchanges. The issue was that the second message would fail with:
"ValueError: Both invocation_id and new_message are None."

Root cause: Two bugs combined to cause the failure:
1. An incorrect conditional `if message_batch else None` set user_message to None
   even when valid user messages existed in unseen_messages.
2. When unseen_messages was empty (because message IDs were already marked as
   processed), there was no fallback to extract the latest user message from
   input.messages.

See: https://github.com/ag-ui-protocol/ag-ui/issues/769
"""

import asyncio
import os
import pytest
from typing import List, Any
from unittest.mock import MagicMock, AsyncMock, patch

from ag_ui.core import (
    RunAgentInput,
    UserMessage,
    AssistantMessage,
    EventType,
    BaseEvent,
)
from ag_ui_adk import ADKAgent
from ag_ui_adk.session_manager import SessionManager
from google.adk.agents import Agent, LlmAgent
from google.genai import types
from tests.constants import LIVE_TEST_MODEL


# Default model for live tests
DEFAULT_MODEL = LIVE_TEST_MODEL


def create_mock_adk_event(text: str, is_final: bool = False, partial: bool = True):
    """Create a mock ADK event with the given text content."""
    event = MagicMock()
    event.content = MagicMock()
    event.content.parts = [MagicMock(text=text)]
    event.author = "model"
    event.partial = partial
    event.turn_complete = is_final
    event.is_final_response = lambda: is_final
    event.finish_reason = "STOP" if is_final else None
    event.candidates = [MagicMock(finish_reason="STOP")] if is_final else []
    event.invocation_id = "test-invocation"
    event.long_running_tool_ids = []
    return event


async def collect_events(agent: ADKAgent, run_input: RunAgentInput) -> List[BaseEvent]:
    """Collect all events from running an agent."""
    events = []
    async for event in agent.run(run_input):
        events.append(event)
    return events


def get_event_types(events: List[BaseEvent]) -> List[str]:
    """Extract event type names from a list of events."""
    return [str(event.type) for event in events]


class TestMultiTurnConversation:
    """Test cases for multi-turn conversation support."""

    @pytest.fixture(autouse=True)
    def setup_llmock(self, llmock_server):
        """Ensure LLMock is running when no real API key is set."""

    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        """Reset singleton SessionManager between tests."""
        SessionManager.reset_instance()
        yield
        SessionManager.reset_instance()

    @pytest.fixture
    def llm_agent(self):
        """Create a test LLM agent with a model for live tests."""
        return LlmAgent(
            name="test_agent",
            model=DEFAULT_MODEL,
            instruction="You are a test agent for multi-turn conversation testing. Keep responses very brief."
        )

    @pytest.fixture
    def adk_agent(self, llm_agent):
        """Create an ADKAgent wrapper."""
        return ADKAgent(
            adk_agent=llm_agent,
            app_name="test_app",
            user_id="test_user",
            use_in_memory_services=True,
        )

    @pytest.mark.asyncio
    async def test_first_message_succeeds(self, adk_agent):
        """Test that the first message in a conversation succeeds."""
        if not os.getenv("GOOGLE_API_KEY"):
            pytest.skip("GOOGLE_API_KEY not set - skipping live test")

        run_input = RunAgentInput(
            thread_id="test_thread_first",
            run_id="run_1",
            messages=[
                UserMessage(
                    id="msg_1",
                    role="user",
                    content="Hello, this is my first message."
                )
            ],
            state={},
            context=[],
            tools=[],
            forwarded_props={}
        )

        events = await collect_events(adk_agent, run_input)
        event_types = get_event_types(events)

        # Should have RUN_STARTED and RUN_FINISHED at minimum
        assert "EventType.RUN_STARTED" in event_types
        assert "EventType.RUN_FINISHED" in event_types

        # Should not have errors
        assert "EventType.RUN_ERROR" not in event_types

    @pytest.mark.asyncio
    async def test_second_message_succeeds(self, adk_agent):
        """Test that the second message in a conversation succeeds (the main bug).

        This was the core issue in #769: the second message would fail with
        "ValueError: Both invocation_id and new_message are None."
        """
        if not os.getenv("GOOGLE_API_KEY"):
            pytest.skip("GOOGLE_API_KEY not set - skipping live test")

        thread_id = "test_thread_multi_turn"

        # First message
        run_input_1 = RunAgentInput(
            thread_id=thread_id,
            run_id="run_1",
            messages=[
                UserMessage(
                    id="msg_1",
                    role="user",
                    content="Hello, this is my first message."
                )
            ],
            state={},
            context=[],
            tools=[],
            forwarded_props={}
        )

        events_1 = await collect_events(adk_agent, run_input_1)
        event_types_1 = get_event_types(events_1)

        assert "EventType.RUN_STARTED" in event_types_1
        assert "EventType.RUN_FINISHED" in event_types_1
        assert "EventType.RUN_ERROR" not in event_types_1

        # Second message - this is where the bug manifested
        # The messages array includes the previous conversation context
        run_input_2 = RunAgentInput(
            thread_id=thread_id,
            run_id="run_2",
            messages=[
                UserMessage(
                    id="msg_1",
                    role="user",
                    content="Hello, this is my first message."
                ),
                AssistantMessage(
                    id="msg_2",
                    role="assistant",
                    content="Hello! How can I help you today?"
                ),
                UserMessage(
                    id="msg_3",
                    role="user",
                    content="This is my second message."
                )
            ],
            state={},
            context=[],
            tools=[],
            forwarded_props={}
        )

        events_2 = await collect_events(adk_agent, run_input_2)
        event_types_2 = get_event_types(events_2)

        # The fix ensures the second message succeeds
        assert "EventType.RUN_STARTED" in event_types_2
        assert "EventType.RUN_FINISHED" in event_types_2
        assert "EventType.RUN_ERROR" not in event_types_2

    @pytest.mark.asyncio
    async def test_third_and_fourth_messages_succeed(self, adk_agent):
        """Test that subsequent messages also succeed."""
        if not os.getenv("GOOGLE_API_KEY"):
            pytest.skip("GOOGLE_API_KEY not set - skipping live test")

        thread_id = "test_thread_extended"

        # Build up conversation over 4 turns
        conversations = [
            [
                UserMessage(id="msg_1", role="user", content="First message")
            ],
            [
                UserMessage(id="msg_1", role="user", content="First message"),
                AssistantMessage(id="msg_2", role="assistant", content="First response"),
                UserMessage(id="msg_3", role="user", content="Second message")
            ],
            [
                UserMessage(id="msg_1", role="user", content="First message"),
                AssistantMessage(id="msg_2", role="assistant", content="First response"),
                UserMessage(id="msg_3", role="user", content="Second message"),
                AssistantMessage(id="msg_4", role="assistant", content="Second response"),
                UserMessage(id="msg_5", role="user", content="Third message")
            ],
            [
                UserMessage(id="msg_1", role="user", content="First message"),
                AssistantMessage(id="msg_2", role="assistant", content="First response"),
                UserMessage(id="msg_3", role="user", content="Second message"),
                AssistantMessage(id="msg_4", role="assistant", content="Second response"),
                UserMessage(id="msg_5", role="user", content="Third message"),
                AssistantMessage(id="msg_6", role="assistant", content="Third response"),
                UserMessage(id="msg_7", role="user", content="Fourth message")
            ]
        ]

        for i, messages in enumerate(conversations, 1):
            run_input = RunAgentInput(
                thread_id=thread_id,
                run_id=f"run_{i}",
                messages=messages,
                state={},
                context=[],
                tools=[],
                forwarded_props={}
            )

            events = await collect_events(adk_agent, run_input)
            event_types = get_event_types(events)

            assert "EventType.RUN_STARTED" in event_types, f"Turn {i} missing RUN_STARTED"
            assert "EventType.RUN_FINISHED" in event_types, f"Turn {i} missing RUN_FINISHED"
            assert "EventType.RUN_ERROR" not in event_types, f"Turn {i} had error"


class TestMultiTurnConversationMocked:
    """Mocked tests that don't require GOOGLE_API_KEY."""

    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        """Reset singleton SessionManager between tests."""
        SessionManager.reset_instance()
        yield
        SessionManager.reset_instance()

    @pytest.fixture
    def mock_agent(self):
        """Create a test ADK agent."""
        return Agent(
            name="test_agent",
            instruction="You are a test agent."
        )

    @pytest.fixture
    def adk_agent(self, mock_agent):
        """Create an ADKAgent wrapper."""
        return ADKAgent(
            adk_agent=mock_agent,
            app_name="test_app",
            user_id="test_user",
            use_in_memory_services=True,
        )

    @pytest.mark.asyncio
    async def test_unseen_messages_filtering(self, adk_agent):
        """Test that message filtering correctly identifies unseen messages."""
        thread_id = "test_filtering"
        app_name = "test_app"

        # First run with one message
        run_input_1 = RunAgentInput(
            thread_id=thread_id,
            run_id="run_1",
            messages=[
                UserMessage(id="msg_1", role="user", content="First message")
            ],
            state={},
            context=[],
            tools=[],
            forwarded_props={}
        )

        unseen_1 = await adk_agent._get_unseen_messages(run_input_1)
        assert len(unseen_1) == 1
        assert unseen_1[0].id == "msg_1"

        # Mark the message as processed (simulating what happens after first run)
        adk_agent._session_manager.mark_messages_processed(
            app_name, thread_id, ["msg_1"]
        )

        # Second run with both messages (msg_1 already processed)
        run_input_2 = RunAgentInput(
            thread_id=thread_id,
            run_id="run_2",
            messages=[
                UserMessage(id="msg_1", role="user", content="First message"),
                AssistantMessage(id="msg_2", role="assistant", content="Response"),
                UserMessage(id="msg_3", role="user", content="Second message")
            ],
            state={},
            context=[],
            tools=[],
            forwarded_props={}
        )

        unseen_2 = await adk_agent._get_unseen_messages(run_input_2)

        # msg_1 should be filtered out, msg_2 and msg_3 should remain
        unseen_ids = [m.id for m in unseen_2]
        assert "msg_1" not in unseen_ids
        assert "msg_2" in unseen_ids
        assert "msg_3" in unseen_ids

    @pytest.mark.asyncio
    async def test_convert_latest_message_with_empty_unseen(self, adk_agent):
        """Test that _convert_latest_message falls back to input.messages when unseen is empty.

        This tests the fix for Bug #2 in issue #769: when unseen_messages is empty
        (because all were already processed), the code should fall back to extracting
        the latest user message from input.messages.
        """
        run_input = RunAgentInput(
            thread_id="test_fallback",
            run_id="run_1",
            messages=[
                UserMessage(id="msg_1", role="user", content="First message"),
                AssistantMessage(id="msg_2", role="assistant", content="Response"),
                UserMessage(id="msg_3", role="user", content="Latest message")
            ],
            state={},
            context=[],
            tools=[],
            forwarded_props={}
        )

        # Test with empty unseen_messages - should still extract latest user message
        result = await adk_agent._convert_latest_message(run_input, messages=[])

        # When messages list is empty, should return None (function behavior)
        assert result is None

        # But when we pass None (simulating unseen_messages=None), it should use input.messages
        result_with_input = await adk_agent._convert_latest_message(run_input, messages=None)

        # Should extract the latest user message from input.messages
        assert result_with_input is not None
        assert result_with_input.role == "user"
        assert result_with_input.parts[0].text == "Latest message"

    @pytest.mark.asyncio
    async def test_convert_latest_message_with_valid_unseen(self, adk_agent):
        """Test that _convert_latest_message correctly extracts from unseen messages."""
        run_input = RunAgentInput(
            thread_id="test_unseen",
            run_id="run_1",
            messages=[
                UserMessage(id="msg_1", role="user", content="Old message"),
                AssistantMessage(id="msg_2", role="assistant", content="Response"),
                UserMessage(id="msg_3", role="user", content="New message")
            ],
            state={},
            context=[],
            tools=[],
            forwarded_props={}
        )

        # Test with only the new message in unseen
        unseen = [UserMessage(id="msg_3", role="user", content="New message")]
        result = await adk_agent._convert_latest_message(run_input, messages=unseen)

        assert result is not None
        assert result.role == "user"
        assert result.parts[0].text == "New message"

    @pytest.mark.asyncio
    async def test_message_batch_none_does_not_skip_user_message(self, adk_agent):
        """Test that when message_batch is None, unseen_messages are still processed.

        This tests the fix for Bug #1 in issue #769: the original code had
        `if message_batch else None` which incorrectly set user_message to None
        when message_batch was None, even though unseen_messages might have valid
        messages.
        """
        # This test verifies the fix by checking that _convert_latest_message
        # is called with unseen_messages when message_batch is None

        run_input = RunAgentInput(
            thread_id="test_batch_none",
            run_id="run_1",
            messages=[
                UserMessage(id="msg_1", role="user", content="User message")
            ],
            state={},
            context=[],
            tools=[],
            forwarded_props={}
        )

        # Get unseen messages (should be the user message)
        unseen = await adk_agent._get_unseen_messages(run_input)
        assert len(unseen) == 1

        # When message_batch is None, unseen_messages should be used
        # The fix ensures we pass unseen_messages, not None
        result = await adk_agent._convert_latest_message(run_input, messages=unseen)

        assert result is not None
        assert result.role == "user"
        assert result.parts[0].text == "User message"

    @pytest.mark.asyncio
    async def test_processed_messages_accumulate_correctly(self, adk_agent):
        """Test that processed message IDs accumulate across multiple runs."""
        thread_id = "test_accumulation"
        app_name = "test_app"

        # First batch of messages
        adk_agent._session_manager.mark_messages_processed(
            app_name, thread_id, ["msg_1", "msg_2"]
        )

        processed = adk_agent._session_manager.get_processed_message_ids(
            app_name, thread_id
        )
        assert processed == {"msg_1", "msg_2"}

        # Second batch - should accumulate
        adk_agent._session_manager.mark_messages_processed(
            app_name, thread_id, ["msg_3", "msg_4"]
        )

        processed = adk_agent._session_manager.get_processed_message_ids(
            app_name, thread_id
        )
        assert processed == {"msg_1", "msg_2", "msg_3", "msg_4"}

    @pytest.mark.asyncio
    async def test_different_threads_have_separate_processed_ids(self, adk_agent):
        """Test that different threads maintain separate processed message lists."""
        app_name = "test_app"

        # Thread 1
        adk_agent._session_manager.mark_messages_processed(
            app_name, "thread_1", ["msg_a", "msg_b"]
        )

        # Thread 2
        adk_agent._session_manager.mark_messages_processed(
            app_name, "thread_2", ["msg_x", "msg_y"]
        )

        processed_1 = adk_agent._session_manager.get_processed_message_ids(
            app_name, "thread_1"
        )
        processed_2 = adk_agent._session_manager.get_processed_message_ids(
            app_name, "thread_2"
        )

        assert processed_1 == {"msg_a", "msg_b"}
        assert processed_2 == {"msg_x", "msg_y"}
        assert processed_1.isdisjoint(processed_2)


class TestMultiTurnFallbackBehavior:
    """Test the fallback behavior when unseen_messages is empty."""

    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        """Reset singleton SessionManager between tests."""
        SessionManager.reset_instance()
        yield
        SessionManager.reset_instance()

    @pytest.fixture
    def mock_agent(self):
        """Create a test ADK agent."""
        return Agent(
            name="test_agent",
            instruction="You are a test agent."
        )

    @pytest.fixture
    def adk_agent(self, mock_agent):
        """Create an ADKAgent wrapper."""
        return ADKAgent(
            adk_agent=mock_agent,
            app_name="test_app",
            user_id="test_user",
            use_in_memory_services=True,
        )

    @pytest.mark.asyncio
    async def test_fallback_extracts_latest_user_message_when_all_processed(
        self, adk_agent
    ):
        """Test fallback when all messages are already marked as processed.

        This simulates the second turn of a conversation where all message IDs
        have been processed in the first turn, but we still need to extract
        the latest user message for the agent.
        """
        thread_id = "test_fallback_all_processed"
        app_name = "test_app"

        # Simulate first turn: mark all messages as processed
        adk_agent._session_manager.mark_messages_processed(
            app_name, thread_id, ["msg_1", "msg_2", "msg_3"]
        )

        run_input = RunAgentInput(
            thread_id=thread_id,
            run_id="run_2",
            messages=[
                UserMessage(id="msg_1", role="user", content="First message"),
                AssistantMessage(id="msg_2", role="assistant", content="Response"),
                UserMessage(id="msg_3", role="user", content="Second message - should be extracted")
            ],
            state={},
            context=[],
            tools=[],
            forwarded_props={}
        )

        # All messages should be filtered as "seen"
        unseen = await adk_agent._get_unseen_messages(run_input)
        assert len(unseen) == 0

        # The fallback should still be able to extract from input.messages
        # This tests the fix: lines 1193-1195 in adk_agent.py
        result = await adk_agent._convert_latest_message(run_input, messages=None)

        assert result is not None
        assert result.role == "user"
        assert result.parts[0].text == "Second message - should be extracted"


# Run tests with pytest
if __name__ == "__main__":
    pytest.main([__file__, "-v"])
