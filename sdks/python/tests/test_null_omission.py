"""
Guards the rule that a producer omits a field with no value instead of writing ``null``.

Three tests, each doing a different job:

* ``TestNullOmissionSweep`` walks every wire type the SDK defines, by reflection, and fails
  on any ``null`` for a field that has no value. It is deliberately not a list of known
  fields — a new optional field is covered the moment it is declared.
* ``TestNullOmissionIsTheBaseModelsDoing`` reverts the setting on one class and shows the
  ``null`` come back, so a passing sweep can't be credited to something else.
* ``TestNullOmissionCrossLanguageFixture`` runs the shared fixture that the TypeScript and
  .NET SDKs run too, so all three are held to the same text.
"""

import enum
import json
import unittest
import warnings
from pathlib import Path
from typing import Any, Callable, Dict, List, Literal, Tuple, Type, Union, get_args, get_origin

from pydantic import BaseModel, SerializerFunctionWrapHandler, TypeAdapter, model_serializer

from ag_ui.core import capabilities as capabilities_module
from ag_ui.core import events as events_module
from ag_ui.core import types as types_module
from ag_ui.core.events import Event, ToolCallStartEvent
from ag_ui.core.types import ConfiguredBaseModel
from ag_ui.encoder.encoder import EventEncoder

FIXTURE_PATH = Path(__file__).resolve().parents[2] / "fixtures" / "null-omission.json"

SDK_NAME = "python"

# Placeholder values used to fill required fields when building a probe instance. Keyed by
# the concrete type the annotation resolves to.
_REQUIRED_FIELD_SAMPLES: Dict[Any, Any] = {
    str: "x",
    int: 1,
    float: 1.0,
    bool: True,
}


def _wire_model_classes() -> List[Type[ConfiguredBaseModel]]:
    """Every ``ConfiguredBaseModel`` subclass the SDK puts on the wire."""
    seen: Dict[str, Type[ConfiguredBaseModel]] = {}
    for module in (types_module, events_module, capabilities_module):
        for name in dir(module):
            candidate = getattr(module, name)
            if (
                isinstance(candidate, type)
                and issubclass(candidate, ConfiguredBaseModel)
                and candidate is not ConfiguredBaseModel
            ):
                seen[f"{candidate.__module__}.{candidate.__qualname__}"] = candidate
    return [seen[key] for key in sorted(seen)]


def _sample_for_annotation(annotation: Any) -> Any:
    """A minimal value that satisfies ``annotation``, or ``None`` if nothing fits."""
    try:
        if annotation in _REQUIRED_FIELD_SAMPLES:
            return _REQUIRED_FIELD_SAMPLES[annotation]
    except TypeError:  # unhashable annotation
        pass

    origin = get_origin(annotation)
    args = get_args(annotation)

    if annotation is Any or annotation is None:
        return None
    if origin is Literal:
        return args[0]
    if origin in (list, List):
        return []
    if origin in (dict, Dict):
        return {}
    if origin is Union:
        # A union of message or content variants: take the first member that yields
        # something. Which variant it is does not matter — the sweep runs over all of
        # them in their own right anyway.
        for arg in args:
            if arg is type(None):
                continue
            sample = _sample_for_annotation(arg)
            if sample is not None:
                return sample
        return None
    if isinstance(annotation, type) and issubclass(annotation, enum.Enum):
        return next(iter(annotation))
    if isinstance(annotation, type) and issubclass(annotation, BaseModel):
        return _build_probe(annotation)
    return None


# A handful of models carry cross-field invariants that a required-fields-only probe
# cannot satisfy (a list that must be non-empty, an at-least-one-of rule). They get a
# hand-written probe. This is a list of *constructors*, not of fields to check — the
# assertions still discover which fields must be omitted from the model itself.
_PROBE_OVERRIDES: Dict[str, Callable[[], BaseModel]] = {
    "RunFinishedInterruptOutcome": lambda: events_module.RunFinishedInterruptOutcome(
        interrupts=[types_module.Interrupt(id="int_1", reason="input_required")]
    ),
    "BinaryInputContent": lambda: types_module.BinaryInputContent(mime_type="text/plain", id="bin_1"),
}


def _build_probe(model: Type[BaseModel]) -> BaseModel:
    """
    Instantiate ``model`` with values for its required fields only.

    Every optional field is left at its default, which is the state this test cares
    about: a field with no value must not reach the wire.
    """
    with warnings.catch_warnings():
        # BinaryInputContent warns on construction; it is deprecated but still on the wire.
        warnings.simplefilter("ignore", DeprecationWarning)

        override = _PROBE_OVERRIDES.get(model.__qualname__)
        if override is not None:
            return override()

        kwargs: Dict[str, Any] = {}
        for name, field in model.model_fields.items():
            if not field.is_required():
                continue
            kwargs[name] = _sample_for_annotation(field.annotation)
        return model(**kwargs)


def _find_nulls(value: Any, path: str = "") -> List[str]:
    """Paths of every JSON ``null`` in ``value``, using JSON-Pointer-ish notation."""
    if value is None:
        return [path or "/"]
    if isinstance(value, dict):
        found: List[str] = []
        for key, item in value.items():
            found.extend(_find_nulls(item, f"{path}/{key}"))
        return found
    if isinstance(value, list):
        found = []
        for index, item in enumerate(value):
            found.extend(_find_nulls(item, f"{path}/{index}"))
        return found
    return []


def _permitted_null_paths(model: Type[BaseModel], probe: BaseModel) -> List[str]:
    """
    Top-level paths where this probe legitimately carries ``null``.

    A required field typed to accept anything (``state``, ``snapshot``, ``value``) has no
    placeholder to fill it with, so the probe holds ``None`` there and the contract says
    the key must still be written. Everything else must be absent.
    """
    permitted = []
    for name, field in model.model_fields.items():
        if not field.is_required():
            continue
        if getattr(probe, name, "missing") is None:
            # Both spellings, because the caller picks one with `by_alias`.
            permitted.append(f"/{name}")
            if field.alias is not None:
                permitted.append(f"/{field.alias}")
    return permitted


class TestNullOmissionSweep(unittest.TestCase):
    """No wire type serializes a field that has no value as ``null``."""

    def test_every_wire_type_omits_fields_without_a_value(self):
        models = _wire_model_classes()
        self.assertGreater(len(models), 30, "reflection found suspiciously few wire types")

        for model in models:
            with self.subTest(model=model.__qualname__):
                probe = _build_probe(model)
                permitted = _permitted_null_paths(model, probe)
                for by_alias in (True, False):
                    serialized = json.loads(probe.model_dump_json(by_alias=by_alias))
                    offending = sorted(set(_find_nulls(serialized)) - set(permitted))
                    self.assertEqual(
                        [],
                        offending,
                        f"{model.__qualname__} wrote null at {offending} "
                        f"(by_alias={by_alias}) for fields that have no value",
                    )

    def test_encoded_event_stream_contains_no_omittable_nulls(self):
        """The same sweep through the producer path an agent actually uses."""
        encoder = EventEncoder()
        event_models = [
            model
            for model in _wire_model_classes()
            if issubclass(model, events_module.BaseEvent) and model is not events_module.BaseEvent
        ]
        self.assertGreater(len(event_models), 25, "reflection found suspiciously few event types")

        for model in event_models:
            with self.subTest(event=model.__qualname__):
                probe = _build_probe(model)
                encoded = encoder.encode(probe)
                payload = json.loads(encoded[len("data: ") : -len("\n\n")])
                permitted = _permitted_null_paths(model, probe)
                offending = sorted(set(_find_nulls(payload)) - set(permitted))
                self.assertEqual([], offending, f"{model.__qualname__} encoded null at {offending}")


class TestNullOmissionIsTheBaseModelsDoing(unittest.TestCase):
    """
    The sweep above only means something if the base model is what makes it pass.

    Reverting the omission for a single class — by overriding the wrap serializer with a
    passthrough — has to bring the ``null`` straight back, both from ``model_dump_json``
    and through the encoder.
    """

    def _reverted_tool_call_start(self) -> Type[ToolCallStartEvent]:
        class ToolCallStartEventWithoutOmission(ToolCallStartEvent):
            @model_serializer(mode="wrap")
            def _serialize_without_omission(
                self,
                handler: SerializerFunctionWrapHandler,
            ) -> Dict[str, Any]:
                return handler(self)

        return ToolCallStartEventWithoutOmission

    def test_reverting_the_setting_reintroduces_the_null(self):
        event = self._reverted_tool_call_start()(tool_call_id="tc_1", tool_call_name="search")
        serialized = json.loads(event.model_dump_json(by_alias=True))
        self.assertIn(
            "parentMessageId",
            serialized,
            "reverting the base model's serializer should bring the null back; if it does "
            "not, the sweep is passing for some other reason and no longer proves anything",
        )
        self.assertIsNone(serialized["parentMessageId"])

    def test_reverting_the_setting_reintroduces_the_null_in_the_encoder(self):
        event = self._reverted_tool_call_start()(tool_call_id="tc_1", tool_call_name="search")
        encoded = EventEncoder().encode(event)
        self.assertIn('"parentMessageId":null', encoded)

    def test_omission_holds_for_the_unmodified_class(self):
        event = ToolCallStartEvent(tool_call_id="tc_1", tool_call_name="search")
        self.assertNotIn("parentMessageId", json.loads(event.model_dump_json(by_alias=True)))


class TestLegitimateNullsRoundTrip(unittest.TestCase):
    """Omission applies to fields with no value, not to ``null`` as a value."""

    def test_null_inside_a_metadata_dict_survives(self):
        interrupt = types_module.Interrupt(
            id="int_1", reason="input_required", metadata={"traceId": None}
        )
        serialized = json.loads(interrupt.model_dump_json(by_alias=True))
        self.assertEqual({"traceId": None}, serialized["metadata"])

    def test_null_extra_field_survives(self):
        event = events_module.StepStartedEvent(step_name="plan", vendorHint=None)
        serialized = json.loads(event.model_dump_json(by_alias=True))
        self.assertIn("vendorHint", serialized)
        self.assertIsNone(serialized["vendorHint"])

    def test_required_field_holding_null_survives(self):
        event = events_module.StateSnapshotEvent(snapshot=None)
        serialized = json.loads(event.model_dump_json(by_alias=True))
        self.assertIn("snapshot", serialized)
        self.assertIsNone(serialized["snapshot"])

    def test_run_agent_input_with_no_state_omits_the_key(self):
        """The state contract: optional, absent means no state, bare null reads
        as absent. All consumers surveyed collapse null into "no state", so the
        wire carries the one spelling every SDK can represent: omission.
        forwarded_props goes the same way: the schema settled it as optional
        across the SDKs (see spec/RECONCILIATION.md), so an unset one is left
        out rather than written as null."""
        original = types_module.RunAgentInput(
            thread_id="thread_1",
            run_id="run_1",
            state=None,
            messages=[],
            tools=[],
            context=[],
            forwarded_props=None,
        )
        encoded = original.model_dump_json(by_alias=True)
        self.assertNotIn('"state"', encoded)
        self.assertNotIn('"forwardedProps"', encoded)
        self.assertEqual(
            original, types_module.RunAgentInput.model_validate_json(encoded)
        )

    def test_run_agent_input_accepts_absent_state(self):
        parsed = types_module.RunAgentInput.model_validate(
            {"threadId": "t", "runId": "r", "messages": [], "tools": [],
             "context": [], "forwardedProps": None}
        )
        self.assertIsNone(parsed.state)


class TestNullOmissionCrossLanguageFixture(unittest.TestCase):
    """The shared fixture: the same stream, the same expectations, in all three SDKs."""

    @classmethod
    def setUpClass(cls):
        cls.fixture = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
        cls.event_adapter = TypeAdapter(Event)

    def _cases(self) -> List[Tuple[str, Dict[str, Any], Dict[str, Any]]]:
        return [
            (case["name"], case["input"], case["expected"])
            for case in self.fixture["stream"]
            if SDK_NAME in case["producedBy"]
        ]

    def test_fixture_covers_this_sdk(self):
        self.assertGreater(len(self._cases()), 15, "fixture lost most of its Python cases")

    def test_every_case_reserializes_to_its_expected_json(self):
        encoder = EventEncoder()
        for name, payload, expected in self._cases():
            with self.subTest(case=name):
                event = self.event_adapter.validate_python(payload)
                encoded = encoder.encode(event)
                self.assertEqual(expected, json.loads(encoded[len("data: ") : -len("\n\n")]))


if __name__ == "__main__":
    unittest.main()
