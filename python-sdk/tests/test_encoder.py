import unittest
import json
from datetime import datetime

from ag_ui.encoder.encoder import EventEncoder, AGUI_MEDIA_TYPE
from ag_ui.core.events import BaseEvent, EventType, TextMessageContentEvent, ToolCallStartEvent


class TestEventEncoder(unittest.TestCase):
    """Test suite for EventEncoder class"""

    def test_encoder_initialization(self):
        """Test initializing an EventEncoder"""
        encoder = EventEncoder()
        self.assertIsInstance(encoder, EventEncoder)

        # Test with accept parameter
        encoder_with_accept = EventEncoder(accept=AGUI_MEDIA_TYPE)
        self.assertIsInstance(encoder_with_accept, EventEncoder)

    def test_encode_method(self):
        """Test the encode method which calls encode_sse"""
        # Create a test event
        timestamp = int(datetime.now().timestamp() * 1000)
        event = BaseEvent(type=EventType.RAW, timestamp=timestamp)
        
        # Create encoder and encode event
        encoder = EventEncoder()
        encoded = encoder.encode(event)
        
        # The encode method calls encode_sse, so the result should be in SSE format
        expected = f"data: {event.model_dump_json(by_alias=True, exclude_none=True)}\n\n"
        self.assertEqual(encoded, expected)
        
        # Verify that camelCase is used in the encoded output
        self.assertIn('"type":', encoded)
        self.assertIn('"timestamp":', encoded)
        # Raw event should be excluded if it's None
        self.assertNotIn('"rawEvent":', encoded)
        self.assertNotIn('"raw_event":', encoded)

    def test_encode_sse_method(self):
        """Test the encode_sse method"""
        # Create a test event with specific data
        event = TextMessageContentEvent(
            message_id="msg_123",
            delta="Hello, world!",
            timestamp=1648214400000
        )
        
        # Create encoder and encode event to SSE
        encoder = EventEncoder()
        encoded_sse = encoder._encode_sse(event)
        
        # Verify the format is correct for SSE (data: [json]\n\n)
        self.assertTrue(encoded_sse.startswith("data: "))
        self.assertTrue(encoded_sse.endswith("\n\n"))
        
        # Extract and verify the JSON content
        json_content = encoded_sse[6:-2]  # Remove "data: " prefix and "\n\n" suffix
        decoded = json.loads(json_content)
        
        # Check that all fields were properly encoded
        self.assertEqual(decoded["type"], "TEXT_MESSAGE_CONTENT")
        self.assertEqual(decoded["messageId"], "msg_123")  # Check snake_case converted to camelCase
        self.assertEqual(decoded["delta"], "Hello, world!")
        self.assertEqual(decoded["timestamp"], 1648214400000)
        
        # Verify that snake_case has been converted to camelCase
        self.assertIn("messageId", decoded)  # camelCase key exists
        self.assertNotIn("message_id", decoded)  # snake_case key doesn't exist

    def test_encode_with_different_event_types(self):
        """Test encoding different types of events"""
        # Create encoder
        encoder = EventEncoder()
        
        # Test with a basic BaseEvent
        base_event = BaseEvent(type=EventType.RAW, timestamp=1648214400000)
        encoded_base = encoder.encode(base_event)
        self.assertIn('"type":"RAW"', encoded_base)
        
        # Test with a more complex event
        content_event = TextMessageContentEvent(
            message_id="msg_456",
            delta="Testing different events",
            timestamp=1648214400000
        )
        encoded_content = encoder.encode(content_event)
        
        # Verify correct encoding and camelCase conversion
        self.assertIn('"type":"TEXT_MESSAGE_CONTENT"', encoded_content)
        self.assertIn('"messageId":"msg_456"', encoded_content)  # Check snake_case converted to camelCase
        self.assertIn('"delta":"Testing different events"', encoded_content)
        
        # Extract JSON and verify camelCase conversion
        json_content = encoded_content.split("data: ")[1].rstrip("\n\n")
        decoded = json.loads(json_content)
        
        # Verify messageId is camelCase (not message_id)
        self.assertIn("messageId", decoded)
        self.assertNotIn("message_id", decoded)
        
    def test_null_value_exclusion(self):
        """Test that fields with None values are excluded from the JSON output"""
        # Create an event with some fields set to None
        event = BaseEvent(
            type=EventType.RAW,
            timestamp=1648214400000,
            raw_event=None  # Explicitly set to None
        )
        
        # Create encoder and encode event
        encoder = EventEncoder()
        encoded = encoder.encode(event)
        
        # Extract JSON
        json_content = encoded.split("data: ")[1].rstrip("\n\n")
        decoded = json.loads(json_content)
        
        # Verify fields that are present
        self.assertIn("type", decoded)
        self.assertIn("timestamp", decoded)
        
        # Verify null fields are excluded
        self.assertNotIn("rawEvent", decoded)
        
        # Test with another event that has optional fields
        # Create event with some optional fields set to None
        event_with_optional = ToolCallStartEvent(
            tool_call_id="call_123",
            tool_call_name="test_tool",
            parent_message_id=None,  # Optional field explicitly set to None
            timestamp=1648214400000
        )
        
        encoded_optional = encoder.encode(event_with_optional)
        json_content_optional = encoded_optional.split("data: ")[1].rstrip("\n\n")
        decoded_optional = json.loads(json_content_optional)
        
        # Required fields should be present
        self.assertIn("toolCallId", decoded_optional)
        self.assertIn("toolCallName", decoded_optional)
        
        # Optional field with None value should be excluded
        self.assertNotIn("parentMessageId", decoded_optional)
        
    def test_round_trip_serialization(self):
        """Test that events can be serialized to JSON with camelCase and deserialized back correctly"""
        # Create a complex event with multiple fields
        original_event = ToolCallStartEvent(
            tool_call_id="call_abc123",
            tool_call_name="search_tool",
            parent_message_id="msg_parent_456",
            timestamp=1648214400000
        )
        
        # Serialize to JSON with camelCase fields
        json_str = original_event.model_dump_json(by_alias=True)
        
        # Verify JSON uses camelCase
        json_data = json.loads(json_str)
        self.assertIn("toolCallId", json_data)
        self.assertIn("toolCallName", json_data)
        self.assertIn("parentMessageId", json_data)
        self.assertNotIn("tool_call_id", json_data)
        self.assertNotIn("tool_call_name", json_data)
        self.assertNotIn("parent_message_id", json_data)
        
        # Deserialize back to an event
        deserialized_event = ToolCallStartEvent.model_validate_json(json_str)
        
        # Verify the deserialized event is equivalent to the original
        self.assertEqual(deserialized_event.type, original_event.type)
        self.assertEqual(deserialized_event.tool_call_id, original_event.tool_call_id)
        self.assertEqual(deserialized_event.tool_call_name, original_event.tool_call_name)
        self.assertEqual(deserialized_event.parent_message_id, original_event.parent_message_id)
        self.assertEqual(deserialized_event.timestamp, original_event.timestamp)
        
        # Verify complete equality using model_dump
        self.assertEqual(
            original_event.model_dump(), 
            deserialized_event.model_dump()
        )
