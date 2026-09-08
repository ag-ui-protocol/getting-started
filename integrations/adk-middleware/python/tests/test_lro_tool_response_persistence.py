#!/usr/bin/env python
"""Integration tests for LRO tool response persistence and invocation_id handling.

These are TRUE integration tests that require GOOGLE_API_KEY and use real ADK
runners to verify end-to-end behavior.

Tests verify that function_response events are correctly persisted to the
ADK session with proper invocation_id values. This is critical for:

1. DatabaseSessionService compatibility - requires invocation_id on all events
2. HITL (Human-in-the-Loop) resumption - SequentialAgent needs consistent invocation_id
3. Preventing duplicate function_response events (GitHub issue #1074)

See:
- https://github.com/ag-ui-protocol/ag-ui/issues/1074
- https://github.com/ag-ui-protocol/ag-ui/issues/957
- https://github.com/ag-ui-protocol/ag-ui/pull/958
"""

import asyncio
import os
import time
import pytest
from typing import List, Optional, Dict, Any

from ag_ui.core import (
    RunAgentInput,
    EventType,
    UserMessage,
    AssistantMessage,
    ToolMessage,
    ToolCall,
    FunctionCall,
    Tool as AGUITool,
    BaseEvent,
    ToolCallStartEvent,
    ToolCallEndEvent,
)
from ag_ui_adk import ADKAgent, AGUIToolset
from ag_ui_adk.adk_agent import _ADK_OVERRIDES_INVOCATION_ID
from ag_ui_adk.session_manager import SessionManager, INVOCATION_ID_STATE_KEY
from google.adk.agents import Agent
from google.adk.apps import App, ResumabilityConfig
from google.genai import types
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


def find_tool_call_id(events: List[BaseEvent]) -> Optional[str]:
    """Find the tool_call_id from TOOL_CALL_START or TOOL_CALL_END events."""
    for event in events:
        if hasattr(event, 'tool_call_id'):
            return event.tool_call_id
    return None


def count_function_responses(session, tool_call_id: str) -> tuple[int, List[Dict]]:
    """Count FunctionResponse events for a given tool_call_id in a session.

    Returns (count, list of response details including invocation_id).
    """
    responses = []
    for event in session.events:
        if event.content and hasattr(event.content, 'parts'):
            for part in event.content.parts:
                if hasattr(part, 'function_response') and part.function_response:
                    fr = part.function_response
                    if hasattr(fr, 'id') and fr.id == tool_call_id:
                        responses.append({
                            'invocation_id': getattr(event, 'invocation_id', None),
                            'name': fr.name,
                            'response': fr.response,
                        })
    return len(responses), responses


class TestLROToolResponseIntegration:
    """True integration tests for LRO tool response persistence.

    These tests require GOOGLE_API_KEY and use real ADK runners.
    """

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
    def check_api_key(self):
        """Skip test if GOOGLE_API_KEY is not set."""
        if not os.getenv("GOOGLE_API_KEY"):
            pytest.skip("GOOGLE_API_KEY not set - skipping live integration test")

    @pytest.fixture
    def hitl_agent(self):
        """Create an ADK agent with client-side tools for HITL testing."""
        # Define a simple client-side tool
        agent = Agent(
            model=DEFAULT_MODEL,
            name='hitl_test_agent',
            instruction="""You are a test agent. When asked to do a task,
            ALWAYS call the approve_action tool to get user approval first.
            Keep all responses brief.""",
            tools=[AGUIToolset()],  # Client-side tools
        )

        # Create ADK App with ResumabilityConfig for HITL
        adk_app = App(
            name="test_hitl_app",
            root_agent=agent,
            resumability_config=ResumabilityConfig(is_resumable=True),
        )

        return ADKAgent.from_app(
            adk_app,
            user_id="test_user",
            use_in_memory_services=True,
        )

    @pytest.fixture
    def simple_agent(self):
        """Create a simple ADK agent for tool persistence tests.

        Uses ADKAgent.from_app() with ResumabilityConfig because the HITL
        tool-result flow (pending tool tracking, invocation_id storage)
        requires a resumable app.
        """
        agent = Agent(
            model=DEFAULT_MODEL,
            name='simple_test_agent',
            instruction="You are a test agent. Keep responses very brief.",
            tools=[AGUIToolset()],
        )

        adk_app = App(
            name="test_simple_app",
            root_agent=agent,
            resumability_config=ResumabilityConfig(is_resumable=True),
        )

        return ADKAgent.from_app(
            adk_app,
            user_id="test_user",
            use_in_memory_services=True,
        )

    @pytest.mark.asyncio
    @pytest.mark.skipif(
        not _ADK_OVERRIDES_INVOCATION_ID,
        reason="Single-FunctionResponse persistence guarantee depends on the ADK >=1.30 pre-append workaround",
    )
    async def test_tool_result_persists_single_function_response(
        self, check_api_key, simple_agent
    ):
        """Integration test: tool result submission persists exactly ONE function_response.

        This is the core test for issue #1074. It verifies that when a tool result
        is submitted, only ONE function_response event is persisted to the session,
        not two (which would indicate duplicate persistence).

        Flow:
        1. Send a message that triggers a client-side tool call
        2. Capture the tool_call_id from the response
        3. Submit the tool result
        4. Verify exactly ONE function_response is in the session
        """
        thread_id = f"test_single_response_{int(time.time())}"

        # Define the client-side tool
        approve_tool = AGUITool(
            name="approve_action",
            description="Get user approval for an action",
            parameters={
                "type": "object",
                "properties": {
                    "action": {"type": "string", "description": "The action to approve"}
                },
                "required": ["action"]
            }
        )

        # Step 1: Send initial message to trigger tool call
        run_input_1 = RunAgentInput(
            thread_id=thread_id,
            run_id="run_1",
            messages=[
                UserMessage(id="msg_1", role="user", content="Please approve doing task X")
            ],
            tools=[approve_tool],
            context=[],
            state={},
            forwarded_props={}
        )

        events_1 = await collect_events(simple_agent, run_input_1)
        event_types_1 = get_event_types(events_1)

        # Verify we got a tool call
        assert "EventType.RUN_STARTED" in event_types_1, "Expected RUN_STARTED"

        # Find the tool_call_id
        tool_call_id = find_tool_call_id(events_1)

        if tool_call_id is None:
            # Agent didn't call the tool - this can happen with LLMs
            # Skip this test run but don't fail
            pytest.skip("Agent did not call the tool in this run - LLM behavior varies")

        # Step 2: Submit tool result
        run_input_2 = RunAgentInput(
            thread_id=thread_id,
            run_id="run_2",
            messages=[
                UserMessage(id="msg_1", role="user", content="Please approve doing task X"),
                AssistantMessage(
                    id="msg_2",
                    role="assistant",
                    content=None,
                    tool_calls=[
                        ToolCall(
                            id=tool_call_id,
                            function=FunctionCall(name="approve_action", arguments='{"action": "task X"}')
                        )
                    ]
                ),
                ToolMessage(
                    id="msg_3",
                    role="tool",
                    content='{"approved": true, "message": "User approved"}',
                    tool_call_id=tool_call_id
                )
            ],
            tools=[approve_tool],
            context=[],
            state={},
            forwarded_props={}
        )

        events_2 = await collect_events(simple_agent, run_input_2)
        event_types_2 = get_event_types(events_2)

        # Should complete without error
        assert "EventType.RUN_STARTED" in event_types_2
        assert "EventType.RUN_ERROR" not in event_types_2, f"Got error: {events_2}"

        # Step 3: Verify session has exactly ONE function_response
        app_name = simple_agent._get_app_name(run_input_2)
        user_id = simple_agent._get_user_id(run_input_2)
        backend_session_id = simple_agent._get_backend_session_id(thread_id, user_id)

        if backend_session_id:
            session = await simple_agent._session_manager._session_service.get_session(
                session_id=backend_session_id,
                app_name=app_name,
                user_id=user_id
            )

            count, responses = count_function_responses(session, tool_call_id)

            assert count == 1, (
                f"Expected exactly 1 FunctionResponse for tool_call_id={tool_call_id}, "
                f"found {count}. This indicates duplicate persistence (issue #1074). "
                f"Responses: {responses}"
            )

            # Verify invocation_id is set
            assert responses[0]['invocation_id'] is not None, (
                "FunctionResponse missing invocation_id - required for DatabaseSessionService"
            )

    @pytest.mark.asyncio
    async def test_function_response_has_correct_invocation_id(
        self, check_api_key, simple_agent
    ):
        """Integration test: persisted function_response carries a usable invocation_id.

        DatabaseSessionService requires invocation_id to be non-null on every event
        (GitHub #957). The exact value differs by ADK version:

        - ADK <1.30: the middleware tags the FunctionResponse with the AG-UI run_id
          and passes it to runner.run_async(); ADK honors that value.
        - ADK >=1.30: Runner._resolve_invocation_id() forcibly substitutes the
          invocation_id of the matching FunctionCall event (an ADK-generated
          ``e-…`` identifier). The middleware pre-appends the FunctionResponse
          with that same identifier to stay consistent with ADK's contract.

        Either way, the persisted invocation_id must be non-null and must match
        the FunctionCall event's invocation_id.
        """
        thread_id = f"test_invocation_id_{int(time.time())}"
        expected_run_id = "run_with_tool_result_456"

        approve_tool = AGUITool(
            name="get_confirmation",
            description="Get user confirmation",
            parameters={"type": "object", "properties": {}}
        )

        # Step 1: Trigger tool call
        run_input_1 = RunAgentInput(
            thread_id=thread_id,
            run_id="run_1",
            messages=[
                UserMessage(id="msg_1", role="user", content="Please confirm this action")
            ],
            tools=[approve_tool],
            context=[],
            state={},
            forwarded_props={}
        )

        events_1 = await collect_events(simple_agent, run_input_1)
        tool_call_id = find_tool_call_id(events_1)

        if tool_call_id is None:
            pytest.skip("Agent did not call the tool in this run")

        # Step 2: Submit tool result with specific run_id
        run_input_2 = RunAgentInput(
            thread_id=thread_id,
            run_id=expected_run_id,  # This should become the invocation_id
            messages=[
                UserMessage(id="msg_1", role="user", content="Please confirm this action"),
                AssistantMessage(
                    id="msg_2",
                    role="assistant",
                    content=None,
                    tool_calls=[
                        ToolCall(
                            id=tool_call_id,
                            function=FunctionCall(name="get_confirmation", arguments="{}")
                        )
                    ]
                ),
                ToolMessage(
                    id="msg_3",
                    role="tool",
                    content='{"confirmed": true}',
                    tool_call_id=tool_call_id
                )
            ],
            tools=[approve_tool],
            context=[],
            state={},
            forwarded_props={}
        )

        events_2 = await collect_events(simple_agent, run_input_2)

        assert "EventType.RUN_ERROR" not in get_event_types(events_2)

        # Verify invocation_id
        app_name = simple_agent._get_app_name(run_input_2)
        user_id = simple_agent._get_user_id(run_input_2)
        backend_session_id = simple_agent._get_backend_session_id(thread_id, user_id)

        if backend_session_id:
            session = await simple_agent._session_manager._session_service.get_session(
                session_id=backend_session_id,
                app_name=app_name,
                user_id=user_id
            )

            count, responses = count_function_responses(session, tool_call_id)

            if count > 0:
                actual_invocation_id = responses[0]['invocation_id']
                assert actual_invocation_id, (
                    "FunctionResponse missing invocation_id - breaks DatabaseSessionService"
                )

                # Find the FunctionCall event's invocation_id so we can compare
                # against the ground-truth identity that ADK uses.
                fc_invocation_id = None
                for event in session.events:
                    if not event.content or not getattr(event.content, 'parts', None):
                        continue
                    for part in event.content.parts:
                        fc = getattr(part, 'function_call', None)
                        if fc and getattr(fc, 'id', None) == tool_call_id:
                            fc_invocation_id = getattr(event, 'invocation_id', None)
                            break
                    if fc_invocation_id:
                        break

                if _ADK_OVERRIDES_INVOCATION_ID:
                    # ADK >=1.30: the persisted FunctionResponse must carry the same
                    # invocation_id as the originating FunctionCall event, because
                    # Runner._resolve_invocation_id() enforces that linkage.
                    assert fc_invocation_id is not None, (
                        "Could not locate the FunctionCall event in session — test setup bug"
                    )
                    assert actual_invocation_id == fc_invocation_id, (
                        f"FunctionResponse invocation_id should match FunctionCall "
                        f"invocation_id '{fc_invocation_id}', got '{actual_invocation_id}'"
                    )
                else:
                    # ADK <1.30: the middleware propagates the AG-UI run_id as the
                    # invocation_id, which pre-1.30 ADK honors.
                    assert actual_invocation_id == expected_run_id, (
                        f"FunctionResponse invocation_id should be '{expected_run_id}', "
                        f"got '{actual_invocation_id}'. This breaks DatabaseSessionService."
                    )

    @pytest.mark.asyncio
    @pytest.mark.skipif(
        not _ADK_OVERRIDES_INVOCATION_ID,
        reason="Single-FunctionResponse persistence guarantee depends on the ADK >=1.30 pre-append workaround",
    )
    async def test_tool_result_with_trailing_user_message(
        self, check_api_key, simple_agent
    ):
        """Integration test: tool result + user message persists single function_response.

        When tool results arrive WITH a trailing user message, the function_response
        should still be persisted exactly once.
        """
        thread_id = f"test_with_user_msg_{int(time.time())}"

        approve_tool = AGUITool(
            name="check_status",
            description="Check status of something",
            parameters={"type": "object", "properties": {}}
        )

        # Step 1: Trigger tool call
        run_input_1 = RunAgentInput(
            thread_id=thread_id,
            run_id="run_1",
            messages=[
                UserMessage(id="msg_1", role="user", content="Check the status please")
            ],
            tools=[approve_tool],
            context=[],
            state={},
            forwarded_props={}
        )

        events_1 = await collect_events(simple_agent, run_input_1)
        tool_call_id = find_tool_call_id(events_1)

        if tool_call_id is None:
            pytest.skip("Agent did not call the tool in this run")

        # Step 2: Submit tool result WITH trailing user message
        run_input_2 = RunAgentInput(
            thread_id=thread_id,
            run_id="run_2",
            messages=[
                UserMessage(id="msg_1", role="user", content="Check the status please"),
                AssistantMessage(
                    id="msg_2",
                    role="assistant",
                    content=None,
                    tool_calls=[
                        ToolCall(
                            id=tool_call_id,
                            function=FunctionCall(name="check_status", arguments="{}")
                        )
                    ]
                ),
                ToolMessage(
                    id="msg_3",
                    role="tool",
                    content='{"status": "ok"}',
                    tool_call_id=tool_call_id
                ),
                UserMessage(id="msg_4", role="user", content="Thanks! What next?")  # Trailing message
            ],
            tools=[approve_tool],
            context=[],
            state={},
            forwarded_props={}
        )

        events_2 = await collect_events(simple_agent, run_input_2)

        assert "EventType.RUN_ERROR" not in get_event_types(events_2)

        # Verify single function_response
        app_name = simple_agent._get_app_name(run_input_2)
        user_id = simple_agent._get_user_id(run_input_2)
        backend_session_id = simple_agent._get_backend_session_id(thread_id, user_id)

        if backend_session_id:
            session = await simple_agent._session_manager._session_service.get_session(
                session_id=backend_session_id,
                app_name=app_name,
                user_id=user_id
            )

            count, responses = count_function_responses(session, tool_call_id)

            assert count == 1, (
                f"Expected 1 FunctionResponse with trailing user message, found {count}. "
                f"Issue #1074 may affect tool results + user message path too."
            )


class TestHITLResumptionIntegration:
    """Integration tests for HITL resumption with stored invocation_id."""

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
    def check_api_key(self):
        """Skip test if GOOGLE_API_KEY is not set."""
        if not os.getenv("GOOGLE_API_KEY"):
            pytest.skip("GOOGLE_API_KEY not set - skipping live integration test")

    @pytest.fixture
    def hitl_agent(self):
        """Create an ADK agent configured for HITL with ResumabilityConfig."""
        agent = Agent(
            model=DEFAULT_MODEL,
            name='hitl_resume_agent',
            instruction="""You are a task planning agent. When asked to plan something,
            call the plan_task tool to generate a plan. Keep responses brief.""",
            tools=[AGUIToolset()],
        )

        adk_app = App(
            name="test_hitl_resume_app",
            root_agent=agent,
            resumability_config=ResumabilityConfig(is_resumable=True),
        )

        return ADKAgent.from_app(
            adk_app,
            user_id="test_user",
            use_in_memory_services=True,
        )

    @pytest.mark.asyncio
    @pytest.mark.skipif(
        not _ADK_OVERRIDES_INVOCATION_ID,
        reason="HITL resumption FunctionResponse persistence depends on the ADK >=1.30 pre-append workaround",
    )
    async def test_hitl_resumption_preserves_invocation_context(
        self, check_api_key, hitl_agent
    ):
        """Integration test: HITL resumption uses stored invocation_id.

        When resuming after HITL pause, the stored invocation_id should be used
        to ensure SequentialAgent state is properly restored.

        This tests the full HITL flow:
        1. Initial request triggers tool call (agent pauses)
        2. Tool result submitted (should use stored invocation context)
        3. Agent resumes with correct state
        """
        thread_id = f"test_hitl_resume_{int(time.time())}"

        plan_tool = AGUITool(
            name="plan_task",
            description="Generate a task plan for user approval",
            parameters={
                "type": "object",
                "properties": {
                    "steps": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "List of steps"
                    }
                },
                "required": ["steps"]
            }
        )

        # Step 1: Initial request - should trigger tool call and pause
        run_input_1 = RunAgentInput(
            thread_id=thread_id,
            run_id="initial_run",
            messages=[
                UserMessage(id="msg_1", role="user", content="Plan a simple 2-step task")
            ],
            tools=[plan_tool],
            context=[],
            state={},
            forwarded_props={}
        )

        events_1 = await collect_events(hitl_agent, run_input_1)
        event_types_1 = get_event_types(events_1)

        tool_call_id = find_tool_call_id(events_1)

        if tool_call_id is None:
            pytest.skip("Agent did not call the tool - HITL flow not triggered")

        # Verify the run finished (HITL pauses return RUN_FINISHED)
        assert "EventType.RUN_FINISHED" in event_types_1, (
            f"HITL should pause with RUN_FINISHED, got: {event_types_1}"
        )

        # Step 2: Submit tool result (resuming HITL)
        run_input_2 = RunAgentInput(
            thread_id=thread_id,
            run_id="resume_run",
            messages=[
                UserMessage(id="msg_1", role="user", content="Plan a simple 2-step task"),
                AssistantMessage(
                    id="msg_2",
                    role="assistant",
                    content=None,
                    tool_calls=[
                        ToolCall(
                            id=tool_call_id,
                            function=FunctionCall(
                                name="plan_task",
                                arguments='{"steps": ["Step 1", "Step 2"]}'
                            )
                        )
                    ]
                ),
                ToolMessage(
                    id="msg_3",
                    role="tool",
                    content='{"approved": true, "steps": ["Step 1", "Step 2"]}',
                    tool_call_id=tool_call_id
                )
            ],
            tools=[plan_tool],
            context=[],
            state={},
            forwarded_props={}
        )

        events_2 = await collect_events(hitl_agent, run_input_2)
        event_types_2 = get_event_types(events_2)

        # Should resume successfully
        assert "EventType.RUN_STARTED" in event_types_2
        assert "EventType.RUN_FINISHED" in event_types_2
        assert "EventType.RUN_ERROR" not in event_types_2, (
            f"HITL resumption failed with error: {events_2}"
        )

        # Verify function_response was persisted correctly
        app_name = hitl_agent._get_app_name(run_input_2)
        user_id = hitl_agent._get_user_id(run_input_2)
        backend_session_id = hitl_agent._get_backend_session_id(thread_id, user_id)

        if backend_session_id:
            session = await hitl_agent._session_manager._session_service.get_session(
                session_id=backend_session_id,
                app_name=app_name,
                user_id=user_id
            )

            count, responses = count_function_responses(session, tool_call_id)

            # Should have exactly one function_response
            assert count == 1, (
                f"HITL resumption should persist exactly 1 FunctionResponse, found {count}"
            )

            # invocation_id should be set (either stored or from run_id)
            assert responses[0]['invocation_id'] is not None, (
                "HITL FunctionResponse missing invocation_id - breaks SequentialAgent resumption"
            )


# Run tests with pytest
if __name__ == "__main__":
    pytest.main([__file__, "-v"])
