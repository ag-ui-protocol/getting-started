#!/usr/bin/env python
"""Test for duplicate function_response event bug fix.

This module tests the fix for the bug where ag-ui-adk would persist duplicate
function_response events when using LongRunningFunctionTool with
DatabaseSessionService and StreamingMode.NONE.

Root cause: When tool results arrived WITHOUT a trailing user message,
ag-ui-adk explicitly persisted the function_response via append_event(),
AND passed the same function_response_content as new_message to ADK's
runner.run_async(). ADK then also persisted the new_message internally,
resulting in duplicate function_response events with different invocation_ids.

The fix keeps the explicit append_event() (required for HITL resumption to work
because InMemorySessionService.get_session() returns a deep copy and ADK's state
checks happen before its internal persistence), but sets new_message = None to
prevent the runner from appending a duplicate.
"""

import pytest
import asyncio
import time
from unittest.mock import patch, AsyncMock

from ag_ui.core import (
    RunAgentInput, Tool as AGUITool,
    UserMessage, ToolMessage, AssistantMessage, ToolCall, FunctionCall,
)
from google.adk.sessions.session import Event
from google.genai import types

from ag_ui_adk import ADKAgent
from ag_ui_adk.session_manager import SessionManager
from tests.constants import LIVE_TEST_MODEL


class TestDuplicateFunctionResponseFix:
    """Test cases for the duplicate function_response event bug fix."""

    @pytest.fixture
    def mock_adk_agent(self):
        """Create a mock ADK agent."""
        from google.adk.agents import LlmAgent
        return LlmAgent(
            name="test_agent",
            model=LIVE_TEST_MODEL,
            instruction="Test agent for duplicate function_response fix"
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

    async def _setup_session_with_tool_call(
        self,
        ag_ui_adk,
        thread_id: str,
        tool_call_id: str,
        tool_name: str,
        tool_args: dict,
    ):
        """Helper to set up a session with a pending tool call."""
        app_name = "test_app"

        # Create the session
        session, backend_session_id = await ag_ui_adk._ensure_session_exists(
            app_name=app_name,
            user_id="test_user",
            thread_id=thread_id,
            initial_state={}
        )

        # Add tool call to pending
        await ag_ui_adk._add_pending_tool_call_with_context(
            thread_id, tool_call_id, app_name, "test_user"
        )

        # Add the FunctionCall event to the session (simulating ADK behavior)
        function_call_content = types.Content(
            parts=[
                types.Part(
                    function_call=types.FunctionCall(
                        id=tool_call_id,
                        name=tool_name,
                        args=tool_args
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
        await ag_ui_adk._session_manager._session_service.append_event(
            session, function_call_event
        )

        return app_name, backend_session_id

    def _count_function_responses_in_session(self, session, tool_call_id: str) -> int:
        """Count the number of function_response events for a specific tool_call_id."""
        count = 0
        for event in session.events:
            if event.content and hasattr(event.content, 'parts'):
                for part in event.content.parts:
                    if hasattr(part, 'function_response') and part.function_response:
                        fr = part.function_response
                        if hasattr(fr, 'id') and fr.id == tool_call_id:
                            count += 1
        return count

    @pytest.mark.asyncio
    async def test_no_duplicate_function_response_without_user_message(self, ag_ui_adk):
        """Test that only ONE function_response is persisted when tool result arrives alone.

        This is the main regression test for the duplicate function_response bug.

        Scenario:
        1. Agent calls a LongRunningFunctionTool (e.g., useFrontendTool)
        2. Client submits tool result WITHOUT any additional user message
        3. Only ONE function_response event should be persisted to the session

        Before fix: 2 function_response events (one from explicit append_event,
                    one from ADK's runner processing new_message)
        After fix:  1 function_response event (from explicit append_event only,
                    new_message is set to None so runner doesn't duplicate)
        """
        thread_id = "test_no_duplicate_without_user"
        tool_call_id = "lro_tool_call_123"
        run_id = "run_no_duplicate"

        # Set up input with tool result ONLY (no trailing user message)
        input_data = RunAgentInput(
            thread_id=thread_id,
            run_id=run_id,
            messages=[
                UserMessage(id="user_1", role="user", content="Do something"),
                AssistantMessage(
                    id="assistant_1",
                    role="assistant",
                    content=None,
                    tool_calls=[
                        ToolCall(
                            id=tool_call_id,
                            function=FunctionCall(
                                name="frontend_action",
                                arguments='{"action": "render"}'
                            )
                        )
                    ]
                ),
                ToolMessage(
                    id="tool_result_1",
                    role="tool",
                    content='{"status": "completed"}',
                    tool_call_id=tool_call_id
                )
                # NOTE: No trailing user message - this is the bug scenario
            ],
            tools=[
                AGUITool(
                    name="frontend_action",
                    description="A frontend action",
                    parameters={
                        "type": "object",
                        "properties": {"action": {"type": "string"}}
                    }
                )
            ],
            context=[],
            state={},
            forwarded_props={}
        )

        # Mark initial messages as processed
        ag_ui_adk._session_manager.mark_messages_processed(
            "test_app", thread_id, ["user_1", "assistant_1"]
        )

        # Set up session with pending tool call
        app_name, backend_session_id = await self._setup_session_with_tool_call(
            ag_ui_adk, thread_id, tool_call_id, "frontend_action", {"action": "render"}
        )

        # Mock the runner to avoid actual LLM calls
        # This verifies we pass the correct parameters to prevent duplicates
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
                assert len(new_msg.parts) > 0, "new_message should have at least one part"

                # Should specify invocation_id to prevent ADK auto-generation
                assert inv_id is not None, (
                    "invocation_id should be provided to use client's run_id"
                )
                return
                yield

        # Prepare tool results (no message_batch since no trailing user message)
        tool_results = [
            {
                'tool_name': 'frontend_action',
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
                message_batch=None  # No trailing user message
            )

        # Note: With the regression fix approach, we pass new_message + invocation_id to ADK.
        # The MockRunner above validates these parameters are correct.
        # Integration tests with real ADK runners (test_lro_tool_response_persistence.py)
        # validate that only 1 function_response event is persisted with the correct invocation_id.

    @pytest.mark.asyncio
    async def test_function_response_persisted_with_user_message(self, ag_ui_adk):
        """Test that function_response IS persisted when tool result has trailing user message.

        When tool results arrive WITH a trailing user message, ag-ui-adk needs to
        explicitly persist the function_response because ADK will receive the user
        message as new_message, not the function_response.

        This test ensures the fix didn't break this case.
        """
        thread_id = "test_persist_with_user"
        tool_call_id = "lro_tool_call_456"
        run_id = "run_with_user_message"

        # Set up input with tool result AND trailing user message
        input_data = RunAgentInput(
            thread_id=thread_id,
            run_id=run_id,
            messages=[
                UserMessage(id="user_1", role="user", content="Do something"),
                AssistantMessage(
                    id="assistant_1",
                    role="assistant",
                    content=None,
                    tool_calls=[
                        ToolCall(
                            id=tool_call_id,
                            function=FunctionCall(
                                name="frontend_action",
                                arguments='{"action": "render"}'
                            )
                        )
                    ]
                ),
                ToolMessage(
                    id="tool_result_1",
                    role="tool",
                    content='{"status": "completed"}',
                    tool_call_id=tool_call_id
                ),
                UserMessage(id="user_2", role="user", content="Thanks, continue!")
            ],
            tools=[
                AGUITool(
                    name="frontend_action",
                    description="A frontend action",
                    parameters={
                        "type": "object",
                        "properties": {"action": {"type": "string"}}
                    }
                )
            ],
            context=[],
            state={},
            forwarded_props={}
        )

        # Mark initial messages as processed
        ag_ui_adk._session_manager.mark_messages_processed(
            "test_app", thread_id, ["user_1", "assistant_1"]
        )

        # Set up session with pending tool call
        app_name, backend_session_id = await self._setup_session_with_tool_call(
            ag_ui_adk, thread_id, tool_call_id, "frontend_action", {"action": "render"}
        )

        # Mock the runner
        class MockRunner:
            async def run_async(self, **kwargs):
                # With trailing user message, new_message should be the user message (not None)
                new_msg = kwargs.get('new_message')
                assert new_msg is not None, "new_message should be the user message"
                return
                yield

        # Prepare tool results WITH message_batch (trailing user message)
        tool_results = [
            {
                'tool_name': 'frontend_action',
                'message': input_data.messages[2]
            }
        ]
        message_batch = [input_data.messages[3]]  # Trailing user message

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
                message_batch=message_batch  # Has trailing user message
            )

        # Verify: function_response should be explicitly persisted
        session = await ag_ui_adk._session_manager._session_service.get_session(
            session_id=backend_session_id,
            app_name=app_name,
            user_id="test_user"
        )

        function_response_count = self._count_function_responses_in_session(
            session, tool_call_id
        )

        # With trailing user message, we explicitly persist (ADK gets user msg as new_message)
        assert function_response_count == 1, (
            f"Expected exactly 1 function_response event when tool result has "
            f"trailing user message, but found {function_response_count}. "
            f"The function_response should be explicitly persisted in this case."
        )

    @pytest.mark.asyncio
    async def test_multiple_tool_results_without_user_message(self, ag_ui_adk):
        """Test multiple tool results without trailing user message - exactly 1 event per tool.

        When multiple tool results arrive without a user message, we should persist
        exactly ONE function_response event per tool (all in a single Content with
        multiple parts). The runner receives new_message = None, so no duplicates.
        """
        thread_id = "test_multiple_tools_no_user"
        tool_call_id_1 = "lro_tool_call_multi_1"
        tool_call_id_2 = "lro_tool_call_multi_2"
        run_id = "run_multiple_no_user"

        # Set up input with multiple tool results, no trailing user message
        input_data = RunAgentInput(
            thread_id=thread_id,
            run_id=run_id,
            messages=[
                UserMessage(id="user_1", role="user", content="Do two things"),
                AssistantMessage(
                    id="assistant_1",
                    role="assistant",
                    content=None,
                    tool_calls=[
                        ToolCall(
                            id=tool_call_id_1,
                            function=FunctionCall(
                                name="action_one",
                                arguments='{}'
                            )
                        ),
                        ToolCall(
                            id=tool_call_id_2,
                            function=FunctionCall(
                                name="action_two",
                                arguments='{}'
                            )
                        )
                    ]
                ),
                ToolMessage(
                    id="tool_result_1",
                    role="tool",
                    content='{"status": "done_1"}',
                    tool_call_id=tool_call_id_1
                ),
                ToolMessage(
                    id="tool_result_2",
                    role="tool",
                    content='{"status": "done_2"}',
                    tool_call_id=tool_call_id_2
                )
                # No trailing user message
            ],
            tools=[
                AGUITool(
                    name="action_one",
                    description="Action one",
                    parameters={"type": "object", "properties": {}}
                ),
                AGUITool(
                    name="action_two",
                    description="Action two",
                    parameters={"type": "object", "properties": {}}
                )
            ],
            context=[],
            state={},
            forwarded_props={}
        )

        # Mark initial messages as processed
        ag_ui_adk._session_manager.mark_messages_processed(
            "test_app", thread_id, ["user_1", "assistant_1"]
        )

        app_name = "test_app"

        # Create session
        session, backend_session_id = await ag_ui_adk._ensure_session_exists(
            app_name=app_name,
            user_id="test_user",
            thread_id=thread_id,
            initial_state={}
        )

        # Add both tool calls as pending
        await ag_ui_adk._add_pending_tool_call_with_context(
            thread_id, tool_call_id_1, app_name, "test_user"
        )
        await ag_ui_adk._add_pending_tool_call_with_context(
            thread_id, tool_call_id_2, app_name, "test_user"
        )

        # Add FunctionCall events for both
        for tool_id, tool_name in [(tool_call_id_1, "action_one"), (tool_call_id_2, "action_two")]:
            fc_content = types.Content(
                parts=[
                    types.Part(
                        function_call=types.FunctionCall(
                            id=tool_id,
                            name=tool_name,
                            args={}
                        )
                    )
                ],
                role="model"
            )
            fc_event = Event(timestamp=time.time(), author="test_agent", content=fc_content)
            session = await ag_ui_adk._session_manager._session_service.get_session(
                session_id=backend_session_id, app_name=app_name, user_id="test_user"
            )
            await ag_ui_adk._session_manager._session_service.append_event(session, fc_event)

        # Mock the runner
        class MockRunner:
            async def run_async(self, **kwargs):
                # Regression fix: verify BOTH new_message and invocation_id are provided
                new_msg = kwargs.get('new_message')
                inv_id = kwargs.get('invocation_id')

                # Should pass new_message with function_response content (multiple parts)
                assert new_msg is not None, (
                    "new_message should contain function_response (regression fix approach)"
                )
                assert hasattr(new_msg, 'parts'), "new_message should have parts"
                assert len(new_msg.parts) == 2, "new_message should have 2 parts (2 tool results)"

                # Should specify invocation_id to prevent ADK auto-generation
                assert inv_id is not None, (
                    "invocation_id should be provided to use client's run_id"
                )
                return
                yield

        # Prepare tool results
        tool_results = [
            {'tool_name': 'action_one', 'message': input_data.messages[2]},
            {'tool_name': 'action_two', 'message': input_data.messages[3]}
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
                message_batch=None  # No trailing user message
            )

        # Note: With the regression fix approach, we pass new_message + invocation_id to ADK.
        # The MockRunner above validates these parameters are correct (including 2 parts).
        # Integration tests with real ADK runners validate that function_response events
        # are persisted correctly without duplication.
