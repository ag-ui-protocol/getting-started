#!/usr/bin/env python
"""Comprehensive tests for EventTranslator, focusing on untested paths."""

import json
from dataclasses import asdict, dataclass
from types import SimpleNamespace
from typing import Optional

import pytest
import uuid
from unittest.mock import MagicMock, patch, AsyncMock

from ag_ui.core import (
    EventType, TextMessageStartEvent, TextMessageContentEvent, TextMessageEndEvent,
    ToolCallStartEvent, ToolCallArgsEvent, ToolCallEndEvent, ToolCallResultEvent,
    StateDeltaEvent, StateSnapshotEvent, CustomEvent
)
from google.adk.events import Event as ADKEvent
from ag_ui_adk.event_translator import EventTranslator


class TestEventTranslatorComprehensive:
    """Comprehensive tests for EventTranslator functionality."""

    @pytest.fixture
    def translator(self):
        """Create a fresh EventTranslator instance."""
        return EventTranslator()

    @pytest.fixture
    def mock_adk_event(self):
        """Create a mock ADK event."""
        event = MagicMock(spec=ADKEvent)
        event.id = "test_event_id"
        event.author = "model"
        event.content = None
        event.partial = False
        event.turn_complete = True
        event.is_final_response = False
        return event

    @pytest.fixture
    def mock_adk_event_with_content(self):
        """Create a mock ADK event with content."""
        event = MagicMock(spec=ADKEvent)
        event.id = "test_event_id"
        event.author = "model"

        # Mock content with text parts
        mock_content = MagicMock()
        mock_part = MagicMock()
        mock_part.text = "Test content"
        mock_content.parts = [mock_part]
        event.content = mock_content

        event.partial = False
        event.turn_complete = True
        event.is_final_response = False
        event.usage_metadata = {'tokens': 22}
        return event

    @pytest.mark.asyncio
    async def test_translate_user_event_skipped(self, translator, mock_adk_event):
        """Test that user events are skipped."""
        mock_adk_event.author = "user"

        events = []
        async for event in translator.translate(mock_adk_event, "thread_1", "run_1"):
            events.append(event)

        assert len(events) == 0

    @pytest.mark.asyncio
    async def test_translate_event_without_content(self, translator, mock_adk_event):
        """Test translating event without content."""
        mock_adk_event.content = None

        events = []
        async for event in translator.translate(mock_adk_event, "thread_1", "run_1"):
            events.append(event)

        assert len(events) == 0

    @pytest.mark.asyncio
    async def test_translate_event_with_empty_parts(self, translator, mock_adk_event):
        """Test translating event with empty parts."""
        mock_content = MagicMock()
        mock_content.parts = []
        mock_adk_event.content = mock_content

        events = []
        async for event in translator.translate(mock_adk_event, "thread_1", "run_1"):
            events.append(event)

        assert len(events) == 0

    @pytest.mark.asyncio
    async def test_translate_function_calls_detection(self, translator, mock_adk_event):
        """Test that function calls produce ToolCall events."""
        mock_function_call = MagicMock()
        mock_function_call.name = "test_function"
        mock_function_call.id = "call_123"
        mock_function_call.args = {"param": "value"}
        mock_adk_event.get_function_calls = MagicMock(return_value=[mock_function_call])

        events = []
        async for event in translator.translate(mock_adk_event, "thread_1", "run_1"):
            events.append(event)

        type_names = [str(event.type).split('.')[-1] for event in events]
        assert type_names == ["TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END"]
        ids = [getattr(event, 'tool_call_id', None) for event in events]
        assert ids == ["call_123", "call_123", "call_123"]

    @pytest.mark.asyncio
    async def test_translate_function_responses_handling(self, translator, mock_adk_event):
        """Test function responses handling."""
        # Mock event with function responses
        function_response = SimpleNamespace(id="tool-1", response={"ok": True})
        mock_adk_event.get_function_calls = MagicMock(return_value=[])
        mock_adk_event.get_function_responses = MagicMock(return_value=[function_response])

        events = []
        async for event in translator.translate(mock_adk_event, "thread_1", "run_1"):
            events.append(event)

        assert len(events) == 1
        event = events[0]
        assert isinstance(event, ToolCallResultEvent)
        assert json.loads(event.content) == {"ok": True}

    @pytest.mark.asyncio
    async def test_translate_function_response_with_call_tool_result_payload(self, translator):
        """Ensure complex CallToolResult payloads are serialized correctly."""

        @dataclass
        class TextContent:
            type: str = "text"
            text: str = ""
            annotations: Optional[list] = None
            meta: Optional[dict] = None

        @dataclass
        class CallToolResult:
            meta: Optional[dict]
            structuredContent: Optional[dict]
            isError: bool
            content: list[TextContent]

        repeated_text_entries = [
            "Primary Task: Provide a detailed walkthrough for the requested topic.",
            "Primary Task: Provide a detailed walkthrough for the requested topic.",
            "Constraints: Ensure clarity and maintain a concise explanation.",
            "Constraints: Ensure clarity and maintain a concise explanation.",
        ]

        payload = CallToolResult(
            meta=None,
            structuredContent=None,
            isError=False,
            content=[TextContent(text=text) for text in repeated_text_entries],
        )

        function_response = SimpleNamespace(
            id="tool-structured-1",
            response={"result": payload},
        )

        events = []
        async for event in translator._translate_function_response([function_response]):
            events.append(event)

        assert len(events) == 1
        event = events[0]
        assert isinstance(event, ToolCallResultEvent)

        content = json.loads(event.content)
        assert content["result"]["isError"] is False
        assert content["result"]["structuredContent"] is None
        assert [item["text"] for item in content["result"]["content"]] == repeated_text_entries

    @pytest.mark.asyncio
    async def test_translate_state_delta_event(self, translator, mock_adk_event):
        """Test state delta event creation."""
        # Mock event with state delta
        mock_actions = MagicMock()
        mock_actions.state_delta = {"key1": "value1", "key2": "value2"}
        mock_actions.state_snapshot = None
        mock_adk_event.actions = mock_actions

        events = []
        async for event in translator.translate(mock_adk_event, "thread_1", "run_1"):
            events.append(event)

        assert len(events) == 1
        assert isinstance(events[0], StateDeltaEvent)
        assert events[0].type == EventType.STATE_DELTA

        # Check patches
        patches = events[0].delta
        assert len(patches) == 2
        assert any(patch["path"] == "/key1" and patch["value"] == "value1" for patch in patches)
        assert any(patch["path"] == "/key2" and patch["value"] == "value2" for patch in patches)

    @pytest.mark.asyncio
    async def test_translate_state_snapshot_event_passthrough(self, translator, mock_adk_event):
        """Test state snapshot events preserve the ADK payload."""

        state_snapshot = {
            "user_name": "Alice",
            "timezone": "UTC",
            "custom_state": {
                "view": {"active_tab": "details"},
                "progress": 0.75,
            },
            "extra_field": [1, 2, 3],
        }

        mock_adk_event.actions = SimpleNamespace(
            state_delta=None,
            state_snapshot=state_snapshot,
        )

        events = []
        async for event in translator.translate(mock_adk_event, "thread_1", "run_1"):
            events.append(event)

        snapshot_events = [event for event in events if isinstance(event, StateSnapshotEvent)]
        assert snapshot_events, "Expected a StateSnapshotEvent to be emitted"

        snapshot_event = snapshot_events[0]
        assert snapshot_event.type == EventType.STATE_SNAPSHOT
        assert snapshot_event.snapshot == state_snapshot
        assert snapshot_event.snapshot["user_name"] == "Alice"
        assert snapshot_event.snapshot["custom_state"]["view"]["active_tab"] == "details"
        assert "extra_field" in snapshot_event.snapshot

    def test_create_state_snapshot_event_passthrough(self, translator):
        """Direct helper should forward the snapshot unchanged."""

        state_snapshot = {
            "user_name": "Bob",
            "custom_state": {"step": 3},
            "timezone": "PST",
        }

        event = translator._create_state_snapshot_event(state_snapshot)

        assert isinstance(event, StateSnapshotEvent)
        assert event.type == EventType.STATE_SNAPSHOT
        assert event.snapshot == state_snapshot
        assert set(event.snapshot.keys()) == {"user_name", "custom_state", "timezone"}

    @pytest.mark.asyncio
    async def test_translate_custom_event(self, translator, mock_adk_event):
        """Test custom event creation."""
        mock_adk_event.custom_data = {"custom_key": "custom_value"}

        events = []
        async for event in translator.translate(mock_adk_event, "thread_1", "run_1"):
            events.append(event)

        assert len(events) == 1
        assert isinstance(events[0], CustomEvent)
        assert events[0].type == EventType.CUSTOM
        assert events[0].name == "adk_metadata"
        assert events[0].value == {"custom_key": "custom_value"}

    @pytest.mark.asyncio
    async def test_translate_exception_handling(self, translator, mock_adk_event):
        """Test exception handling during translation."""
        # Mock event that will cause an exception during iteration
        mock_adk_event.content = MagicMock()
        mock_adk_event.content.parts = MagicMock()
        # Make parts iteration raise an exception
        mock_adk_event.content.parts.__iter__ = MagicMock(side_effect=ValueError("Test exception"))

        with patch('ag_ui_adk.event_translator.logger') as mock_logger:
            events = []
            async for event in translator.translate(mock_adk_event, "thread_1", "run_1"):
                events.append(event)

            # Should log error but not yield error event
            mock_logger.error.assert_called_once()
            assert "Error translating ADK event" in str(mock_logger.error.call_args)
            assert len(events) == 0

    @pytest.mark.asyncio
    async def test_translate_text_content_basic(self, translator, mock_adk_event_with_content):
        """Test basic text content translation."""
        events = []
        async for event in translator.translate(mock_adk_event_with_content, "thread_1", "run_1"):
            events.append(event)

        assert len(events) == 3  # START, CONTENT , END
        assert isinstance(events[0], TextMessageStartEvent)
        assert isinstance(events[1], TextMessageContentEvent)
        assert isinstance(events[2], TextMessageEndEvent)

        # Check content
        assert events[1].delta == "Test content"

        # Check message IDs are consistent
        message_id = events[0].message_id
        assert events[1].message_id == message_id

    @pytest.mark.asyncio
    async def test_translate_text_content_multiple_parts(self, translator, mock_adk_event):
        """Test text content with multiple parts."""
        mock_content = MagicMock()
        mock_part1 = MagicMock()
        mock_part1.text = "First part"
        mock_part2 = MagicMock()
        mock_part2.text = "Second part"
        mock_content.parts = [mock_part1, mock_part2]
        mock_adk_event.content = mock_content

        events = []
        async for event in translator.translate(mock_adk_event, "thread_1", "run_1"):
            events.append(event)

        assert len(events) == 3  # START, CONTENT , END
        assert isinstance(events[1], TextMessageContentEvent)
        assert events[1].delta == "First partSecond part"  # Joined without newlines

    @pytest.mark.asyncio
    async def test_translate_text_content_partial_streaming(self, translator, mock_adk_event_with_content):
        """Test partial streaming (no END event)."""
        mock_adk_event_with_content.partial = True
        mock_adk_event_with_content.turn_complete = False

        events = []
        async for event in translator.translate(mock_adk_event_with_content, "thread_1", "run_1"):
            events.append(event)

        # The translator keeps streaming open; forcing a close should yield END
        async for event in translator.force_close_streaming_message():
            events.append(event)

        assert len(events) == 3  # START, CONTENT, END (forced close)
        assert isinstance(events[0], TextMessageStartEvent)
        assert isinstance(events[1], TextMessageContentEvent)
        assert isinstance(events[2], TextMessageEndEvent)

    @pytest.mark.asyncio
    async def test_translate_text_content_final_response_callable(self, translator, mock_adk_event_with_content):
        """Test final response detection with callable method."""
        mock_adk_event_with_content.is_final_response = MagicMock(return_value=True)

        # Set up streaming state
        translator._is_streaming = True
        translator._streaming_message_id = "test_message_id"

        events = []
        async for event in translator.translate(mock_adk_event_with_content, "thread_1", "run_1"):
            events.append(event)

        assert len(events) == 1  # Only END event
        assert isinstance(events[0], TextMessageEndEvent)
        assert events[0].message_id == "test_message_id"

        # Should reset streaming state
        assert translator._is_streaming is False
        assert translator._streaming_message_id is None

    @pytest.mark.asyncio
    async def test_translate_text_content_final_response_property(self, translator, mock_adk_event_with_content):
        """Test final response detection with property."""
        mock_adk_event_with_content.is_final_response = True

        # Set up streaming state
        translator._is_streaming = True
        translator._streaming_message_id = "test_message_id"

        events = []
        async for event in translator.translate(mock_adk_event_with_content, "thread_1", "run_1"):
            events.append(event)

        assert len(events) == 1  # Only END event
        assert isinstance(events[0], TextMessageEndEvent)

    @pytest.mark.asyncio
    async def test_translate_text_content_final_response_no_streaming(self, translator, mock_adk_event_with_content):
        """Test final response when not streaming."""
        mock_adk_event_with_content.is_final_response = True

        # Not streaming
        translator._is_streaming = False

        events = []
        async for event in translator.translate(mock_adk_event_with_content, "thread_1", "run_1"):
            events.append(event)

        assert len(events) == 3  # START, CONTENT, END
        assert isinstance(events[0], TextMessageStartEvent)
        assert isinstance(events[1], TextMessageContentEvent)
        assert isinstance(events[2], TextMessageEndEvent)

        # Final response without streaming should capture the last streamed text for de-dupe
        assert translator._current_stream_text == ""
        assert translator._last_streamed_text == "Test content"
        assert translator._last_streamed_run_id == "run_1"

    @pytest.mark.asyncio
    async def test_translate_text_content_final_response_from_agent_callback(self, translator, mock_adk_event_with_content):
        """Test final response when it was received from an agent callback function."""
        mock_adk_event_with_content.is_final_response = True
        mock_adk_event_with_content.usage_metadata = None

        # Not streaming
        translator._is_streaming = False

        events = []
        async for event in translator.translate(mock_adk_event_with_content, "thread_1", "run_1"):
            events.append(event)

        assert len(events) == 3  # START, CONTENT, END
        assert isinstance(events[0], TextMessageStartEvent)
        assert isinstance(events[1], TextMessageContentEvent)
        assert events[1].delta == "Test content"
        assert isinstance(events[2], TextMessageEndEvent)

    @pytest.mark.asyncio
    async def test_translate_text_content_final_response_after_stream_duplicate_suppressed(self, translator):
        """Final LLM payload matching streamed text should be suppressed."""

        stream_event = MagicMock(spec=ADKEvent)
        stream_event.id = "event-1"
        stream_event.author = "model"
        stream_event.content = MagicMock()
        stream_part = MagicMock()
        stream_part.text = "Hello"
        stream_event.content.parts = [stream_part]
        stream_event.partial = False
        stream_event.turn_complete = False
        stream_event.is_final_response = False
        stream_event.usage_metadata = {"tokens": 1}

        events = []
        async for event in translator.translate(stream_event, "thread_1", "run_1"):
            events.append(event)

        assert len(events) == 2  # START + CONTENT
        assert isinstance(events[0], TextMessageStartEvent)
        assert isinstance(events[1], TextMessageContentEvent)

        final_stream_event = MagicMock(spec=ADKEvent)
        final_stream_event.id = "event-2"
        final_stream_event.author = "model"
        final_stream_event.content = MagicMock()
        final_stream_part = MagicMock()
        final_stream_part.text = ""
        final_stream_event.content.parts = [final_stream_part]
        final_stream_event.partial = False
        final_stream_event.turn_complete = True
        final_stream_event.is_final_response = True
        final_stream_event.usage_metadata = {"tokens": 1}

        events = []
        async for event in translator.translate(final_stream_event, "thread_1", "run_1"):
            events.append(event)

        assert len(events) == 1  # END only
        assert isinstance(events[0], TextMessageEndEvent)

        final_payload = MagicMock(spec=ADKEvent)
        final_payload.id = "event-3"
        final_payload.author = "model"
        final_payload.content = MagicMock()
        final_payload_part = MagicMock()
        final_payload_part.text = "Hello"
        final_payload.content.parts = [final_payload_part]
        final_payload.partial = False
        final_payload.turn_complete = True
        final_payload.is_final_response = True
        final_payload.usage_metadata = {"tokens": 2}

        events = []
        async for event in translator.translate(final_payload, "thread_1", "run_1"):
            events.append(event)

        assert events == []  # duplicate suppressed

    @pytest.mark.asyncio
    async def test_translate_text_content_final_response_closes_stream_without_consolidated_text(self, translator):
        """Final response with consolidated text should only close the open stream."""

        # Stream some content first
        stream_event = MagicMock(spec=ADKEvent)
        stream_event.id = "event-1"
        stream_event.author = "model"
        stream_event.content = MagicMock()
        stream_part = MagicMock()
        stream_part.text = "Streaming chunk"
        stream_event.content.parts = [stream_part]
        stream_event.partial = False
        stream_event.turn_complete = False
        stream_event.is_final_response = False
        stream_event.usage_metadata = {"tokens": 1}

        async for _ in translator.translate(stream_event, "thread_1", "run_1"):
            pass

        streaming_message_id = translator._streaming_message_id

        # Now receive a final response that includes the consolidated text
        final_event = MagicMock(spec=ADKEvent)
        final_event.id = "event-2"
        final_event.author = "model"
        final_event.content = MagicMock()
        final_part = MagicMock()
        final_part.text = "Streaming chunk"
        final_event.content.parts = [final_part]
        final_event.partial = False
        final_event.turn_complete = True
        final_event.is_final_response = True
        final_event.usage_metadata = {"tokens": 2}

        events = []
        async for event in translator.translate(final_event, "thread_1", "run_1"):
            events.append(event)

        # Only the END event should be emitted to close the active stream
        assert events == [
            TextMessageEndEvent(type=EventType.TEXT_MESSAGE_END, message_id=streaming_message_id)
        ]
        assert translator._is_streaming is False
        assert translator._current_stream_text == ""
        assert translator._last_streamed_text == "Streaming chunk"
        assert translator._last_streamed_run_id == "run_1"

    @pytest.mark.asyncio
    async def test_translate_text_content_final_response_after_stream_new_content(self, translator):
        """Final LLM payload with new content should be emitted."""

        stream_event = MagicMock(spec=ADKEvent)
        stream_event.id = "event-1"
        stream_event.author = "model"
        stream_event.content = MagicMock()
        stream_part = MagicMock()
        stream_part.text = "Hello"
        stream_event.content.parts = [stream_part]
        stream_event.partial = False
        stream_event.turn_complete = False
        stream_event.is_final_response = False
        stream_event.usage_metadata = {"tokens": 1}

        async for _ in translator.translate(stream_event, "thread_1", "run_1"):
            pass

        final_stream_event = MagicMock(spec=ADKEvent)
        final_stream_event.id = "event-2"
        final_stream_event.author = "model"
        final_stream_event.content = MagicMock()
        final_stream_part = MagicMock()
        final_stream_part.text = ""
        final_stream_event.content.parts = [final_stream_part]
        final_stream_event.partial = False
        final_stream_event.turn_complete = True
        final_stream_event.is_final_response = True
        final_stream_event.usage_metadata = {"tokens": 1}

        async for _ in translator.translate(final_stream_event, "thread_1", "run_1"):
            pass

        final_payload = MagicMock(spec=ADKEvent)
        final_payload.id = "event-3"
        final_payload.author = "model"
        final_payload.content = MagicMock()
        final_payload_part = MagicMock()
        final_payload_part.text = "Hello again"
        final_payload.content.parts = [final_payload_part]
        final_payload.partial = False
        final_payload.turn_complete = True
        final_payload.is_final_response = True
        final_payload.usage_metadata = {"tokens": 2}

        events = []
        async for event in translator.translate(final_payload, "thread_1", "run_1"):
            events.append(event)

        assert len(events) == 3
        assert isinstance(events[0], TextMessageStartEvent)
        assert isinstance(events[1], TextMessageContentEvent)
        assert events[1].delta == "Hello again"
        assert isinstance(events[2], TextMessageEndEvent)

    @pytest.mark.asyncio
    async def test_consolidated_text_skipped_during_streaming(self, translator):
        """Test that consolidated text (partial=False) is skipped during active streaming (GitHub #742).

        This tests the scenario where:
        1. Text is streamed as individual tokens (partial=True)
        2. An event arrives with consolidated text (partial=False) + function call
        3. The consolidated text should be skipped because partial=False indicates
           it's a recap of already-streamed content
        """
        # Stream first token (partial=True)
        event1 = MagicMock(spec=ADKEvent)
        event1.author = "model"
        event1.partial = True  # Streaming delta
        event1.turn_complete = False
        event1.is_final_response = lambda: False
        mock_content1 = MagicMock()
        mock_part1 = MagicMock()
        mock_part1.text = "I need to search"
        mock_content1.parts = [mock_part1]
        event1.content = mock_content1

        events = []
        async for event in translator.translate(event1, "thread_1", "run_1"):
            events.append(event)

        assert len(events) == 2  # START + CONTENT
        assert isinstance(events[0], TextMessageStartEvent)
        assert isinstance(events[1], TextMessageContentEvent)
        assert events[1].delta == "I need to search"
        message_id = events[0].message_id

        # Verify streaming is active
        assert translator._current_stream_text == "I need to search"
        assert translator._is_streaming is True

        # Now simulate consolidated event (partial=False) with function call
        # ADK sends this as a recap before executing the function
        event2 = MagicMock(spec=ADKEvent)
        event2.author = "model"
        event2.partial = False  # Key: partial=False indicates consolidated message
        event2.turn_complete = False  # Not complete because function needs to execute
        event2.is_final_response = lambda: False  # is_final_response=False due to function call
        mock_content2 = MagicMock()
        mock_part2 = MagicMock()
        mock_part2.text = "I need to search"  # Consolidated text (same as streamed)
        mock_content2.parts = [mock_part2]
        event2.content = mock_content2

        events2 = []
        async for event in translator.translate(event2, "thread_1", "run_1"):
            events2.append(event)

        # Consolidated text should be skipped - no new CONTENT event
        assert len(events2) == 0, "Consolidated text (partial=False) should be skipped during streaming"

        # Stream should still be active (waiting for function call to complete)
        assert translator._is_streaming is True
        assert translator._streaming_message_id == message_id

    @pytest.mark.asyncio
    async def test_consolidated_text_with_different_content_still_skipped(self, translator):
        """Test that consolidated text is skipped even if content differs slightly.

        The partial=False flag is the authoritative indicator, not text comparison.
        """
        # Stream tokens
        event1 = MagicMock(spec=ADKEvent)
        event1.author = "model"
        event1.partial = True
        event1.turn_complete = False
        event1.is_final_response = lambda: False
        mock_content1 = MagicMock()
        mock_part1 = MagicMock()
        mock_part1.text = "Hello world"
        mock_content1.parts = [mock_part1]
        event1.content = mock_content1

        events = []
        async for event in translator.translate(event1, "thread_1", "run_1"):
            events.append(event)

        assert len(events) == 2  # START + CONTENT
        assert translator._is_streaming is True

        # Consolidated event with slightly different text (e.g., added punctuation)
        # Should still be skipped because partial=False
        event2 = MagicMock(spec=ADKEvent)
        event2.author = "model"
        event2.partial = False  # Consolidated
        event2.turn_complete = False
        event2.is_final_response = lambda: False
        mock_content2 = MagicMock()
        mock_part2 = MagicMock()
        mock_part2.text = "Hello world!"  # Slightly different - has exclamation
        mock_content2.parts = [mock_part2]
        event2.content = mock_content2

        events2 = []
        async for event in translator.translate(event2, "thread_1", "run_1"):
            events2.append(event)

        # Should be skipped because partial=False, regardless of text content
        assert len(events2) == 0, "Consolidated text should be skipped based on partial=False flag"

    @pytest.mark.asyncio
    async def test_translate_text_content_empty_text(self, translator, mock_adk_event):
        """Test text content with empty text."""
        mock_content = MagicMock()
        mock_part = MagicMock()
        mock_part.text = ""
        mock_content.parts = [mock_part]
        mock_adk_event.content = mock_content

        events = []
        async for event in translator.translate(mock_adk_event, "thread_1", "run_1"):
            events.append(event)

        # Empty text is filtered out by the translator, so no events are generated
        assert len(events) == 0

    @pytest.mark.asyncio
    async def test_translate_text_content_none_text_parts(self, translator, mock_adk_event):
        """Test text content with None text parts."""
        mock_content = MagicMock()
        mock_part1 = MagicMock()
        mock_part1.text = None
        mock_part2 = MagicMock()
        mock_part2.text = None
        mock_content.parts = [mock_part1, mock_part2]
        mock_adk_event.content = mock_content

        events = []
        async for event in translator.translate(mock_adk_event, "thread_1", "run_1"):
            events.append(event)

        assert len(events) == 0  # No events for None text

    @pytest.mark.asyncio
    async def test_translate_text_content_mixed_text_parts(self, translator, mock_adk_event):
        """Test text content with mixed text and None parts."""
        mock_content = MagicMock()
        mock_part1 = MagicMock()
        mock_part1.text = "Valid text"
        mock_part2 = MagicMock()
        mock_part2.text = None
        mock_part3 = MagicMock()
        mock_part3.text = "More text"
        mock_content.parts = [mock_part1, mock_part2, mock_part3]
        mock_adk_event.content = mock_content

        events = []
        async for event in translator.translate(mock_adk_event, "thread_1", "run_1"):
            events.append(event)

        assert len(events) == 3  # START, CONTENT , END
        assert events[1].delta == "Valid textMore text"

    @pytest.mark.asyncio
    async def test_translate_function_calls_basic(self, translator, mock_adk_event):
        """Test basic function call translation."""
        mock_function_call = MagicMock()
        mock_function_call.name = "test_function"
        mock_function_call.args = {"param1": "value1"}
        mock_function_call.id = "call_123"

        events = []
        async for event in translator._translate_function_calls(
             [mock_function_call]
        ):
            events.append(event)

        assert len(events) == 3  # START, ARGS, END
        assert isinstance(events[0], ToolCallStartEvent)
        assert isinstance(events[1], ToolCallArgsEvent)
        assert isinstance(events[2], ToolCallEndEvent)

        # Check details
        assert events[0].tool_call_id == "call_123"
        assert events[0].tool_call_name == "test_function"
        assert events[1].tool_call_id == "call_123"
        assert json.loads(events[1].delta) == {"param1": "value1"}
        assert events[2].tool_call_id == "call_123"

    @pytest.mark.asyncio
    async def test_translate_function_calls_no_id(self, translator, mock_adk_event):
        """Test function call translation without ID."""
        mock_function_call = MagicMock()
        mock_function_call.name = "test_function"
        mock_function_call.args = {"param1": "value1"}
        # No id attribute
        delattr(mock_function_call, 'id')

        with patch('uuid.uuid4') as mock_uuid:
            mock_uuid.return_value = "generated_id"

            events = []
            async for event in translator._translate_function_calls(
                 [mock_function_call]
            ):
                events.append(event)

        assert len(events) == 3
        assert events[0].tool_call_id == "generated_id"
        assert events[1].tool_call_id == "generated_id"
        assert events[2].tool_call_id == "generated_id"

    @pytest.mark.asyncio
    async def test_translate_function_calls_no_args(self, translator, mock_adk_event):
        """Test function call translation without args."""
        mock_function_call = MagicMock()
        mock_function_call.name = "test_function"
        mock_function_call.id = "call_123"
        # No args attribute
        delattr(mock_function_call, 'args')

        events = []
        async for event in translator._translate_function_calls(
            [mock_function_call]
        ):
            events.append(event)

        assert len(events) == 2  # START, END (no ARGS)
        assert isinstance(events[0], ToolCallStartEvent)
        assert isinstance(events[1], ToolCallEndEvent)

    @pytest.mark.asyncio
    async def test_translate_function_calls_string_args(self, translator, mock_adk_event):
        """Test function call translation with string args."""
        mock_function_call = MagicMock()
        mock_function_call.name = "test_function"
        mock_function_call.args = "string_args"
        mock_function_call.id = "call_123"

        events = []
        async for event in translator._translate_function_calls(
             [mock_function_call]
        ):
            events.append(event)

        assert len(events) == 3
        assert events[1].delta == "string_args"

    @pytest.mark.asyncio
    async def test_translate_function_calls_multiple(self, translator, mock_adk_event):
        """Test multiple function calls translation."""
        mock_function_call1 = MagicMock()
        mock_function_call1.name = "function1"
        mock_function_call1.args = {"param1": "value1"}
        mock_function_call1.id = "call_1"

        mock_function_call2 = MagicMock()
        mock_function_call2.name = "function2"
        mock_function_call2.args = {"param2": "value2"}
        mock_function_call2.id = "call_2"

        events = []
        async for event in translator._translate_function_calls(
             [mock_function_call1, mock_function_call2]
        ):
            events.append(event)

        assert len(events) == 6  # 3 events per function call

        # Check first function call
        assert events[0].tool_call_id == "call_1"
        assert events[0].tool_call_name == "function1"
        assert events[1].tool_call_id == "call_1"
        assert events[2].tool_call_id == "call_1"

        # Check second function call
        assert events[3].tool_call_id == "call_2"
        assert events[3].tool_call_name == "function2"
        assert events[4].tool_call_id == "call_2"
        assert events[5].tool_call_id == "call_2"

    def test_create_state_delta_event_basic(self, translator):
        """Test basic state delta event creation."""
        state_delta = {"key1": "value1", "key2": "value2"}

        event = translator._create_state_delta_event(state_delta, "thread_1", "run_1")

        assert isinstance(event, StateDeltaEvent)
        assert event.type == EventType.STATE_DELTA
        assert len(event.delta) == 2

        # Check patches
        patches = event.delta
        assert any(patch["op"] == "add" and patch["path"] == "/key1" and patch["value"] == "value1" for patch in patches)
        assert any(patch["op"] == "add" and patch["path"] == "/key2" and patch["value"] == "value2" for patch in patches)

    def test_create_state_delta_event_empty(self, translator):
        """Test state delta event creation with empty delta."""
        event = translator._create_state_delta_event({}, "thread_1", "run_1")

        assert isinstance(event, StateDeltaEvent)
        assert event.delta == []

    def test_create_state_delta_event_nested_objects(self, translator):
        """Test state delta event creation with nested objects."""
        state_delta = {
            "user": {"name": "John", "age": 30},
            "settings": {"theme": "dark", "notifications": True}
        }

        event = translator._create_state_delta_event(state_delta, "thread_1", "run_1")

        assert isinstance(event, StateDeltaEvent)
        assert len(event.delta) == 2

        # Check patches for nested objects
        patches = event.delta
        assert any(patch["op"] == "add" and patch["path"] == "/user" and patch["value"] == {"name": "John", "age": 30} for patch in patches)
        assert any(patch["op"] == "add" and patch["path"] == "/settings" and patch["value"] == {"theme": "dark", "notifications": True} for patch in patches)

    def test_create_state_delta_event_array_values(self, translator):
        """Test state delta event creation with array values."""
        state_delta = {
            "items": ["item1", "item2", "item3"],
            "numbers": [1, 2, 3, 4, 5]
        }

        event = translator._create_state_delta_event(state_delta, "thread_1", "run_1")

        assert isinstance(event, StateDeltaEvent)
        assert len(event.delta) == 2

        # Check patches for arrays
        patches = event.delta
        assert any(patch["op"] == "add" and patch["path"] == "/items" and patch["value"] == ["item1", "item2", "item3"] for patch in patches)
        assert any(patch["op"] == "add" and patch["path"] == "/numbers" and patch["value"] == [1, 2, 3, 4, 5] for patch in patches)

    def test_create_state_delta_event_mixed_types(self, translator):
        """Test state delta event creation with mixed value types."""
        state_delta = {
            "string_val": "text",
            "number_val": 42,
            "boolean_val": True,
            "null_val": None,
            "object_val": {"nested": "value"},
            "array_val": [1, "mixed", {"nested": True}]
        }

        event = translator._create_state_delta_event(state_delta, "thread_1", "run_1")

        assert isinstance(event, StateDeltaEvent)
        assert len(event.delta) == 6

        # Check all patches use "add" operation
        patches = event.delta
        for patch in patches:
            assert patch["op"] == "add"
            assert patch["path"].startswith("/")

        # Verify specific values
        patch_dict = {patch["path"]: patch["value"] for patch in patches}
        assert patch_dict["/string_val"] == "text"
        assert patch_dict["/number_val"] == 42
        assert patch_dict["/boolean_val"] is True
        assert patch_dict["/null_val"] is None
        assert patch_dict["/object_val"] == {"nested": "value"}
        assert patch_dict["/array_val"] == [1, "mixed", {"nested": True}]

    def test_create_state_delta_event_special_characters_in_keys(self, translator):
        """Test state delta event creation with special characters in keys."""
        state_delta = {
            "key-with-dashes": "value1",
            "key_with_underscores": "value2",
            "key.with.dots": "value3",
            "key with spaces": "value4"
        }

        event = translator._create_state_delta_event(state_delta, "thread_1", "run_1")

        assert isinstance(event, StateDeltaEvent)
        assert len(event.delta) == 4

        # Check that all keys are properly escaped in paths
        patches = event.delta
        paths = [patch["path"] for patch in patches]
        assert "/key-with-dashes" in paths
        assert "/key_with_underscores" in paths
        assert "/key.with.dots" in paths
        assert "/key with spaces" in paths

    @pytest.mark.asyncio
    async def test_force_close_streaming_message_with_open_stream(self, translator):
        """Test force closing an open streaming message."""
        translator._is_streaming = True
        translator._streaming_message_id = "test_message_id"

        with patch('ag_ui_adk.event_translator.logger') as mock_logger:
            events = []
            async for event in translator.force_close_streaming_message():
                events.append(event)

        assert len(events) == 1
        assert isinstance(events[0], TextMessageEndEvent)
        assert events[0].message_id == "test_message_id"

        # Should reset streaming state
        assert translator._is_streaming is False
        assert translator._streaming_message_id is None

        # Should log warning
        mock_logger.warning.assert_called_once()
        assert "Force-closing unterminated streaming message" in str(mock_logger.warning.call_args)

    @pytest.mark.asyncio
    async def test_force_close_streaming_message_no_open_stream(self, translator):
        """Test force closing when no stream is open."""
        translator._is_streaming = False
        translator._streaming_message_id = None

        events = []
        async for event in translator.force_close_streaming_message():
            events.append(event)

        assert len(events) == 0

    def test_reset_translator_state(self, translator):
        """Test resetting translator state."""
        # Set up some state
        translator._is_streaming = True
        translator._streaming_message_id = "test_id"
        translator._active_tool_calls = {"call_1": "call_1", "call_2": "call_2"}

        translator.reset()

        # Should reset all state
        assert translator._is_streaming is False
        assert translator._streaming_message_id is None
        assert translator._active_tool_calls == {}

    @pytest.mark.asyncio
    async def test_streaming_state_management(self, translator, mock_adk_event_with_content):
        """Test streaming state management across multiple events."""
        # First event should start streaming
        events1 = []
        async for event in translator.translate(mock_adk_event_with_content, "thread_1", "run_1"):
            events1.append(event)

        assert len(events1) == 3  # START, CONTENT, END
        message_id = events1[0].message_id

        # streaming is stoped after TextMessageEndEvent
        assert translator._is_streaming is False
        # since the streaming is stopped
        assert translator._streaming_message_id == None

        # Second event should continue streaming (same message ID)
        events2 = []
        async for event in translator.translate(mock_adk_event_with_content, "thread_1", "run_1"):
            events2.append(event)

        assert len(events2) == 3  # New Streaming (START , CONTENT ,END)
        assert events2[0].message_id != message_id  # Same message ID

    @pytest.mark.asyncio
    async def test_complex_event_with_multiple_features(self, translator, mock_adk_event):
        """Test complex event with text, function calls, state delta, and custom data."""
        # Set up complex event
        mock_content = MagicMock()
        mock_part = MagicMock()
        mock_part.text = "Complex event text"
        mock_content.parts = [mock_part]
        mock_adk_event.content = mock_content

        # Add state delta
        mock_actions = MagicMock()
        mock_actions.state_delta = {"state_key": "state_value"}
        mock_adk_event.actions = mock_actions

        # Add custom data
        mock_adk_event.custom_data = {"custom_key": "custom_value"}

        events = []
        async for event in translator.translate(mock_adk_event, "thread_1", "run_1"):
            events.append(event)

        # Should have text events, state delta, state snapshot, and custom event
        assert len(events) == 6  # START, CONTENT, STATE_DELTA, STATE_SNAPSHOT, CUSTOM, END

        # Check event types
        event_types = [type(event) for event in events]
        assert TextMessageStartEvent in event_types
        assert TextMessageContentEvent in event_types
        assert StateDeltaEvent in event_types
        assert StateSnapshotEvent in event_types
        assert CustomEvent in event_types
        assert TextMessageEndEvent in event_types

    @pytest.mark.asyncio
    async def test_event_logging_coverage(self, translator, mock_adk_event_with_content):
        """Test event translation without diagnostic logging."""
        # After diagnostic logging cleanup, we just verify events are generated correctly
        events = []
        async for event in translator.translate(mock_adk_event_with_content, "thread_1", "run_1"):
            events.append(event)

        # Verify events are generated
        assert len(events) > 0
        event_types = [type(event).__name__ for event in events]
        # Should have text message events
        assert any("TextMessage" in event_type for event_type in event_types)

    @pytest.mark.asyncio
    async def test_attribute_access_patterns(self, translator, mock_adk_event):
        """Test different attribute access patterns for ADK events."""
        # Test event with various attribute patterns
        mock_adk_event.partial = None  # Test None handling
        mock_adk_event.turn_complete = None

        # Remove is_final_response to test missing attribute
        delattr(mock_adk_event, 'is_final_response')

        events = []
        async for event in translator.translate(mock_adk_event, "thread_1", "run_1"):
            events.append(event)

        # Should handle missing/None attributes gracefully
        assert len(events) == 0  # No content to process

    @pytest.mark.asyncio
    async def test_tool_call_tracking_cleanup(self, translator, mock_adk_event):
        """Test that tool call tracking is properly cleaned up."""
        mock_function_call = MagicMock()
        mock_function_call.name = "test_function"
        mock_function_call.args = {"param": "value"}
        mock_function_call.id = "call_123"

        # Before translation
        assert len(translator._active_tool_calls) == 0

        events = []
        async for event in translator._translate_function_calls(
             [mock_function_call]
        ):
            events.append(event)

        # After translation, should be cleaned up
        assert len(translator._active_tool_calls) == 0

    @pytest.mark.asyncio
    async def test_partial_streaming_continuation(self, translator):
        """Test continuation of partial streaming with different text chunks."""
        # First partial event - "Hello"
        event1 = MagicMock(spec=ADKEvent)
        event1.author = "model"
        event1.partial = True
        event1.turn_complete = False
        event1.is_final_response = lambda: False
        mock_content1 = MagicMock()
        mock_part1 = MagicMock()
        mock_part1.text = "Hello"
        mock_content1.parts = [mock_part1]
        event1.content = mock_content1

        events1 = []
        async for event in translator.translate(event1, "thread_1", "run_1"):
            events1.append(event)

        assert len(events1) == 2  # START, CONTENT (stream remains open)
        assert translator._is_streaming is True
        message_id = events1[0].message_id

        # Second partial event - " world" (different text, continues stream)
        event2 = MagicMock(spec=ADKEvent)
        event2.author = "model"
        event2.partial = True
        event2.turn_complete = False
        event2.is_final_response = lambda: False
        mock_content2 = MagicMock()
        mock_part2 = MagicMock()
        mock_part2.text = " world"
        mock_content2.parts = [mock_part2]
        event2.content = mock_content2

        events2 = []
        async for event in translator.translate(event2, "thread_1", "run_1"):
            events2.append(event)

        assert len(events2) == 1  # Additional CONTENT chunk
        assert isinstance(events2[0], TextMessageContentEvent)
        assert events2[0].delta == " world"
        assert events2[0].message_id == message_id  # Same stream continues
        assert translator._is_streaming is True
        assert translator._streaming_message_id == message_id

        # Final event (should end streaming - requires is_final_response=True)
        event3 = MagicMock(spec=ADKEvent)
        event3.author = "model"
        event3.partial = False
        event3.turn_complete = True
        event3.is_final_response = True
        mock_content3 = MagicMock()
        mock_part3 = MagicMock()
        mock_part3.text = "!"  # Final text chunk
        mock_content3.parts = [mock_part3]
        event3.content = mock_content3

        events3 = []
        async for event in translator.translate(event3, "thread_1", "run_1"):
            events3.append(event)

        assert len(events3) == 1  # Final END to close the stream
        assert isinstance(events3[0], TextMessageEndEvent)
        assert events3[0].message_id == message_id

        # Should reset streaming state
        assert translator._is_streaming is False
        assert translator._streaming_message_id is None

    @pytest.fixture
    def mock_adk_event_empty_text(self):
        """Create a mock ADK event with empty text content."""
        event = MagicMock(spec=ADKEvent)
        event.id = "test_event_id"
        event.author = "model"

        # Mock content with empty text part
        mock_content = MagicMock()
        mock_part = MagicMock()
        mock_part.text = ""
        mock_content.parts = [mock_part]
        event.content = mock_content

        event.partial = False
        event.turn_complete = True
        event.is_final_response = False
        return event

    @pytest.mark.asyncio
    async def test_empty_text_event_does_not_crash(self, translator, mock_adk_event_empty_text):
        """Test that empty text events are filtered and don't crash the frontend.

        Previously, empty text content would cause AG-UI's TextMessageContentEvent
        validation to fail. The fix filters out empty text before reaching validation.
        """
        events = []
        async for event in translator.translate(mock_adk_event_empty_text, "thread_1", "run_1"):
            events.append(event)

        # Empty text should be filtered out - no events emitted
        assert len(events) == 0
        content_events = [e for e in events if isinstance(e, TextMessageContentEvent)]
        assert len(content_events) == 0

    @pytest.mark.asyncio
    async def test_whitespace_only_text_event_does_not_crash(self, translator):
        """Test that whitespace-only text events are also handled.

        While the current fix checks for empty string, whitespace-only
        content should also not cause issues.
        """
        event = MagicMock(spec=ADKEvent)
        event.id = "test_event_id"
        event.author = "model"

        mock_content = MagicMock()
        mock_part = MagicMock()
        mock_part.text = "   "  # Whitespace only
        mock_content.parts = [mock_part]
        event.content = mock_content

        event.partial = False
        event.turn_complete = True
        event.is_final_response = False

        events = []
        async for event in translator.translate(event, "thread_1", "run_1"):
            events.append(event)

        # Whitespace is valid text content, should be emitted
        content_events = [e for e in events if isinstance(e, TextMessageContentEvent)]
        assert len(content_events) == 1
        assert content_events[0].delta == "   "

    @pytest.mark.asyncio
    async def test_multiple_empty_parts_filtered(self, translator, mock_adk_event):
        """Test that multiple empty text parts are all filtered."""
        mock_content = MagicMock()
        mock_part1 = MagicMock()
        mock_part1.text = ""
        mock_part2 = MagicMock()
        mock_part2.text = ""
        mock_part3 = MagicMock()
        mock_part3.text = ""
        mock_content.parts = [mock_part1, mock_part2, mock_part3]
        mock_adk_event.content = mock_content

        events = []
        async for event in translator.translate(mock_adk_event, "thread_1", "run_1"):
            events.append(event)

        # All empty parts should result in no text events
        assert len(events) == 0

    @pytest.mark.asyncio
    async def test_mixed_empty_and_valid_parts_filtering(self, translator, mock_adk_event):
        """Test that valid text parts are still emitted when mixed with empty parts."""
        mock_content = MagicMock()
        mock_part1 = MagicMock()
        mock_part1.text = ""
        mock_part2 = MagicMock()
        mock_part2.text = "Valid content"
        mock_part3 = MagicMock()
        mock_part3.text = ""
        mock_content.parts = [mock_part1, mock_part2, mock_part3]
        mock_adk_event.content = mock_content

        events = []
        async for event in translator.translate(mock_adk_event, "thread_1", "run_1"):
            events.append(event)

        # Valid content should still be emitted
        content_events = [e for e in events if isinstance(e, TextMessageContentEvent)]
        assert len(content_events) == 1
        assert content_events[0].delta == "Valid content"

    @pytest.mark.asyncio
    async def test_empty_combined_text_early_return(self, translator, mock_adk_event):
        """Test the early return when combined_text is empty.
        
        This directly tests the fix at lines 281-283:
            if not combined_text:
                return
        """
        # Create content where all parts have empty/None text
        mock_content = MagicMock()
        mock_part1 = MagicMock()
        mock_part1.text = ""
        mock_part2 = MagicMock()
        mock_part2.text = None
        mock_content.parts = [mock_part1, mock_part2]
        mock_adk_event.content = mock_content

        # Verify the translator doesn't start streaming for empty content
        assert translator._is_streaming is False

        events = []
        async for event in translator.translate(mock_adk_event, "thread_1", "run_1"):
            events.append(event)

        # No streaming should have started
        assert translator._is_streaming is False
        assert len(events) == 0
        # No TextMessageStartEvent should be created for empty content
        start_events = [e for e in events if isinstance(e, TextMessageStartEvent)]
        assert len(start_events) == 0


class TestThoughtHandling:
    """Tests for thought parts to THINKING events conversion."""

    @pytest.fixture
    def translator(self):
        """Create a fresh EventTranslator instance."""
        return EventTranslator()

    @pytest.fixture
    def mock_adk_event(self):
        """Create a mock ADK event."""
        event = MagicMock(spec=ADKEvent)
        event.id = "test_event_id"
        event.author = "model"
        event.content = None
        event.partial = False
        event.turn_complete = True
        event.is_final_response = False
        return event

    @pytest.mark.asyncio
    async def test_thought_parts_emit_reasoning_events(self, translator, mock_adk_event):
        """Test that parts with thought=True emit REASONING events."""
        from ag_ui.core import (
            ReasoningStartEvent, ReasoningMessageStartEvent,
            ReasoningMessageContentEvent
        )

        # Create a part with thought=True
        mock_content = MagicMock()
        mock_part = MagicMock()
        mock_part.text = "Let me think about this..."
        mock_part.thought = True  # Explicitly set to True
        mock_part.thought_signature = None
        mock_content.parts = [mock_part]
        mock_adk_event.content = mock_content

        events = []
        async for event in translator.translate(mock_adk_event, "thread_1", "run_1"):
            events.append(event)

        # Should emit REASONING_START, REASONING_MESSAGE_START, REASONING_MESSAGE_CONTENT
        assert len(events) >= 3
        assert isinstance(events[0], ReasoningStartEvent)
        assert isinstance(events[1], ReasoningMessageStartEvent)
        assert isinstance(events[2], ReasoningMessageContentEvent)
        assert events[2].delta == "Let me think about this..."

    @pytest.mark.asyncio
    async def test_mixed_thought_and_text_parts(self, translator, mock_adk_event):
        """Test handling of mixed thought and regular text parts."""
        from ag_ui.core import (
            ReasoningStartEvent, ReasoningMessageStartEvent,
            ReasoningMessageContentEvent, ReasoningMessageEndEvent,
            ReasoningEndEvent
        )

        # Create parts with both thought and regular text
        mock_content = MagicMock()

        thought_part = MagicMock()
        thought_part.text = "Thinking..."
        thought_part.thought = True
        thought_part.thought_signature = None

        text_part = MagicMock()
        text_part.text = "Here is my response."
        text_part.thought = False  # Explicitly set to False

        mock_content.parts = [thought_part, text_part]
        mock_adk_event.content = mock_content

        events = []
        async for event in translator.translate(mock_adk_event, "thread_1", "run_1"):
            events.append(event)

        # Should have reasoning events, then reasoning close events, then text events
        event_types = [type(e).__name__ for e in events]

        # Verify reasoning events come first
        assert "ReasoningStartEvent" in event_types
        assert "ReasoningMessageContentEvent" in event_types

        # Verify text message events are present
        assert "TextMessageStartEvent" in event_types
        assert "TextMessageContentEvent" in event_types

    @pytest.mark.asyncio
    async def test_non_thought_parts_emit_text_events(self, translator, mock_adk_event):
        """Test that parts without thought attribute emit regular text events."""
        # Create a part without thought attribute (simulating older SDK)
        mock_content = MagicMock()
        mock_part = MagicMock()
        mock_part.text = "Regular response"
        # Don't set thought attribute - let it be a mock (should be treated as non-thought)
        del mock_part.thought  # Remove the attribute if it exists
        mock_content.parts = [mock_part]
        mock_adk_event.content = mock_content

        events = []
        async for event in translator.translate(mock_adk_event, "thread_1", "run_1"):
            events.append(event)

        # Should emit regular text events, not reasoning events
        event_types = [type(e).__name__ for e in events]
        assert "TextMessageStartEvent" in event_types
        assert "TextMessageContentEvent" in event_types
        assert "ReasoningStartEvent" not in event_types

    @pytest.mark.asyncio
    async def test_thought_false_emits_text_events(self, translator, mock_adk_event):
        """Test that parts with thought=False emit regular text events."""
        mock_content = MagicMock()
        mock_part = MagicMock()
        mock_part.text = "Regular response"
        mock_part.thought = False  # Explicitly False
        mock_content.parts = [mock_part]
        mock_adk_event.content = mock_content

        events = []
        async for event in translator.translate(mock_adk_event, "thread_1", "run_1"):
            events.append(event)

        # Should emit regular text events
        event_types = [type(e).__name__ for e in events]
        assert "TextMessageStartEvent" in event_types
        assert "TextMessageContentEvent" in event_types
        assert "ReasoningStartEvent" not in event_types

    @pytest.mark.asyncio
    async def test_reasoning_stream_closed_on_final_response(self, translator, mock_adk_event):
        """Test that reasoning streams are properly closed on final response."""
        from ag_ui.core import ReasoningEndEvent, ReasoningMessageEndEvent

        # First, start a reasoning stream
        mock_content = MagicMock()
        thought_part = MagicMock()
        thought_part.text = "Thinking..."
        thought_part.thought = True
        thought_part.thought_signature = None
        mock_content.parts = [thought_part]
        mock_adk_event.content = mock_content
        mock_adk_event.partial = True  # Still streaming

        events = []
        async for event in translator.translate(mock_adk_event, "thread_1", "run_1"):
            events.append(event)

        # Verify reasoning is active
        assert translator._is_reasoning is True
        assert translator._is_streaming_reasoning is True

        # Now send final response
        mock_adk_event.is_final_response = MagicMock(return_value=True)
        mock_adk_event.partial = False
        mock_adk_event.turn_complete = True

        # Create content with regular text for final response
        final_part = MagicMock()
        final_part.text = "Final answer"
        final_part.thought = False
        mock_content.parts = [final_part]

        events = []
        async for event in translator.translate(mock_adk_event, "thread_1", "run_1"):
            events.append(event)

        # Should have closed reasoning stream
        event_types = [type(e).__name__ for e in events]
        assert "ReasoningMessageEndEvent" in event_types
        assert "ReasoningEndEvent" in event_types

        # Verify reasoning state is reset
        assert translator._is_reasoning is False
        assert translator._is_streaming_reasoning is False

    def test_reset_clears_reasoning_state(self, translator):
        """Test that reset() clears reasoning state."""
        # Set up some reasoning state
        translator._is_reasoning = True
        translator._is_streaming_reasoning = True
        translator._current_reasoning_text = "Some thinking"

        # Reset
        translator.reset()

        # Verify reasoning state is cleared
        assert translator._is_reasoning is False
        assert translator._is_streaming_reasoning is False
        assert translator._current_reasoning_text == ""

    @pytest.mark.asyncio
    async def test_fallback_when_thought_support_unavailable(self, translator, mock_adk_event):
        """Test fallback behavior when thought support is not available (old SDK).

        When _check_thought_support() returns False (simulating an older google-genai
        SDK without the part.thought attribute), all parts should be treated as
        regular text, even if they have thought=True set.
        """
        import ag_ui_adk.event_translator as et_module

        # Create a part with thought=True
        mock_content = MagicMock()
        mock_part = MagicMock()
        mock_part.text = "This would be a thought in newer SDK"
        mock_part.thought = True  # Set to True, but should be ignored
        mock_content.parts = [mock_part]
        mock_adk_event.content = mock_content

        # Mock _check_thought_support to return False (simulating old SDK)
        with patch.object(et_module, '_check_thought_support', return_value=False):
            events = []
            async for event in translator.translate(mock_adk_event, "thread_1", "run_1"):
                events.append(event)

        # Should emit regular text events, NOT reasoning events
        event_types = [type(e).__name__ for e in events]
        assert "TextMessageStartEvent" in event_types
        assert "TextMessageContentEvent" in event_types
        assert "ReasoningStartEvent" not in event_types
        assert "ReasoningMessageStartEvent" not in event_types

    @pytest.mark.asyncio
    async def test_thought_support_check_caching(self):
        """Test that thought support check is cached and only runs once."""
        import ag_ui_adk.event_translator as et_module

        # Reset the cached state
        et_module._THOUGHT_SUPPORT_CHECKED = False
        et_module._HAS_THOUGHT_SUPPORT = False

        # First call should set the cached value
        result1 = et_module._check_thought_support()
        assert et_module._THOUGHT_SUPPORT_CHECKED is True

        # Second call should return cached value without re-checking
        cached_value = et_module._HAS_THOUGHT_SUPPORT
        result2 = et_module._check_thought_support()

        assert result1 == result2
        assert result2 == cached_value

    @pytest.mark.asyncio
    async def test_thought_none_treated_as_non_thought(self, translator, mock_adk_event):
        """Test that thought=None is treated as non-thought content.

        Some SDK versions might return None instead of False for non-thought parts.
        """
        mock_content = MagicMock()
        mock_part = MagicMock()
        mock_part.text = "Regular response"
        mock_part.thought = None  # Explicitly None
        mock_content.parts = [mock_part]
        mock_adk_event.content = mock_content

        events = []
        async for event in translator.translate(mock_adk_event, "thread_1", "run_1"):
            events.append(event)

        # Should emit regular text events
        event_types = [type(e).__name__ for e in events]
        assert "TextMessageStartEvent" in event_types
        assert "TextMessageContentEvent" in event_types
        assert "ReasoningStartEvent" not in event_types

    @pytest.mark.asyncio
    async def test_thought_signature_emits_encrypted_value(self, translator, mock_adk_event):
        """Test that thought_signature on a part emits REASONING_ENCRYPTED_VALUE."""
        from ag_ui.core import (
            ReasoningStartEvent, ReasoningMessageStartEvent,
            ReasoningMessageContentEvent, ReasoningEncryptedValueEvent,
        )
        import base64

        # Create a part with thought=True and a thought_signature
        mock_content = MagicMock()
        mock_part = MagicMock()
        mock_part.text = "Let me reason about this..."
        mock_part.thought = True
        mock_part.thought_signature = b"\x01\x02\x03\x04"  # Opaque signature bytes
        mock_content.parts = [mock_part]
        mock_adk_event.content = mock_content

        events = []
        async for event in translator.translate(mock_adk_event, "thread_1", "run_1"):
            events.append(event)

        event_types = [type(e).__name__ for e in events]

        # Should have reasoning events
        assert "ReasoningStartEvent" in event_types
        assert "ReasoningMessageStartEvent" in event_types
        assert "ReasoningMessageContentEvent" in event_types

        # Should have encrypted value event
        assert "ReasoningEncryptedValueEvent" in event_types
        encrypted_event = [e for e in events if isinstance(e, ReasoningEncryptedValueEvent)][0]
        assert encrypted_event.subtype == "message"
        assert encrypted_event.encrypted_value == base64.b64encode(b"\x01\x02\x03\x04").decode("ascii")

    @pytest.mark.asyncio
    async def test_thought_signature_none_no_encrypted_value(self, translator, mock_adk_event):
        """Test that thought_signature=None does NOT emit REASONING_ENCRYPTED_VALUE."""
        from ag_ui.core import ReasoningEncryptedValueEvent

        mock_content = MagicMock()
        mock_part = MagicMock()
        mock_part.text = "Thinking without signature..."
        mock_part.thought = True
        mock_part.thought_signature = None  # No signature
        mock_content.parts = [mock_part]
        mock_adk_event.content = mock_content

        events = []
        async for event in translator.translate(mock_adk_event, "thread_1", "run_1"):
            events.append(event)

        # Should NOT have encrypted value event
        encrypted_events = [e for e in events if isinstance(e, ReasoningEncryptedValueEvent)]
        assert len(encrypted_events) == 0

    @pytest.mark.asyncio
    async def test_function_call_thought_signature_emits_tool_call_encrypted_value(
        self, translator, mock_adk_event
    ):
        """A thought_signature on a function_call part emits REASONING_ENCRYPTED_VALUE
        with subtype='tool-call'.

        Gemini attaches the thought signature to the function_call part (not to the
        thought-text part), so this is the path that surfaces encrypted reasoning for
        tool calls.
        """
        from ag_ui.core import ReasoningEncryptedValueEvent
        import base64

        fc = MagicMock()
        fc.id = "tool_call_1"
        fc.name = "get_weather"
        fc.args = {"city": "Valencia"}

        part = MagicMock()
        part.text = None  # function-call parts carry no text
        part.thought = None
        part.function_call = fc
        part.thought_signature = b"\x10\x20\x30"

        mock_content = MagicMock()
        mock_content.parts = [part]
        mock_adk_event.content = mock_content
        mock_adk_event.get_function_calls = MagicMock(return_value=[fc])
        mock_adk_event.get_function_responses = MagicMock(return_value=[])

        events = []
        async for event in translator.translate(mock_adk_event, "thread_1", "run_1"):
            events.append(event)

        encrypted = [e for e in events if isinstance(e, ReasoningEncryptedValueEvent)]
        assert len(encrypted) == 1
        assert encrypted[0].subtype == "tool-call"
        assert encrypted[0].entity_id == "tool_call_1"
        assert encrypted[0].encrypted_value == base64.b64encode(b"\x10\x20\x30").decode("ascii")

    @pytest.mark.asyncio
    async def test_function_call_without_signature_no_encrypted_value(
        self, translator, mock_adk_event
    ):
        """A function_call part without a thought_signature emits no encrypted value."""
        from ag_ui.core import ReasoningEncryptedValueEvent

        fc = MagicMock()
        fc.id = "tool_call_2"
        fc.name = "get_weather"
        fc.args = {"city": "Bilbao"}

        part = MagicMock()
        part.text = None
        part.thought = None
        part.function_call = fc
        part.thought_signature = None

        mock_content = MagicMock()
        mock_content.parts = [part]
        mock_adk_event.content = mock_content
        mock_adk_event.get_function_calls = MagicMock(return_value=[fc])
        mock_adk_event.get_function_responses = MagicMock(return_value=[])

        events = []
        async for event in translator.translate(mock_adk_event, "thread_1", "run_1"):
            events.append(event)

        assert [e for e in events if isinstance(e, ReasoningEncryptedValueEvent)] == []

    @pytest.mark.asyncio
    async def test_streaming_none_mode_partial_false_thought_emits_reasoning(self, translator, mock_adk_event):
        """StreamingMode.NONE regression: a single partial=False event carrying thought
        parts must still emit REASONING events when no prior streaming has occurred.

        The naive fix (block all partial=False thought events) broke this path because
        StreamingMode.NONE yields exactly one partial=False event as the only copy of the
        thought. The correct guard checks _is_streaming_reasoning, not just partial.
        """
        from ag_ui.core import (
            ReasoningStartEvent, ReasoningMessageStartEvent,
            ReasoningMessageContentEvent,
        )

        # No prior events — _is_streaming_reasoning starts False (NONE mode)
        assert translator._is_streaming_reasoning is False

        mock_content = MagicMock()
        mock_part = MagicMock()
        mock_part.text = "Let me reason step by step."
        mock_part.thought = True
        mock_part.thought_signature = None
        mock_content.parts = [mock_part]
        mock_adk_event.content = mock_content
        mock_adk_event.partial = False  # StreamingMode.NONE sends partial=False

        events = []
        async for event in translator.translate(mock_adk_event, "thread_1", "run_1"):
            events.append(event)

        event_types = [type(e).__name__ for e in events]
        assert "ReasoningStartEvent" in event_types, \
            "StreamingMode.NONE thought must emit ReasoningStartEvent"
        assert "ReasoningMessageStartEvent" in event_types
        content_events = [e for e in events if isinstance(e, ReasoningMessageContentEvent)]
        assert len(content_events) == 1
        assert content_events[0].delta == "Let me reason step by step."

    @pytest.mark.asyncio
    async def test_streaming_mode_final_aggregate_thought_not_duplicated(self, translator, mock_adk_event):
        """Dedup regression: after partial=True thought chunks open a reasoning stream,
        the final partial=False aggregate event must not re-emit REASONING content.

        ADK emits all streamed thought text again in the closing aggregate event.
        The guard must fire (was_already_reasoning=True, is_partial=False) and suppress it.
        """
        from ag_ui.core import ReasoningMessageContentEvent

        # --- first event: partial=True thought chunk opens the reasoning stream ---
        mock_content = MagicMock()
        thought_part = MagicMock()
        thought_part.text = "Let me reason step by step."
        thought_part.thought = True
        thought_part.thought_signature = None
        mock_content.parts = [thought_part]
        mock_adk_event.content = mock_content
        mock_adk_event.partial = True

        first_events = []
        async for event in translator.translate(mock_adk_event, "thread_1", "run_1"):
            first_events.append(event)

        assert translator._is_streaming_reasoning is True, \
            "Reasoning stream must be open after partial=True thought chunk"
        assert any(isinstance(e, ReasoningMessageContentEvent) for e in first_events)

        # --- second event: partial=False aggregate re-containing the full thought ---
        mock_adk_event.partial = False

        second_events = []
        async for event in translator.translate(mock_adk_event, "thread_1", "run_1"):
            second_events.append(event)

        duplicate_content = [e for e in second_events if isinstance(e, ReasoningMessageContentEvent)]
        assert len(duplicate_content) == 0, \
            "Final aggregate must not re-emit ReasoningMessageContentEvent (duplicate)"
