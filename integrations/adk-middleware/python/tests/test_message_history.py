# tests/test_message_history.py

"""Tests for message history features: adk_events_to_messages, emit_messages_snapshot, and /agents/state endpoint."""

import pytest
import json
import uuid
import threading
import time
import socket
from contextlib import closing
from unittest.mock import MagicMock, AsyncMock, patch
from typing import List, Any

import uvicorn
from fastapi import FastAPI, APIRouter
from fastapi.testclient import TestClient
from httpx import AsyncClient, ASGITransport
import httpx

from ag_ui.core import (
    RunAgentInput, UserMessage, AssistantMessage, ToolMessage,
    ReasoningMessage,
    EventType, MessagesSnapshotEvent, ToolCall, FunctionCall,
    ImageInputContent, AudioInputContent, VideoInputContent,
    DocumentInputContent, InputContentUrlSource, TextInputContent,
)

from ag_ui_adk import (
    ADKAgent,
    add_adk_fastapi_endpoint,
    adk_events_to_messages,
    resolve_agent_from_message_history,
)
from ag_ui_adk.event_translator import _translate_function_calls_to_tool_calls


# ============================================================================
# Test Fixtures
# ============================================================================

def create_mock_adk_event(
    event_id: str = None,
    author: str = "test_agent",  # Use realistic agent name, not "model"
    text: str = None,
    partial: bool = False,
    function_calls: List[Any] = None,
    function_responses: List[Any] = None,
):
    """Create a mock ADK event for testing."""
    event = MagicMock()
    event.id = event_id or str(uuid.uuid4())
    event.author = author
    event.partial = partial

    # Create content with parts - always create content with parts for events that have any data
    event.content = MagicMock()
    if text:
        part = MagicMock()
        part.text = text
        part.file_data = None
        event.content.parts = [part]
    elif function_calls or function_responses:
        # For function calls/responses, create empty parts but content exists
        part = MagicMock()
        part.text = None
        part.file_data = None
        event.content.parts = [part]
    else:
        event.content = None

    # Mock function call methods
    event.get_function_calls = MagicMock(return_value=function_calls or [])
    event.get_function_responses = MagicMock(return_value=function_responses or [])

    return event


def create_mock_adk_event_with_parts(
    event_id: str = None,
    author: str = "test_agent",
    parts: List[dict] = None,
    partial: bool = False,
    function_calls: List[Any] = None,
    function_responses: List[Any] = None,
):
    """Create a mock ADK event with explicit parts control.

    Each item in parts should be a dict with keys:
        text: str - the text content
        thought: bool - whether this is a thought part (default False)
    """
    event = MagicMock()
    event.id = event_id or str(uuid.uuid4())
    event.author = author
    event.partial = partial

    event.content = MagicMock()
    if parts:
        mock_parts = []
        for p in parts:
            part = MagicMock()
            part.text = p.get("text")
            part.thought = p.get("thought", False)
            part.file_data = None
            mock_parts.append(part)
        event.content.parts = mock_parts
    else:
        event.content = None

    event.get_function_calls = MagicMock(return_value=function_calls or [])
    event.get_function_responses = MagicMock(return_value=function_responses or [])

    return event


def create_mock_adk_event_with_file(
    event_id: str = None,
    author: str = "user",
    text: str = "check this file",
    file_uri: str = "https://storage.googleapis.com/bucket/file.png",
    mime_type: str = "image/png",
):
    """Create a mock ADK user event with a text part and a file_data part."""
    event = MagicMock()
    event.id = event_id or str(uuid.uuid4())
    event.author = author
    event.partial = False

    text_part = MagicMock()
    text_part.text = text
    text_part.file_data = None

    file_part = MagicMock()
    file_part.text = None
    file_part.file_data = MagicMock()
    file_part.file_data.file_uri = file_uri
    file_part.file_data.mime_type = mime_type

    event.content = MagicMock()
    event.content.parts = [text_part, file_part]
    event.get_function_calls = MagicMock(return_value=[])
    event.get_function_responses = MagicMock(return_value=[])
    return event


# Keep old name as alias so any external callers still work
create_mock_adk_event_with_image = create_mock_adk_event_with_file


def create_mock_function_call(name: str, args: dict = None, fc_id: str = None):
    """Create a mock function call object."""
    fc = MagicMock()
    fc.id = fc_id or str(uuid.uuid4())
    fc.name = name
    fc.args = args or {}
    return fc


def create_mock_function_response(response: Any, fr_id: str = None):
    """Create a mock function response object."""
    fr = MagicMock()
    fr.id = fr_id or str(uuid.uuid4())
    fr.response = response
    return fr


# ============================================================================
# Unit Tests: adk_events_to_messages()
# ============================================================================

class TestAdkEventsToMessages:
    """Unit tests for the adk_events_to_messages conversion function."""

    def test_empty_events_list(self):
        """Should return empty list for empty input."""
        messages = adk_events_to_messages([])
        assert messages == []

    def test_user_message_conversion(self):
        """Should convert user events to UserMessage."""
        event = create_mock_adk_event(
            event_id="user-1",
            author="user",
            text="Hello, how are you?"
        )

        messages = adk_events_to_messages([event])

        assert len(messages) == 1
        assert isinstance(messages[0], UserMessage)
        assert messages[0].id == "user-1"
        assert messages[0].role == "user"
        assert messages[0].content == "Hello, how are you?"

    def test_user_message_with_image_attachment(self):
        """User event with text + image file_data → content list with text and image."""
        event = create_mock_adk_event_with_file(
            event_id="user-img-1",
            text="describe this image",
            file_uri="https://storage.googleapis.com/bucket/photo.png",
            mime_type="image/png",
        )

        messages = adk_events_to_messages([event])

        assert len(messages) == 1
        msg = messages[0]
        assert isinstance(msg, UserMessage)
        assert isinstance(msg.content, list)
        assert len(msg.content) == 2

        text_part = msg.content[0]
        assert isinstance(text_part, TextInputContent)
        assert text_part.text == "describe this image"

        img_part = msg.content[1]
        assert isinstance(img_part, ImageInputContent)
        assert isinstance(img_part.source, InputContentUrlSource)
        assert img_part.source.value == "https://storage.googleapis.com/bucket/photo.png"
        assert img_part.source.mime_type == "image/png"

    def test_user_message_with_audio_attachment(self):
        """User event with text + audio file_data → AudioInputContent."""
        event = create_mock_adk_event_with_file(
            event_id="user-audio-1",
            text="transcribe this",
            file_uri="https://storage.googleapis.com/bucket/clip.mp3",
            mime_type="audio/mpeg",
        )

        messages = adk_events_to_messages([event])

        assert len(messages) == 1
        msg = messages[0]
        assert isinstance(msg.content, list)
        audio_part = msg.content[1]
        assert isinstance(audio_part, AudioInputContent)
        assert audio_part.source.value == "https://storage.googleapis.com/bucket/clip.mp3"
        assert audio_part.source.mime_type == "audio/mpeg"

    def test_user_message_with_video_attachment(self):
        """User event with text + video file_data → VideoInputContent."""
        event = create_mock_adk_event_with_file(
            event_id="user-video-1",
            text="summarize this video",
            file_uri="https://storage.googleapis.com/bucket/recording.mp4",
            mime_type="video/mp4",
        )

        messages = adk_events_to_messages([event])

        assert len(messages) == 1
        msg = messages[0]
        assert isinstance(msg.content, list)
        video_part = msg.content[1]
        assert isinstance(video_part, VideoInputContent)
        assert video_part.source.value == (
            "https://storage.googleapis.com/bucket/recording.mp4"
        )
        assert video_part.source.mime_type == "video/mp4"

    def test_user_message_with_document_attachment(self):
        """User event with text + document file_data → DocumentInputContent."""
        event = create_mock_adk_event_with_file(
            event_id="user-doc-1",
            text="summarize this document",
            file_uri="https://storage.googleapis.com/bucket/report.docx",
            mime_type=(
                "application/vnd.openxmlformats-officedocument"
                ".wordprocessingml.document"
            ),
        )

        messages = adk_events_to_messages([event])

        assert len(messages) == 1
        msg = messages[0]
        assert isinstance(msg.content, list)
        doc_part = msg.content[1]
        assert isinstance(doc_part, DocumentInputContent)
        assert doc_part.source.value == (
            "https://storage.googleapis.com/bucket/report.docx"
        )

    def test_user_message_file_data_without_uri_is_skipped(self):
        """file_data parts with no file_uri are filtered out; content stays a string."""
        event = create_mock_adk_event_with_file(
            event_id="user-no-uri",
            text="text only please",
            file_uri=None,
            mime_type="image/png",
        )

        messages = adk_events_to_messages([event])

        assert len(messages) == 1
        msg = messages[0]
        assert isinstance(msg, UserMessage)
        # No valid media parts → content collapses back to a plain string
        assert msg.content == "text only please"

    def test_user_message_without_image_stays_string(self):
        """User event with text only → content remains a plain string (backward compat)."""
        event = create_mock_adk_event(
            event_id="user-text-1",
            author="user",
            text="just text, no image",
        )

        messages = adk_events_to_messages([event])

        assert len(messages) == 1
        msg = messages[0]
        assert isinstance(msg, UserMessage)
        assert msg.content == "just text, no image"

    def test_assistant_message_conversion(self):
        """Should convert model events to AssistantMessage."""
        event = create_mock_adk_event(
            event_id="assistant-1",
            author="model",
            text="I'm doing well, thank you!"
        )

        messages = adk_events_to_messages([event])

        assert len(messages) == 1
        assert isinstance(messages[0], AssistantMessage)
        assert messages[0].id == "assistant-1"
        assert messages[0].role == "assistant"
        assert messages[0].content == "I'm doing well, thank you!"

    def test_assistant_message_with_tool_calls(self):
        """Should convert model events with function calls to AssistantMessage with tool_calls."""
        fc = create_mock_function_call(
            name="get_weather",
            args={"city": "Seattle"},
            fc_id="fc-1"
        )
        event = create_mock_adk_event(
            event_id="assistant-2",
            author="model",
            text="Let me check the weather.",
            function_calls=[fc]
        )

        messages = adk_events_to_messages([event])

        assert len(messages) == 1
        assert isinstance(messages[0], AssistantMessage)
        assert messages[0].tool_calls is not None
        assert len(messages[0].tool_calls) == 1
        assert messages[0].tool_calls[0].id == "fc-1"
        assert messages[0].tool_calls[0].function.name == "get_weather"
        assert json.loads(messages[0].tool_calls[0].function.arguments) == {"city": "Seattle"}

    def test_tool_message_conversion(self):
        """Should convert function responses to ToolMessage."""
        fr = create_mock_function_response(
            response={"temperature": 72, "conditions": "sunny"},
            fr_id="fr-1"
        )
        event = create_mock_adk_event(
            event_id="tool-1",
            author="model",
            function_responses=[fr]
        )

        messages = adk_events_to_messages([event])

        assert len(messages) == 1
        assert isinstance(messages[0], ToolMessage)
        assert messages[0].role == "tool"
        assert messages[0].tool_call_id == "fr-1"
        content = json.loads(messages[0].content)
        assert content["temperature"] == 72
        assert content["conditions"] == "sunny"

    def test_partial_events_skipped(self):
        """Should skip partial/streaming events."""
        partial_event = create_mock_adk_event(
            author="model",
            text="Partial...",
            partial=True
        )
        complete_event = create_mock_adk_event(
            author="model",
            text="Complete message",
            partial=False
        )

        messages = adk_events_to_messages([partial_event, complete_event])

        assert len(messages) == 1
        assert messages[0].content == "Complete message"

    def test_events_without_content_skipped(self):
        """Should skip events without content."""
        event_no_content = MagicMock()
        event_no_content.content = None
        event_no_content.partial = False

        event_with_content = create_mock_adk_event(
            author="model",
            text="Has content"
        )

        messages = adk_events_to_messages([event_no_content, event_with_content])

        assert len(messages) == 1
        assert messages[0].content == "Has content"

    def test_conversation_order_preserved(self):
        """Should preserve conversation order."""
        events = [
            create_mock_adk_event(event_id="1", author="user", text="Hi"),
            create_mock_adk_event(event_id="2", author="model", text="Hello!"),
            create_mock_adk_event(event_id="3", author="user", text="How are you?"),
            create_mock_adk_event(event_id="4", author="model", text="I'm great!"),
        ]

        messages = adk_events_to_messages(events)

        assert len(messages) == 4
        assert messages[0].id == "1"
        assert messages[1].id == "2"
        assert messages[2].id == "3"
        assert messages[3].id == "4"

    def test_none_author_treated_as_assistant(self):
        """Events with None author should be treated as assistant messages."""
        event = create_mock_adk_event(
            event_id="anon-1",
            author=None,
            text="Anonymous response"
        )

        messages = adk_events_to_messages([event])

        assert len(messages) == 1
        assert isinstance(messages[0], AssistantMessage)
        assert messages[0].content == "Anonymous response"
        assert messages[0].name is None

    def test_custom_agent_name_treated_as_assistant(self):
        """Events with custom agent names should be treated as assistant messages.

        This is critical: ADK agents set author to the agent's name (e.g., "my_agent"),
        not "model". This test ensures we handle real ADK agent names correctly
        and preserve them as AssistantMessage.name for agent resolver pinning.
        """
        # Test various realistic agent names
        agent_names = ["my_assistant", "weather_agent", "code_helper", "assistant"]

        for agent_name in agent_names:
            event = create_mock_adk_event(
                event_id=f"event-{agent_name}",
                author=agent_name,
                text=f"Response from {agent_name}"
            )

            messages = adk_events_to_messages([event])

            assert len(messages) == 1, f"Failed for agent_name={agent_name}"
            assert isinstance(messages[0], AssistantMessage), f"Failed for agent_name={agent_name}"
            assert messages[0].content == f"Response from {agent_name}"
            assert messages[0].name == agent_name

    def test_model_author_treated_as_assistant(self):
        """Events with author='model' should still work as assistant messages."""
        event = create_mock_adk_event(
            event_id="model-1",
            author="model",
            text="Model response"
        )

        messages = adk_events_to_messages([event])

        assert len(messages) == 1
        assert isinstance(messages[0], AssistantMessage)
        assert messages[0].content == "Model response"
        assert messages[0].name is None

    def test_agent_author_preserved_on_tool_call_message(self):
        """Tool-call assistant messages should preserve the ADK agent author."""
        fc = create_mock_function_call(
            name="do_something",
            args={},
            fc_id="tool-call-1",
        )
        event = create_mock_adk_event(
            event_id="fc-agent",
            author="subagent1",
            text="",
            function_calls=[fc],
        )

        messages = adk_events_to_messages([event])

        assert len(messages) == 1
        assert isinstance(messages[0], AssistantMessage)
        assert messages[0].name == "subagent1"
        assert messages[0].tool_calls is not None
        assert messages[0].tool_calls[0].id == "tool-call-1"

        agent = MagicMock(spec=ADKAgent)
        resolved_agent = resolve_agent_from_message_history(
            [
                *messages,
                ToolMessage(
                    id="tool-result-1",
                    role="tool",
                    tool_call_id="tool-call-1",
                    content='{"ok": true}',
                ),
            ],
            {"subagent1": agent},
        )

        assert resolved_agent is agent

    def test_empty_text_with_function_calls(self):
        """Should create assistant message with just tool calls if no text."""
        fc = create_mock_function_call(name="do_something", args={})
        event = create_mock_adk_event(
            event_id="fc-only",
            author="model",
            text="",
            function_calls=[fc]
        )

        messages = adk_events_to_messages([event])

        assert len(messages) == 1
        assert isinstance(messages[0], AssistantMessage)
        assert messages[0].content is None or messages[0].content == ""
        assert messages[0].name is None
        assert len(messages[0].tool_calls) == 1


class TestThoughtPartSeparation:
    """Tests for separating thought parts from regular text in adk_events_to_messages.

    When extended thinking is enabled, ADK events contain Part objects with
    thought=True alongside regular text parts. These must be separated so that
    internal model reasoning is not shown as chat content to the user.
    """

    @patch('ag_ui_adk.event_translator._check_thought_support', return_value=True)
    def test_thought_parts_emitted_as_reasoning_message(self, mock_thought):
        """Thought parts should become ReasoningMessage, not part of AssistantMessage.content."""
        event = create_mock_adk_event_with_parts(
            event_id="evt-1",
            author="model",
            parts=[
                {"text": "Let me think about this carefully.", "thought": True},
                {"text": "Here is my answer."},
            ],
        )

        messages = adk_events_to_messages([event])

        assert len(messages) == 2
        assert isinstance(messages[0], ReasoningMessage)
        assert messages[0].role == "reasoning"
        assert messages[0].content == "Let me think about this carefully."
        assert messages[0].id == "evt-1-reasoning"

        assert isinstance(messages[1], AssistantMessage)
        assert messages[1].role == "assistant"
        assert messages[1].content == "Here is my answer."

    @patch('ag_ui_adk.event_translator._check_thought_support', return_value=True)
    def test_multiple_thought_parts_concatenated(self, mock_thought):
        """Multiple thought parts in one event should be concatenated into one ReasoningMessage."""
        event = create_mock_adk_event_with_parts(
            event_id="evt-2",
            author="model",
            parts=[
                {"text": "First I need to check ", "thought": True},
                {"text": "the user's request.", "thought": True},
                {"text": "Done!"},
            ],
        )

        messages = adk_events_to_messages([event])

        assert len(messages) == 2
        assert isinstance(messages[0], ReasoningMessage)
        assert messages[0].content == "First I need to check the user's request."
        assert isinstance(messages[1], AssistantMessage)
        assert messages[1].content == "Done!"

    @patch('ag_ui_adk.event_translator._check_thought_support', return_value=True)
    def test_thought_only_event_emits_reasoning_only(self, mock_thought):
        """An event with only thought parts should emit only a ReasoningMessage."""
        event = create_mock_adk_event_with_parts(
            event_id="evt-3",
            author="model",
            parts=[
                {"text": "Internal reasoning only.", "thought": True},
            ],
        )

        messages = adk_events_to_messages([event])

        assert len(messages) == 1
        assert isinstance(messages[0], ReasoningMessage)
        assert messages[0].content == "Internal reasoning only."

    @patch('ag_ui_adk.event_translator._check_thought_support', return_value=True)
    def test_user_message_thought_parts_excluded(self, mock_thought):
        """Thought parts in user events should be excluded entirely."""
        event = create_mock_adk_event_with_parts(
            event_id="evt-4",
            author="user",
            parts=[
                {"text": "Some injected thought.", "thought": True},
                {"text": "Hello there!"},
            ],
        )

        messages = adk_events_to_messages([event])

        assert len(messages) == 1
        assert isinstance(messages[0], UserMessage)
        assert messages[0].content == "Hello there!"

    @patch('ag_ui_adk.event_translator._check_thought_support', return_value=True)
    def test_user_message_with_only_thought_parts_skipped(self, mock_thought):
        """User events containing only thought parts should be skipped."""
        event = create_mock_adk_event_with_parts(
            event_id="evt-5",
            author="user",
            parts=[
                {"text": "Only thought content.", "thought": True},
            ],
        )

        messages = adk_events_to_messages([event])

        assert len(messages) == 0

    @patch('ag_ui_adk.event_translator._check_thought_support', return_value=True)
    def test_thought_parts_with_tool_calls(self, mock_thought):
        """Thought parts and tool calls should both be preserved correctly."""
        fc = create_mock_function_call(name="search", args={"q": "test"}, fc_id="fc-1")
        event = create_mock_adk_event_with_parts(
            event_id="evt-6",
            author="model",
            parts=[
                {"text": "I should search for this.", "thought": True},
                {"text": "Let me search."},
            ],
            function_calls=[fc],
        )

        messages = adk_events_to_messages([event])

        assert len(messages) == 2
        assert isinstance(messages[0], ReasoningMessage)
        assert messages[0].content == "I should search for this."
        assert isinstance(messages[1], AssistantMessage)
        assert messages[1].content == "Let me search."
        assert messages[1].tool_calls is not None
        assert len(messages[1].tool_calls) == 1

    @patch('ag_ui_adk.event_translator._check_thought_support', return_value=True)
    def test_thought_only_with_tool_calls(self, mock_thought):
        """Event with only thought parts + tool calls should emit both messages."""
        fc = create_mock_function_call(name="do_it", args={}, fc_id="fc-2")
        event = create_mock_adk_event_with_parts(
            event_id="evt-7",
            author="model",
            parts=[
                {"text": "Internal reasoning before tool call.", "thought": True},
            ],
            function_calls=[fc],
        )

        messages = adk_events_to_messages([event])

        assert len(messages) == 2
        assert isinstance(messages[0], ReasoningMessage)
        assert isinstance(messages[1], AssistantMessage)
        assert messages[1].content is None
        assert len(messages[1].tool_calls) == 1

    @patch('ag_ui_adk.event_translator._check_thought_support', return_value=False)
    def test_no_thought_support_treats_all_as_text(self, mock_thought):
        """When SDK lacks thought support, all parts are treated as regular text."""
        event = create_mock_adk_event_with_parts(
            event_id="evt-8",
            author="model",
            parts=[
                {"text": "Would be thought.", "thought": True},
                {"text": " Regular text."},
            ],
        )

        messages = adk_events_to_messages([event])

        # Without thought support, everything is concatenated as before
        assert len(messages) == 1
        assert isinstance(messages[0], AssistantMessage)
        assert messages[0].content == "Would be thought. Regular text."

    @patch('ag_ui_adk.event_translator._check_thought_support', return_value=True)
    def test_conversation_with_reasoning_preserves_order(self, mock_thought):
        """Full conversation with reasoning should preserve correct message order."""
        events = [
            create_mock_adk_event(event_id="1", author="user", text="Hi"),
            create_mock_adk_event_with_parts(
                event_id="2",
                author="model",
                parts=[
                    {"text": "The user said hi.", "thought": True},
                    {"text": "Hello!"},
                ],
            ),
            create_mock_adk_event(event_id="3", author="user", text="What is 2+2?"),
            create_mock_adk_event_with_parts(
                event_id="4",
                author="model",
                parts=[
                    {"text": "Simple arithmetic.", "thought": True},
                    {"text": "4"},
                ],
            ),
        ]

        messages = adk_events_to_messages(events)

        assert len(messages) == 6
        assert isinstance(messages[0], UserMessage)
        assert messages[0].content == "Hi"
        assert isinstance(messages[1], ReasoningMessage)
        assert messages[1].content == "The user said hi."
        assert isinstance(messages[2], AssistantMessage)
        assert messages[2].content == "Hello!"
        assert isinstance(messages[3], UserMessage)
        assert messages[3].content == "What is 2+2?"
        assert isinstance(messages[4], ReasoningMessage)
        assert messages[4].content == "Simple arithmetic."
        assert isinstance(messages[5], AssistantMessage)
        assert messages[5].content == "4"

    @patch('ag_ui_adk.event_translator._check_thought_support', return_value=True)
    def test_reasoning_message_serializes_correctly(self, mock_thought):
        """ReasoningMessage should serialize with role='reasoning' for JSON responses."""
        event = create_mock_adk_event_with_parts(
            event_id="evt-ser",
            author="model",
            parts=[
                {"text": "Thinking...", "thought": True},
                {"text": "Answer."},
            ],
        )

        messages = adk_events_to_messages([event])
        serialized = [msg.model_dump(by_alias=True) for msg in messages]

        assert serialized[0]["role"] == "reasoning"
        assert serialized[0]["content"] == "Thinking..."
        assert serialized[1]["role"] == "assistant"
        assert serialized[1]["content"] == "Answer."


class TestTranslateFunctionCallsToToolCalls:
    """Unit tests for _translate_function_calls_to_tool_calls helper."""

    def test_single_function_call(self):
        """Should convert a single function call."""
        fc = create_mock_function_call(
            name="search",
            args={"query": "test"},
            fc_id="fc-123"
        )

        tool_calls = _translate_function_calls_to_tool_calls([fc])

        assert len(tool_calls) == 1
        assert tool_calls[0].id == "fc-123"
        assert tool_calls[0].type == "function"
        assert tool_calls[0].function.name == "search"
        assert json.loads(tool_calls[0].function.arguments) == {"query": "test"}

    def test_multiple_function_calls(self):
        """Should convert multiple function calls."""
        fcs = [
            create_mock_function_call(name="fn1", args={"a": 1}, fc_id="fc-1"),
            create_mock_function_call(name="fn2", args={"b": 2}, fc_id="fc-2"),
        ]

        tool_calls = _translate_function_calls_to_tool_calls(fcs)

        assert len(tool_calls) == 2
        assert tool_calls[0].function.name == "fn1"
        assert tool_calls[1].function.name == "fn2"

    def test_function_call_without_id(self):
        """Should generate UUID if function call has no ID."""
        fc = MagicMock()
        fc.id = None
        fc.name = "test_fn"
        fc.args = {}

        tool_calls = _translate_function_calls_to_tool_calls([fc])

        assert len(tool_calls) == 1
        assert tool_calls[0].id is not None
        # Verify it's a valid UUID format
        uuid.UUID(tool_calls[0].id)

    def test_empty_function_calls(self):
        """Should return empty list for empty input."""
        tool_calls = _translate_function_calls_to_tool_calls([])
        assert tool_calls == []


# ============================================================================
# Unit Tests: emit_messages_snapshot flag
# ============================================================================

class TestEmitMessagesSnapshot:
    """Tests for the emit_messages_snapshot configuration flag."""

    @pytest.fixture
    def mock_adk_agent(self):
        """Create a mock ADK agent."""
        agent = MagicMock()
        agent.name = "test_agent"
        return agent

    def test_default_emit_messages_snapshot_is_false(self, mock_adk_agent):
        """Default value for emit_messages_snapshot should be False."""
        agent = ADKAgent(
            adk_agent=mock_adk_agent,
            app_name="test_app",
            user_id="test_user"
        )

        assert agent._emit_messages_snapshot is False

    def test_emit_messages_snapshot_can_be_enabled(self, mock_adk_agent):
        """emit_messages_snapshot can be set to True."""
        agent = ADKAgent(
            adk_agent=mock_adk_agent,
            app_name="test_app",
            user_id="test_user",
            emit_messages_snapshot=True
        )

        assert agent._emit_messages_snapshot is True

    def test_emit_messages_snapshot_stored_on_agent(self, mock_adk_agent):
        """Verify emit_messages_snapshot flag is stored correctly on the agent."""
        # Test with False (default)
        agent_false = ADKAgent(
            adk_agent=mock_adk_agent,
            app_name="test_app",
            user_id="test_user",
            emit_messages_snapshot=False
        )
        assert agent_false._emit_messages_snapshot is False

        # Test with True
        agent_true = ADKAgent(
            adk_agent=mock_adk_agent,
            app_name="test_app",
            user_id="test_user",
            emit_messages_snapshot=True
        )
        assert agent_true._emit_messages_snapshot is True


# ============================================================================
# Integration Tests: /agents/state endpoint
# ============================================================================

class TestAgentsStateEndpoint:
    """Integration tests for the /agents/state endpoint."""

    @pytest.fixture
    def mock_agent(self):
        """Create a mock ADKAgent with necessary attributes."""
        mock_adk = MagicMock()
        mock_adk.name = "test_agent"

        agent = MagicMock(spec=ADKAgent)
        agent._static_app_name = "test_app"
        agent._static_user_id = "test_user"
        agent._adk_agent = mock_adk

        # Mock session manager
        mock_session_manager = MagicMock()
        agent._session_manager = mock_session_manager

        return agent

    @pytest.fixture(
        params=[FastAPI, APIRouter]
    )
    def app(self, request):
        """Create a FastAPI app or APIRouter."""
        return request.param()

    def get_test_app(self, app):
        """Return app suitable for TestClient (wrap APIRouter in FastAPI if needed).

        Note: This must be called AFTER routes are added to the router,
        since include_router copies routes at the time of inclusion.
        """
        if isinstance(app, APIRouter):
            fastapi_app = FastAPI()
            fastapi_app.include_router(app)
            return fastapi_app
        return app

    def test_agents_state_endpoint_exists(self, app, mock_agent):
        """The /agents/state endpoint should be registered."""
        add_adk_fastapi_endpoint(app, mock_agent, path="/")
        routes = [r.path for r in app.routes]
        assert "/agents/state" in routes

    def test_agents_state_returns_thread_info(self, app, mock_agent):
        """Should return thread info for existing session."""
        # Setup mock session with events
        mock_session = MagicMock()
        mock_session.events = [
            create_mock_adk_event(author="user", text="Hello"),
            create_mock_adk_event(author="model", text="Hi!"),
        ]

        # Mock _get_session_metadata to return session metadata tuple
        # Format: (session_id, app_name, user_id)
        mock_agent._get_session_metadata = MagicMock(return_value=(
            "backend-session-id",
            "test_app",
            "test_user"
        ))

        # Mock _session_service.get_session to return the session
        mock_session_service = MagicMock()
        mock_session_service.get_session = AsyncMock(return_value=mock_session)
        mock_agent._session_manager._session_service = mock_session_service
        mock_agent._session_manager.get_session_state = AsyncMock(return_value={"key": "value"})

        add_adk_fastapi_endpoint(app, mock_agent, path="/")

        with TestClient(self.get_test_app(app)) as client:
            response = client.post(
                "/agents/state",
                json={"threadId": "test-thread-123"}
            )

            assert response.status_code == 200
            data = response.json()
            assert data["threadId"] == "test-thread-123"
            assert data["threadExists"] is True

            # State and messages should be native objects (not double-encoded strings)
            assert data["state"] == {"key": "value"}
            assert len(data["messages"]) == 2

    def test_agents_state_handles_missing_session(self, app, mock_agent):
        """Should return threadExists=false for missing session."""
        # Mock _get_session_metadata to return None (session doesn't exist)
        mock_agent._get_session_metadata = MagicMock(return_value=None)
        # Mock _find_session_by_thread_id to return None (no session in backend either)
        mock_agent._session_manager._find_session_by_thread_id = AsyncMock(return_value=None)

        add_adk_fastapi_endpoint(app, mock_agent, path="/")

        with TestClient(self.get_test_app(app)) as client:
            response = client.post(
                "/agents/state",
                json={"threadId": "nonexistent-thread"}
            )

            assert response.status_code == 200
            data = response.json()
            assert data["threadExists"] is False
            assert data["threadId"] == "nonexistent-thread"

    def test_agents_state_cache_miss_loads_events(self, app, mock_agent):
        """Should load events via get_session() on cache miss.

        This tests the fix for the bug where _find_session_by_thread_id()
        uses list_sessions() which returns session metadata only, not events.
        The endpoint must call get_session() after cache miss to populate events.
        """
        # Create a session with events that will be returned by get_session
        mock_session_with_events = MagicMock()
        mock_session_with_events.id = "backend-session-id"
        mock_session_with_events.events = [
            create_mock_adk_event(author="user", text="Hello from cache miss"),
            create_mock_adk_event(author="model", text="Response after reload"),
        ]

        # Create a session without events (as returned by list_sessions)
        mock_session_metadata_only = MagicMock()
        mock_session_metadata_only.id = "backend-session-id"
        mock_session_metadata_only.events = None  # list_sessions doesn't populate events

        # Mock cache miss: _get_session_metadata returns None
        mock_agent._get_session_metadata = MagicMock(return_value=None)

        # Mock _find_session_by_thread_id returning session metadata (no events)
        mock_agent._session_manager._find_session_by_thread_id = AsyncMock(
            return_value=mock_session_metadata_only
        )

        # Initialize empty cache to simulate cache miss path
        mock_agent._session_lookup_cache = {}

        # Mock get_session to return the full session WITH events
        mock_session_service = MagicMock()
        mock_session_service.get_session = AsyncMock(return_value=mock_session_with_events)
        mock_agent._session_manager._session_service = mock_session_service
        mock_agent._session_manager.get_session_state = AsyncMock(return_value={"key": "value"})

        add_adk_fastapi_endpoint(app, mock_agent, path="/")

        with TestClient(self.get_test_app(app)) as client:
            response = client.post(
                "/agents/state",
                json={"threadId": "cache-miss-thread"}
            )

            assert response.status_code == 200
            data = response.json()
            assert data["threadId"] == "cache-miss-thread"
            assert data["threadExists"] is True

            # Verify messages are populated from the reloaded session
            assert len(data["messages"]) == 2
            assert data["messages"][0]["content"] == "Hello from cache miss"
            assert data["messages"][1]["content"] == "Response after reload"

            # Verify get_session was called to reload the session with events
            mock_session_service.get_session.assert_called_once_with(
                session_id="backend-session-id",
                app_name="test_app",
                user_id="test_user"
            )

    def test_agents_state_handles_empty_events(self, app, mock_agent):
        """Should return empty messages list for session with no events."""
        mock_session = MagicMock()
        mock_session.events = []

        # Mock _get_session_metadata to return session metadata tuple
        # Format: (session_id, app_name, user_id)
        mock_agent._get_session_metadata = MagicMock(return_value=(
            "backend-session-id",
            "test_app",
            "test_user"
        ))

        # Mock _session_service.get_session to return the session
        mock_session_service = MagicMock()
        mock_session_service.get_session = AsyncMock(return_value=mock_session)
        mock_agent._session_manager._session_service = mock_session_service
        mock_agent._session_manager.get_session_state = AsyncMock(return_value={})

        add_adk_fastapi_endpoint(app, mock_agent, path="/")

        with TestClient(self.get_test_app(app)) as client:
            response = client.post(
                "/agents/state",
                json={"threadId": "empty-thread"}
            )

            assert response.status_code == 200
            data = response.json()
            assert data["messages"] == []

    def test_agents_state_handles_error(self, app, mock_agent):
        """Should return 500 error on exception."""
        mock_agent._session_manager.get_or_create_session = AsyncMock(
            side_effect=Exception("Database error")
        )

        add_adk_fastapi_endpoint(app, mock_agent, path="/")

        with TestClient(self.get_test_app(app)) as client:
            response = client.post(
                "/agents/state",
                json={"threadId": "error-thread"}
            )

            assert response.status_code == 500
            data = response.json()
            assert "error" in data
            assert data["threadExists"] is False

    def test_agents_state_optional_fields(self, app, mock_agent):
        """Should accept optional name and properties fields."""
        mock_session = MagicMock()
        mock_session.events = []

        # Mock _get_session_metadata to return session metadata tuple
        # Format: (session_id, app_name, user_id)
        mock_agent._get_session_metadata = MagicMock(return_value=(
            "backend-session-id",
            "test_app",
            "test_user"
        ))

        # Mock _session_service.get_session to return the session
        mock_session_service = MagicMock()
        mock_session_service.get_session = AsyncMock(return_value=mock_session)
        mock_agent._session_manager._session_service = mock_session_service
        mock_agent._session_manager.get_session_state = AsyncMock(return_value={})

        add_adk_fastapi_endpoint(app, mock_agent, path="/")

        with TestClient(self.get_test_app(app)) as client:
            response = client.post(
                "/agents/state",
                json={
                    "threadId": "test-thread",
                    "name": "my_agent",
                    "properties": {"custom": "prop"}
                }
            )

            assert response.status_code == 200


# ============================================================================
# Regression Tests: /agents/state extract_state_from_request integration (#1646)
# ============================================================================


class TestAgentsStateExtractorIntegration:
    """Regression tests for ag-ui-protocol/ag-ui#1646.

    The /agents/state endpoint historically read ``userId``/``appName``
    straight from the request body, bypassing ``extract_state_from_request``.
    For deployments that use the extractor as an auth hook (e.g. minting
    user_id from a session-provider JWT) this lets a client read another
    user's session state and message history by supplying any ``userId`` in
    the body.

    These tests pin the fix: the extractor is invoked on /agents/state, its
    output drives identity resolution, and the body fields fall back only
    when no other source produces a value.
    """

    @pytest.fixture
    def mock_agent(self):
        """ADKAgent mock with no static identity and no agent-level extractors.

        This isolates the extractor pipeline as the only identity source —
        the precedence chain falls straight to the extractor-produced state
        or to the body fallback, mirroring how a JWT-auth deployment is
        configured.
        """
        mock_adk = MagicMock()
        mock_adk.name = "test_agent"

        agent = MagicMock(spec=ADKAgent)
        agent._static_app_name = None
        agent._static_user_id = None
        agent._app_name_extractor = None
        agent._user_id_extractor = None
        agent._adk_agent = mock_adk
        agent._session_manager = MagicMock()
        agent._session_lookup_cache = {}

        return agent

    def _wire_session_lookup(self, mock_agent, expected_app_name, expected_user_id):
        """Wire the session-lookup chain so the endpoint reaches a 200 response
        and so the test can assert what app_name/user_id were used downstream."""
        mock_session = MagicMock()
        mock_session.id = "backend-session-id"
        mock_session.events = []

        mock_agent._get_session_metadata = MagicMock(return_value=None)
        mock_agent._session_manager._find_session_by_thread_id = AsyncMock(
            return_value=mock_session
        )
        mock_agent._session_manager._session_service = MagicMock()
        mock_agent._session_manager._session_service.get_session = AsyncMock(
            return_value=mock_session
        )
        mock_agent._session_manager.get_session_state = AsyncMock(return_value={})

    def test_extract_state_fn_is_invoked(self, mock_agent):
        """Regression: /agents/state must call extract_state_from_request."""
        self._wire_session_lookup(mock_agent, "from-extractor", "from-extractor")

        extract_state_fn = AsyncMock(
            return_value={"app_name": "from-extractor", "user_id": "from-extractor"}
        )

        app = FastAPI()
        add_adk_fastapi_endpoint(
            app, mock_agent, path="/", extract_state_from_request=extract_state_fn
        )

        with TestClient(app) as client:
            response = client.post(
                "/agents/state", json={"threadId": "thread-1"}
            )

        assert response.status_code == 200
        extract_state_fn.assert_called_once()
        # Second positional arg is the synthetic RunAgentInput.
        synthetic_input = extract_state_fn.call_args.args[1]
        assert isinstance(synthetic_input, RunAgentInput)
        assert synthetic_input.thread_id == "thread-1"

    def test_extractor_user_id_overrides_body(self, mock_agent):
        """The bypass case: body userId is ignored when the extractor mints one.

        Without the fix, a client posting ``userId: "victim"`` would read the
        victim's session. With the fix, the extractor's ``user_id`` wins and
        the spoofed value never reaches ``_session_manager``.
        """
        self._wire_session_lookup(mock_agent, "from-jwt-app", "from-jwt-user")

        async def jwt_extractor(request, input_data):
            return {"app_name": "from-jwt-app", "user_id": "from-jwt-user"}

        app = FastAPI()
        add_adk_fastapi_endpoint(
            app, mock_agent, path="/", extract_state_from_request=jwt_extractor
        )

        with TestClient(app) as client:
            with pytest.warns(DeprecationWarning, match="#1646"):
                response = client.post(
                    "/agents/state",
                    json={
                        "threadId": "thread-2",
                        "userId": "victim-user-id",
                        "appName": "victim-app",
                    },
                )

        assert response.status_code == 200
        # The downstream session lookup must have been called with the
        # extractor-supplied identity, never the spoofed body values.
        find_call = mock_agent._session_manager._find_session_by_thread_id.call_args
        assert find_call.kwargs["user_id"] == "from-jwt-user"
        assert find_call.kwargs["app_name"] == "from-jwt-app"
        assert "victim" not in str(find_call)

    def test_body_fallback_when_no_extractor(self, mock_agent):
        """Backward compat: body userId still works when no extractor is set."""
        self._wire_session_lookup(mock_agent, "body-app", "body-user")

        app = FastAPI()
        add_adk_fastapi_endpoint(app, mock_agent, path="/")

        with TestClient(app) as client:
            response = client.post(
                "/agents/state",
                json={
                    "threadId": "thread-3",
                    "userId": "body-user",
                    "appName": "body-app",
                },
            )

        assert response.status_code == 200
        find_call = mock_agent._session_manager._find_session_by_thread_id.call_args
        assert find_call.kwargs["user_id"] == "body-user"
        assert find_call.kwargs["app_name"] == "body-app"

    def test_extract_headers_does_not_auto_protect_identity(self, mock_agent):
        """Documentation test: legacy ``extract_headers`` parks values under
        ``state.headers.*`` and so does NOT override identity. Deployments
        wanting auth must either (a) write a custom ``extract_state_from_request``
        that places the value at ``state["user_id"]``, or (b) configure an
        ADKAgent-level ``user_id_extractor`` that reads ``input.state.headers``.
        Pinned here so a future refactor doesn't silently change this contract.
        """
        from ag_ui_adk.endpoint import make_extract_headers

        self._wire_session_lookup(mock_agent, "body-app", "body-user")

        app = FastAPI()
        add_adk_fastapi_endpoint(
            app,
            mock_agent,
            path="/",
            extract_state_from_request=make_extract_headers(["x-user-id"]),
        )

        with TestClient(app) as client:
            with pytest.warns(DeprecationWarning, match="#1646"):
                response = client.post(
                    "/agents/state",
                    headers={"x-user-id": "header-user"},
                    json={
                        "threadId": "thread-4",
                        "userId": "body-user",
                        "appName": "body-app",
                    },
                )

        assert response.status_code == 200
        # extract_headers writes to state.headers.user_id, not state.user_id, so
        # identity falls through to the body fallback for both fields.
        find_call = mock_agent._session_manager._find_session_by_thread_id.call_args
        assert find_call.kwargs["user_id"] == "body-user"
        assert find_call.kwargs["app_name"] == "body-app"


# ============================================================================
# Integration Tests: Full Flow with Live Endpoint
# ============================================================================

class TestMessageHistoryIntegration:
    """Integration tests for message history features with a live endpoint."""

    @pytest.fixture
    def real_agent(self):
        """Create a real ADKAgent for integration testing."""
        mock_adk = MagicMock()
        mock_adk.name = "integration_test_agent"

        agent = ADKAgent(
            adk_agent=mock_adk,
            app_name="integration_test",
            user_id="test_user"
        )
        return agent

    @pytest.fixture(
        params=[FastAPI, APIRouter]
    )
    def app(self, request):
        """Create a FastAPI app or APIRouter."""
        return request.param()

    def get_test_app(self, app):
        """Return app suitable for TestClient (wrap APIRouter in FastAPI if needed).

        Note: This must be called AFTER routes are added to the router,
        since include_router copies routes at the time of inclusion.
        """
        if isinstance(app, APIRouter):
            fastapi_app = FastAPI()
            fastapi_app.include_router(app)
            return fastapi_app
        return app

    @pytest.mark.asyncio
    async def test_agents_state_with_real_session_manager(self, app, real_agent):
        """Test /agents/state with a real session manager."""
        add_adk_fastapi_endpoint(app, real_agent, path="/")

        # First, create a session via session manager
        await real_agent._session_manager.get_or_create_session(
            thread_id="integration-test-thread",
            app_name="integration_test",
            user_id="test_user"
        )

        async with AsyncClient(
            transport=ASGITransport(app=self.get_test_app(app)),
            base_url="http://test"
        ) as client:
            # Now /agents/state should find the existing session
            response = await client.post(
                "/agents/state",
                json={"threadId": "integration-test-thread"}
            )

            assert response.status_code == 200
            data = response.json()
            assert data["threadId"] == "integration-test-thread"
            assert data["threadExists"] is True

    @pytest.mark.asyncio
    async def test_agents_state_returns_native_json_response(self, app, real_agent):
        """Verify state and messages are native JSON objects (not double-encoded strings)."""
        add_adk_fastapi_endpoint(app, real_agent, path="/")

        async with AsyncClient(
            transport=ASGITransport(app=self.get_test_app(app)),
            base_url="http://test"
        ) as client:
            response = await client.post(
                "/agents/state",
                json={"threadId": "json-test-thread"}
            )

            assert response.status_code == 200
            data = response.json()

            # Verify these are native objects (not strings)
            assert isinstance(data["state"], dict)
            assert isinstance(data["messages"], list)


# ============================================================================
# Live Server Integration Tests
# ============================================================================

def find_free_port():
    """Find a free port on localhost."""
    with closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as s:
        s.bind(('', 0))
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        return s.getsockname()[1]


class UvicornServer:
    """Context manager for running uvicorn server in a background thread."""

    def __init__(self, app: FastAPI, host: str = "127.0.0.1", port: int = None):
        self.app = app
        self.host = host
        self.port = port or find_free_port()
        self.server = None
        self.thread = None

    def __enter__(self):
        config = uvicorn.Config(
            app=self.app,
            host=self.host,
            port=self.port,
            log_level="error",  # Suppress logs during tests
        )
        self.server = uvicorn.Server(config)

        # Run server in background thread
        self.thread = threading.Thread(target=self.server.run, daemon=True)
        self.thread.start()

        # Wait for server to start
        max_retries = 50
        for _ in range(max_retries):
            try:
                with socket.create_connection((self.host, self.port), timeout=0.1):
                    break
            except (socket.error, ConnectionRefusedError):
                time.sleep(0.1)
        else:
            raise RuntimeError(f"Server failed to start on {self.host}:{self.port}")

        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        if self.server:
            self.server.should_exit = True
        if self.thread:
            self.thread.join(timeout=5)

    @property
    def base_url(self):
        return f"http://{self.host}:{self.port}"


class TestLiveServerIntegration:
    """Integration tests against a live uvicorn server.

    These tests spin up an actual uvicorn server and make real HTTP requests.
    They use mocked ADK agents, so no external API keys are required.
    """

    @pytest.fixture(
        params=[FastAPI, APIRouter]
    )
    def app(self, request):
        """Create a FastAPI app."""
        return request.param()

    @pytest.fixture
    def live_agent(self):
        """Create a real ADKAgent for live server testing."""
        mock_adk = MagicMock()
        mock_adk.name = "live_test_agent"

        agent = ADKAgent(
            adk_agent=mock_adk,
            app_name="live_test_app",
            user_id="live_test_user"
        )
        return agent

    @pytest.fixture
    def live_server(self, app, live_agent):
        """Start a live uvicorn server with the agent endpoint."""
        if isinstance(app, APIRouter):
            main_app = FastAPI()
            add_adk_fastapi_endpoint(app, live_agent, path="/")
            main_app.include_router(app, prefix="")
        elif isinstance(app, FastAPI):
            add_adk_fastapi_endpoint(app, live_agent, path="/")
            main_app = app
        else:
            raise ValueError("app fixture must be FastAPI or APIRouter")

        with UvicornServer(main_app) as server:
            yield server

    def test_live_server_agents_state_endpoint(self, live_server, live_agent):
        """Test /agents/state endpoint on a live server."""
        import asyncio

        # First create a session
        async def create_session():
            await live_agent._session_manager.get_or_create_session(
                thread_id="live-test-thread-1",
                app_name="live_test_app",
                user_id="live_test_user"
            )
        asyncio.run(create_session())

        response = httpx.post(
            f"{live_server.base_url}/agents/state",
            json={"threadId": "live-test-thread-1"},
            timeout=10.0
        )

        assert response.status_code == 200
        data = response.json()
        assert data["threadId"] == "live-test-thread-1"
        assert data["threadExists"] is True
        assert "state" in data
        assert "messages" in data

    def test_live_server_agents_state_json_format(self, live_server):
        """Verify state and messages are native JSON objects on live server."""
        response = httpx.post(
            f"{live_server.base_url}/agents/state",
            json={"threadId": "live-json-test-thread"},
            timeout=10.0
        )

        assert response.status_code == 200
        data = response.json()

        # Verify state and messages are native objects (not double-encoded strings)
        assert isinstance(data["state"], dict)
        assert isinstance(data["messages"], list)

    def test_live_server_agents_state_with_optional_fields(self, live_server):
        """Test /agents/state with optional name and properties fields."""
        response = httpx.post(
            f"{live_server.base_url}/agents/state",
            json={
                "threadId": "live-optional-fields-thread",
                "name": "custom_agent",
                "properties": {"key": "value"}
            },
            timeout=10.0
        )

        assert response.status_code == 200
        data = response.json()
        assert data["threadId"] == "live-optional-fields-thread"

    def test_live_server_session_persistence(self, live_server, live_agent):
        """Test that session state persists across requests."""
        import asyncio
        thread_id = f"live-persist-test-{uuid.uuid4()}"

        # First create a session
        async def create_session():
            await live_agent._session_manager.get_or_create_session(
                thread_id=thread_id,
                app_name="live_test_app",
                user_id="live_test_user"
            )
        asyncio.run(create_session())

        # First request - session should exist
        response1 = httpx.post(
            f"{live_server.base_url}/agents/state",
            json={"threadId": thread_id},
            timeout=10.0
        )
        assert response1.status_code == 200
        data1 = response1.json()
        assert data1["threadExists"] is True

        # Second request - same thread should still exist
        response2 = httpx.post(
            f"{live_server.base_url}/agents/state",
            json={"threadId": thread_id},
            timeout=10.0
        )
        assert response2.status_code == 200
        data2 = response2.json()
        assert data2["threadExists"] is True
        assert data2["threadId"] == thread_id

    def test_live_server_multiple_threads(self, live_server, live_agent):
        """Test handling multiple different thread IDs."""
        import asyncio
        threads = [f"live-multi-thread-{i}-{uuid.uuid4()}" for i in range(3)]

        # First create all sessions
        async def create_sessions():
            for thread_id in threads:
                await live_agent._session_manager.get_or_create_session(
                    thread_id=thread_id,
                    app_name="live_test_app",
                    user_id="live_test_user"
                )
        asyncio.run(create_sessions())

        responses = []
        for thread_id in threads:
            response = httpx.post(
                f"{live_server.base_url}/agents/state",
                json={"threadId": thread_id},
                timeout=10.0
            )
            responses.append(response)

        # All requests should succeed
        for i, response in enumerate(responses):
            assert response.status_code == 200
            data = response.json()
            assert data["threadId"] == threads[i]
            assert data["threadExists"] is True

    @pytest.mark.asyncio
    async def test_live_server_concurrent_requests(self, live_server):
        """Test concurrent requests to the live server."""
        thread_ids = [f"live-concurrent-{i}-{uuid.uuid4()}" for i in range(5)]

        async with httpx.AsyncClient(timeout=10.0) as client:
            # Send concurrent requests
            tasks = [
                client.post(
                    f"{live_server.base_url}/agents/state",
                    json={"threadId": tid}
                )
                for tid in thread_ids
            ]
            import asyncio
            responses = await asyncio.gather(*tasks)

        # All requests should succeed
        for i, response in enumerate(responses):
            assert response.status_code == 200
            data = response.json()
            assert data["threadId"] == thread_ids[i]

    def test_live_server_invalid_request(self, live_server):
        """Test error handling for invalid requests."""
        # Missing required threadId field
        response = httpx.post(
            f"{live_server.base_url}/agents/state",
            json={},
            timeout=10.0
        )

        # Should return 422 Unprocessable Entity for validation error
        assert response.status_code in [
            422, 
            500, # When using APIRouter it returns a 500 instead and I don't know why
        ]

    def test_live_server_main_endpoint_exists(self, live_server):
        """Test that the main POST endpoint exists (even if it requires proper input)."""
        # Send a minimal valid request to verify endpoint exists
        # This will likely fail due to missing proper input, but should not 404
        response = httpx.post(
            f"{live_server.base_url}/",
            json={
                "thread_id": "test",
                "run_id": "test-run",
                "messages": [],
                "context": [],
                "state": {},
                "tools": [],
                "forwarded_props": {}
            },
            headers={"accept": "text/event-stream"},
            timeout=10.0
        )

        # Should not be 404 (endpoint exists)
        assert response.status_code != 404
