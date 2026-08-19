import unittest
from pydantic import ValidationError

from ag_ui.core.types import Interrupt, ResumeEntry, RunAgentInput


class InterruptTest(unittest.TestCase):
    def test_required_fields_only(self):
        i = Interrupt(id="int-1", reason="tool_call")
        self.assertEqual(i.id, "int-1")
        self.assertEqual(i.reason, "tool_call")
        self.assertIsNone(i.message)
        self.assertIsNone(i.tool_call_id)

    def test_all_optional_fields(self):
        i = Interrupt(
            id="int-1",
            reason="input_required",
            message="Approve?",
            tool_call_id="tc-1",
            response_schema={"type": "object"},
            expires_at="2099-01-01T00:00:00Z",
            metadata={"foo": "bar"},
        )
        self.assertEqual(i.tool_call_id, "tc-1")
        self.assertEqual(i.response_schema, {"type": "object"})

    def test_alias_camel_case_on_serialization(self):
        i = Interrupt(id="int-1", reason="tool_call", tool_call_id="tc-1")
        dumped = i.model_dump(by_alias=True)
        self.assertIn("toolCallId", dumped)
        self.assertNotIn("tool_call_id", dumped)

    def test_parse_from_camel_case(self):
        i = Interrupt.model_validate({"id": "int-1", "reason": "tool_call", "toolCallId": "tc-1"})
        self.assertEqual(i.tool_call_id, "tc-1")

    def test_rejects_missing_id(self):
        with self.assertRaises(ValidationError):
            Interrupt(reason="tool_call")

    def test_rejects_missing_reason(self):
        with self.assertRaises(ValidationError):
            Interrupt(id="int-1")


class ResumeEntryTest(unittest.TestCase):
    def test_resolved_with_payload(self):
        r = ResumeEntry(interrupt_id="int-1", status="resolved", payload={"approved": True})
        self.assertEqual(r.status, "resolved")
        self.assertEqual(r.payload, {"approved": True})

    def test_cancelled_without_payload(self):
        r = ResumeEntry(interrupt_id="int-1", status="cancelled")
        self.assertEqual(r.status, "cancelled")
        self.assertIsNone(r.payload)

    def test_rejects_unknown_status(self):
        with self.assertRaises(ValidationError):
            ResumeEntry(interrupt_id="int-1", status="denied")

    def test_rejects_missing_interrupt_id(self):
        with self.assertRaises(ValidationError):
            ResumeEntry(status="resolved")

    def test_alias_camel_case_on_serialization(self):
        r = ResumeEntry(interrupt_id="int-1", status="resolved", payload={"approved": True})
        dumped = r.model_dump(by_alias=True)
        self.assertIn("interruptId", dumped)
        self.assertNotIn("interrupt_id", dumped)

    def test_parse_from_camel_case(self):
        r = ResumeEntry.model_validate({"interruptId": "int-1", "status": "cancelled"})
        self.assertEqual(r.interrupt_id, "int-1")
        self.assertEqual(r.status, "cancelled")


class ResumeEntryMetadataTest(unittest.TestCase):
    """
    Metadata on a resume entry follows the same conventions as everywhere else:
    open by key, any JSON value including None under a key, the object itself
    absent or a mapping but never null on the wire.
    """

    # Every JSON shape the protocol promises survives a round trip.
    VALUE_SHAPES = {
        "nullValue": None,
        "string": "afterModel-review",
        "number": 42,
        "float": 1.5,
        "boolean": True,
        "emptyArray": [],
        "array": [1, "two", None, {"nested": True}],
        "emptyObject": {},
        "nested": {"signature": {"alg": "ed25519", "hash": "abc"}, "tags": ["a", "b"]},
    }

    def test_absent_by_default(self):
        r = ResumeEntry(interrupt_id="int-1", status="resolved")
        self.assertIsNone(r.metadata)

    def test_json_round_trip_of_every_value_shape(self):
        r = ResumeEntry(interrupt_id="int-1", status="resolved", metadata=self.VALUE_SHAPES)
        restored = ResumeEntry.model_validate_json(r.model_dump_json(by_alias=True))
        self.assertEqual(restored.metadata, self.VALUE_SHAPES)

    def test_empty_object_round_trips_distinct_from_absent(self):
        r = ResumeEntry(interrupt_id="int-1", status="resolved", metadata={})
        restored = ResumeEntry.model_validate_json(r.model_dump_json(by_alias=True))
        self.assertEqual(restored.metadata, {})

    def test_explicit_null_reads_back_as_absent(self):
        r = ResumeEntry.model_validate(
            {"interruptId": "int-1", "status": "resolved", "metadata": None}
        )
        self.assertIsNone(r.metadata)

    def test_plain_model_dump_json_round_trips(self):
        # No exclude_none here — this is the shape integrations commonly emit.
        original = ResumeEntry(interrupt_id="int-1", status="cancelled")
        restored = ResumeEntry.model_validate_json(original.model_dump_json(by_alias=True))
        self.assertIsNone(restored.metadata)

    def test_absent_metadata_serializes_without_the_key(self):
        r = ResumeEntry(interrupt_id="int-1", status="resolved", payload={"approved": True})
        dumped = r.model_dump(by_alias=True, exclude_none=True)
        self.assertNotIn("metadata", dumped)

    def test_exclude_none_preserves_null_values_under_keys(self):
        # exclude_none must only drop the unset object itself, never recurse
        # into metadata values — a None under a key is data.
        r = ResumeEntry(
            interrupt_id="int-1",
            status="resolved",
            metadata={"source": "ui", "nullValue": None},
        )
        dumped = r.model_dump(by_alias=True, exclude_none=True)
        self.assertEqual(dumped["metadata"], {"source": "ui", "nullValue": None})

    def test_carried_on_cancelled_entries_too(self):
        r = ResumeEntry(interrupt_id="int-1", status="cancelled", metadata={"reason": "timeout"})
        self.assertEqual(r.metadata, {"reason": "timeout"})

    def test_reaches_the_agent_through_run_agent_input(self):
        i = RunAgentInput.model_validate(
            {
                "threadId": "t-1",
                "runId": "r-1",
                "state": {},
                "messages": [],
                "tools": [],
                "context": [],
                "forwardedProps": {},
                "resume": [
                    {
                        "interruptId": "generic-1",
                        "status": "resolved",
                        "payload": {"approved": True},
                        "metadata": {
                            "ag-ui": {},
                            "definitionId": "review-plan",
                            "key": "afterModel-review",
                        },
                    }
                ],
            }
        )
        self.assertEqual(
            i.resume[0].metadata,
            {"ag-ui": {}, "definitionId": "review-plan", "key": "afterModel-review"},
        )


class RunAgentInputResumeTest(unittest.TestCase):
    def _base_input(self, **overrides):
        base = dict(
            thread_id="t-1",
            run_id="r-1",
            state={},
            messages=[],
            tools=[],
            context=[],
            forwarded_props={},
        )
        base.update(overrides)
        return base

    def test_without_resume(self):
        i = RunAgentInput(**self._base_input())
        self.assertIsNone(i.resume)

    def test_with_resume(self):
        i = RunAgentInput(
            **self._base_input(
                resume=[
                    ResumeEntry(interrupt_id="int-1", status="resolved", payload={"approved": True}),
                    ResumeEntry(interrupt_id="int-2", status="cancelled"),
                ]
            )
        )
        self.assertEqual(len(i.resume), 2)
        self.assertEqual(i.resume[0].status, "resolved")


if __name__ == "__main__":
    unittest.main()
