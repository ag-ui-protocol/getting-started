"""
The generated models against the fixture corpus, and against the handwritten
models they sit alongside.

The fixtures are the behavioural contract, so the generated validators must
agree with them wherever the semantics are meant to coincide. The one
deliberate divergence is closure: the spec is strict and the generated models
are tolerant (unknown fields survive for the strip-and-warn middleware), so a
fixture rejected only by ``unevaluatedProperties`` is expected to parse.
"""

import json
import unittest
from pathlib import Path

from pydantic import TypeAdapter, ValidationError

from ag_ui._generated import models as generated
from ag_ui._generated import version as generated_version
from ag_ui.core import events as handwritten

FIXTURES = (
    Path(__file__).resolve().parents[3] / "spec" / "draft" / "fixtures"
)

GENERATED_EVENT = TypeAdapter(generated.Event)
GENERATED_MESSAGE = TypeAdapter(generated.Message)
HANDWRITTEN_EVENT = TypeAdapter(handwritten.Event)


def collect(kind):
    """Every fixture of one kind, as (name, anchor, document) triples."""
    entries = []
    for anchor_dir in sorted(FIXTURES.iterdir()):
        directory = anchor_dir / kind
        if not directory.is_dir():
            continue
        for path in sorted(directory.glob("*.json")):
            if path.name.endswith(".expect.json"):
                continue
            entries.append(
                (
                    f"{anchor_dir.name}/{kind}/{path.name}",
                    anchor_dir.name,
                    json.loads(path.read_text()),
                )
            )
    return entries


def expectation_keyword(name):
    """The keyword an invalid fixture's .expect.json pins."""
    path = FIXTURES / (name.removesuffix(".json") + ".expect.json")
    return json.loads(path.read_text())["keyword"]


def adapter_for(anchor):
    return TypeAdapter(getattr(generated, anchor))


class GeneratedModelsAgainstFixtures(unittest.TestCase):
    def test_valid_fixtures_parse(self):
        for name, anchor, document in collect("valid"):
            with self.subTest(name):
                adapter_for(anchor).validate_python(document)

    def test_invalid_fixtures_fail(self):
        for name, anchor, document in collect("invalid"):
            # Closure is the spec's; the tolerant layer accepts unknown keys.
            if expectation_keyword(name) == "unevaluatedProperties":
                continue
            with self.subTest(name):
                with self.assertRaises(ValidationError):
                    adapter_for(anchor).validate_python(document)

    def test_valid_event_fixtures_parse_through_the_union(self):
        event_anchors = {
            definition
            for definition in dir(generated)
            if definition.endswith("Event")
        }
        for name, anchor, document in collect("valid"):
            if anchor not in event_anchors:
                continue
            with self.subTest(name):
                GENERATED_EVENT.validate_python(document)

    def test_message_fixtures_parse_through_the_union(self):
        for name, anchor, document in collect("valid"):
            if anchor not in ("UserMessage", "ToolMessage"):
                continue
            with self.subTest(name):
                GENERATED_MESSAGE.validate_python(document)

    def test_unknown_fields_survive_the_parse(self):
        # The tolerant layer's promise: unknown fields are kept, not dropped,
        # so the strip-and-warn middleware can see them and a re-serialising
        # intermediary does not lose them.
        for name, anchor, document in collect("valid"):
            if not isinstance(document, dict):
                continue
            with self.subTest(name):
                probed = {**document, "xPassthroughProbe": 1}
                parsed = adapter_for(anchor).validate_python(probed)
                self.assertEqual(parsed.model_dump()["xPassthroughProbe"], 1)

    def test_serialization_never_emits_null_for_an_absent_field(self):
        # The reason this target exists: omission is the default. A field that
        # simply has no value is left out, not spelled null — while a null the
        # input actually carried (null as data, on an any-JSON field) is kept.
        for name, anchor, document in collect("valid"):
            with self.subTest(name):
                parsed = adapter_for(anchor).validate_python(document)
                dumped = json.loads(parsed.model_dump_json())
                for key, value in dumped.items():
                    if value is None:
                        self.assertTrue(
                            isinstance(document, dict)
                            and document.get(key) is None
                            and key in document,
                            f"{key} serialized as null without a null input",
                        )


# The handwritten models do not know these events yet: they land with the
# subagent PR (#2350). Until it merges they exist in the schema and the
# generated models only, which is expected.
HANDWRITTEN_UNSUPPORTED = {
    "SUBAGENT_STARTED",
    "SUBAGENT_FINISHED",
    "SUBAGENT_ERROR",
}

# Every place the handwritten JSON is allowed to differ from the generated
# JSON, recorded as (event type, field) -> why. The handwritten models apply
# schema defaults at parse time (the schema treats a default as
# documentation, so the generated models do not), which makes the handwritten
# dump carry a key the input never had.
RECORDED_DIVERGENCES = {
    ("TEXT_MESSAGE_START", "role"): "handwritten applies the default 'assistant'",
    ("ACTIVITY_SNAPSHOT", "replace"): "handwritten applies the default True",
    ("STATE_DELTA", "delta"): (
        "handwritten serializes with exclude_none, which drops a JSON Patch "
        "add/replace/test value of null; the generated models keep it — null "
        "there is data, not absence"
    ),
    ("CUSTOM", "value"): (
        "handwritten exclude_none drops an explicit null payload; the "
        "generated models keep it — on an any-JSON field null is data"
    ),
    ("TEXT_MESSAGE_END", "rawEvent"): (
        "handwritten exclude_none drops an explicit null rawEvent; the "
        "generated models keep it — on an any-JSON field null is data"
    ),
}

# Schema-valid documents the handwritten models reject outright, each a
# required-ness divergence RECONCILIATION.md already records.
RECORDED_HANDWRITTEN_REJECTIONS = {
    "RunStartedEvent/valid/with-input.json": (
        "handwritten RunAgentInput requires tools and context; the schema "
        "makes them optional"
    ),
}


class GeneratedAgainstHandwritten(unittest.TestCase):
    def test_same_json_for_the_same_input(self):
        event_types = {value.value for value in generated.EventType}
        for name, anchor, document in collect("valid"):
            if not isinstance(document, dict):
                continue
            if document.get("type") not in event_types:
                continue
            if document["type"] in HANDWRITTEN_UNSUPPORTED:
                with self.subTest(name), self.assertRaises(ValidationError):
                    HANDWRITTEN_EVENT.validate_python(document)
                continue
            with self.subTest(name):
                try:
                    parsed = HANDWRITTEN_EVENT.validate_python(document)
                except ValidationError:
                    self.assertIn(name, RECORDED_HANDWRITTEN_REJECTIONS)
                    continue
                ours = json.loads(
                    GENERATED_EVENT.validate_python(document).model_dump_json()
                )
                theirs = json.loads(
                    parsed.model_dump_json(by_alias=True, exclude_none=True)
                )
                for key in set(ours) | set(theirs):
                    # Presence matters: an omitted key and an explicit null
                    # must not compare equal, or data loss hides.
                    if (
                        (key in ours) == (key in theirs)
                        and ours.get(key) == theirs.get(key)
                    ):
                        continue
                    divergence = (document["type"], key)
                    self.assertIn(
                        divergence,
                        RECORDED_DIVERGENCES,
                        f"{name}: unrecorded difference on {key!r}: "
                        f"generated {ours.get(key)!r} vs handwritten {theirs.get(key)!r}",
                    )


class WireFidelity(unittest.TestCase):
    """
    The config choices that keep the generated models honest about the wire,
    each pinned so a silent regression (strict off, name-based validation on,
    exclude_none back) fails here rather than nowhere.
    """

    def test_no_lax_coercion(self):
        # The schema's "false" is not False and its "42" is not 42.
        for document in (
            {
                "type": "ACTIVITY_SNAPSHOT",
                "messageId": "m",
                "activityType": "p",
                "content": {},
                "replace": "false",
            },
            {
                "type": "TEXT_MESSAGE_CONTENT",
                "messageId": "m",
                "delta": "d",
                "timestamp": "42",
            },
        ):
            with self.subTest(document["type"]):
                with self.assertRaises(ValidationError):
                    GENERATED_EVENT.validate_python(document)

    def test_snake_case_is_not_a_wire_name(self):
        # An unknown message_id must not populate messageId — the tolerant
        # layer keeps unknown keys, it does not invent meaning for them.
        with self.assertRaises(ValidationError):
            GENERATED_EVENT.validate_python(
                {"type": "TEXT_MESSAGE_END", "message_id": "m"}
            )
        event = GENERATED_EVENT.validate_python(
            {"type": "TEXT_MESSAGE_END", "messageId": "m", "message_id": "other"}
        )
        self.assertEqual(event.message_id, "m")
        self.assertEqual(event.model_dump()["message_id"], "other")

    def test_null_as_data_survives_serialization(self):
        # exclude_unset, not exclude_none: an explicit null on an any-JSON
        # field is data and must come out the other side.
        custom = GENERATED_EVENT.validate_python(
            {"type": "CUSTOM", "name": "n", "value": None}
        )
        self.assertIn("value", json.loads(custom.model_dump_json()))
        delta = GENERATED_EVENT.validate_python(
            {"type": "STATE_DELTA", "delta": [{"op": "add", "path": "/x", "value": None}]}
        )
        operation = json.loads(delta.model_dump_json())["delta"][0]
        self.assertIn("value", operation)
        self.assertIsNone(operation["value"])


class GeneratedPackageShape(unittest.TestCase):
    def test_version_constant(self):
        self.assertEqual(generated_version.PROTOCOL_VERSION, "draft")

    def test_all_31_events_and_every_message_type_exist(self):
        self.assertEqual(len(list(generated.EventType)), 31)
        for role in ("Developer", "System", "Assistant", "User", "Tool",
                     "Activity", "Reasoning"):
            self.assertTrue(hasattr(generated, f"{role}Message"))


if __name__ == "__main__":
    unittest.main()
