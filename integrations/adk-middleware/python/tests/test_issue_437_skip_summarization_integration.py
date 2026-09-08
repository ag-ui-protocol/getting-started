#!/usr/bin/env python
"""Integration tests for GitHub issue #437: skip_summarization tool call bug.

This test verifies that when skip_summarization=True is set in an ADK tool function,
the middleware correctly handles the scenario without causing infinite "calling tool" loops.

Original issue: https://github.com/ag-ui-protocol/ag-ui/issues/437

The bug occurred when:
1. A tool sets tool_context.actions.skip_summarization = True
2. StreamMode=SSE is used
3. The UI would show "calling the tool" in a loop

Root causes addressed:
- Issue #765: Events with function responses but no text content were incorrectly
  routed to the LRO (long-running operation) branch instead of translate()
- Tool call ID mismatches between ADK and AG-UI protocols (fixed in v0.4.1)

Requirements:
- GOOGLE_API_KEY environment variable must be set
"""

import asyncio
import os
import sys
import pytest
import uuid
from collections import Counter
from typing import Dict, List

# Python 3.10 compatibility: asyncio.timeout was added in 3.11
if sys.version_info >= (3, 11):
    from asyncio import timeout as asyncio_timeout
else:
    from async_timeout import timeout as asyncio_timeout

from ag_ui.core import (
    EventType,
    RunAgentInput,
    UserMessage,
    AssistantMessage,
    ToolMessage,
    ToolCall,
    FunctionCall,
    BaseEvent,
)
from ag_ui_adk import ADKAgent
from ag_ui_adk.session_manager import SessionManager
from google.adk.agents import LlmAgent
from google.adk.tools import ToolContext
from tests.constants import LIVE_TEST_MODEL


@pytest.fixture(autouse=True)
def setup_llmock(llmock_server):
    """Ensure LLMock is running when no real API key is set."""


def get_weather_with_skip_summarization(
    tool_context: ToolContext,
    location: str = "the entire world"
) -> str:
    """Get the weather in a given location.

    This tool sets skip_summarization=True to prevent the model from
    summarizing the tool result. This is the scenario from issue #437.
    """
    tool_context.actions.skip_summarization = True
    return f"It is sunny in {location}"


def get_temperature(
    tool_context: ToolContext,
    location: str = "New York"
) -> str:
    """Get the temperature in a given location.

    This is a normal tool (no skip_summarization) for comparison.
    """
    return f"The temperature in {location} is 72°F"


class TestSkipSummarizationIntegration:
    """Integration tests for skip_summarization behavior with real API calls."""

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
    def weather_agent(self):
        """Create an ADK agent with the skip_summarization tool."""
        adk_agent = LlmAgent(
            name="weather_agent",
            model=LIVE_TEST_MODEL,
            instruction="""You are a weather assistant.
            When asked about the weather, ALWAYS use the get_weather_with_skip_summarization tool.
            After the tool returns, do NOT repeat or summarize the result.
            Just say something brief like "I've checked the weather for you."
            """,
            tools=[get_weather_with_skip_summarization],
        )

        return ADKAgent(
            adk_agent=adk_agent,
            app_name="test_skip_summarization",
            user_id="test_user",
            use_in_memory_services=True,
        )

    @pytest.fixture
    def normal_tool_agent(self):
        """Create an ADK agent with a normal tool (no skip_summarization)."""
        adk_agent = LlmAgent(
            name="temp_agent",
            model=LIVE_TEST_MODEL,
            instruction="""You are a temperature assistant.
            When asked about the temperature, use the get_temperature tool.
            """,
            tools=[get_temperature],
        )

        return ADKAgent(
            adk_agent=adk_agent,
            app_name="test_normal_tool",
            user_id="test_user",
            use_in_memory_services=True,
        )

    def _create_input(self, message: str) -> RunAgentInput:
        """Helper to create RunAgentInput."""
        return RunAgentInput(
            thread_id=f"test_thread_{uuid.uuid4().hex[:8]}",
            run_id=f"test_run_{uuid.uuid4().hex[:8]}",
            messages=[
                UserMessage(
                    id=f"msg_{uuid.uuid4().hex[:8]}",
                    role="user",
                    content=message
                )
            ],
            state={},
            context=[],
            tools=[],
            forwarded_props={}
        )

    def _count_events(self, events: List[BaseEvent]) -> Dict[str, int]:
        """Count events by type."""
        return Counter(e.type.value if hasattr(e.type, 'value') else str(e.type) for e in events)

    @pytest.mark.asyncio
    async def test_skip_summarization_no_infinite_loop(self, weather_agent):
        """Verify skip_summarization doesn't cause infinite tool call loop (issue #437).

        This is the main regression test for issue #437. The bug caused the UI to
        display "calling the tool" in a loop when skip_summarization=True was set.

        Expected behavior:
        - Exactly 1 TOOL_CALL_START event
        - Exactly 1 TOOL_CALL_END event
        - No repeated tool calls
        - Run completes successfully with RUN_FINISHED
        """
        input_data = self._create_input("What's the weather in San Francisco?")

        events = []
        tool_call_starts = []

        async for event in weather_agent.run(input_data):
            events.append(event)
            if event.type == EventType.TOOL_CALL_START:
                tool_call_starts.append(event)

        event_counts = self._count_events(events)

        # Critical assertion: should NOT have multiple tool call starts (infinite loop)
        assert len(tool_call_starts) <= 1, (
            f"Expected at most 1 tool call start, got {len(tool_call_starts)}. "
            "This suggests the infinite loop bug from issue #437 may still exist."
        )

        # Should have completed successfully
        assert event_counts.get("RUN_STARTED", 0) == 1, "Expected exactly 1 RUN_STARTED"
        assert event_counts.get("RUN_FINISHED", 0) == 1, "Expected exactly 1 RUN_FINISHED"
        assert event_counts.get("RUN_ERROR", 0) == 0, "Should not have any errors"

        # If tool was called, verify proper event sequence
        if len(tool_call_starts) == 1:
            assert event_counts.get("TOOL_CALL_END", 0) == 1, "Expected TOOL_CALL_END after TOOL_CALL_START"
            # ToolCallResultEvent should be emitted for skip_summarization scenarios
            # (this was the fix from issue #765)
            assert event_counts.get("TOOL_CALL_RESULT", 0) >= 1, (
                "Expected TOOL_CALL_RESULT for skip_summarization scenario (fix from #765)"
            )

    @pytest.mark.asyncio
    async def test_skip_summarization_tool_result_emitted(self, weather_agent):
        """Verify ToolCallResultEvent is emitted for skip_summarization tools.

        This tests the fix from issue #765: when skip_summarization=True is set,
        the model returns a final response with no text content but function
        responses. The middleware must emit ToolCallResultEvent for these.
        """
        input_data = self._create_input("Check the weather in Tokyo")

        events = []
        tool_results = []

        async for event in weather_agent.run(input_data):
            events.append(event)
            if event.type == EventType.TOOL_CALL_RESULT:
                tool_results.append(event)

        # Should have tool result if tool was called
        tool_calls = [e for e in events if e.type == EventType.TOOL_CALL_START]
        if tool_calls:
            assert len(tool_results) >= 1, (
                "ToolCallResultEvent should be emitted when skip_summarization=True. "
                "This was the fix from issue #765."
            )
            # The result should contain our weather data
            for result in tool_results:
                assert result.tool_call_id, "ToolCallResultEvent must have tool_call_id"

    @pytest.mark.asyncio
    async def test_normal_tool_vs_skip_summarization_comparison(
        self, weather_agent, normal_tool_agent
    ):
        """Compare event patterns between normal tools and skip_summarization tools.

        Both should complete successfully without loops, but skip_summarization
        tools should have ToolCallResultEvent emitted.
        """
        # Test normal tool
        normal_input = self._create_input("What's the temperature in Boston?")
        normal_events = [event async for event in normal_tool_agent.run(normal_input)]
        normal_counts = self._count_events(normal_events)

        # Test skip_summarization tool
        skip_input = self._create_input("What's the weather in London?")
        skip_events = [event async for event in weather_agent.run(skip_input)]
        skip_counts = self._count_events(skip_events)

        # Both should complete successfully
        assert normal_counts.get("RUN_FINISHED", 0) == 1, "Normal tool should finish"
        assert skip_counts.get("RUN_FINISHED", 0) == 1, "Skip summarization tool should finish"

        # Neither should have errors
        assert normal_counts.get("RUN_ERROR", 0) == 0, "Normal tool should not error"
        assert skip_counts.get("RUN_ERROR", 0) == 0, "Skip summarization tool should not error"

        # Neither should have multiple tool calls (no infinite loop)
        normal_tool_starts = normal_counts.get("TOOL_CALL_START", 0)
        skip_tool_starts = skip_counts.get("TOOL_CALL_START", 0)

        assert normal_tool_starts <= 1, "Normal tool should have at most 1 tool call"
        assert skip_tool_starts <= 1, "Skip summarization tool should have at most 1 tool call"

    @pytest.mark.asyncio
    async def test_skip_summarization_event_order(self, weather_agent):
        """Verify correct event ordering for skip_summarization scenarios.

        Expected order:
        1. RUN_STARTED
        2. TEXT_MESSAGE_START (optional - model might think before tool)
        3. TEXT_MESSAGE_CONTENT (optional)
        4. TEXT_MESSAGE_END (optional)
        5. TOOL_CALL_START
        6. TOOL_CALL_ARGS
        7. TOOL_CALL_END
        8. TOOL_CALL_RESULT (from skip_summarization - fix #765)
        9. TEXT_MESSAGE_* (optional - brief follow-up)
        10. STATE_SNAPSHOT (optional)
        11. RUN_FINISHED
        """
        input_data = self._create_input("Weather in Paris please")

        events = []
        async for event in weather_agent.run(input_data):
            events.append(event)

        event_types = [e.type for e in events]

        # RUN_STARTED must be first
        assert event_types[0] == EventType.RUN_STARTED, "RUN_STARTED must be first event"

        # RUN_FINISHED must be last (or second to last if STATE_SNAPSHOT follows)
        # Find RUN_FINISHED index
        run_finished_indices = [i for i, t in enumerate(event_types) if t == EventType.RUN_FINISHED]
        assert len(run_finished_indices) == 1, "Should have exactly one RUN_FINISHED"
        run_finished_idx = run_finished_indices[0]

        # Only STATE_SNAPSHOT can come after RUN_FINISHED
        for i in range(run_finished_idx + 1, len(event_types)):
            assert event_types[i] in (EventType.STATE_SNAPSHOT, EventType.STATE_DELTA), (
                f"Only state events can come after RUN_FINISHED, got {event_types[i]}"
            )

        # If we have tool calls, verify TOOL_CALL_END comes before TOOL_CALL_RESULT
        tool_call_end_idx = None
        tool_call_result_idx = None
        for i, t in enumerate(event_types):
            if t == EventType.TOOL_CALL_END and tool_call_end_idx is None:
                tool_call_end_idx = i
            if t == EventType.TOOL_CALL_RESULT and tool_call_result_idx is None:
                tool_call_result_idx = i

        if tool_call_end_idx is not None and tool_call_result_idx is not None:
            assert tool_call_end_idx < tool_call_result_idx, (
                "TOOL_CALL_END should come before TOOL_CALL_RESULT"
            )

    @pytest.mark.asyncio
    async def test_skip_summarization_with_ck_prefixed_tool_ids(self, weather_agent):
        """Verify handling of tool call IDs (related to CopilotKit ID mismatch issue).

        The original issue #437 mentioned tool call ID mismatches between
        CopilotKit-generated IDs ("ck-" prefixed) and ADK-generated IDs.

        This test verifies that all tool call events have consistent IDs.
        """
        input_data = self._create_input("Weather check for Berlin")

        events = []
        async for event in weather_agent.run(input_data):
            events.append(event)

        # Collect all tool call IDs
        tool_call_ids = {}  # tool_call_id -> list of event types that reference it

        for event in events:
            if event.type == EventType.TOOL_CALL_START:
                tool_id = event.tool_call_id
                if tool_id not in tool_call_ids:
                    tool_call_ids[tool_id] = []
                tool_call_ids[tool_id].append("START")
            elif event.type == EventType.TOOL_CALL_ARGS:
                tool_id = event.tool_call_id
                if tool_id not in tool_call_ids:
                    tool_call_ids[tool_id] = []
                tool_call_ids[tool_id].append("ARGS")
            elif event.type == EventType.TOOL_CALL_END:
                tool_id = event.tool_call_id
                if tool_id not in tool_call_ids:
                    tool_call_ids[tool_id] = []
                tool_call_ids[tool_id].append("END")
            elif event.type == EventType.TOOL_CALL_RESULT:
                tool_id = event.tool_call_id
                if tool_id not in tool_call_ids:
                    tool_call_ids[tool_id] = []
                tool_call_ids[tool_id].append("RESULT")

        # Verify each tool call ID has a complete event sequence
        for tool_id, event_types in tool_call_ids.items():
            assert tool_id, f"Tool call ID should not be empty: {event_types}"

            # Each tool call should have START, ARGS (optional), END
            if "START" in event_types:
                assert "END" in event_types, (
                    f"Tool call {tool_id} has START but no END: {event_types}"
                )

            # For skip_summarization, RESULT should also be present
            if "END" in event_types:
                # Note: RESULT is emitted separately and is expected for skip_summarization
                pass  # RESULT presence is tested in other tests


class TestSkipSummarizationEdgeCases:
    """Edge case tests for skip_summarization scenarios."""

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
    def multi_tool_agent(self):
        """Create an agent with multiple tools, some with skip_summarization."""

        def tool_with_skip(tool_context: ToolContext, query: str) -> str:
            """Tool that skips summarization."""
            tool_context.actions.skip_summarization = True
            return f"Result for: {query}"

        def tool_without_skip(tool_context: ToolContext, query: str) -> str:
            """Normal tool without skip_summarization."""
            return f"Normal result for: {query}"

        adk_agent = LlmAgent(
            name="multi_tool_agent",
            model=LIVE_TEST_MODEL,
            instruction="""You have two tools:
            - tool_with_skip: Use this when asked about "skip" queries
            - tool_without_skip: Use this when asked about "normal" queries
            Always use the appropriate tool based on the query type.
            """,
            tools=[tool_with_skip, tool_without_skip],
        )

        return ADKAgent(
            adk_agent=adk_agent,
            app_name="test_multi_tool",
            user_id="test_user",
            use_in_memory_services=True,
        )

    @pytest.mark.asyncio
    async def test_timeout_protection(self):
        """Verify that agent run completes within reasonable time.

        If the infinite loop bug exists, this test will timeout.
        """
        def slow_skip_tool(tool_context: ToolContext, data: str) -> str:
            tool_context.actions.skip_summarization = True
            return f"Processed: {data}"

        adk_agent = LlmAgent(
            name="timeout_test_agent",
            model=LIVE_TEST_MODEL,
            instruction="Use the slow_skip_tool when asked to process anything.",
            tools=[slow_skip_tool],
        )

        agent = ADKAgent(
            adk_agent=adk_agent,
            app_name="test_timeout",
            user_id="test_user",
            use_in_memory_services=True,
        )

        input_data = RunAgentInput(
            thread_id=f"timeout_test_{uuid.uuid4().hex[:8]}",
            run_id=f"run_{uuid.uuid4().hex[:8]}",
            messages=[
                UserMessage(
                    id=f"msg_{uuid.uuid4().hex[:8]}",
                    role="user",
                    content="Please process this data: test_value"
                )
            ],
            state={},
            context=[],
            tools=[],
            forwarded_props={}
        )

        # If infinite loop exists, this will timeout after 60 seconds
        events = []
        try:
            async with asyncio_timeout(60):  # 60 second timeout
                async for event in agent.run(input_data):
                    events.append(event)
        except asyncio.TimeoutError:
            pytest.fail(
                "Agent run timed out after 60 seconds. "
                "This likely indicates the infinite loop bug from issue #437."
            )

        # Should complete successfully
        event_types = [e.type for e in events]
        assert EventType.RUN_FINISHED in event_types, (
            "Agent should complete with RUN_FINISHED"
        )


class TestSkipSummarizationReplayBug:
    """Tests for the replay bug where skip_summarization is lost on subsequent runs.

    BUG DESCRIPTION (from issue #437 comment):
    When running with CopilotKit, the summarization is delivered on the next run
    when the result gets "played back" by CopilotKit sending down the complete
    history. The middleware reprocesses the tool call result as the last message,
    and since "skip_summarization=true" is lost at that point, the LLM summarizes it.

    This is a SEPARATE BUG from the original infinite loop issue.

    Root cause:
    - `skip_summarization=True` is set in `tool_context.actions` during tool execution
    - This flag is NOT persisted anywhere (session state, tool result metadata, etc.)
    - On the next run, when history is replayed, ADK doesn't know to skip summarization
    - The LLM then summarizes the tool result that was meant to be returned as-is
    """

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
    def skip_sum_agent(self):
        """Create an ADK agent with skip_summarization tool."""

        def weather_skip_sum(tool_context: ToolContext, city: str) -> str:
            """Get weather with skip_summarization."""
            tool_context.actions.skip_summarization = True
            return f"Weather in {city}: Sunny, 72°F"

        adk_agent = LlmAgent(
            name="weather_skip_agent",
            model=LIVE_TEST_MODEL,
            instruction="""You are a weather assistant.
            ALWAYS use the weather_skip_sum tool when asked about weather.
            After the tool returns, do NOT repeat or summarize the result.
            Just say "Done." or similar brief acknowledgment.
            """,
            tools=[weather_skip_sum],
        )

        return ADKAgent(
            adk_agent=adk_agent,
            app_name="test_replay_bug",
            user_id="test_user",
            use_in_memory_services=True,
        )

    @pytest.mark.asyncio
    async def test_skip_summarization_replay_scenario(self, skip_sum_agent):
        """Test multi-turn scenario that demonstrates the replay bug.

        This test simulates the CopilotKit replay scenario:
        1. First run: User asks for weather, tool executes with skip_summarization
        2. Second run: Send history including the tool result, add new user message

        EXPECTED (if bug is fixed): No summarization of the first tool result
        ACTUAL (with bug): LLM may summarize the tool result from history

        NOTE: This test documents the bug. If it fails, the bug might be fixed.
        If it passes but shows summarization, the bug still exists.
        """
        thread_id = f"replay_test_{uuid.uuid4().hex[:8]}"

        # === FIRST RUN: Initial weather request ===
        first_input = RunAgentInput(
            thread_id=thread_id,
            run_id=f"run1_{uuid.uuid4().hex[:8]}",
            messages=[
                UserMessage(
                    id="msg_user_1",
                    role="user",
                    content="What's the weather in Seattle?"
                )
            ],
            state={},
            context=[],
            tools=[],
            forwarded_props={}
        )

        first_run_events = []
        tool_call_id = None
        tool_result_content = None

        async for event in skip_sum_agent.run(first_input):
            first_run_events.append(event)
            # Capture tool call info for replay
            if event.type == EventType.TOOL_CALL_START:
                tool_call_id = event.tool_call_id
            if event.type == EventType.TOOL_CALL_RESULT:
                tool_result_content = event.content

        # Verify first run completed with tool call
        assert any(e.type == EventType.RUN_FINISHED for e in first_run_events), (
            "First run should complete"
        )

        # If no tool was called, skip the replay test
        if not tool_call_id:
            pytest.skip("Model didn't call the tool in first run - can't test replay")

        # === SECOND RUN: Replay history + new question ===
        # This simulates CopilotKit sending the full conversation history
        second_input = RunAgentInput(
            thread_id=thread_id,
            run_id=f"run2_{uuid.uuid4().hex[:8]}",
            messages=[
                # Original user message
                UserMessage(
                    id="msg_user_1",
                    role="user",
                    content="What's the weather in Seattle?"
                ),
                # Assistant's tool call (from first run)
                AssistantMessage(
                    id="msg_assistant_1",
                    role="assistant",
                    content=None,
                    tool_calls=[
                        ToolCall(
                            id=tool_call_id,
                            type="function",
                            function=FunctionCall(
                                name="weather_skip_sum",
                                arguments='{"city": "Seattle"}'
                            )
                        )
                    ]
                ),
                # Tool result (from first run) - THIS IS WHERE skip_summarization IS LOST
                ToolMessage(
                    id="msg_tool_1",
                    role="tool",
                    tool_call_id=tool_call_id,
                    content=tool_result_content or "Weather in Seattle: Sunny, 72°F"
                ),
                # NEW user message triggering second run
                UserMessage(
                    id="msg_user_2",
                    role="user",
                    content="Thanks! Now what about Portland?"
                )
            ],
            state={},
            context=[],
            tools=[],
            forwarded_props={}
        )

        second_run_events = []
        second_run_text = []

        # KEY ASSERTION: The historical ToolMessage should be filtered out
        # because its tool_call_id was marked as processed in the first run
        unseen = await skip_sum_agent._get_unseen_messages(second_input)
        unseen_tool_messages = [m for m in unseen if getattr(m, "role", None) == "tool"]
        assert len(unseen_tool_messages) == 0, (
            f"Historical ToolMessage should be filtered out! Found {len(unseen_tool_messages)} "
            f"unseen tool messages with tool_call_ids: "
            f"{[getattr(m, 'tool_call_id', None) for m in unseen_tool_messages]}. "
            f"The fix should mark tool_call_id as processed when backend tool completes."
        )

        async for event in skip_sum_agent.run(second_input):
            second_run_events.append(event)
            if event.type == EventType.TEXT_MESSAGE_CONTENT:
                second_run_text.append(event.delta)

        # Verify second run completed
        assert any(e.type == EventType.RUN_FINISHED for e in second_run_events), (
            "Second run should complete"
        )

        # Analyze the response for unwanted summarization
        full_response = "".join(second_run_text).lower()

        # Check if the response contains summarization of the FIRST result
        # The bug manifests as the LLM repeating/summarizing the Seattle weather
        # even though skip_summarization was set
        contains_seattle_summary = (
            "seattle" in full_response and
            ("sunny" in full_response or "72" in full_response)
        )

        # Regression test: historical tool results should NOT be re-summarized
        # The fix marks backend tool_call_ids as processed, so they're skipped on replay
        assert not contains_seattle_summary, (
            "Historical tool results should not be re-processed on replay. "
            f"Response contained Seattle weather summary: {full_response[:200]}..."
        )

    @pytest.mark.asyncio
    async def test_document_skip_summarization_not_persisted(self, skip_sum_agent):
        """Document that skip_summarization flag is not persisted in session state.

        This test verifies the root cause: skip_summarization is an ephemeral flag
        that only exists during tool execution and is not stored anywhere.

        This is informational - it documents the architectural limitation.
        """
        thread_id = f"persist_test_{uuid.uuid4().hex[:8]}"

        # Run a query that triggers the tool
        input_data = RunAgentInput(
            thread_id=thread_id,
            run_id=f"run_{uuid.uuid4().hex[:8]}",
            messages=[
                UserMessage(
                    id=f"msg_{uuid.uuid4().hex[:8]}",
                    role="user",
                    content="Weather in Miami please"
                )
            ],
            state={},
            context=[],
            tools=[],
            forwarded_props={}
        )

        events = []
        async for event in skip_sum_agent.run(input_data):
            events.append(event)

        # Check session state for skip_summarization info
        session_state = await skip_sum_agent._session_manager.get_session_state(
            thread_id,
            skip_sum_agent._get_app_name(input_data),
            skip_sum_agent._get_user_id(input_data)
        )

        # Document: skip_summarization is NOT stored in session state
        if session_state:
            has_skip_sum_tracking = any(
                "skip" in str(key).lower() or "summarization" in str(key).lower()
                for key in session_state.keys()
            )

            print("\n" + "-" * 60)
            print("Session state keys:", list(session_state.keys()) if session_state else "None")
            print(f"Has skip_summarization tracking: {has_skip_sum_tracking}")
            print("-" * 60 + "\n")

            # This documents the gap - no assertion because it's expected to be missing
            if not has_skip_sum_tracking:
                print("NOTE: skip_summarization is NOT persisted in session state")
                print("This is the root cause of the replay bug")


if __name__ == "__main__":
    pytest.main([__file__, "-v", "-s"])
