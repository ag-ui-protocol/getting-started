#!/usr/bin/env python
"""Tests for utility functions in converters.py."""

import pytest
import json
import base64
from unittest.mock import MagicMock, patch, PropertyMock

from ag_ui.core import (
    UserMessage,
    AssistantMessage,
    SystemMessage,
    ToolMessage,
    ToolCall,
    FunctionCall,
    TextInputContent,
    BinaryInputContent,
    ImageInputContent,
    AudioInputContent,
    VideoInputContent,
    DocumentInputContent,
    InputContentDataSource,
    InputContentUrlSource,
)
from google.adk.events import Event as ADKEvent
from google.genai import types

from ag_ui_adk.utils.converters import (
    convert_ag_ui_messages_to_adk,
    convert_adk_event_to_ag_ui_message,
    convert_message_content_to_parts,
    convert_state_to_json_patch,
    convert_json_patch_to_state,
    extract_text_from_content,
    create_error_message
)


class TestConvertAGUIMessagesToADK:
    """Tests for convert_ag_ui_messages_to_adk function."""

    def test_convert_user_message(self):
        """Test converting a UserMessage to ADK event."""
        user_msg = UserMessage(
            id="user_1",
            role="user",
            content="Hello, how are you?"
        )

        adk_events = convert_ag_ui_messages_to_adk([user_msg])

        assert len(adk_events) == 1
        event = adk_events[0]
        assert event.id == "user_1"
        assert event.author == "user"
        assert event.content.role == "user"
        assert len(event.content.parts) == 1
        assert event.content.parts[0].text == "Hello, how are you?"

    def test_convert_user_message_multimodal_inline_data(self):
        """Test converting a multimodal UserMessage with inline base64 binary data."""
        raw = b"fake-image-bytes"
        b64 = base64.b64encode(raw).decode("ascii")
        user_msg = UserMessage(
            id="user_mm_1",
            role="user",
            content=[
                TextInputContent(text="Here is an image."),
                BinaryInputContent(mime_type="image/png", data=b64, filename="x.png"),
            ],
        )

        adk_events = convert_ag_ui_messages_to_adk([user_msg])
        event = adk_events[0]

        assert len(event.content.parts) == 2
        assert event.content.parts[0].text == "Here is an image."
        assert event.content.parts[1].inline_data.mime_type == "image/png"
        assert event.content.parts[1].inline_data.data == raw
    
    def test_convert_user_message_multimodal_id_only_ignored(self):
        """Test that BinaryInputContent with id only is ignored."""
        user_msg = UserMessage(
            id="user_id_only",
            role="user",
            content=[
                TextInputContent(text="Id only data."),
                BinaryInputContent(mime_type="image/png", id="123"),
            ],
        )

        adk_events = convert_ag_ui_messages_to_adk([user_msg])

        event = adk_events[0]
        assert len(event.content.parts) == 1
        assert event.content.parts[0].text == "Id only data."
    
    def test_convert_user_message_multimodal_broken_base64_ignored(self):
        """Test that broken base64 data is ignored."""
        user_msg = UserMessage(
            id="user_broken_b64_ignored",
            role="user",
            content=[
                TextInputContent(text="Broken data."),
                BinaryInputContent(mime_type="image/png", data="This Data is Broken", filename="broken.png"),
            ],
        )

        adk_events = convert_ag_ui_messages_to_adk([user_msg])
        event = adk_events[0]

        assert len(event.content.parts) == 1
        assert event.content.parts[0].text == "Broken data."

    def test_convert_user_message_multimodal_file_data_url_ignored(self):
        """Test that BinaryInputContent with URL is currently ignored (data supported only)."""

        user_msg = UserMessage(
            id="user_mm_2",
            role="user",
            content=[
                TextInputContent(text="Please look at the image at this URL."),
                BinaryInputContent(mime_type="image/jpeg", url="https://example.com/a.jpg"),
            ],
        )

        adk_events = convert_ag_ui_messages_to_adk([user_msg])
        event = adk_events[0]

        assert len(event.content.parts) == 1
        assert event.content.parts[0].text == "Please look at the image at this URL."

    def test_convert_user_message_image_input_data_source(self):
        """Test converting ImageInputContent with inline base64 data source."""
        raw = b"fake-image-bytes"
        b64 = base64.b64encode(raw).decode("ascii")
        user_msg = UserMessage(
            id="user_img_data",
            role="user",
            content=[
                TextInputContent(text="Describe this image."),
                ImageInputContent(
                    source=InputContentDataSource(
                        value=b64,
                        mime_type="image/png",
                    ),
                ),
            ],
        )

        adk_events = convert_ag_ui_messages_to_adk([user_msg])
        event = adk_events[0]

        assert len(event.content.parts) == 2
        assert event.content.parts[0].text == "Describe this image."
        assert event.content.parts[1].inline_data.mime_type == "image/png"
        assert event.content.parts[1].inline_data.data == raw

    def test_convert_user_message_image_input_url_source(self):
        """Test converting ImageInputContent with URL source uses file_data."""
        user_msg = UserMessage(
            id="user_img_url",
            role="user",
            content=[
                TextInputContent(text="What is in this image?"),
                ImageInputContent(
                    source=InputContentUrlSource(
                        value="https://example.com/photo.png",
                        mime_type="image/png",
                    ),
                ),
            ],
        )

        adk_events = convert_ag_ui_messages_to_adk([user_msg])
        event = adk_events[0]

        assert len(event.content.parts) == 2
        assert event.content.parts[0].text == "What is in this image?"
        assert event.content.parts[1].file_data.file_uri == "https://example.com/photo.png"
        assert event.content.parts[1].file_data.mime_type == "image/png"

    def test_convert_user_message_audio_input_data_source(self):
        """Test converting AudioInputContent with inline base64 data source."""
        raw = b"fake-audio-bytes"
        b64 = base64.b64encode(raw).decode("ascii")
        user_msg = UserMessage(
            id="user_audio_data",
            role="user",
            content=[
                AudioInputContent(
                    source=InputContentDataSource(
                        value=b64,
                        mime_type="audio/wav",
                    ),
                ),
            ],
        )

        adk_events = convert_ag_ui_messages_to_adk([user_msg])
        event = adk_events[0]

        assert len(event.content.parts) == 1
        assert event.content.parts[0].inline_data.mime_type == "audio/wav"
        assert event.content.parts[0].inline_data.data == raw

    def test_convert_user_message_video_input_url_source(self):
        """Test converting VideoInputContent with URL source."""
        user_msg = UserMessage(
            id="user_video_url",
            role="user",
            content=[
                VideoInputContent(
                    source=InputContentUrlSource(
                        value="https://example.com/clip.mp4",
                        mime_type="video/mp4",
                    ),
                ),
            ],
        )

        adk_events = convert_ag_ui_messages_to_adk([user_msg])
        event = adk_events[0]

        assert len(event.content.parts) == 1
        assert event.content.parts[0].file_data.file_uri == "https://example.com/clip.mp4"
        assert event.content.parts[0].file_data.mime_type == "video/mp4"

    def test_convert_user_message_document_input_data_source(self):
        """Test converting DocumentInputContent with inline base64 data source."""
        raw = b"%PDF-fake-document"
        b64 = base64.b64encode(raw).decode("ascii")
        user_msg = UserMessage(
            id="user_doc_data",
            role="user",
            content=[
                TextInputContent(text="Summarize this document."),
                DocumentInputContent(
                    source=InputContentDataSource(
                        value=b64,
                        mime_type="application/pdf",
                    ),
                ),
            ],
        )

        adk_events = convert_ag_ui_messages_to_adk([user_msg])
        event = adk_events[0]

        assert len(event.content.parts) == 2
        assert event.content.parts[0].text == "Summarize this document."
        assert event.content.parts[1].inline_data.mime_type == "application/pdf"
        assert event.content.parts[1].inline_data.data == raw

    def test_convert_user_message_url_source_without_mime_type(self):
        """Test converting URL source without mime_type still works (ADK auto-detects)."""
        user_msg = UserMessage(
            id="user_img_url_no_mime",
            role="user",
            content=[
                ImageInputContent(
                    source=InputContentUrlSource(
                        value="https://example.com/photo.jpg",
                    ),
                ),
            ],
        )

        adk_events = convert_ag_ui_messages_to_adk([user_msg])
        event = adk_events[0]

        assert len(event.content.parts) == 1
        assert event.content.parts[0].file_data.file_uri == "https://example.com/photo.jpg"
        assert event.content.parts[0].file_data.mime_type is None

    def test_convert_user_message_media_broken_base64_ignored(self):
        """Test that media content with broken base64 data is ignored."""
        user_msg = UserMessage(
            id="user_media_broken",
            role="user",
            content=[
                TextInputContent(text="Check this."),
                ImageInputContent(
                    source=InputContentDataSource(
                        value="This Is Not Valid Base64!!!",
                        mime_type="image/png",
                    ),
                ),
            ],
        )

        adk_events = convert_ag_ui_messages_to_adk([user_msg])
        event = adk_events[0]

        assert len(event.content.parts) == 1
        assert event.content.parts[0].text == "Check this."

    def test_convert_user_message_mixed_media_types(self):
        """Test converting a message with multiple different media types."""
        img_raw = b"fake-image"
        img_b64 = base64.b64encode(img_raw).decode("ascii")
        user_msg = UserMessage(
            id="user_mixed",
            role="user",
            content=[
                TextInputContent(text="Analyze these files."),
                ImageInputContent(
                    source=InputContentDataSource(
                        value=img_b64,
                        mime_type="image/png",
                    ),
                ),
                DocumentInputContent(
                    source=InputContentUrlSource(
                        value="https://example.com/report.pdf",
                        mime_type="application/pdf",
                    ),
                ),
            ],
        )

        adk_events = convert_ag_ui_messages_to_adk([user_msg])
        event = adk_events[0]

        assert len(event.content.parts) == 3
        assert event.content.parts[0].text == "Analyze these files."
        assert event.content.parts[1].inline_data.mime_type == "image/png"
        assert event.content.parts[1].inline_data.data == img_raw
        assert event.content.parts[2].file_data.file_uri == "https://example.com/report.pdf"
        assert event.content.parts[2].file_data.mime_type == "application/pdf"

    def test_convert_system_message(self):
        """Test converting a SystemMessage to ADK event."""
        system_msg = SystemMessage(
            id="system_1",
            role="system",
            content="You are a helpful assistant."
        )

        adk_events = convert_ag_ui_messages_to_adk([system_msg])

        assert len(adk_events) == 1
        event = adk_events[0]
        assert event.id == "system_1"
        assert event.author == "system"
        assert event.content.role == "system"
        assert event.content.parts[0].text == "You are a helpful assistant."

    def test_convert_assistant_message_with_text(self):
        """Test converting an AssistantMessage with text content."""
        assistant_msg = AssistantMessage(
            id="assistant_1",
            role="assistant",
            content="I'm doing well, thank you!"
        )

        adk_events = convert_ag_ui_messages_to_adk([assistant_msg])

        assert len(adk_events) == 1
        event = adk_events[0]
        assert event.id == "assistant_1"
        assert event.author == "model"
        assert event.content.role == "model"  # ADK uses "model" for assistant
        assert event.content.parts[0].text == "I'm doing well, thank you!"

    def test_convert_named_assistant_message_uses_name_as_author(self):
        """Test converting named AssistantMessage to ADK event author."""
        assistant_msg = AssistantMessage(
            id="assistant_named_1",
            role="assistant",
            name="subagent1",
            content="Handled by subagent1.",
        )

        adk_events = convert_ag_ui_messages_to_adk([assistant_msg])

        assert len(adk_events) == 1
        event = adk_events[0]
        assert event.id == "assistant_named_1"
        assert event.author == "subagent1"
        assert event.content.role == "model"
        assert event.content.parts[0].text == "Handled by subagent1."

    def test_convert_unnamed_assistant_round_trip_does_not_synthesize_name(self):
        """Test plain assistant messages round-trip without name='assistant'."""
        assistant_msg = AssistantMessage(
            id="assistant_plain_1",
            role="assistant",
            content="Plain assistant response.",
        )

        adk_event = convert_ag_ui_messages_to_adk([assistant_msg])[0]
        round_trip_message = convert_adk_event_to_ag_ui_message(adk_event)

        assert adk_event.author == "model"
        assert isinstance(round_trip_message, AssistantMessage)
        assert round_trip_message.name is None

    def test_convert_assistant_message_with_tool_calls(self):
        """Test converting an AssistantMessage with tool calls."""
        tool_call = ToolCall(
            id="call_123",
            type="function",
            function=FunctionCall(
                name="get_weather",
                arguments='{"location": "New York"}'
            )
        )

        assistant_msg = AssistantMessage(
            id="assistant_2",
            role="assistant",
            content="Let me check the weather for you.",
            tool_calls=[tool_call]
        )

        adk_events = convert_ag_ui_messages_to_adk([assistant_msg])

        assert len(adk_events) == 1
        event = adk_events[0]
        assert event.content.role == "model"
        assert len(event.content.parts) == 2  # Text + function call

        # Check text part
        text_part = event.content.parts[0]
        assert text_part.text == "Let me check the weather for you."

        # Check function call part
        func_part = event.content.parts[1]
        assert func_part.function_call.name == "get_weather"
        assert func_part.function_call.args == {"location": "New York"}
        assert func_part.function_call.id == "call_123"

    def test_convert_assistant_message_with_dict_tool_args(self):
        """Test converting tool calls with dict arguments (not JSON string)."""
        tool_call = ToolCall(
            id="call_456",
            type="function",
            function=FunctionCall(
                name="calculate",
                arguments='{"expression": "2 + 2"}'
            )
        )

        assistant_msg = AssistantMessage(
            id="assistant_3",
            role="assistant",
            tool_calls=[tool_call]
        )

        adk_events = convert_ag_ui_messages_to_adk([assistant_msg])

        event = adk_events[0]
        func_part = event.content.parts[0]
        assert func_part.function_call.args == {"expression": "2 + 2"}

    def test_convert_tool_message(self):
        """Test the fallback path: a ToolMessage with no prior AssistantMessage
        in the same batch falls back to using tool_call_id as the
        FunctionResponse.name. Preserves backwards-compatible behaviour for
        malformed inputs / orphan tool messages.

        For the corrected round-trip path (AssistantMessage with the matching
        tool_call present in the batch), see
        `test_tool_message_uses_function_name_from_prior_assistant_call`.
        """
        tool_msg = ToolMessage(
            id="tool_1",
            role="tool",
            content='{"temperature": 72, "condition": "sunny"}',
            tool_call_id="call_123"
        )

        adk_events = convert_ag_ui_messages_to_adk([tool_msg])

        assert len(adk_events) == 1
        event = adk_events[0]
        assert event.id == "tool_1"
        assert event.author == "tool"
        assert event.content.role == "function"

        func_response = event.content.parts[0].function_response
        # Fallback: no prior AssistantMessage with the matching tool_call.id
        # in this batch, so the converter degrades gracefully to using the
        # tool_call_id as the function name. Gemini will not be able to
        # correlate the response back to a call by name in this case, but at
        # least the conversion doesn't crash.
        assert func_response.name == "call_123"
        assert func_response.id == "call_123"
        assert func_response.response == {"result": '{"temperature": 72, "condition": "sunny"}'}

    def test_tool_message_uses_function_name_from_prior_assistant_call(self):
        """When a ToolMessage is preceded by an AssistantMessage carrying a
        tool_call with the matching id, FunctionResponse.name MUST be set to
        the called function's name (not the tool_call_id).

        Gemini's wire contract is that FunctionResponse.name equals the
        originating FunctionCall.name; downstream consumers that recover the
        call id by name (real Gemini's session correlator, the aimock
        gemini->openai translator, etc.) hit a UUID-shaped name with no
        matching prior call when this is wrong, silently breaking the
        round-trip.
        """
        assistant_msg = AssistantMessage(
            id="assistant_1",
            role="assistant",
            tool_calls=[
                ToolCall(
                    id="call_weather_001",
                    type="function",
                    function=FunctionCall(
                        name="get_weather",
                        arguments='{"city": "Tokyo"}',
                    ),
                )
            ],
        )
        tool_msg = ToolMessage(
            id="tool_1",
            role="tool",
            content='{"temperature": 72, "condition": "sunny"}',
            tool_call_id="call_weather_001",
        )

        adk_events = convert_ag_ui_messages_to_adk([assistant_msg, tool_msg])

        # Two events: assistant turn + tool turn.
        assert len(adk_events) == 2
        tool_event = adk_events[1]
        assert tool_event.content.role == "function"
        func_response = tool_event.content.parts[0].function_response
        # Critical: name = function name, NOT tool_call_id.
        assert func_response.name == "get_weather"
        # id continues to carry the tool_call_id for clients that key on it.
        assert func_response.id == "call_weather_001"

    def test_multiple_tool_messages_each_use_their_own_function_name(self):
        """Each ToolMessage looks up its OWN function name by tool_call_id —
        not a shared / first-found name. Exercises the per-id mapping when an
        AssistantMessage carries multiple tool_calls and multiple ToolMessages
        follow in any order.
        """
        assistant_msg = AssistantMessage(
            id="assistant_1",
            role="assistant",
            tool_calls=[
                ToolCall(
                    id="call_a",
                    type="function",
                    function=FunctionCall(name="get_weather", arguments="{}"),
                ),
                ToolCall(
                    id="call_b",
                    type="function",
                    function=FunctionCall(name="get_time", arguments="{}"),
                ),
            ],
        )
        # Tool messages out of declaration order — id-based lookup must still
        # resolve each to the correct function name.
        tool_b = ToolMessage(
            id="tool_b",
            role="tool",
            content="2pm",
            tool_call_id="call_b",
        )
        tool_a = ToolMessage(
            id="tool_a",
            role="tool",
            content="sunny",
            tool_call_id="call_a",
        )

        adk_events = convert_ag_ui_messages_to_adk([assistant_msg, tool_b, tool_a])

        # 3 events total; events[1] is tool_b, events[2] is tool_a.
        b_response = adk_events[1].content.parts[0].function_response
        a_response = adk_events[2].content.parts[0].function_response
        assert b_response.name == "get_time"
        assert b_response.id == "call_b"
        assert a_response.name == "get_weather"
        assert a_response.id == "call_a"

    def test_tool_message_lookup_falls_back_when_id_unknown(self):
        """If a ToolMessage's tool_call_id doesn't match any prior
        AssistantMessage's tool_call in the same batch, the converter falls
        back to the pre-fix behaviour (name = tool_call_id) rather than
        crashing. Exercises the same defensive guard as
        `test_convert_tool_message` but with a prior AssistantMessage that
        contains an UNRELATED tool_call — proving the lookup is keyed on id,
        not just presence.
        """
        assistant_msg = AssistantMessage(
            id="assistant_1",
            role="assistant",
            tool_calls=[
                ToolCall(
                    id="call_known",
                    type="function",
                    function=FunctionCall(name="get_weather", arguments="{}"),
                )
            ],
        )
        # ToolMessage's tool_call_id references a DIFFERENT id (the
        # AssistantMessage's tool_call.id is "call_known", not "call_orphan").
        tool_msg = ToolMessage(
            id="tool_orphan",
            role="tool",
            content="orphan result",
            tool_call_id="call_orphan",
        )

        adk_events = convert_ag_ui_messages_to_adk([assistant_msg, tool_msg])

        orphan_response = adk_events[1].content.parts[0].function_response
        # Falls back to tool_call_id since no matching prior call.
        assert orphan_response.name == "call_orphan"
        assert orphan_response.id == "call_orphan"

    def test_convert_tool_message_with_dict_content(self):
        """Test converting a ToolMessage with dict content (not JSON string)."""
        tool_msg = ToolMessage(
            id="tool_2",
            role="tool",
            content='{"result": "success", "value": 42}',  # Must be JSON string
            tool_call_id="call_456"
        )

        adk_events = convert_ag_ui_messages_to_adk([tool_msg])

        event = adk_events[0]
        func_response = event.content.parts[0].function_response
        assert func_response.response == {"result": '{"result": "success", "value": 42}'}

    def test_binary_filename_maps_to_blob_display_name(self):
        """Test that BinaryInputContent.filename is set as Blob.display_name."""
        item = BinaryInputContent(
            data=base64.b64encode(b"hello").decode(),
            mime_type="application/pdf",
            filename="report.pdf",
        )
        parts = convert_message_content_to_parts([item])
        assert len(parts) == 1
        assert parts[0].inline_data.display_name == "report.pdf"

    def test_binary_without_filename_has_no_display_name(self):
        """Test that Blob.display_name is None when filename is not provided."""
        item = BinaryInputContent(
            data=base64.b64encode(b"hello").decode(),
            mime_type="application/pdf",
        )
        parts = convert_message_content_to_parts([item])
        assert parts[0].inline_data.display_name is None

    def test_convert_empty_message_list(self):
        """Test converting an empty message list."""
        adk_events = convert_ag_ui_messages_to_adk([])
        assert adk_events == []

    def test_convert_message_without_content(self):
        """Test converting a message without content."""
        user_msg = UserMessage(id="user_2", role="user", content="")

        adk_events = convert_ag_ui_messages_to_adk([user_msg])

        assert len(adk_events) == 1
        event = adk_events[0]
        # Empty content creates content=None because empty string is falsy
        assert event.content is None

    def test_convert_assistant_message_without_content_or_tools(self):
        """Test converting an AssistantMessage without content or tool calls."""
        assistant_msg = AssistantMessage(
            id="assistant_4",
            role="assistant",
            content=None,
            tool_calls=None
        )

        adk_events = convert_ag_ui_messages_to_adk([assistant_msg])

        assert len(adk_events) == 1
        event = adk_events[0]
        assert event.content is None

    def test_convert_multiple_messages(self):
        """Test converting multiple messages."""
        messages = [
            UserMessage(id="1", role="user", content="Hello"),
            AssistantMessage(id="2", role="assistant", content="Hi there!"),
            UserMessage(id="3", role="user", content="How are you?")
        ]

        adk_events = convert_ag_ui_messages_to_adk(messages)

        assert len(adk_events) == 3
        assert adk_events[0].id == "1"
        assert adk_events[1].id == "2"
        assert adk_events[2].id == "3"

    @patch('ag_ui_adk.utils.converters.logger')
    def test_convert_with_exception_handling(self, mock_logger):
        """Test that exceptions during conversion are logged and skipped."""
        # Create a message that will cause an exception
        bad_msg = UserMessage(id="bad", role="user", content="test")

        # Mock the ADKEvent constructor to raise an exception
        with patch('ag_ui_adk.utils.converters.ADKEvent') as mock_adk_event:
            mock_adk_event.side_effect = ValueError("Test exception")

            adk_events = convert_ag_ui_messages_to_adk([bad_msg])

            # Should return empty list and log error
            assert adk_events == []
            mock_logger.error.assert_called_once()
            assert "Error converting message bad" in str(mock_logger.error.call_args)


class TestConvertADKEventToAGUIMessage:
    """Tests for convert_adk_event_to_ag_ui_message function."""

    def test_convert_user_event(self):
        """Test converting ADK user event to AG-UI message."""
        mock_event = MagicMock()
        mock_event.id = "user_1"
        mock_event.author = "user"
        mock_event.content = MagicMock()

        mock_part = MagicMock()
        mock_part.text = "Hello, assistant!"
        mock_event.content.parts = [mock_part]

        result = convert_adk_event_to_ag_ui_message(mock_event)

        assert isinstance(result, UserMessage)
        assert result.id == "user_1"
        assert result.role == "user"
        assert result.content == "Hello, assistant!"

    def test_convert_user_event_multiple_text_parts(self):
        """Test converting user event with multiple text parts."""
        mock_event = MagicMock()
        mock_event.id = "user_2"
        mock_event.author = "user"
        mock_event.content = MagicMock()

        mock_part1 = MagicMock()
        mock_part1.text = "First part"
        mock_part2 = MagicMock()
        mock_part2.text = "Second part"
        mock_event.content.parts = [mock_part1, mock_part2]

        result = convert_adk_event_to_ag_ui_message(mock_event)

        assert result.content == "First part\nSecond part"

    def test_convert_assistant_event_with_text(self):
        """Test converting ADK assistant event with text content."""
        mock_event = MagicMock()
        mock_event.id = "assistant_1"
        mock_event.author = "model"
        mock_event.content = MagicMock()

        mock_part = MagicMock()
        mock_part.text = "I can help you with that."
        mock_part.function_call = None
        mock_event.content.parts = [mock_part]

        result = convert_adk_event_to_ag_ui_message(mock_event)

        assert isinstance(result, AssistantMessage)
        assert result.id == "assistant_1"
        assert result.role == "assistant"
        assert result.content == "I can help you with that."
        assert result.name is None
        assert result.tool_calls is None

    def test_convert_agent_author_to_assistant_name(self):
        """Test preserving concrete ADK agent authors as AssistantMessage.name."""
        mock_event = MagicMock()
        mock_event.id = "assistant_agent_1"
        mock_event.author = "subagent1"
        mock_event.content = MagicMock()

        mock_part = MagicMock()
        mock_part.text = "Handled by subagent1."
        mock_part.function_call = None
        mock_event.content.parts = [mock_part]

        result = convert_adk_event_to_ag_ui_message(mock_event)

        assert isinstance(result, AssistantMessage)
        assert result.id == "assistant_agent_1"
        assert result.role == "assistant"
        assert result.name == "subagent1"
        assert result.content == "Handled by subagent1."

    def test_convert_assistant_event_with_function_call(self):
        """Test converting assistant event with function call."""
        mock_event = MagicMock()
        mock_event.id = "assistant_2"
        mock_event.author = "model"
        mock_event.content = MagicMock()

        mock_part = MagicMock()
        mock_part.text = None
        mock_part.function_call = MagicMock()
        mock_part.function_call.name = "get_weather"
        mock_part.function_call.args = {"location": "Boston"}
        mock_part.function_call.id = "call_123"
        mock_event.content.parts = [mock_part]

        result = convert_adk_event_to_ag_ui_message(mock_event)

        assert isinstance(result, AssistantMessage)
        assert result.content is None
        assert result.name is None
        assert len(result.tool_calls) == 1

        tool_call = result.tool_calls[0]
        assert tool_call.id == "call_123"
        assert tool_call.type == "function"
        assert tool_call.function.name == "get_weather"
        assert json.loads(tool_call.function.arguments) == {"location": "Boston"}

    def test_convert_assistant_event_with_text_and_function_call(self):
        """Test converting assistant event with both text and function call."""
        mock_event = MagicMock()
        mock_event.id = "assistant_3"
        mock_event.author = "model"
        mock_event.content = MagicMock()

        mock_text_part = MagicMock()
        mock_text_part.text = "Let me check the weather."
        mock_text_part.function_call = None

        mock_func_part = MagicMock()
        mock_func_part.text = None
        mock_func_part.function_call = MagicMock()
        mock_func_part.function_call.name = "get_weather"
        mock_func_part.function_call.args = {"location": "Seattle"}
        mock_func_part.function_call.id = "call_456"

        mock_event.content.parts = [mock_text_part, mock_func_part]

        result = convert_adk_event_to_ag_ui_message(mock_event)

        assert result.content == "Let me check the weather."
        assert len(result.tool_calls) == 1
        assert result.tool_calls[0].function.name == "get_weather"

    def test_convert_function_call_without_args(self):
        """Test converting function call without args."""
        mock_event = MagicMock()
        mock_event.id = "assistant_4"
        mock_event.author = "model"
        mock_event.content = MagicMock()

        mock_part = MagicMock()
        mock_part.text = None
        mock_part.function_call = MagicMock()
        mock_part.function_call.name = "get_time"
        # No args attribute
        delattr(mock_part.function_call, 'args')
        mock_part.function_call.id = "call_789"

        mock_event.content.parts = [mock_part]

        result = convert_adk_event_to_ag_ui_message(mock_event)

        tool_call = result.tool_calls[0]
        assert tool_call.function.arguments == "{}"

    def test_convert_function_call_without_id(self):
        """Test converting function call without id."""
        mock_event = MagicMock()
        mock_event.id = "assistant_5"
        mock_event.author = "model"
        mock_event.content = MagicMock()

        mock_part = MagicMock()
        mock_part.text = None
        mock_part.function_call = MagicMock()
        mock_part.function_call.name = "get_time"
        mock_part.function_call.args = {}
        # No id attribute
        delattr(mock_part.function_call, 'id')

        mock_event.content.parts = [mock_part]

        result = convert_adk_event_to_ag_ui_message(mock_event)

        tool_call = result.tool_calls[0]
        assert tool_call.id == "assistant_5"  # Falls back to event ID

    def test_convert_event_without_content(self):
        """Test converting event without content."""
        mock_event = MagicMock()
        mock_event.id = "empty_1"
        mock_event.author = "model"
        mock_event.content = None

        result = convert_adk_event_to_ag_ui_message(mock_event)

        assert result is None

    def test_convert_event_without_parts(self):
        """Test converting event without parts."""
        mock_event = MagicMock()
        mock_event.id = "empty_2"
        mock_event.author = "model"
        mock_event.content = MagicMock()
        mock_event.content.parts = []

        result = convert_adk_event_to_ag_ui_message(mock_event)

        assert result is None

    def test_convert_user_event_without_text(self):
        """Test converting user event without text content."""
        mock_event = MagicMock()
        mock_event.id = "user_3"
        mock_event.author = "user"
        mock_event.content = MagicMock()

        mock_part = MagicMock()
        mock_part.text = None
        mock_event.content.parts = [mock_part]

        result = convert_adk_event_to_ag_ui_message(mock_event)

        assert result is None

    @patch('ag_ui_adk.utils.converters.logger')
    def test_convert_with_exception_handling(self, mock_logger):
        """Test that exceptions during conversion are logged and None returned."""
        mock_event = MagicMock()
        mock_event.id = "bad_event"
        mock_event.author = "user"
        mock_event.content = MagicMock()
        mock_event.content.parts = [MagicMock()]
        # Make parts[0].text raise an exception when accessed
        type(mock_event.content.parts[0]).text = PropertyMock(side_effect=ValueError("Test exception"))

        result = convert_adk_event_to_ag_ui_message(mock_event)

        assert result is None
        mock_logger.error.assert_called_once()
        assert "Error converting ADK event bad_event" in str(mock_logger.error.call_args)


class TestStateConversionFunctions:
    """Tests for state conversion functions."""

    def test_convert_state_to_json_patch_basic(self):
        """Test converting state delta to JSON patch operations."""
        state_delta = {
            "user_name": "John",
            "status": "active",
            "count": 42
        }

        patches = convert_state_to_json_patch(state_delta)

        assert len(patches) == 3

        # Check each patch
        user_patch = next(p for p in patches if p["path"] == "/user_name")
        assert user_patch["op"] == "replace"
        assert user_patch["value"] == "John"

        status_patch = next(p for p in patches if p["path"] == "/status")
        assert status_patch["op"] == "replace"
        assert status_patch["value"] == "active"

        count_patch = next(p for p in patches if p["path"] == "/count")
        assert count_patch["op"] == "replace"
        assert count_patch["value"] == 42

    def test_convert_state_to_json_patch_with_none_values(self):
        """Test converting state delta with None values (remove operations)."""
        state_delta = {
            "keep_this": "value",
            "remove_this": None,
            "also_remove": None
        }

        patches = convert_state_to_json_patch(state_delta)

        assert len(patches) == 3

        keep_patch = next(p for p in patches if p["path"] == "/keep_this")
        assert keep_patch["op"] == "replace"
        assert keep_patch["value"] == "value"

        remove_patch = next(p for p in patches if p["path"] == "/remove_this")
        assert remove_patch["op"] == "remove"
        assert "value" not in remove_patch

        also_remove_patch = next(p for p in patches if p["path"] == "/also_remove")
        assert also_remove_patch["op"] == "remove"

    def test_convert_state_to_json_patch_empty_dict(self):
        """Test converting empty state delta."""
        patches = convert_state_to_json_patch({})
        assert patches == []

    def test_convert_json_patch_to_state_basic(self):
        """Test converting JSON patch operations to state delta."""
        patches = [
            {"op": "replace", "path": "/user_name", "value": "Alice"},
            {"op": "add", "path": "/new_field", "value": "new_value"},
            {"op": "remove", "path": "/old_field"}
        ]

        state_delta = convert_json_patch_to_state(patches)

        assert len(state_delta) == 3
        assert state_delta["user_name"] == "Alice"
        assert state_delta["new_field"] == "new_value"
        assert state_delta["old_field"] is None

    def test_convert_json_patch_to_state_with_nested_paths(self):
        """Test converting patches with nested paths (only first level supported)."""
        patches = [
            {"op": "replace", "path": "/user/name", "value": "Bob"},
            {"op": "add", "path": "/config/theme", "value": "dark"}
        ]

        state_delta = convert_json_patch_to_state(patches)

        # Should extract the first path segment after the slash
        assert state_delta["user/name"] == "Bob"
        assert state_delta["config/theme"] == "dark"

    def test_convert_json_patch_to_state_with_unsupported_ops(self):
        """Test converting patches with unsupported operations."""
        patches = [
            {"op": "replace", "path": "/supported", "value": "yes"},
            {"op": "copy", "path": "/unsupported", "from": "/somewhere"},
            {"op": "move", "path": "/also_unsupported", "from": "/elsewhere"},
            {"op": "test", "path": "/test_op", "value": "test"}
        ]

        state_delta = convert_json_patch_to_state(patches)

        # Should only process the replace operation
        assert len(state_delta) == 1
        assert state_delta["supported"] == "yes"

    def test_convert_json_patch_to_state_empty_list(self):
        """Test converting empty patch list."""
        state_delta = convert_json_patch_to_state([])
        assert state_delta == {}

    def test_convert_json_patch_to_state_malformed_patches(self):
        """Test converting malformed patches."""
        patches = [
            {"op": "replace", "path": "/good", "value": "value"},
            {"op": "replace"},  # No path
            {"path": "/no_op", "value": "value"},  # No op
            {"op": "replace", "path": "", "value": "empty_path"}  # Empty path
        ]

        state_delta = convert_json_patch_to_state(patches)

        # Should only process the good patch
        assert len(state_delta) == 2
        assert state_delta["good"] == "value"
        assert state_delta[""] == "empty_path"  # Empty path becomes empty key

    def test_roundtrip_conversion(self):
        """Test that state -> patches -> state works correctly."""
        original_state = {
            "name": "Test",
            "active": True,
            "count": 100,
            "remove_me": None
        }

        patches = convert_state_to_json_patch(original_state)
        converted_state = convert_json_patch_to_state(patches)

        assert converted_state == original_state


class TestUtilityFunctions:
    """Tests for utility functions."""

    def test_extract_text_from_content_basic(self):
        """Test extracting text from ADK Content object."""
        mock_content = MagicMock()

        mock_part1 = MagicMock()
        mock_part1.text = "Hello"
        mock_part2 = MagicMock()
        mock_part2.text = "World"
        mock_content.parts = [mock_part1, mock_part2]

        result = extract_text_from_content(mock_content)

        assert result == "Hello\nWorld"

    def test_extract_text_from_content_with_none_text(self):
        """Test extracting text when some parts have None text."""
        mock_content = MagicMock()

        mock_part1 = MagicMock()
        mock_part1.text = "Hello"
        mock_part2 = MagicMock()
        mock_part2.text = None
        mock_part3 = MagicMock()
        mock_part3.text = "World"
        mock_content.parts = [mock_part1, mock_part2, mock_part3]

        result = extract_text_from_content(mock_content)

        assert result == "Hello\nWorld"

    def test_extract_text_from_content_no_text_parts(self):
        """Test extracting text when no parts have text."""
        mock_content = MagicMock()

        mock_part1 = MagicMock()
        mock_part1.text = None
        mock_part2 = MagicMock()
        mock_part2.text = None
        mock_content.parts = [mock_part1, mock_part2]

        result = extract_text_from_content(mock_content)

        assert result == ""

    def test_extract_text_from_content_no_parts(self):
        """Test extracting text when content has no parts."""
        mock_content = MagicMock()
        mock_content.parts = []

        result = extract_text_from_content(mock_content)

        assert result == ""

    def test_extract_text_from_content_none_content(self):
        """Test extracting text from None content."""
        result = extract_text_from_content(None)

        assert result == ""

    def test_extract_text_from_content_no_parts_attribute(self):
        """Test extracting text when content has no parts attribute."""
        mock_content = MagicMock()
        mock_content.parts = None

        result = extract_text_from_content(mock_content)

        assert result == ""

    def test_create_error_message_basic(self):
        """Test creating error message from exception."""
        error = ValueError("Something went wrong")

        result = create_error_message(error)

        assert result == "ValueError: Something went wrong"

    def test_create_error_message_with_context(self):
        """Test creating error message with context."""
        error = RuntimeError("Database connection failed")
        context = "During user authentication"

        result = create_error_message(error, context)

        assert result == "During user authentication: RuntimeError - Database connection failed"

    def test_create_error_message_empty_context(self):
        """Test creating error message with empty context."""
        error = TypeError("Invalid type")

        result = create_error_message(error, "")

        assert result == "TypeError: Invalid type"

    def test_create_error_message_custom_exception(self):
        """Test creating error message from custom exception."""
        class CustomError(Exception):
            pass

        error = CustomError("Custom error message")

        result = create_error_message(error)

        assert result == "CustomError: Custom error message"

    def test_create_error_message_exception_without_message(self):
        """Test creating error message from exception without message."""
        error = ValueError()

        result = create_error_message(error)

        assert result == "ValueError: "
