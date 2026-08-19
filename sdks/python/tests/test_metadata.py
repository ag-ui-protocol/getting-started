"""
Tests for the optional metadata object on every event and message.
"""

import json
import unittest

from ag_ui.core import (
    AGUI_METADATA_KEY,
    ActivityMessage,
    AssistantMessage,
    CustomEvent,
    DeveloperMessage,
    FunctionCall,
    EventType,
    ReasoningMessage,
    RunFinishedEvent,
    SystemMessage,
    TextMessageStartEvent,
    ToolCallResultEvent,
    ToolCall,
    ToolMessage,
    UserMessage,
)
from ag_ui.encoder import EventEncoder

# Every JSON shape the protocol promises survives a round trip.
VALUE_SHAPES = {
    "nullValue": None,
    "string": "finish_reason",
    "number": 42,
    "float": 1.5,
    "boolean": True,
    "emptyArray": [],
    "array": [1, "two", None, {"nested": True}],
    "emptyObject": {},
    "nested": {"usage": {"input": 10, "output": 20}, "tags": ["a", "b"]},
}


class TestMetadataOnEvents(unittest.TestCase):
    """Metadata is declared on BaseEvent, so every event type carries it."""

    def test_accepts_every_value_shape(self):
        event = TextMessageStartEvent(
            type=EventType.TEXT_MESSAGE_START,
            message_id="m1",
            metadata=VALUE_SHAPES,
        )
        self.assertEqual(event.metadata, VALUE_SHAPES)

    def test_absent_by_default(self):
        event = TextMessageStartEvent(
            type=EventType.TEXT_MESSAGE_START,
            message_id="m1",
        )
        self.assertIsNone(event.metadata)

    def test_accepts_empty_object(self):
        event = CustomEvent(type=EventType.CUSTOM, name="n", value=1, metadata={})
        self.assertEqual(event.metadata, {})

    def test_explicit_null_reads_back_as_absent(self):
        # A plain model_dump_json() emits "metadata": null for an unset object,
        # so parsing must accept it rather than reject the producer's own output.
        event = TextMessageStartEvent.model_validate(
            {"type": "TEXT_MESSAGE_START", "messageId": "m1", "metadata": None}
        )
        self.assertIsNone(event.metadata)

    def test_plain_model_dump_json_round_trips(self):
        original = TextMessageStartEvent(
            type=EventType.TEXT_MESSAGE_START, message_id="m1"
        )
        # No exclude_none here — this is the shape integrations commonly emit.
        restored = TextMessageStartEvent.model_validate_json(
            original.model_dump_json(by_alias=True)
        )
        self.assertIsNone(restored.metadata)

    def test_json_round_trip(self):
        event = ToolCallResultEvent(
            type=EventType.TOOL_CALL_RESULT,
            message_id="m1",
            tool_call_id="tc1",
            content="done",
            metadata=VALUE_SHAPES,
        )
        restored = ToolCallResultEvent.model_validate_json(
            event.model_dump_json(by_alias=True)
        )
        self.assertEqual(restored.metadata, VALUE_SHAPES)

    def test_non_message_event_carries_metadata(self):
        event = RunFinishedEvent(
            type=EventType.RUN_FINISHED,
            thread_id="t1",
            run_id="r1",
            metadata={"usage": {"total": 100}},
        )
        self.assertEqual(event.metadata, {"usage": {"total": 100}})


class TestMetadataOnMessages(unittest.TestCase):
    """Every message type carries metadata."""

    def _cases(self):
        return [
            (DeveloperMessage, {"id": "1", "content": "c"}),
            (SystemMessage, {"id": "1", "content": "c"}),
            (AssistantMessage, {"id": "1", "content": "c"}),
            (UserMessage, {"id": "1", "content": "c"}),
            (ToolMessage, {"id": "1", "content": "c", "tool_call_id": "tc1"}),
            (
                ActivityMessage,
                {"id": "1", "activity_type": "PLAN", "content": {}},
            ),
            (ReasoningMessage, {"id": "1", "content": "c"}),
        ]

    def test_all_message_types_carry_metadata(self):
        for cls, base in self._cases():
            with self.subTest(cls=cls.__name__):
                message = cls(**base, metadata=VALUE_SHAPES)
                self.assertEqual(message.metadata, VALUE_SHAPES)

    def test_all_message_types_allow_absent_metadata(self):
        for cls, base in self._cases():
            with self.subTest(cls=cls.__name__):
                self.assertIsNone(cls(**base).metadata)

    def test_all_message_types_read_null_metadata_as_absent(self):
        for cls, base in self._cases():
            with self.subTest(cls=cls.__name__):
                self.assertIsNone(cls(**base, metadata=None).metadata)

    def test_all_message_types_survive_a_plain_json_round_trip(self):
        for cls, base in self._cases():
            with self.subTest(cls=cls.__name__):
                original = cls(**base)
                restored = cls.model_validate_json(original.model_dump_json(by_alias=True))
                self.assertIsNone(restored.metadata)

    def test_message_json_round_trip(self):
        message = AssistantMessage(
            id="1", content="hello", metadata={AGUI_METADATA_KEY: {"usage": {"input": 1}}}
        )
        restored = AssistantMessage.model_validate_json(
            message.model_dump_json(by_alias=True)
        )
        self.assertEqual(restored.metadata, {AGUI_METADATA_KEY: {"usage": {"input": 1}}})


class TestMetadataOnToolCalls(unittest.TestCase):
    """
    A tool call is not a message, so it carries its own metadata rather than
    folding into the assistant message that owns it.
    """

    def test_tool_call_carries_metadata(self):
        call = ToolCall(
            id="tc1",
            function=FunctionCall(name="search", arguments="{}"),
            metadata=VALUE_SHAPES,
        )
        self.assertEqual(call.metadata, VALUE_SHAPES)

    def test_tool_call_metadata_is_optional(self):
        call = ToolCall(id="tc1", function=FunctionCall(name="search", arguments="{}"))
        self.assertIsNone(call.metadata)

    def test_tool_calls_keep_their_metadata_separate(self):
        message = AssistantMessage(
            id="m1",
            tool_calls=[
                ToolCall(
                    id="tc1",
                    function=FunctionCall(name="a", arguments="{}"),
                    metadata={"phase": "one"},
                ),
                ToolCall(id="tc2", function=FunctionCall(name="b", arguments="{}")),
            ],
        )
        restored = AssistantMessage.model_validate_json(
            message.model_dump_json(by_alias=True)
        )
        self.assertEqual(restored.tool_calls[0].metadata, {"phase": "one"})
        self.assertIsNone(restored.tool_calls[1].metadata)
        self.assertIsNone(restored.metadata)


class TestMetadataEncoding(unittest.TestCase):
    """
    The encoder omits an absent metadata object rather than emitting null, so
    AG-UI never puts a null on the wire in place of the object. Consumers still
    tolerate one, but producing it is not the protocol's shape.
    """

    def test_absent_metadata_is_omitted_from_the_wire(self):
        encoded = EventEncoder().encode(
            TextMessageStartEvent(type=EventType.TEXT_MESSAGE_START, message_id="m1")
        )
        payload = json.loads(encoded[len("data: ") :].strip())
        self.assertNotIn("metadata", payload)

    def test_nested_nulls_survive_exclude_none(self):
        # exclude_none must only drop the unset field itself, never recurse into
        # the bag. Everything below metadata is plain dict/list data, not model
        # fields, so a null nested at any depth is data and has to survive.
        metadata = {
            "usage": {"cost": None, "tokens": {"input": None}},
            "trace": [None, {"span": None}],
        }
        encoded = EventEncoder().encode(
            TextMessageStartEvent(
                type=EventType.TEXT_MESSAGE_START,
                message_id="m1",
                metadata=metadata,
            )
        )
        payload = json.loads(encoded[len("data: ") :].strip())
        self.assertEqual(payload["metadata"], metadata)

    def test_present_metadata_is_encoded(self):
        encoded = EventEncoder().encode(
            TextMessageStartEvent(
                type=EventType.TEXT_MESSAGE_START,
                message_id="m1",
                metadata={"source": "openai", "nullValue": None},
            )
        )
        payload = json.loads(encoded[len("data: ") :].strip())
        # exclude_none must not strip null values *inside* metadata, only the
        # absent object itself.
        self.assertEqual(payload["metadata"], {"source": "openai", "nullValue": None})


if __name__ == "__main__":
    unittest.main()
