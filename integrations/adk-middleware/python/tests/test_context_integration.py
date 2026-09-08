#!/usr/bin/env python
"""Integration tests for AG-UI context handling in ADK middleware.

These tests verify that context from RunAgentInput is properly accessible
in both instruction providers and tools during actual agent execution.

Tests in this module require GOOGLE_API_KEY to be set.
"""

import os
import pytest
from typing import List

from ag_ui.core import (
    RunAgentInput,
    UserMessage,
    Context,
    EventType,
    BaseEvent,
)
from ag_ui_adk import ADKAgent, CONTEXT_STATE_KEY
from ag_ui_adk.session_manager import SessionManager
from google.adk.agents import LlmAgent
from google.adk.agents.readonly_context import ReadonlyContext
from google.adk.tools import ToolContext
from tests.constants import LIVE_TEST_MODEL


# Default model for live tests
DEFAULT_MODEL = LIVE_TEST_MODEL


async def collect_events(agent: ADKAgent, run_input: RunAgentInput) -> List[BaseEvent]:
    """Collect all events from running an agent."""
    events = []
    async for event in agent.run(run_input):
        events.append(event)
    return events


def get_event_types(events: List[BaseEvent]) -> List[str]:
    """Extract event type names from a list of events."""
    return [str(event.type) for event in events]


class TestContextInInstructionProvider:
    """Integration tests for context access in instruction providers."""

    @pytest.fixture(autouse=True)
    def setup_llmock(self, llmock_server):
        """Ensure LLMock is running when no real API key is set."""

    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        """Reset singleton SessionManager between tests."""
        SessionManager.reset_instance()
        yield
        SessionManager.reset_instance()

    @pytest.mark.asyncio
    async def test_instruction_provider_receives_context(self):
        """Test that instruction provider can access context from state."""
        if not os.getenv("GOOGLE_API_KEY"):
            pytest.skip("GOOGLE_API_KEY not set - skipping live test")

        # Track what context the instruction provider receives
        received_context = []

        def context_tracking_instructions(ctx: ReadonlyContext) -> str:
            """Instruction provider that records context for verification."""
            nonlocal received_context

            # Access context from session state
            context_items = ctx.state.get(CONTEXT_STATE_KEY, [])
            received_context.extend(context_items)

            return "You are a test assistant. Respond with 'OK'."

        # Create agent with tracking instruction provider
        llm_agent = LlmAgent(
            name="context_test_agent",
            model=DEFAULT_MODEL,
            instruction=context_tracking_instructions,
        )

        adk_agent = ADKAgent(
            adk_agent=llm_agent,
            app_name="test_app",
            user_id="test_user",
            use_in_memory_services=True,
        )

        # Run with context
        run_input = RunAgentInput(
            thread_id="test_instruction_context",
            run_id="run_1",
            messages=[
                UserMessage(id="msg_1", role="user", content="Hello")
            ],
            context=[
                Context(description="test_key", value="test_value"),
                Context(description="another_key", value="another_value"),
            ],
            state={},
            tools=[],
            forwarded_props={}
        )

        events = await collect_events(adk_agent, run_input)
        event_types = get_event_types(events)

        # Verify run completed successfully
        assert "EventType.RUN_STARTED" in event_types
        assert "EventType.RUN_FINISHED" in event_types
        assert "EventType.RUN_ERROR" not in event_types

        # Verify instruction provider received the context
        assert len(received_context) == 2
        assert {"description": "test_key", "value": "test_value"} in received_context
        assert {"description": "another_key", "value": "another_value"} in received_context

        await adk_agent.close()


class TestContextInTools:
    """Integration tests for context access in tools."""

    @pytest.fixture(autouse=True)
    def setup_llmock(self, llmock_server):
        """Ensure LLMock is running when no real API key is set."""

    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        """Reset singleton SessionManager between tests."""
        SessionManager.reset_instance()
        yield
        SessionManager.reset_instance()

    @pytest.mark.asyncio
    async def test_tool_can_access_context_from_state(self):
        """Test that tools can access context from session state."""
        if not os.getenv("GOOGLE_API_KEY"):
            pytest.skip("GOOGLE_API_KEY not set - skipping live test")

        # Track what context the tool receives
        tool_received_context = []

        def context_checking_tool(tool_context: ToolContext) -> str:
            """Tool that reads and returns context from state."""
            nonlocal tool_received_context

            context_items = tool_context.state.get(CONTEXT_STATE_KEY, [])
            tool_received_context.extend(context_items)

            return f"Found {len(context_items)} context items"

        # Create agent with context-checking tool
        llm_agent = LlmAgent(
            name="tool_context_agent",
            model=DEFAULT_MODEL,
            instruction="You have access to a tool called context_checking_tool. Always call it when asked about context.",
            tools=[context_checking_tool],
        )

        adk_agent = ADKAgent(
            adk_agent=llm_agent,
            app_name="test_app",
            user_id="test_user",
            use_in_memory_services=True,
        )

        # Run with context and ask agent to use the tool
        run_input = RunAgentInput(
            thread_id="test_tool_context",
            run_id="run_1",
            messages=[
                UserMessage(
                    id="msg_1",
                    role="user",
                    content="Please call the context_checking_tool to check the context."
                )
            ],
            context=[
                Context(description="user_preference", value="dark_mode"),
                Context(description="language", value="en"),
            ],
            state={},
            tools=[],
            forwarded_props={}
        )

        events = await collect_events(adk_agent, run_input)
        event_types = get_event_types(events)

        # Verify run completed successfully
        assert "EventType.RUN_STARTED" in event_types
        assert "EventType.RUN_FINISHED" in event_types
        assert "EventType.RUN_ERROR" not in event_types

        # Verify tool received the context
        # Note: The tool may or may not be called depending on model behavior
        # If called, it should have received the context
        if tool_received_context:
            assert len(tool_received_context) == 2
            assert {"description": "user_preference", "value": "dark_mode"} in tool_received_context
            assert {"description": "language", "value": "en"} in tool_received_context

        await adk_agent.close()


class TestContextInStateSnapshot:
    """Integration tests for context in state snapshot events."""

    @pytest.fixture(autouse=True)
    def setup_llmock(self, llmock_server):
        """Ensure LLMock is running when no real API key is set."""

    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        """Reset singleton SessionManager between tests."""
        SessionManager.reset_instance()
        yield
        SessionManager.reset_instance()

    @pytest.mark.asyncio
    async def test_state_snapshot_includes_context(self):
        """Test that STATE_SNAPSHOT event includes context under _ag_ui_context."""
        if not os.getenv("GOOGLE_API_KEY"):
            pytest.skip("GOOGLE_API_KEY not set - skipping live test")

        llm_agent = LlmAgent(
            name="snapshot_test_agent",
            model=DEFAULT_MODEL,
            instruction="You are a helpful assistant. Keep responses very brief.",
        )

        adk_agent = ADKAgent(
            adk_agent=llm_agent,
            app_name="test_app",
            user_id="test_user",
            use_in_memory_services=True,
        )

        run_input = RunAgentInput(
            thread_id="test_snapshot_context",
            run_id="run_1",
            messages=[
                UserMessage(id="msg_1", role="user", content="Hello")
            ],
            context=[
                Context(description="session_type", value="test"),
            ],
            state={"custom_state": "value"},
            tools=[],
            forwarded_props={}
        )

        events = await collect_events(adk_agent, run_input)

        # Find STATE_SNAPSHOT event
        state_snapshot_events = [
            e for e in events
            if str(e.type) == "EventType.STATE_SNAPSHOT"
        ]

        # Should have at least one state snapshot
        assert len(state_snapshot_events) >= 1

        # Check the last state snapshot for context
        last_snapshot = state_snapshot_events[-1]
        assert hasattr(last_snapshot, 'snapshot')

        snapshot = last_snapshot.snapshot
        assert CONTEXT_STATE_KEY in snapshot

        context_in_snapshot = snapshot[CONTEXT_STATE_KEY]
        assert len(context_in_snapshot) == 1
        assert context_in_snapshot[0] == {"description": "session_type", "value": "test"}

        # Verify custom state is also present
        assert snapshot.get("custom_state") == "value"

        await adk_agent.close()


class TestContextPersistenceAcrossRuns:
    """Test that context is properly updated across multiple runs."""

    @pytest.fixture(autouse=True)
    def setup_llmock(self, llmock_server):
        """Ensure LLMock is running when no real API key is set."""

    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        """Reset singleton SessionManager between tests."""
        SessionManager.reset_instance()
        yield
        SessionManager.reset_instance()

    @pytest.mark.asyncio
    async def test_context_updates_between_runs(self):
        """Test that context is updated when it changes between runs."""
        if not os.getenv("GOOGLE_API_KEY"):
            pytest.skip("GOOGLE_API_KEY not set - skipping live test")

        llm_agent = LlmAgent(
            name="multi_run_agent",
            model=DEFAULT_MODEL,
            instruction="You are a helpful assistant. Keep responses very brief.",
        )

        adk_agent = ADKAgent(
            adk_agent=llm_agent,
            app_name="test_app",
            user_id="test_user",
            use_in_memory_services=True,
        )

        thread_id = "test_context_persistence"

        # First run with initial context
        run_input_1 = RunAgentInput(
            thread_id=thread_id,
            run_id="run_1",
            messages=[
                UserMessage(id="msg_1", role="user", content="Hello")
            ],
            context=[
                Context(description="run_number", value="1"),
            ],
            state={},
            tools=[],
            forwarded_props={}
        )

        events_1 = await collect_events(adk_agent, run_input_1)

        # Find last state snapshot from first run
        snapshots_1 = [
            e for e in events_1
            if str(e.type) == "EventType.STATE_SNAPSHOT"
        ]
        assert len(snapshots_1) >= 1
        snapshot_1 = snapshots_1[-1].snapshot
        assert snapshot_1[CONTEXT_STATE_KEY] == [{"description": "run_number", "value": "1"}]

        # Second run with updated context
        run_input_2 = RunAgentInput(
            thread_id=thread_id,
            run_id="run_2",
            messages=[
                UserMessage(id="msg_1", role="user", content="Hello"),
                # Include previous exchange for context
                UserMessage(id="msg_2", role="user", content="Hello again")
            ],
            context=[
                Context(description="run_number", value="2"),
                Context(description="new_context", value="added"),
            ],
            state={},
            tools=[],
            forwarded_props={}
        )

        events_2 = await collect_events(adk_agent, run_input_2)

        # Find last state snapshot from second run
        snapshots_2 = [
            e for e in events_2
            if str(e.type) == "EventType.STATE_SNAPSHOT"
        ]
        assert len(snapshots_2) >= 1
        snapshot_2 = snapshots_2[-1].snapshot

        # Context should be updated to new values
        assert CONTEXT_STATE_KEY in snapshot_2
        context_2 = snapshot_2[CONTEXT_STATE_KEY]
        assert len(context_2) == 2
        assert {"description": "run_number", "value": "2"} in context_2
        assert {"description": "new_context", "value": "added"} in context_2

        await adk_agent.close()


# Run tests with pytest
if __name__ == "__main__":
    pytest.main([__file__, "-v"])
