#!/usr/bin/env python
"""Integration tests for thought-to-REASONING events conversion.

This test verifies that when Gemini models return thought summaries
(via include_thoughts=True), the ADK middleware correctly converts them
to AG-UI REASONING events.

Related issue: https://github.com/ag-ui-protocol/ag-ui/issues/951
Updated for: https://github.com/ag-ui-protocol/ag-ui/issues/1406

Requirements:
- GOOGLE_API_KEY environment variable must be set
- Uses Gemini 2.5 Flash model with thinking enabled
"""

import asyncio
import os
import pytest
import uuid
from collections import Counter
from typing import Dict, List

from ag_ui.core import (
    EventType,
    RunAgentInput,
    UserMessage,
    BaseEvent,
)
from ag_ui_adk import ADKAgent
from ag_ui_adk.session_manager import SessionManager
from google.adk.agents import LlmAgent
from google.adk.planners import BuiltInPlanner
from google.genai import types
from tests.constants import LIVE_TEST_MODEL


@pytest.fixture(autouse=True)
def setup_llmock(llmock_server):
    """Ensure LLMock is running when no real API key is set."""


class TestThoughtToReasoningIntegration:
    """Integration tests for thought-to-REASONING event conversion with real API calls."""

    REASONING_EVENT_TYPES = {
        EventType.REASONING_START,
        EventType.REASONING_END,
        EventType.REASONING_MESSAGE_START,
        EventType.REASONING_MESSAGE_CONTENT,
        EventType.REASONING_MESSAGE_END,
    }

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
    def thinking_agent(self):
        """Create an ADK agent with thinking enabled (include_thoughts=True)."""
        adk_agent = LlmAgent(
            name="thinking_agent",
            model=LIVE_TEST_MODEL,
            instruction="""You are a careful reasoning assistant. For every question:
            1. First, think through the problem systematically
            2. Consider potential pitfalls or trick questions
            3. Work through the logic step by step
            4. Only then provide your final answer

            Always show your reasoning process before giving the answer.
            """,
            planner=BuiltInPlanner(
                thinking_config=types.ThinkingConfig(
                    include_thoughts=True
                )
            ),
        )

        return ADKAgent(
            adk_agent=adk_agent,
            app_name="test_thinking",
            user_id="test_user",
            use_in_memory_services=True,
        )

    @pytest.fixture
    def non_thinking_agent(self):
        """Create an ADK agent without thinking enabled for comparison."""
        adk_agent = LlmAgent(
            name="non_thinking_agent",
            model=LIVE_TEST_MODEL,
            instruction="""You are a helpful assistant. Answer questions directly and concisely.""",
        )

        return ADKAgent(
            adk_agent=adk_agent,
            app_name="test_non_thinking",
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

    def _get_reasoning_content(self, events: List[BaseEvent]) -> str:
        """Extract reasoning content from events."""
        content_parts = []
        for event in events:
            if event.type == EventType.REASONING_MESSAGE_CONTENT:
                content_parts.append(event.delta)
        return "".join(content_parts)

    def _get_reasoning_blocks(self, events: List[BaseEvent]) -> list[list[BaseEvent]]:
        """Extract reasoning blocks (REASONING_START to REASONING_END) from events."""
        blocks: list[list[BaseEvent]] = []
        current_block: list[BaseEvent] = []
        in_block = False

        for event in events:
            if event.type == EventType.REASONING_START:
                in_block = True
                current_block = [event]
            elif in_block:
                current_block.append(event)
                if event.type == EventType.REASONING_END:
                    blocks.append(current_block)
                    current_block = []
                    in_block = False

        return blocks

    @pytest.mark.asyncio
    async def test_thinking_agent_emits_reasoning_events(self, thinking_agent):
        """Verify that an agent with include_thoughts=True emits REASONING events.

        The agent should emit:
        - REASONING_START at the beginning of thought content
        - REASONING_MESSAGE_START/CONTENT/END for thought text
        - REASONING_END when thoughts are complete
        - Regular TEXT_MESSAGE events for the final response
        """
        input_data = self._create_input(
            "A farmer has 17 sheep. All but 9 run away. How many sheep does the farmer have left? "
            "Think through this carefully before answering."
        )

        events = []
        async for event in thinking_agent.run(input_data):
            events.append(event)

        event_counts = self._count_events(events)
        print(f"\nEvent counts: {dict(event_counts)}")

        # Verify basic run structure
        assert event_counts.get("RUN_STARTED", 0) >= 1, "Should have RUN_STARTED"
        assert event_counts.get("RUN_FINISHED", 0) >= 1, "Should have RUN_FINISHED"

        # With include_thoughts=True on gemini-2.5-flash, we must get reasoning events
        reasoning_events = [e for e in events if e.type in self.REASONING_EVENT_TYPES]
        assert len(reasoning_events) > 0, \
            "Agent with include_thoughts=True must emit REASONING events"

        # Verify proper structure: first REASONING_START before last REASONING_END
        reasoning_start_idx = next(
            i for i, e in enumerate(events) if e.type == EventType.REASONING_START
        )
        reasoning_end_idx = next(
            i for i, e in reversed(list(enumerate(events))) if e.type == EventType.REASONING_END
        )
        assert reasoning_start_idx < reasoning_end_idx, \
            "REASONING_START should come before REASONING_END"

        # Verify we have non-empty reasoning content
        reasoning_content = self._get_reasoning_content(events)
        assert len(reasoning_content) > 0, "Should have non-empty reasoning content"
        print(f"✅ Reasoning content captured: {len(reasoning_content)} chars")

        # Verify we also got a text response
        assert event_counts.get("TEXT_MESSAGE_START", 0) >= 1 or \
               event_counts.get("TEXT_MESSAGE_CONTENT", 0) >= 1, \
            "Should have text message events for the response"

    @pytest.mark.asyncio
    async def test_non_thinking_agent_no_reasoning_events(self, non_thinking_agent):
        """Verify that an agent without include_thoughts=True does NOT emit REASONING events."""
        input_data = self._create_input("What is 2 + 2?")

        events = []
        async for event in non_thinking_agent.run(input_data):
            events.append(event)

        event_counts = self._count_events(events)
        print(f"\nEvent counts: {dict(event_counts)}")

        assert event_counts.get("RUN_STARTED", 0) >= 1, "Should have RUN_STARTED"
        assert event_counts.get("RUN_FINISHED", 0) >= 1, "Should have RUN_FINISHED"

        reasoning_events = [e for e in events if e.type in self.REASONING_EVENT_TYPES]
        assert len(reasoning_events) == 0, \
            "Non-thinking agent should NOT emit REASONING events"

        assert event_counts.get("TEXT_MESSAGE_START", 0) >= 1 or \
               event_counts.get("TEXT_MESSAGE_CONTENT", 0) >= 1, \
            "Should have text message events"

        print("✅ No REASONING events as expected for non-thinking agent")

    @pytest.mark.asyncio
    async def test_reasoning_events_structure(self, thinking_agent):
        """Verify that each reasoning block has correct internal structure.

        Each block (REASONING_START to REASONING_END) should contain:
        REASONING_START, REASONING_MESSAGE_START, one or more
        REASONING_MESSAGE_CONTENT, then REASONING_MESSAGE_END (on stream close),
        and finally REASONING_END.

        During streaming, the model may produce multiple reasoning blocks if
        thought and text parts interleave across partial events.
        """
        input_data = self._create_input(
            "If it takes 5 machines 5 minutes to make 5 widgets, how long would it take "
            "100 machines to make 100 widgets? Reason through this step by step."
        )

        events = []
        async for event in thinking_agent.run(input_data):
            events.append(event)

        blocks = self._get_reasoning_blocks(events)
        assert len(blocks) >= 1, "Should have at least one reasoning block"

        for i, block in enumerate(blocks):
            # First event must be REASONING_START
            assert block[0].type == EventType.REASONING_START, \
                f"Block {i}: first event should be REASONING_START"

            # Last event must be REASONING_END
            assert block[-1].type == EventType.REASONING_END, \
                f"Block {i}: last event should be REASONING_END"

            # Must contain at least one REASONING_MESSAGE_CONTENT
            content_events = [e for e in block if e.type == EventType.REASONING_MESSAGE_CONTENT]
            assert len(content_events) >= 1, \
                f"Block {i}: should have at least one REASONING_MESSAGE_CONTENT"

            # REASONING_MESSAGE_START should come before REASONING_MESSAGE_END
            block_types = [e.type for e in block]
            if EventType.REASONING_MESSAGE_START in block_types and EventType.REASONING_MESSAGE_END in block_types:
                start_idx = block_types.index(EventType.REASONING_MESSAGE_START)
                end_idx = len(block_types) - 1 - block_types[::-1].index(EventType.REASONING_MESSAGE_END)
                assert start_idx < end_idx, \
                    f"Block {i}: REASONING_MESSAGE_START should come before END"

        print(f"✅ {len(blocks)} reasoning block(s) with correct structure")

    @pytest.mark.asyncio
    async def test_reasoning_message_id_consistency(self, thinking_agent):
        """Verify that reasoning events within each block share the same message_id.

        During streaming, the model may produce multiple reasoning blocks
        (thought -> text -> thought interleaving). Within each block (from
        REASONING_START to REASONING_END), all events must share one message_id.
        """
        input_data = self._create_input(
            "What is the sum of the first 10 prime numbers? "
            "Show your work step by step."
        )

        events = []
        async for event in thinking_agent.run(input_data):
            events.append(event)

        blocks = self._get_reasoning_blocks(events)
        assert len(blocks) >= 1, "Should have at least one reasoning block"

        for i, block in enumerate(blocks):
            message_ids = set()
            for event in block:
                assert hasattr(event, 'message_id'), \
                    f"Block {i}: {event.type} should have a message_id attribute"
                assert event.message_id, \
                    f"Block {i}: {event.type} should have a non-empty message_id"
                message_ids.add(event.message_id)

            assert len(message_ids) == 1, \
                f"Block {i}: all events should share one message_id, got {message_ids}"

        print(f"✅ {len(blocks)} reasoning block(s), each with consistent message_id")

    @pytest.mark.asyncio
    async def test_reasoning_message_start_has_role(self, thinking_agent):
        """Verify that REASONING_MESSAGE_START events include role='reasoning'."""
        input_data = self._create_input(
            "Is 97 a prime number? Think carefully."
        )

        events = []
        async for event in thinking_agent.run(input_data):
            events.append(event)

        msg_start_events = [
            e for e in events
            if e.type == EventType.REASONING_MESSAGE_START
        ]

        assert len(msg_start_events) >= 1, \
            "Should have at least one REASONING_MESSAGE_START"

        for event in msg_start_events:
            assert event.role == "reasoning", \
                f"REASONING_MESSAGE_START should have role='reasoning', got '{event.role}'"

        print(f"✅ {len(msg_start_events)} REASONING_MESSAGE_START event(s) with role='reasoning'")

    @pytest.mark.asyncio
    async def test_reasoning_encrypted_value_emitted(self, thinking_agent):
        """Verify REASONING_ENCRYPTED_VALUE events when thought signatures are present.

        When the Gemini model returns thought_signature bytes on thought parts,
        the middleware should emit REASONING_ENCRYPTED_VALUE events with:
        - subtype="message"
        - entity_id matching a reasoning message_id
        - encrypted_value containing valid base64-encoded signature

        Note: Whether the model returns thought_signature depends on the API
        version and configuration. This test validates the structure when present
        but does not fail if the API omits signatures.
        """
        import base64

        input_data = self._create_input(
            "Explain why the square root of 2 is irrational. "
            "Reason through the proof step by step."
        )

        events = []
        async for event in thinking_agent.run(input_data):
            events.append(event)

        # Reasoning events must be present
        assert any(e.type in self.REASONING_EVENT_TYPES for e in events), \
            "Agent with include_thoughts=True must emit REASONING events"

        encrypted_events = [
            e for e in events
            if e.type == EventType.REASONING_ENCRYPTED_VALUE
        ]

        if encrypted_events:
            print(f"✅ Found {len(encrypted_events)} REASONING_ENCRYPTED_VALUE event(s)")

            reasoning_msg_ids = {
                e.message_id for e in events
                if e.type == EventType.REASONING_MESSAGE_START
            }

            for event in encrypted_events:
                assert event.subtype == "message", \
                    f"Expected subtype='message', got '{event.subtype}'"
                assert event.entity_id, \
                    "entity_id should be non-empty"
                assert event.encrypted_value, \
                    "encrypted_value should be non-empty"

                # Verify it's valid base64
                try:
                    decoded = base64.b64decode(event.encrypted_value)
                    assert len(decoded) > 0, "Decoded signature should be non-empty"
                    print(f"  ✅ Valid base64 encrypted_value ({len(decoded)} bytes)")
                except Exception as e:
                    pytest.fail(f"encrypted_value is not valid base64: {e}")

                # entity_id should match one of our reasoning message_ids
                if reasoning_msg_ids:
                    assert event.entity_id in reasoning_msg_ids, \
                        f"entity_id '{event.entity_id}' should match a reasoning message_id"
        else:
            print("ℹ️ No REASONING_ENCRYPTED_VALUE events (API did not return thought_signature)")

    @pytest.mark.asyncio
    async def test_each_reasoning_block_well_formed(self, thinking_agent):
        """Verify that every reasoning block is properly opened and closed.

        During streaming, thought and text parts can interleave across partial
        events, producing multiple reasoning blocks. Each block must be
        well-formed: every REASONING_START must have a matching REASONING_END,
        and the block must never be left dangling.
        """
        input_data = self._create_input(
            "What is 15 factorial? Show your calculation."
        )

        events = []
        async for event in thinking_agent.run(input_data):
            events.append(event)

        # Count starts and ends
        start_count = sum(1 for e in events if e.type == EventType.REASONING_START)
        end_count = sum(1 for e in events if e.type == EventType.REASONING_END)

        assert start_count >= 1, "Should have at least one REASONING_START"
        assert start_count == end_count, \
            f"Every REASONING_START must have a matching REASONING_END " \
            f"(got {start_count} starts, {end_count} ends)"

        # Verify blocks are non-overlapping and properly nested
        depth = 0
        for event in events:
            if event.type == EventType.REASONING_START:
                assert depth == 0, "REASONING_START while already in a reasoning block"
                depth += 1
            elif event.type == EventType.REASONING_END:
                assert depth == 1, "REASONING_END without a matching REASONING_START"
                depth -= 1

        assert depth == 0, "Reasoning block left open at end of stream"
        print(f"✅ {start_count} well-formed reasoning block(s)")


if __name__ == "__main__":
    # Allow running directly for debugging
    import sys
    if os.environ.get("GOOGLE_API_KEY"):
        pytest.main([__file__, "-v", "-s"])
    else:
        print("GOOGLE_API_KEY not set, skipping integration tests")
        sys.exit(0)
