"""Tests for text message events with different roles."""

import unittest
from pydantic import ValidationError
from ag_ui.core import (
    EventType,
    TextMessageStartEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    TextMessageChunkEvent,
    Role,
)

# Test all available roles for text messages (excluding "tool")
TEXT_MESSAGE_ROLES = ["developer", "system", "assistant", "user"]


class TestTextMessageRoles(unittest.TestCase):
    """Test text message events with different roles."""

    def test_text_message_start_with_all_roles(self) -> None:
        """Test TextMessageStartEvent with different roles."""
        for role in TEXT_MESSAGE_ROLES:
            with self.subTest(role=role):
                event = TextMessageStartEvent(
                    message_id="test-msg",
                    role=role,
                )
                
                self.assertEqual(event.type, EventType.TEXT_MESSAGE_START)
                self.assertEqual(event.message_id, "test-msg")
                self.assertEqual(event.role, role)

    def test_text_message_chunk_with_all_roles(self) -> None:
        """Test TextMessageChunkEvent with different roles."""
        for role in TEXT_MESSAGE_ROLES:
            with self.subTest(role=role):
                event = TextMessageChunkEvent(
                    message_id="test-msg",
                    role=role,
                    delta=f"Hello from {role}",
                )
                
                self.assertEqual(event.type, EventType.TEXT_MESSAGE_CHUNK)
                self.assertEqual(event.message_id, "test-msg")
                self.assertEqual(event.role, role)
                self.assertEqual(event.delta, f"Hello from {role}")

    def test_text_message_chunk_without_role(self) -> None:
        """Test TextMessageChunkEvent without role (should be optional)."""
        event = TextMessageChunkEvent(
            message_id="test-msg",
            delta="Hello without role",
        )
        
        self.assertEqual(event.type, EventType.TEXT_MESSAGE_CHUNK)
        self.assertEqual(event.message_id, "test-msg")
        self.assertIsNone(event.role)
        self.assertEqual(event.delta, "Hello without role")

    def test_multiple_messages_different_roles(self) -> None:
        """Test creating multiple messages with different roles."""
        events = []
        
        for role in TEXT_MESSAGE_ROLES:
            start_event = TextMessageStartEvent(
                message_id=f"msg-{role}",
                role=role,
            )
            content_event = TextMessageContentEvent(
                message_id=f"msg-{role}",
                delta=f"Message from {role}",
            )
            end_event = TextMessageEndEvent(
                message_id=f"msg-{role}",
            )
            
            events.extend([start_event, content_event, end_event])
        
        # Verify we have 3 events per role
        self.assertEqual(len(events), len(TEXT_MESSAGE_ROLES) * 3)
        
        # Verify each start event has the correct role
        for i, role in enumerate(TEXT_MESSAGE_ROLES):
            start_event = events[i * 3]
            self.assertIsInstance(start_event, TextMessageStartEvent)
            self.assertEqual(start_event.role, role)
            self.assertEqual(start_event.message_id, f"msg-{role}")

    def test_text_message_serialization(self) -> None:
        """Test that text message events serialize correctly with roles."""
        for role in TEXT_MESSAGE_ROLES:
            with self.subTest(role=role):
                event = TextMessageStartEvent(
                    message_id="test-msg",
                    role=role,
                )
                
                # Convert to dict and back
                event_dict = event.model_dump()
                self.assertEqual(event_dict["role"], role)
                self.assertEqual(event_dict["type"], EventType.TEXT_MESSAGE_START)
                self.assertEqual(event_dict["message_id"], "test-msg")
                
                # Recreate from dict
                new_event = TextMessageStartEvent(**event_dict)
                self.assertEqual(new_event.role, role)
                self.assertEqual(new_event, event)

    def test_invalid_role_rejected(self) -> None:
        """Test that invalid roles are rejected."""
        # Test with completely invalid role
        with self.assertRaises(ValidationError):
            TextMessageStartEvent(
                message_id="test-msg",
                role="invalid_role",  # type: ignore
            )
        
        # Test that 'tool' role is not allowed for text messages
        with self.assertRaises(ValidationError):
            TextMessageStartEvent(
                message_id="test-msg",
                role="tool",  # type: ignore
            )
        
        # Test that 'tool' role is not allowed for chunks either
        with self.assertRaises(ValidationError):
            TextMessageChunkEvent(
                message_id="test-msg",
                role="tool",  # type: ignore
                delta="Tool message",
            )

    def test_text_message_start_name_preserved_with_roles(self) -> None:
        """Test that name is preserved alongside role."""
        for role in TEXT_MESSAGE_ROLES:
            with self.subTest(role=role):
                event = TextMessageStartEvent(
                    message_id="test-msg",
                    role=role,
                    name="test-agent",
                )
                self.assertEqual(event.role, role)
                self.assertEqual(event.name, "test-agent")

    def test_text_message_start_default_role(self) -> None:
        """Test that TextMessageStartEvent defaults to 'assistant' role."""
        event = TextMessageStartEvent(
            message_id="test-msg",
        )
        
        self.assertEqual(event.type, EventType.TEXT_MESSAGE_START)
        self.assertEqual(event.message_id, "test-msg")
        # An absent role MEANS assistant (schema prose); the default is
        # documentation and is never materialised, as in TypeScript.
        self.assertIsNone(event.role)


if __name__ == "__main__":
    unittest.main()