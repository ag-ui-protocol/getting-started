#!/usr/bin/env python
"""Tests for LRO (Long Running Operation) SSE streaming persistence fix.

This module tests the fix for the bug where agent events were NOT persisted
to the session database when using LongRunningFunctionTool with SSE streaming
enabled (the default).

Bug Summary:
- With SSE streaming, ADK yields partial=True events (not persisted) then
  partial=False events (persisted)
- The middleware previously returned early when detecting LRO tools, abandoning
  the runner's async generator before the final non-partial event was consumed
- This caused ADK to never persist the agent's response, losing session history

Fix:
- Continue consuming events from the runner until a non-partial event is received
- This allows ADK's natural persistence mechanism to complete

Integration tests require one of the following authentication methods:
- GOOGLE_API_KEY environment variable (for Google AI Studio)
- GOOGLE_GENAI_USE_VERTEXAI=TRUE with gcloud auth (for Vertex AI)
"""

import asyncio
import os
import uuid
import pytest
from unittest.mock import MagicMock, AsyncMock, patch

from ag_ui.core import (
    RunAgentInput,
    UserMessage,
    EventType,
    Tool as AGUITool,
)
from ag_ui_adk import ADKAgent
from ag_ui_adk.session_manager import SessionManager
from tests.constants import LIVE_TEST_MODEL


# =============================================================================
# Unit Tests (Mocked - No API Key Required)
# =============================================================================

class TestLROSSEPersistenceUnit:
    """Unit tests for the LRO SSE persistence fix using mocks."""

    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        """Reset session manager between tests."""
        SessionManager.reset_instance()
        yield
        SessionManager.reset_instance()

    @pytest.fixture
    def adk_agent(self):
        """Create an ADKAgent with a mocked ADK agent."""
        from google.adk.agents import Agent
        mock_agent = MagicMock(spec=Agent)
        mock_agent.name = "test_agent"
        mock_agent.model_copy = MagicMock(return_value=mock_agent)
        return ADKAgent(
            adk_agent=mock_agent,
            app_name="test_app",
            user_id="test_user"
        )

    @pytest.mark.asyncio
    async def test_lro_with_partial_true_drains_until_non_partial(self, adk_agent):
        """Test that when LRO is detected with partial=True, we drain until partial=False.
        
        This is the core fix: instead of returning immediately when an LRO tool is
        detected, we continue consuming events until ADK yields a non-partial event,
        which signals that persistence has completed.
        """
        lro_tool_id = "lro-tool-123"
        events_consumed = []
        
        def create_event(partial, has_lro=True):
            """Create a mock ADK event."""
            func_call = MagicMock()
            func_call.id = lro_tool_id
            func_call.name = "client_tool"
            func_call.args = {"key": "value"}
            
            func_part = MagicMock()
            func_part.text = None
            func_part.function_call = func_call
            
            evt = MagicMock()
            evt.author = "assistant"
            evt.content = MagicMock()
            evt.content.parts = [func_part]
            evt.partial = partial
            evt.turn_complete = not partial
            evt.is_final_response = MagicMock(return_value=not partial)
            evt.get_function_calls = MagicMock(return_value=[func_call] if has_lro else [])
            evt.get_function_responses = MagicMock(return_value=[])
            evt.long_running_tool_ids = [lro_tool_id] if has_lro else []
            evt.invocation_id = "inv-123"
            return evt

        async def mock_run_async(**kwargs):
            """Simulate SSE streaming: partial=True, then partial=False."""
            # Event 1: partial=True (streaming chunk - NOT persisted by ADK)
            evt1 = create_event(partial=True)
            events_consumed.append(("event1", "partial=True"))
            yield evt1
            
            # Event 2: partial=False (final - IS persisted by ADK)
            evt2 = create_event(partial=False)
            events_consumed.append(("event2", "partial=False"))
            yield evt2

        mock_runner = MagicMock()
        mock_runner.run_async = mock_run_async

        input_data = RunAgentInput(
            thread_id=f"test_thread_{uuid.uuid4().hex[:8]}",
            run_id=f"test_run_{uuid.uuid4().hex[:8]}",
            messages=[UserMessage(id="u1", role="user", content="Test message")],
            tools=[],
            context=[],
            state={},
            forwarded_props={},
        )

        with patch.object(adk_agent, "_create_runner", return_value=mock_runner):
            events = []
            # Suppress the deprecation warning for this test
            import warnings
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", DeprecationWarning)
                async for e in adk_agent.run(input_data):
                    events.append(e)

        # CRITICAL ASSERTION: Both events should have been consumed
        # Before the fix, only event1 would be consumed, then early return
        # After the fix, we drain until event2 (partial=False) is consumed
        assert len(events_consumed) == 2, (
            f"Expected 2 events to be consumed (partial=True then partial=False), "
            f"but only {len(events_consumed)} were consumed: {events_consumed}. "
            f"This means the runner was abandoned early, breaking persistence!"
        )
        
        # Verify we got the final non-partial event
        assert events_consumed[-1] == ("event2", "partial=False"), (
            f"Last event consumed should be partial=False (the persistence trigger), "
            f"got: {events_consumed[-1]}"
        )

    @pytest.mark.asyncio
    async def test_lro_with_partial_false_returns_immediately(self, adk_agent):
        """Test that when LRO is detected with partial=False, we return without draining.
        
        If the LRO event already has partial=False, ADK has already persisted it,
        so we don't need to drain further.
        """
        lro_tool_id = "lro-tool-456"
        events_consumed = []
        
        def create_event(partial):
            func_call = MagicMock()
            func_call.id = lro_tool_id
            func_call.name = "client_tool"
            func_call.args = {}
            
            func_part = MagicMock()
            func_part.text = None
            func_part.function_call = func_call
            
            evt = MagicMock()
            evt.author = "assistant"
            evt.content = MagicMock()
            evt.content.parts = [func_part]
            evt.partial = partial
            evt.turn_complete = not partial
            evt.is_final_response = MagicMock(return_value=not partial)
            evt.get_function_calls = MagicMock(return_value=[func_call])
            evt.get_function_responses = MagicMock(return_value=[])
            evt.long_running_tool_ids = [lro_tool_id]
            evt.invocation_id = "inv-456"
            return evt

        async def mock_run_async(**kwargs):
            # Only one event with partial=False (already persisted)
            evt = create_event(partial=False)
            events_consumed.append("partial=False")
            yield evt
            
            # This event should NOT be consumed (we return after the LRO)
            evt2 = create_event(partial=False)
            events_consumed.append("should_not_reach")
            yield evt2

        mock_runner = MagicMock()
        mock_runner.run_async = mock_run_async

        input_data = RunAgentInput(
            thread_id=f"test_thread_{uuid.uuid4().hex[:8]}",
            run_id=f"test_run_{uuid.uuid4().hex[:8]}",
            messages=[UserMessage(id="u1", role="user", content="Test")],
            tools=[],
            context=[],
            state={},
            forwarded_props={},
        )

        with patch.object(adk_agent, "_create_runner", return_value=mock_runner):
            import warnings
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", DeprecationWarning)
                events = []
                async for e in adk_agent.run(input_data):
                    events.append(e)

        # Should only consume the first event (partial=False means already persisted)
        assert len(events_consumed) == 1, (
            f"Expected only 1 event consumed (partial=False already persisted), "
            f"got {len(events_consumed)}: {events_consumed}"
        )

    @pytest.mark.asyncio
    async def test_text_content_emitted_during_drain(self, adk_agent):
        """Test that text content from remaining events is emitted during drain.
        
        When draining until non-partial, any text content in the remaining events
        should still be translated and emitted to the frontend.
        """
        lro_tool_id = "lro-tool-789"
        
        def create_event(partial, text=None, has_lro=True):
            func_call = MagicMock()
            func_call.id = lro_tool_id
            func_call.name = "client_tool"
            func_call.args = {}
            
            parts = []
            if text:
                text_part = MagicMock()
                text_part.text = text
                text_part.function_call = None
                parts.append(text_part)
            
            if has_lro:
                func_part = MagicMock()
                func_part.text = None
                func_part.function_call = func_call
                parts.append(func_part)
            
            evt = MagicMock()
            evt.author = "assistant"
            evt.content = MagicMock()
            evt.content.parts = parts
            evt.partial = partial
            evt.turn_complete = not partial
            evt.is_final_response = MagicMock(return_value=not partial)
            evt.get_function_calls = MagicMock(return_value=[func_call] if has_lro else [])
            evt.get_function_responses = MagicMock(return_value=[])
            evt.long_running_tool_ids = [lro_tool_id] if has_lro else []
            evt.invocation_id = "inv-789"
            return evt

        async def mock_run_async(**kwargs):
            # Event 1: partial=True with LRO tool
            yield create_event(partial=True, text="Starting...")
            # Event 2: partial=False with final text
            yield create_event(partial=False, text="Done!", has_lro=False)

        mock_runner = MagicMock()
        mock_runner.run_async = mock_run_async

        input_data = RunAgentInput(
            thread_id=f"test_thread_{uuid.uuid4().hex[:8]}",
            run_id=f"test_run_{uuid.uuid4().hex[:8]}",
            messages=[UserMessage(id="u1", role="user", content="Test")],
            tools=[],
            context=[],
            state={},
            forwarded_props={},
        )

        with patch.object(adk_agent, "_create_runner", return_value=mock_runner):
            import warnings
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", DeprecationWarning)
                events = []
                async for e in adk_agent.run(input_data):
                    events.append(e)

        # Should have run lifecycle events and tool call events
        event_types = [str(e.type).split('.')[-1] for e in events]
        assert "RUN_STARTED" in event_types
        assert "RUN_FINISHED" in event_types
        assert "TOOL_CALL_START" in event_types or "TOOL_CALL_END" in event_types


# =============================================================================
# Integration Tests (Require Google AI or Vertex AI Authentication)
# =============================================================================

def _has_google_auth():
    """Check if Google AI or Vertex AI authentication is available."""
    # Check for Google AI Studio API key
    if os.environ.get("GOOGLE_API_KEY"):
        return True
    # Check for Vertex AI (gcloud auth)
    if os.environ.get("GOOGLE_GENAI_USE_VERTEXAI", "").upper() == "TRUE":
        # Vertex AI also needs project and location
        if os.environ.get("GOOGLE_CLOUD_PROJECT") or os.environ.get("VERTEXAI_PROJECT"):
            return True
    return False


class TestLROSSEPersistenceIntegration:
    """Integration tests that verify persistence with real ADK.

    These tests require one of:
    - GOOGLE_API_KEY environment variable (for Google AI Studio)
    - GOOGLE_GENAI_USE_VERTEXAI=TRUE with gcloud auth and GOOGLE_CLOUD_PROJECT (for Vertex AI)
    - LLMock server (started automatically by the llmock_server fixture)
    """

    @pytest.fixture(autouse=True)
    def setup_llmock(self, llmock_server):
        """Ensure LLMock is running when no real API key is set."""

    @pytest.fixture(autouse=True)
    def skip_without_auth(self):
        """Skip if no authentication is available."""
        if not _has_google_auth():
            pytest.skip("No Google authentication available")

    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        """Reset session manager between tests."""
        SessionManager.reset_instance()
        yield
        SessionManager.reset_instance()

    @pytest.fixture
    def lro_tool(self):
        """Create a sample LRO tool (simulates useFrontendTool)."""
        return AGUITool(
            name="get_greeting",
            description="Get a greeting for the given name",
            parameters={
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "The name to greet"
                    }
                },
                "required": ["name"]
            }
        )

    @pytest.mark.asyncio
    async def test_agent_events_persisted_with_sse_streaming(self, lro_tool):
        """Test that agent events ARE persisted when using LRO tool + SSE streaming.
        
        This is the main regression test for the bug. It verifies that:
        1. Agent response is emitted to the frontend
        2. Agent response is persisted to the session
        """
        from google.adk.agents import LlmAgent
        from google.adk.sessions import InMemorySessionService
        from google.adk.agents.run_config import RunConfig, StreamingMode
        from ag_ui_adk.agui_toolset import AGUIToolset

        session_service = InMemorySessionService()
        app_name = f"test_sse_persistence_{uuid.uuid4().hex[:8]}"
        user_id = "test_user"

        # Create agent that will use the LRO tool
        agent = LlmAgent(
            name="greeter",
            model=LIVE_TEST_MODEL,
            instruction="When asked to greet someone, use the get_greeting tool with their name.",
            tools=[AGUIToolset()],
        )

        # SSE streaming is the default, but be explicit
        def sse_streaming_config(input):
            return RunConfig(streaming_mode=StreamingMode.SSE)

        adk_agent = ADKAgent(
            adk_agent=agent,
            app_name=app_name,
            user_id=user_id,
            session_service=session_service,
            run_config_factory=sse_streaming_config,
        )

        thread_id = f"thread_{uuid.uuid4().hex[:8]}"
        input_data = RunAgentInput(
            thread_id=thread_id,
            run_id=f"run_{uuid.uuid4().hex[:8]}",
            messages=[UserMessage(id="msg1", role="user", content="Please greet Alice")],
            state={},
            tools=[lro_tool],
            context=[],
            forwarded_props={},
        )

        # Run the agent
        events = []
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", DeprecationWarning)
            async for event in adk_agent.run(input_data):
                events.append(event)

        # Verify we got events
        event_types = [str(e.type).split('.')[-1] for e in events]
        assert "RUN_STARTED" in event_types, f"Missing RUN_STARTED. Got: {event_types}"
        assert "RUN_FINISHED" in event_types, f"Missing RUN_FINISHED. Got: {event_types}"

        # Check persisted events in session
        sessions = await session_service.list_sessions(app_name=app_name, user_id=user_id)
        assert sessions.sessions, "No sessions found"

        session = await session_service.get_session(
            app_name=app_name,
            user_id=user_id,
            session_id=sessions.sessions[0].id
        )

        # Count agent events (author != 'user')
        agent_events = [
            e for e in session.events 
            if getattr(e, 'author', None) != 'user'
        ]

        # THE KEY ASSERTION: Agent events should be persisted
        assert len(agent_events) > 0, (
            f"BUG NOT FIXED: No agent events persisted with SSE streaming! "
            f"Total events: {len(session.events)}, "
            f"Event authors: {[getattr(e, 'author', 'unknown') for e in session.events]}"
        )

    @pytest.mark.asyncio
    async def test_agent_events_persisted_without_streaming_baseline(self, lro_tool):
        """Baseline test: Agent events ARE persisted when streaming is disabled.
        
        This test confirms that the issue is specific to SSE streaming.
        With streaming disabled, persistence should always work.
        """
        from google.adk.agents import LlmAgent
        from google.adk.sessions import InMemorySessionService
        from google.adk.agents.run_config import RunConfig, StreamingMode
        from ag_ui_adk.agui_toolset import AGUIToolset

        session_service = InMemorySessionService()
        app_name = f"test_no_streaming_{uuid.uuid4().hex[:8]}"
        user_id = "test_user"

        agent = LlmAgent(
            name="greeter",
            model=LIVE_TEST_MODEL,
            instruction="When asked to greet someone, use the get_greeting tool with their name.",
            tools=[AGUIToolset()],
        )

        # Disable streaming
        def no_streaming_config(input):
            return RunConfig(streaming_mode=StreamingMode.NONE)

        adk_agent = ADKAgent(
            adk_agent=agent,
            app_name=app_name,
            user_id=user_id,
            session_service=session_service,
            run_config_factory=no_streaming_config,
        )

        thread_id = f"thread_{uuid.uuid4().hex[:8]}"
        input_data = RunAgentInput(
            thread_id=thread_id,
            run_id=f"run_{uuid.uuid4().hex[:8]}",
            messages=[UserMessage(id="msg1", role="user", content="Please greet Bob")],
            state={},
            tools=[lro_tool],
            context=[],
            forwarded_props={},
        )

        # Run the agent
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", DeprecationWarning)
            async for _ in adk_agent.run(input_data):
                pass

        # Check persisted events
        sessions = await session_service.list_sessions(app_name=app_name, user_id=user_id)
        assert sessions.sessions, "No sessions found"

        session = await session_service.get_session(
            app_name=app_name,
            user_id=user_id,
            session_id=sessions.sessions[0].id
        )

        agent_events = [
            e for e in session.events 
            if getattr(e, 'author', None) != 'user'
        ]

        # Baseline: Without streaming, persistence should work
        assert len(agent_events) > 0, (
            f"Baseline failed: No agent events persisted even without streaming! "
            f"This indicates a different issue."
        )


# =============================================================================
# Direct Execution
# =============================================================================

if __name__ == "__main__":
    import sys
    
    if _has_google_auth():
        print("Running all tests (Google authentication available)")
        pytest.main([__file__, "-v", "-s"])
    else:
        print("No Google authentication - running unit tests only")
        print("Set GOOGLE_API_KEY or configure Vertex AI to run integration tests")
        pytest.main([__file__, "-v", "-s", "-k", "Unit"])
