import json
import unittest

from pydantic import TypeAdapter, ValidationError

from ag_ui.core.events import Event, EventType, ToolCallResultEvent


class TestToolCallResultError(unittest.TestCase):
    """The optional `error` on TOOL_CALL_RESULT — the event-side twin of ToolMessage.error."""

    def _base(self, **overrides):
        kwargs = dict(
            type=EventType.TOOL_CALL_RESULT,
            message_id="msg_1",
            tool_call_id="tc_1",
            content='{"hits":2}',
        )
        kwargs.update(overrides)
        return ToolCallResultEvent(**kwargs)

    def test_error_is_a_declared_field_not_an_extra(self):
        # ConfiguredBaseModel uses extra="allow", so simply passing error= and
        # reading it back would pass even if the field were never declared.
        # model_fields is the assertion that actually proves the declaration.
        self.assertIn("error", ToolCallResultEvent.model_fields)

    def test_defaults_to_none_and_is_omitted_from_the_wire(self):
        event = self._base()
        self.assertIsNone(event.error)
        self.assertNotIn("error", json.loads(event.model_dump_json(by_alias=True)))

    def test_carries_a_real_error_string(self):
        event = self._base(content="", error="SearchTimeout: upstream did not respond within 30s")
        self.assertEqual(event.error, "SearchTimeout: upstream did not respond within 30s")
        self.assertEqual(
            json.loads(event.model_dump_json(by_alias=True))["error"],
            "SearchTimeout: upstream did not respond within 30s",
        )

    def test_empty_string_error_survives_rather_than_being_dropped(self):
        # Omission applies to None, not to a falsy value the producer chose to
        # send. An empty string must not silently become "the call succeeded".
        event = self._base(error="")
        self.assertEqual(event.error, "")
        self.assertEqual(json.loads(event.model_dump_json(by_alias=True))["error"], "")

    def test_a_non_string_error_is_rejected(self):
        # The narrowing half of the field's source comment, which nothing pinned: before
        # `error` was declared, extra="allow" let an `error` of ANY shape ride through as an
        # extra, and declaring it as Optional[str] is what makes a non-string fail
        # validation. Widening the annotation back to Optional[Any] leaves every other test
        # in this suite green, so this is the only assertion standing between the declared
        # type and a silent return to "anything goes".
        adapter = TypeAdapter(Event)
        for value in (42, {"code": "SearchTimeout"}, ["SearchTimeout"], True):
            with self.subTest(error=value):
                with self.assertRaises(ValidationError) as caught:
                    adapter.validate_python(
                        {
                            "type": "TOOL_CALL_RESULT",
                            "messageId": "msg_1",
                            "toolCallId": "tc_1",
                            "content": "",
                            "error": value,
                        }
                    )
                self.assertEqual(
                    ["string_type"], [detail["type"] for detail in caught.exception.errors()]
                )

    def test_an_explicit_null_error_validates_and_is_re_emitted_as_omission(self):
        # The other half of the same comment. Unlike the TypeScript schema, which rejects an
        # explicit null on every new optional field, this SDK accepts one and reads it back
        # as None — as it does for every optional field here. What the contract guarantees is
        # not that a null is refused but that none is ever WRITTEN, so the re-emitted payload
        # has to carry no `error` key at all rather than `"error": null`.
        event = TypeAdapter(Event).validate_python(
            {
                "type": "TOOL_CALL_RESULT",
                "messageId": "msg_1",
                "toolCallId": "tc_1",
                "content": "ok",
                "error": None,
            }
        )
        self.assertIsInstance(event, ToolCallResultEvent)
        self.assertIsNone(event.error)

        encoded = event.model_dump_json(by_alias=True)
        self.assertNotIn('"error"', encoded)
        self.assertEqual(
            {
                "type": "TOOL_CALL_RESULT",
                "messageId": "msg_1",
                "toolCallId": "tc_1",
                "content": "ok",
            },
            json.loads(encoded),
        )

    def test_round_trips_through_json(self):
        event = self._base(content="", error="boom")
        restored = ToolCallResultEvent.model_validate_json(event.model_dump_json(by_alias=True))
        self.assertEqual(restored.error, "boom")
        self.assertEqual(restored.tool_call_id, "tc_1")

    def test_discriminated_union_still_resolves_tool_call_result(self):
        adapter = TypeAdapter(Event)
        with_error = adapter.validate_python(
            {
                "type": "TOOL_CALL_RESULT",
                "messageId": "msg_1",
                "toolCallId": "tc_1",
                "content": "",
                "error": "boom",
            }
        )
        self.assertIsInstance(with_error, ToolCallResultEvent)
        self.assertEqual(with_error.error, "boom")

        without_error = adapter.validate_python(
            {
                "type": "TOOL_CALL_RESULT",
                "messageId": "msg_1",
                "toolCallId": "tc_1",
                "content": "ok",
            }
        )
        self.assertIsInstance(without_error, ToolCallResultEvent)
        self.assertIsNone(without_error.error)

    def test_an_event_without_an_error_round_trips_to_the_same_keys_and_values(self):
        # The compat guarantee for a producer that never writes `error`: no key
        # gains or loses a value. Not a byte comparison — dict equality ignores
        # key order, which is the right strength here: key order is a serializer
        # detail, not part of the wire contract.
        legacy_wire = {
            "type": "TOOL_CALL_RESULT",
            "messageId": "msg_1",
            "toolCallId": "tc_1",
            "content": '{"hits":2}',
            "role": "tool",
        }
        event = ToolCallResultEvent.model_validate(legacy_wire)
        self.assertEqual(json.loads(event.model_dump_json(by_alias=True)), legacy_wire)


if __name__ == "__main__":
    unittest.main()
