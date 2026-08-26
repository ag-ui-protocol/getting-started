import json
import unittest

from pydantic import TypeAdapter

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

    def test_a_pre_existing_event_serializes_exactly_as_before(self):
        # The additive guarantee: an event from before this field existed keeps
        # the same keys and values, so no consumer sees a change.
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
