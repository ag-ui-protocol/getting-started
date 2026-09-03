"""
Wire-contract tests for the capability models.

Since PNI-303 the capability classes are generated from
``spec/draft/schema.json`` and only re-exported by ``ag_ui.core.capabilities``,
so these tests are no longer checking a hand-written copy against the
TypeScript one — they pin the serialized wire shape that every SDK has to
agree on.

The 1.0 rename lands here too: the protocol settled on one word, so the class
is ``SubagentInfo`` and the field is ``subagents``. There is deliberately no
``SubAgentInfo``/``sub_agents`` alias.
"""

import json
import unittest
from pathlib import Path

from pydantic import ValidationError

from ag_ui.core.capabilities import (
    AgentCapabilities,
    ExecutionCapabilities,
    HumanInTheLoopCapabilities,
    IdentityCapabilities,
    MultiAgentCapabilities,
    MultimodalCapabilities,
    MultimodalInputCapabilities,
    MultimodalOutputCapabilities,
    OutputCapabilities,
    ReasoningCapabilities,
    StateCapabilities,
    SubagentInfo,
    ToolsCapabilities,
    TransportCapabilities,
)
from ag_ui.core.types import Tool

# The cross-SDK fixture, shared with TypeScript and .NET so one wire-format
# expectation is written down once (see sdks/fixtures/README.md).
FIXTURE_PATH = (
    Path(__file__).resolve().parents[2] / "fixtures" / "agent-capabilities.json"
)

SDK_NAME = "python"


def fully_populated_capabilities() -> AgentCapabilities:
    """
    Every capability group populated, including the three shapes that are not
    plain booleans: ``identity.metadata`` (open by key), ``custom`` (the
    integration escape hatch) and ``multi_agent.subagents``.

    Kept as a function because two tests and the cross-SDK fixture all have to
    describe the same agent.
    """
    return AgentCapabilities(
        identity=IdentityCapabilities(
            name="agent-x",
            type="langgraph",
            description="Does the thing.",
            version="1.2.0",
            provider="acme",
            documentation_url="https://example.com/docs",
            metadata={"team": "platform", "tier": 2},
        ),
        transport=TransportCapabilities(
            streaming=True,
            websocket=False,
            http_binary=True,
            push_notifications=False,
            resumable=True,
        ),
        tools=ToolsCapabilities(
            supported=True,
            items=[
                Tool(
                    name="search",
                    description="Search the web",
                    parameters={"type": "object"},
                )
            ],
            parallel_calls=True,
            client_provided=False,
        ),
        output=OutputCapabilities(
            structured_output=True,
            supported_mime_types=["text/plain", "application/json"],
        ),
        state=StateCapabilities(
            snapshots=True,
            deltas=True,
            memory=False,
            persistent_state=True,
        ),
        multi_agent=MultiAgentCapabilities(
            supported=True,
            delegation=True,
            handoffs=False,
            subagents=[SubagentInfo(name="planner", description="plans things")],
        ),
        reasoning=ReasoningCapabilities(
            supported=True,
            streaming=True,
            encrypted=False,
        ),
        multimodal=MultimodalCapabilities(
            input=MultimodalInputCapabilities(
                image=True, audio=False, video=False, pdf=True, file=True
            ),
            output=MultimodalOutputCapabilities(image=False, audio=True),
        ),
        execution=ExecutionCapabilities(
            code_execution=True,
            sandboxed=True,
            max_iterations=10,
            max_execution_time=30000,
        ),
        human_in_the_loop=HumanInTheLoopCapabilities(
            supported=True,
            approvals=True,
            interventions=False,
            feedback=True,
            interrupts=True,
            approve_with_edits=True,
        ),
        custom={"integration": "langgraph", "graphId": "main"},
    )


EXPECTED_WIRE = {
    "identity": {
        "name": "agent-x",
        "type": "langgraph",
        "description": "Does the thing.",
        "version": "1.2.0",
        "provider": "acme",
        "documentationUrl": "https://example.com/docs",
        "metadata": {"team": "platform", "tier": 2},
    },
    "transport": {
        "streaming": True,
        "websocket": False,
        "httpBinary": True,
        "pushNotifications": False,
        "resumable": True,
    },
    "tools": {
        "supported": True,
        "items": [
            {
                "name": "search",
                "description": "Search the web",
                "parameters": {"type": "object"},
            }
        ],
        "parallelCalls": True,
        "clientProvided": False,
    },
    "output": {
        "structuredOutput": True,
        "supportedMimeTypes": ["text/plain", "application/json"],
    },
    "state": {
        "snapshots": True,
        "deltas": True,
        "memory": False,
        "persistentState": True,
    },
    "multiAgent": {
        "supported": True,
        "delegation": True,
        "handoffs": False,
        "subagents": [{"name": "planner", "description": "plans things"}],
    },
    "reasoning": {"supported": True, "streaming": True, "encrypted": False},
    "multimodal": {
        "input": {
            "image": True,
            "audio": False,
            "video": False,
            "pdf": True,
            "file": True,
        },
        "output": {"image": False, "audio": True},
    },
    "execution": {
        "codeExecution": True,
        "sandboxed": True,
        "maxIterations": 10,
        "maxExecutionTime": 30000,
    },
    "humanInTheLoop": {
        "supported": True,
        "approvals": True,
        "interventions": False,
        "feedback": True,
        "interrupts": True,
        "approveWithEdits": True,
    },
    "custom": {"integration": "langgraph", "graphId": "main"},
}


class TestFullyPopulatedWireShape(unittest.TestCase):
    """
    One agent that declares everything, dumped once, asserted key by key. This
    is the contract a cross-language client parses, so it is pinned exactly
    rather than by ``assertIn`` on a handful of names.
    """

    def setUp(self):
        # No exclude_none: omitting a field with no value is the base model's
        # job (see GeneratedBaseModel), and this test is here partly to prove
        # it holds for capabilities too.
        self.dumped = fully_populated_capabilities().model_dump(by_alias=True)

    def test_dump_matches_the_wire_shape_exactly(self):
        self.assertEqual(self.dumped, EXPECTED_WIRE)

    def test_camel_case_keys_are_the_ones_on_the_wire(self):
        """Each multi-word key, pinned where it actually appears."""
        self.assertIn("documentationUrl", self.dumped["identity"])
        self.assertIn("httpBinary", self.dumped["transport"])
        self.assertIn("pushNotifications", self.dumped["transport"])
        self.assertIn("structuredOutput", self.dumped["output"])
        self.assertIn("supportedMimeTypes", self.dumped["output"])
        self.assertIn("persistentState", self.dumped["state"])
        self.assertIn("parallelCalls", self.dumped["tools"])
        self.assertIn("clientProvided", self.dumped["tools"])
        self.assertIn("codeExecution", self.dumped["execution"])
        self.assertIn("maxIterations", self.dumped["execution"])
        self.assertIn("maxExecutionTime", self.dumped["execution"])
        self.assertIn("approveWithEdits", self.dumped["humanInTheLoop"])
        self.assertIn("multiAgent", self.dumped)
        self.assertIn("humanInTheLoop", self.dumped)
        self.assertIn("metadata", self.dumped["identity"])
        self.assertIn("custom", self.dumped)
        # `multimodal` is one lowercase word, not `multiModal`.
        self.assertIn("multimodal", self.dumped)
        self.assertNotIn("multiModal", self.dumped)

    def test_subagents_is_one_lowercase_word(self):
        """The 1.0 spelling. `subAgents` was the pre-1.0 name and is gone."""
        self.assertIn("subagents", self.dumped["multiAgent"])
        self.assertNotIn("subAgents", self.dumped["multiAgent"])
        self.assertNotIn("sub_agents", self.dumped["multiAgent"])
        self.assertEqual(self.dumped["multiAgent"]["subagents"][0]["name"], "planner")

    def test_no_snake_case_leaks_into_the_wire(self):
        """No serialized key anywhere in the tree contains an underscore."""

        def walk(node, path="$"):
            if isinstance(node, dict):
                for key, value in node.items():
                    self.assertNotIn(
                        "_", key, f"snake_case key {key!r} serialized at {path}"
                    )
                    walk(value, f"{path}.{key}")
            elif isinstance(node, list):
                for index, value in enumerate(node):
                    walk(value, f"{path}[{index}]")

        # `custom` and `metadata` are open by key, so user keys there are not
        # the SDK's to police -- but nothing in this fixture uses underscores.
        walk(self.dumped)

    def test_round_trip_parses_back_to_an_equal_model(self):
        parsed = AgentCapabilities.model_validate(self.dumped)
        self.assertEqual(parsed, fully_populated_capabilities())
        self.assertEqual(parsed.model_dump(by_alias=True), self.dumped)

    def test_json_round_trip(self):
        """Same trip through real JSON text, since that is the actual wire."""
        text = fully_populated_capabilities().model_dump_json(by_alias=True)
        self.assertEqual(json.loads(text), EXPECTED_WIRE)
        self.assertEqual(
            AgentCapabilities.model_validate_json(text),
            fully_populated_capabilities(),
        )


class TestCrossLanguageFixture(unittest.TestCase):
    """
    The shared fixture: the same capability declarations, the same expected
    JSON, in all three SDKs. Each case is parsed into ``AgentCapabilities`` and
    serialized back; the result must equal ``expected``.
    """

    @classmethod
    def setUpClass(cls):
        cls.fixture = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))

    def _cases(self):
        return [
            (case["name"], case["input"], case["expected"])
            for case in self.fixture["cases"]
            if SDK_NAME in case["producedBy"]
        ]

    def test_fixture_covers_this_sdk(self):
        # Every case must list Python. The model is generated from one schema for
        # every SDK, so excluding this SDK from a case would be papering over a
        # failure, not recording a real gap; a legitimate exclusion is documented
        # here, with its reason, and nowhere else.
        cases = self.fixture["cases"]
        self.assertGreater(len(cases), 0, "fixture has no cases")
        missing = [case["name"] for case in cases if SDK_NAME not in case["producedBy"]]
        self.assertEqual(missing, [], f"cases that exclude {SDK_NAME}: {missing}")
        self.assertEqual(len(self._cases()), len(cases))

    def test_every_case_reserializes_to_its_expected_json(self):
        for name, payload, expected in self._cases():
            with self.subTest(case=name):
                caps = AgentCapabilities.model_validate(payload)
                self.assertEqual(
                    expected, json.loads(caps.model_dump_json(by_alias=True))
                )


class TestNoneFieldsAreOmitted(unittest.TestCase):
    """`absent means absent`: a capability with no value is left out, not null."""

    def test_empty_agent_capabilities_serializes_to_an_empty_object(self):
        self.assertEqual(AgentCapabilities().model_dump(by_alias=True), {})

    def test_partially_declared_groups_omit_their_undeclared_fields(self):
        dumped = AgentCapabilities(
            transport=TransportCapabilities(streaming=True),
            human_in_the_loop=HumanInTheLoopCapabilities(supported=True),
        ).model_dump(by_alias=True)
        self.assertEqual(
            dumped,
            {"transport": {"streaming": True}, "humanInTheLoop": {"supported": True}},
        )

    def test_no_null_survives_anywhere_in_a_partial_dump(self):
        text = AgentCapabilities(
            identity=IdentityCapabilities(name="agent-x"),
            multi_agent=MultiAgentCapabilities(
                subagents=[SubagentInfo(name="planner")]
            ),
        ).model_dump_json(by_alias=True)
        self.assertNotIn("null", text)
        self.assertEqual(
            json.loads(text),
            {
                "identity": {"name": "agent-x"},
                "multiAgent": {"subagents": [{"name": "planner"}]},
            },
        )

    def test_false_and_zero_are_values_and_stay(self):
        """Omission keys off `None`, not off falsiness."""
        dumped = ExecutionCapabilities(
            code_execution=False, max_iterations=0
        ).model_dump(by_alias=True)
        self.assertEqual(dumped, {"codeExecution": False, "maxIterations": 0})


class TestSubagentRenameIsACleanBreak(unittest.TestCase):
    """
    The pre-1.0 `subAgents` wire key and `sub_agents` attribute are gone with
    no alias. These tests state the resulting behaviour so nobody re-adds one
    by accident.
    """

    def test_old_wire_key_does_not_populate_subagents(self):
        """
        `subAgents` is simply an unknown key now. The base model is
        `extra="allow"`, so it is KEPT (unvalidated, as the raw dict it
        arrived as) rather than rejected -- but it does not reach `subagents`,
        which stays None. That is the intended clean break: a producer still
        sending the old key gets no subagents, not a silently-working alias.
        """
        parsed = MultiAgentCapabilities.model_validate(
            {"supported": True, "subAgents": [{"name": "planner"}]}
        )
        self.assertIsNone(parsed.subagents)
        self.assertEqual(parsed.model_extra, {"subAgents": [{"name": "planner"}]})
        # And because extras are kept, a re-serializing intermediary hands the
        # unknown key straight back out -- it is not laundered into `subagents`.
        dumped = parsed.model_dump(by_alias=True)
        self.assertNotIn("subagents", dumped)
        self.assertEqual(dumped["subAgents"], [{"name": "planner"}])

    def test_old_wire_key_nested_in_agent_capabilities(self):
        caps = AgentCapabilities.model_validate(
            {"multiAgent": {"subAgents": [{"name": "planner"}]}}
        )
        self.assertIsNone(caps.multi_agent.subagents)

    def test_old_attribute_name_is_gone(self):
        model = MultiAgentCapabilities(subagents=[SubagentInfo(name="planner")])
        self.assertFalse(hasattr(model, "sub_agents"))

    def test_old_class_name_is_not_exported(self):
        import ag_ui.core as core
        import ag_ui.core.capabilities as capabilities

        self.assertFalse(hasattr(capabilities, "SubAgentInfo"))
        self.assertFalse(hasattr(core, "SubAgentInfo"))
        self.assertIn("SubagentInfo", core.__all__)
        self.assertNotIn("SubAgentInfo", core.__all__)

    def test_generated_classes_are_the_exported_ones(self):
        """`ag_ui.core` re-exports the generated models; it does not copy them."""
        from ag_ui._generated import models as generated

        for name in (
            "SubagentInfo",
            "IdentityCapabilities",
            "TransportCapabilities",
            "ToolsCapabilities",
            "OutputCapabilities",
            "StateCapabilities",
            "MultiAgentCapabilities",
            "ReasoningCapabilities",
            "MultimodalInputCapabilities",
            "MultimodalOutputCapabilities",
            "MultimodalCapabilities",
            "ExecutionCapabilities",
            "HumanInTheLoopCapabilities",
            "AgentCapabilities",
        ):
            with self.subTest(name=name):
                import ag_ui.core as core

                self.assertIs(getattr(core, name), getattr(generated, name))


class TestSubagentInfo(unittest.TestCase):
    def test_name_is_required(self):
        with self.assertRaises(ValidationError) as ctx:
            SubagentInfo()  # type: ignore[call-arg]
        self.assertTrue(
            any(err["loc"] == ("name",) for err in ctx.exception.errors()),
            "ValidationError should flag the missing `name` field specifically",
        )

    def test_description_is_optional_and_omitted_when_absent(self):
        info = SubagentInfo(name="only-name")
        self.assertEqual(info.name, "only-name")
        self.assertIsNone(info.description)
        self.assertEqual(info.model_dump(by_alias=True), {"name": "only-name"})


if __name__ == "__main__":
    unittest.main()
