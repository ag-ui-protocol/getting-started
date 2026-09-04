"""
The generated models — the public SDK's source since PNI-213 — against the
fixture corpus.

The fixtures are the behavioural contract, so the models must agree with them
wherever the semantics are meant to coincide. The models are the TOLERANT
layer, though (the strict contract is the spec's own validation corpus), so a
recorded set of invalid fixtures is expected to parse: unknown keys survive
for the strip-and-warn layer, an explicit null on an optional field means
absent, and a const field's only legal value fills in when omitted.
"""

import json
import unittest
from pathlib import Path

from pydantic import TypeAdapter, ValidationError

from ag_ui._generated import models as generated
from ag_ui._generated import version as generated_version

FIXTURES = (
    Path(__file__).resolve().parents[3] / "spec" / "draft" / "fixtures"
)

GENERATED_EVENT = TypeAdapter(generated.Event)
GENERATED_MESSAGE = TypeAdapter(generated.Message)

# What the wire (encoder) form of a dump looks like: the EventEncoder
# serializes with by_alias and exclude_none, exactly as it always has.
WIRE_DUMP = {"by_alias": True, "exclude_none": True}


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


def adapter_for(anchor):
    return TypeAdapter(getattr(generated, anchor))


# The invalid fixtures the tolerant layer accepts, each one a recorded
# tolerance rather than an oversight. Four classes:
#   unknown-keys — closure belongs to the spec; unknown fields survive here.
#   null-means-absent — idiomatic Python passes None for optionals; the
#     encoder's exclude_none keeps it off the wire.
#   const-fills-in — a field with exactly one legal value defaults to it,
#     so nothing is invented by accepting its omission.
#   lax-coercion — pydantic's default coercion, kept deliberately (see
#     PublicErgonomics.test_lax_coercion_is_the_public_layer): "yes" becomes
#     True here, and the spec's own corpus is what rejects it.
TOLERATED_INVALID = {
    # The pre-1.0 `subAgents` spelling is an unknown key now, not an alias:
    # it survives the parse as an extra but never reaches `subagents`.
    "AgentCapabilities/invalid/old-subagents-key.json": "unknown-keys",
    "AgentCapabilities/invalid/custom-null.json": "null-means-absent",
    "AgentCapabilities/invalid/metadata-null.json": "null-means-absent",
    "AgentCapabilities/invalid/streaming-not-boolean.json": "lax-coercion",
    "MultiAgentCapabilities/invalid/old-subagents-key.json": "unknown-keys",
    "MessagesSnapshotEvent/invalid/message-metadata-null.json": "null-means-absent",
    "ReasoningMessageStartEvent/invalid/role-missing.json": "const-fills-in",
    "RunFinishedEvent/invalid/outcome-null.json": "null-means-absent",
    "RunFinishedEvent/invalid/outcome-success-carrying-interrupts.json": "unknown-keys",
    "SubagentErrorEvent/invalid/code-null.json": "null-means-absent",
    "SubagentFinishedEvent/invalid/outcome-null.json": "null-means-absent",
    "SubagentFinishedEvent/invalid/outcome-success-carrying-interrupt-ids.json": "unknown-keys",
    "SubagentStartedEvent/invalid/description-null.json": "null-means-absent",
    "TextMessageContentEvent/invalid/metadata-null.json": "null-means-absent",
    "TextMessageContentEvent/invalid/subagent-run-id-null.json": "null-means-absent",
    "TextMessageEndEvent/invalid/unknown-property.json": "unknown-keys",
    "ToolCallChunkEvent/invalid/parent-message-id-null.json": "null-means-absent",
    "ToolCallStartEvent/invalid/parent-message-id-null.json": "null-means-absent",
}


class GeneratedModelsAgainstFixtures(unittest.TestCase):
    def test_valid_fixtures_parse(self):
        for name, anchor, document in collect("valid"):
            with self.subTest(name):
                adapter_for(anchor).validate_python(document)

    def test_invalid_fixtures_fail_except_the_recorded_tolerances(self):
        # Exactly the recorded set parses — an entry that stops parsing is a
        # tolerance silently lost, an unlisted one that parses is a tolerance
        # silently gained; both fail here.
        for name, anchor, document in collect("invalid"):
            with self.subTest(name):
                try:
                    adapter_for(anchor).validate_python(document)
                except ValidationError:
                    self.assertNotIn(name, TOLERATED_INVALID)
                else:
                    self.assertIn(name, TOLERATED_INVALID)

    def test_valid_event_fixtures_parse_through_the_union(self):
        event_types = {value.value for value in generated.EventType}
        for name, anchor, document in collect("valid"):
            if not isinstance(document, dict):
                continue
            if document.get("type") not in event_types:
                continue
            with self.subTest(name):
                GENERATED_EVENT.validate_python(document)

    def test_message_fixtures_parse_through_the_union(self):
        for name, anchor, document in collect("valid"):
            if not anchor.endswith("Message"):
                continue
            with self.subTest(name):
                GENERATED_MESSAGE.validate_python(document)

    def test_unknown_fields_survive_the_parse(self):
        # The tolerant layer's promise: unknown fields are kept, not dropped,
        # so the strip-and-warn enforcement stage can see them and a
        # re-serialising intermediary does not lose them.
        for name, anchor, document in collect("valid"):
            if not isinstance(document, dict):
                continue
            with self.subTest(name):
                probed = {**document, "xPassthroughProbe": 1}
                parsed = adapter_for(anchor).validate_python(probed)
                self.assertEqual(parsed.model_dump()["xPassthroughProbe"], 1)

    def test_wire_dump_never_emits_null_for_an_absent_field(self):
        # The encoder form (by_alias, exclude_none) is the wire: a field that
        # has no value is left out, never spelled null. An explicit null that
        # IS data on a required field is the encoder's job to restore — see
        # TestWireNullParity in test_encoder.py.
        for name, anchor, document in collect("valid"):
            with self.subTest(name):
                parsed = adapter_for(anchor).validate_python(document)
                dumped = json.loads(parsed.model_dump_json(**WIRE_DUMP))
                for key, value in dumped.items():
                    self.assertIsNotNone(value, f"{key} reached the wire as null")


class PublicErgonomics(unittest.TestCase):
    """
    The config choices that make the generated models the PUBLIC models,
    pinned so a silent regression to the old wire-fidelity config (strict on,
    alias-only population, null rejection) fails here rather than in every
    downstream integration.
    """

    def test_snake_case_and_alias_both_populate(self):
        by_name = generated.TextMessageStartEvent(message_id="m1")
        by_alias = generated.TextMessageStartEvent.model_validate(
            {"type": "TEXT_MESSAGE_START", "messageId": "m1"}
        )
        self.assertEqual(by_name.message_id, by_alias.message_id)

    def test_discriminators_default_so_constructors_never_spell_them(self):
        event = generated.RunFinishedEvent(thread_id="t", run_id="r")
        self.assertEqual(event.type, generated.EventType.RUN_FINISHED)
        call = generated.ToolCall(
            id="c1", function=generated.FunctionCall(name="f", arguments="{}")
        )
        self.assertEqual(call.type, "function")

    def test_schema_defaults_stay_documentation(self):
        # An absent role MEANS assistant and an absent replace MEANS replace —
        # normative prose, never materialised (as in TypeScript since
        # PNI-212).
        self.assertIsNone(generated.TextMessageStartEvent(message_id="m").role)
        self.assertIsNone(
            generated.ActivitySnapshotEvent(
                message_id="m", activity_type="a", content={}
            ).replace
        )

    def test_explicit_none_means_absent(self):
        event = generated.TextMessageStartEvent(message_id="m", name=None)
        self.assertNotIn("name", json.loads(event.model_dump_json(**WIRE_DUMP)))

    def test_lax_coercion_is_the_public_layer(self):
        # pydantic's default coercion, as the hand-written models always had:
        # the STRICT contract is the spec's validation corpus, not this class.
        event = GENERATED_EVENT.validate_python(
            {
                "type": "TEXT_MESSAGE_CONTENT",
                "messageId": "m",
                "delta": "d",
                "timestamp": "42",
            }
        )
        self.assertEqual(event.timestamp, 42)

    def test_the_hierarchy_supports_isinstance(self):
        event = generated.StepStartedEvent(step_name="s")
        self.assertIsInstance(event, generated.BaseEvent)
        message = generated.UserMessage(id="1", content="hi")
        self.assertIsInstance(message, generated.BaseMessage)
        # Tool/activity/reasoning messages do not compose BaseMessage — the
        # schema says so, and the hand-written hierarchy said the same.
        tool = generated.ToolMessage(id="1", content="c", tool_call_id="tc")
        self.assertNotIsInstance(tool, generated.BaseMessage)


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
