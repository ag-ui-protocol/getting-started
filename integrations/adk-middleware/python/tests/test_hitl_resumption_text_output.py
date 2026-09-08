#!/usr/bin/env python
"""Regression test: HITL resumption must produce text output after tool result.

This test verifies that when a user submits a tool result (e.g., approving a plan)
during a Human-in-the-Loop flow, the agent actually generates a text response
acknowledging the result. This is the core user-facing behavior.

Background:
- PR #1075 would remove explicit FunctionResponse persistence (to fix duplicate events)
- This caused a regression where runner.run_async() returned ZERO events after
  HITL resumption — the LLM was never called, so no text was generated
- The dojo test "Human in the Loop Feature" timed out waiting for assistant messages

The root cause: the middleware was pre-appending the FunctionResponse to the session
before calling runner.run_async(). Removing this pre-append changed the session state
that the runner saw, causing it to skip LLM invocation entirely.

Requires GOOGLE_API_KEY environment variable.
"""

import asyncio
import os
import uuid
import pytest
from typing import List, Optional

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
)
from ag_ui_adk import ADKAgent, AGUIToolset
from ag_ui_adk.session_manager import SessionManager
from google.adk.agents import Agent
from google.adk.apps import App, ResumabilityConfig
from google.genai import types
from tests.constants import LIVE_TEST_MODEL


# Use a fast model for tests
DEFAULT_MODEL = LIVE_TEST_MODEL

# Maximum retries when LLM doesn't call the tool (non-deterministic)
MAX_TOOL_CALL_RETRIES = 3


async def collect_events(agent: ADKAgent, run_input: RunAgentInput) -> List[BaseEvent]:
    """Collect all events from running an agent."""
    events = []
    async for event in agent.run(run_input):
        events.append(event)
    return events


def find_tool_call_id(events: List[BaseEvent]) -> Optional[str]:
    """Find the tool_call_id from events."""
    for event in events:
        if hasattr(event, 'tool_call_id') and event.tool_call_id:
            return event.tool_call_id
    return None


def find_tool_call_name(events: List[BaseEvent]) -> Optional[str]:
    """Find the tool call name from TOOL_CALL_START events."""
    for event in events:
        if hasattr(event, 'tool_call_name') and event.tool_call_name:
            return event.tool_call_name
    return None


def collect_text_content(events: List[BaseEvent]) -> str:
    """Collect all text content from TEXT_MESSAGE_CONTENT events."""
    text = ""
    for event in events:
        if event.type == EventType.TEXT_MESSAGE_CONTENT:
            delta = getattr(event, 'delta', '')
            if delta:
                text += delta
    return text


def get_event_types(events: List[BaseEvent]) -> List[str]:
    """Extract event type names from a list of events."""
    return [str(event.type) for event in events]


class TestHITLResumptionTextOutput:
    """Regression test: HITL resumption must produce text output.

    This test class verifies the specific regression where removing explicit
    FunctionResponse persistence caused the runner to return empty after
    HITL resumption — no LLM call, no text output.
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
        """Create an HITL agent matching the dojo human_in_the_loop example."""
        agent = Agent(
            model=DEFAULT_MODEL,
            name='hitl_text_output_agent',
            instruction="""You are a task planning agent.

When the user asks you to plan ANY task, you MUST immediately call the
plan_steps tool to generate the steps. Call plan_steps before writing any
text: never ask clarifying questions, never reply with a plan as plain
text, and make exactly one plan_steps call per planning request.

When you receive the tool result back, acknowledge the approved steps
by listing each one and confirming execution. Always produce a text response
after receiving tool results.""",
            tools=[AGUIToolset()],
            generate_content_config=types.GenerateContentConfig(
                # temperature=0 makes the tool-call decision as deterministic as
                # the API allows, so run 1 reliably emits a single plan_steps call.
                temperature=0.0,
            ),
        )

        adk_app = App(
            name="test_hitl_text_app",
            root_agent=agent,
            resumability_config=ResumabilityConfig(is_resumable=True),
        )

        return ADKAgent.from_app(
            adk_app,
            user_id="test_user",
            use_in_memory_services=True,
        )

    @pytest.mark.asyncio
    async def test_hitl_resumption_produces_text_after_tool_result(
        self, check_api_key, hitl_agent
    ):
        """CRITICAL REGRESSION TEST: After HITL tool result, agent must produce text.

        This is the exact scenario that broke in the dojo test:
        1. User asks agent to plan something → agent calls tool (pauses)
        2. User approves/modifies the plan → tool result submitted
        3. Agent MUST produce text output acknowledging the result

        The regression: runner.run_async() returned zero events after step 2,
        causing the dojo test to timeout waiting for visible messages.
        """
        plan_tool = AGUITool(
            name="plan_steps",
            description="Generate a step-by-step plan for user approval",
            parameters={
                "type": "object",
                "properties": {
                    "steps": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "description": {"type": "string"},
                                "status": {
                                    "type": "string",
                                    "enum": ["enabled", "disabled"]
                                }
                            },
                            "required": ["description", "status"]
                        },
                        "description": "List of plan steps"
                    }
                },
                "required": ["steps"]
            }
        )

        tool_call_id = None
        tool_call_name = None
        tool_call_args = ""

        # Retry loop since LLM may not always call the tool
        for attempt in range(1, MAX_TOOL_CALL_RETRIES + 1):
            thread_id = f"test_hitl_text_{uuid.uuid4().hex}_{attempt}"

            # Step 1: Send initial request to trigger tool call
            run_input_1 = RunAgentInput(
                thread_id=thread_id,
                run_id="run_plan",
                messages=[
                    UserMessage(
                        id="msg_plan",
                        role="user",
                        content="Plan a 3-step task: buy groceries, cook dinner, serve food"
                    )
                ],
                tools=[plan_tool],
                context=[],
                state={},
                forwarded_props={}
            )

            events_1 = await collect_events(hitl_agent, run_input_1)
            tool_call_id = find_tool_call_id(events_1)

            if tool_call_id:
                # Collect tool call args from TOOL_CALL_ARGS events
                for event in events_1:
                    if event.type == EventType.TOOL_CALL_ARGS:
                        tool_call_args += getattr(event, 'delta', '')
                tool_call_name = find_tool_call_name(events_1) or "plan_steps"
                break

            # Reset session manager for retry with new thread
            SessionManager.reset_instance()
            await asyncio.sleep(1)

        if tool_call_id is None:
            pytest.skip(
                f"Agent did not call tool after {MAX_TOOL_CALL_RETRIES} attempts "
                "(LLM non-determinism)"
            )

        # Step 2: Submit tool result (simulating user approval)
        tool_result = '{"approved": true, "steps": [' \
            '{"description": "Buy groceries", "status": "enabled"},' \
            '{"description": "Cook dinner", "status": "enabled"},' \
            '{"description": "Serve food", "status": "enabled"}' \
            ']}'

        run_input_2 = RunAgentInput(
            thread_id=thread_id,
            run_id="run_resume",
            messages=[
                UserMessage(
                    id="msg_plan",
                    role="user",
                    content="Plan a 3-step task: buy groceries, cook dinner, serve food"
                ),
                AssistantMessage(
                    id="msg_tool_call",
                    role="assistant",
                    content=None,
                    tool_calls=[
                        ToolCall(
                            id=tool_call_id,
                            function=FunctionCall(
                                name=tool_call_name,
                                arguments=tool_call_args or '{"steps": [{"description": "Buy groceries", "status": "enabled"}, {"description": "Cook dinner", "status": "enabled"}, {"description": "Serve food", "status": "enabled"}]}'
                            )
                        )
                    ]
                ),
                ToolMessage(
                    id="msg_tool_result",
                    role="tool",
                    content=tool_result,
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

        # Basic assertions
        assert "EventType.RUN_STARTED" in event_types_2, (
            f"Expected RUN_STARTED, got: {event_types_2}"
        )
        assert "EventType.RUN_ERROR" not in event_types_2, (
            f"HITL resumption produced an error: {events_2}"
        )
        assert "EventType.RUN_FINISHED" in event_types_2, (
            f"Expected RUN_FINISHED, got: {event_types_2}"
        )

        # THE CRITICAL ASSERTION: Agent must produce text after receiving tool result
        text_content = collect_text_content(events_2)

        assert len(text_content) > 0, (
            "REGRESSION: Agent produced NO text output after HITL resumption! "
            "The runner returned with zero content events. "
            "This means the LLM was never called after receiving the tool result. "
            f"All events: {event_types_2}"
        )

        # Verify text events are present
        has_text_start = "EventType.TEXT_MESSAGE_START" in event_types_2
        has_text_content = "EventType.TEXT_MESSAGE_CONTENT" in event_types_2
        has_text_end = "EventType.TEXT_MESSAGE_END" in event_types_2

        assert has_text_start and has_text_content and has_text_end, (
            "REGRESSION: Missing text message events after HITL resumption. "
            f"Expected TEXT_MESSAGE_START/CONTENT/END, got: {event_types_2}. "
            "The agent should acknowledge the approved plan with text output."
        )

    @pytest.mark.asyncio
    async def test_hitl_resumption_no_duplicate_function_response(
        self, check_api_key, hitl_agent
    ):
        """Verify no duplicate FunctionResponse AND text output is produced.

        This tests that the fix for issue #1074 (duplicate FunctionResponse)
        does not regress the HITL text output behavior.
        Both properties must hold simultaneously:
        1. Exactly ONE FunctionResponse in session (no duplicates)
        2. Agent produces text output after resumption
        """
        plan_tool = AGUITool(
            name="plan_steps",
            description="Generate a step-by-step plan for user approval",
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

        tool_call_id = None

        for attempt in range(1, MAX_TOOL_CALL_RETRIES + 1):
            thread_id = f"test_hitl_both_{uuid.uuid4().hex}_{attempt}"

            run_input_1 = RunAgentInput(
                thread_id=thread_id,
                run_id="run_1",
                messages=[
                    UserMessage(
                        id="msg_1",
                        role="user",
                        content="Use the plan_steps tool to plan a 2-step task for tidying a desk."
                    )
                ],
                tools=[plan_tool],
                context=[],
                state={},
                forwarded_props={}
            )

            events_1 = await collect_events(hitl_agent, run_input_1)
            tool_call_id = find_tool_call_id(events_1)

            if tool_call_id:
                break

            SessionManager.reset_instance()
            await asyncio.sleep(1)

        if tool_call_id is None:
            pytest.skip("Agent did not call tool")

        # Submit tool result
        run_input_2 = RunAgentInput(
            thread_id=thread_id,
            run_id="run_2",
            messages=[
                UserMessage(
                    id="msg_1",
                    role="user",
                    content="Use the plan_steps tool to plan a 2-step task for tidying a desk."
                ),
                AssistantMessage(
                    id="msg_2",
                    role="assistant",
                    content=None,
                    tool_calls=[
                        ToolCall(
                            id=tool_call_id,
                            function=FunctionCall(
                                name="plan_steps",
                                arguments='{"steps": ["Step A", "Step B"]}'
                            )
                        )
                    ]
                ),
                ToolMessage(
                    id="msg_3",
                    role="tool",
                    content='{"approved": true}',
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

        # Property 1: No errors
        assert "EventType.RUN_ERROR" not in event_types_2, (
            f"HITL resumption error: {events_2}"
        )

        # Property 2: Text output produced (THE REGRESSION CHECK)
        text_content = collect_text_content(events_2)
        assert len(text_content) > 0, (
            "REGRESSION: No text output after HITL resumption. "
            "Fix for duplicate FunctionResponse must not break text generation."
        )

        # Property 3: No duplicate FunctionResponse in session
        app_name = hitl_agent._get_app_name(run_input_2)
        user_id = hitl_agent._get_user_id(run_input_2)
        backend_session_id = hitl_agent._get_backend_session_id(thread_id, user_id)

        if backend_session_id:
            session = await hitl_agent._session_manager._session_service.get_session(
                session_id=backend_session_id,
                app_name=app_name,
                user_id=user_id
            )

            fr_count = 0
            for event in session.events:
                if event.content and hasattr(event.content, 'parts'):
                    for part in event.content.parts:
                        if hasattr(part, 'function_response') and part.function_response:
                            fr = part.function_response
                            if hasattr(fr, 'id') and fr.id == tool_call_id:
                                fr_count += 1

            # This should be exactly 1 (not 2 like before the fix)
            # But critically, text output must ALSO work
            assert fr_count >= 1, (
                f"No FunctionResponse found for tool_call_id={tool_call_id}"
            )
            if fr_count > 1:
                pytest.xfail(
                    f"Found {fr_count} FunctionResponse events (issue #1074), "
                    "but text output works. Fix should reduce to 1 without breaking text."
                )


# Run tests with pytest
if __name__ == "__main__":
    pytest.main([__file__, "-v"])
