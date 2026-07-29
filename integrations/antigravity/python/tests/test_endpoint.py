"""Endpoint tests: SSE wire format and multi-agent mounting."""

import json

import pytest
from ag_ui.core import RunFinishedEvent, RunStartedEvent, TextMessageContentEvent
from fastapi.testclient import TestClient

from ag_ui_antigravity.endpoint import create_antigravity_app


class StubAgent:
    def __init__(self, events=None, boom=False):
        self._events = events or []
        self._boom = boom

    async def run(self, input_data):
        if self._boom:
            raise RuntimeError("kaboom")
        for event in self._events:
            yield event

    async def close(self):
        pass


def payload(thread_id="t1"):
    return {
        "threadId": thread_id,
        "runId": "r1",
        "state": {},
        "messages": [{"id": "m1", "role": "user", "content": "hi"}],
        "tools": [],
        "context": [],
        "forwardedProps": {},
    }


def parse_sse(text):
    return [
        json.loads(line[len("data: "):])
        for line in text.splitlines()
        if line.startswith("data: ")
    ]


def test_wire_format_is_data_json_with_camelcase_aliases():
    agent = StubAgent(
        [
            RunStartedEvent(type="RUN_STARTED", thread_id="t1", run_id="r1"),
            TextMessageContentEvent(
                type="TEXT_MESSAGE_CONTENT", message_id="m", delta="hi"
            ),
            RunFinishedEvent(type="RUN_FINISHED", thread_id="t1", run_id="r1"),
        ]
    )
    client = TestClient(create_antigravity_app(agent, path="/"))
    response = client.post("/", json=payload())

    assert response.status_code == 200
    assert "text/event-stream" in response.headers["content-type"]

    events = parse_sse(response.text)
    assert [e["type"] for e in events] == [
        "RUN_STARTED",
        "TEXT_MESSAGE_CONTENT",
        "RUN_FINISHED",
    ]
    # camelCase aliases, and None fields omitted.
    assert events[0]["threadId"] == "t1"
    assert "rawEvent" not in events[0]
    assert events[1]["messageId"] == "m"


def test_agent_exception_becomes_a_run_error_frame():
    client = TestClient(create_antigravity_app(StubAgent(boom=True), path="/"))
    events = parse_sse(client.post("/", json=payload()).text)
    assert events[-1]["type"] == "RUN_ERROR"
    assert events[-1]["code"] == "AGENT_ERROR"


def test_an_unencodable_event_becomes_a_run_error_and_ends_the_stream():
    """One bad event must not truncate the stream without explanation."""

    class Unencodable(RunFinishedEvent):
        def model_dump_json(self, **kwargs):
            raise ValueError("circular reference")

    agent = StubAgent(
        [
            RunStartedEvent(type="RUN_STARTED", thread_id="t1", run_id="r1"),
            Unencodable(type="RUN_FINISHED", thread_id="t1", run_id="r1"),
            TextMessageContentEvent(
                type="TEXT_MESSAGE_CONTENT", message_id="m", delta="never"
            ),
        ]
    )
    client = TestClient(create_antigravity_app(agent, path="/"))
    events = parse_sse(client.post("/", json=payload()).text)

    assert [e["type"] for e in events] == ["RUN_STARTED", "RUN_ERROR"]
    assert events[-1]["code"] == "ENCODING_ERROR"
    assert "circular reference" in events[-1]["message"]


def test_a_named_sse_frame_uses_the_same_single_newline_framing():
    """The last-resort error frame must still be valid SSE for the client."""
    from ag_ui_antigravity.endpoint import _sse

    named = _sse('{"error": "x"}', event="error").encode().decode()
    assert named == 'event: error\ndata: {"error": "x"}\n\n'
    assert _sse('{"a": 1}').encode().decode() == 'data: {"a": 1}\n\n'


def test_an_error_raised_mid_stream_still_terminates_the_run():
    class HalfwayAgent(StubAgent):
        async def run(self, input_data):
            yield RunStartedEvent(type="RUN_STARTED", thread_id="t1", run_id="r1")
            raise RuntimeError("harness died")

    client = TestClient(create_antigravity_app(HalfwayAgent(), path="/"))
    events = parse_sse(client.post("/", json=payload()).text)
    assert [e["type"] for e in events] == ["RUN_STARTED", "RUN_ERROR"]
    assert "harness died" in events[-1]["message"]


def test_agents_are_closed_when_the_app_shuts_down():
    class ClosingAgent(StubAgent):
        closed = False

        async def close(self):
            self.closed = True

    first, second = ClosingAgent(), ClosingAgent()
    app = create_antigravity_app({"a": first, "b": second})
    with TestClient(app):
        pass
    assert first.closed and second.closed


def test_a_single_agent_is_closed_when_the_app_shuts_down():
    class ClosingAgent(StubAgent):
        closed = False

        async def close(self):
            self.closed = True

    agent = ClosingAgent()
    with TestClient(create_antigravity_app(agent, path="/")):
        pass
    assert agent.closed


def test_a_nested_mount_path_is_honoured():
    app = create_antigravity_app(
        {"agentic_chat": StubAgent([RunStartedEvent(
            type="RUN_STARTED", thread_id="t1", run_id="r1")])},
        path="/antigravity",
        capabilities={"identity": {"type": "antigravity"}},
    )
    client = TestClient(app)
    assert client.post("/antigravity/agentic_chat", json=payload()).status_code == 200
    assert client.get("/antigravity/agentic_chat/capabilities").status_code == 200


def test_explicit_capabilities_replace_the_defaults():
    app = create_antigravity_app(
        StubAgent(), path="/", capabilities={"identity": {"type": "custom"}}
    )
    body = TestClient(app).get("/capabilities").json()
    assert body == {"identity": {"type": "custom"}}


def test_multiple_agents_mount_on_distinct_paths():
    app = create_antigravity_app(
        {
            "agentic_chat": StubAgent(
                [RunFinishedEvent(type="RUN_FINISHED", thread_id="t1", run_id="r1")]
            ),
            "human_in_the_loop": StubAgent(
                [RunStartedEvent(type="RUN_STARTED", thread_id="t1", run_id="r1")]
            ),
        }
    )
    client = TestClient(app)
    assert parse_sse(client.post("/agentic_chat", json=payload()).text)[0][
        "type"
    ] == "RUN_FINISHED"
    assert parse_sse(client.post("/human_in_the_loop", json=payload()).text)[0][
        "type"
    ] == "RUN_STARTED"


def test_capabilities_endpoint_is_served_per_agent():
    from ag_ui_antigravity import AntigravityAgent

    app = create_antigravity_app({"agentic_chat": AntigravityAgent()})
    client = TestClient(app)
    response = client.get("/agentic_chat/capabilities")
    assert response.status_code == 200
    assert response.json()["tools"]["supported"] is True


def test_capabilities_payload_matches_the_agui_schema():
    """The TS client parses this strictly; loose booleans would throw there.

    Mirrors AgentCapabilitiesSchema: every top-level key is an optional nested
    object (plus `custom`, a free-form record).
    """
    from ag_ui_antigravity import AntigravityAgent
    from ag_ui_antigravity.endpoint import default_capabilities

    known = {
        "identity",
        "transport",
        "tools",
        "output",
        "state",
        "multiAgent",
        "reasoning",
        "multimodal",
        "execution",
        "humanInTheLoop",
        "custom",
    }
    payload = default_capabilities(AntigravityAgent())
    assert set(payload) <= known, set(payload) - known
    for key, value in payload.items():
        assert isinstance(value, dict), f"{key} must be a nested object, got {value!r}"


def test_capabilities_reflect_agent_configuration():
    from ag_ui_antigravity import AntigravityAgent
    from ag_ui_antigravity.endpoint import default_capabilities

    plain = default_capabilities(AntigravityAgent(tool_approval=False))
    approving = default_capabilities(AntigravityAgent(tool_approval=True))
    assert plain["humanInTheLoop"]["approvals"] is False
    assert approving["humanInTheLoop"]["approvals"] is True

    no_tools = default_capabilities(AntigravityAgent(enable_frontend_tools=False))
    assert no_tools["tools"]["clientProvided"] is False


def test_invalid_payload_is_rejected():
    client = TestClient(create_antigravity_app(StubAgent(), path="/"))
    assert client.post("/", json={"nonsense": True}).status_code == 422


def test_capabilities_do_not_advertise_unreachable_interrupts():
    """The ask_question built-in is gated by CapabilitiesConfig, not just by
    the hook, so an allowlist that omits it makes interrupts unreachable."""
    from google.antigravity import CapabilitiesConfig
    from google.antigravity.types import BuiltinTools

    from ag_ui_antigravity import AntigravityAgent
    from ag_ui_antigravity.endpoint import default_capabilities

    chat_only = AntigravityAgent(
        capabilities=CapabilitiesConfig(enabled_tools=[BuiltinTools.FINISH])
    )
    assert chat_only.ask_question_reachable is False
    assert default_capabilities(chat_only)["humanInTheLoop"]["interrupts"] is False

    disabled = AntigravityAgent(
        capabilities=CapabilitiesConfig(disabled_tools=[BuiltinTools.ASK_QUESTION])
    )
    assert disabled.ask_question_reachable is False

    default = AntigravityAgent()
    assert default.ask_question_reachable is True
    assert default_capabilities(default)["humanInTheLoop"]["interrupts"] is True

    # Approvals are their own interrupt source, independent of ask_question.
    approving = AntigravityAgent(
        capabilities=CapabilitiesConfig(enabled_tools=[BuiltinTools.FINISH]),
        tool_approval=True,
    )
    assert default_capabilities(approving)["humanInTheLoop"]["interrupts"] is True


def test_capabilities_do_not_advertise_unreachable_code_execution():
    from google.antigravity import CapabilitiesConfig
    from google.antigravity.types import BuiltinTools

    from ag_ui_antigravity import AntigravityAgent
    from ag_ui_antigravity.endpoint import default_capabilities

    no_shell = AntigravityAgent(
        capabilities=CapabilitiesConfig(disabled_tools=[BuiltinTools.RUN_COMMAND])
    )
    assert default_capabilities(no_shell)["execution"]["codeExecution"] is False
    assert default_capabilities(AntigravityAgent())["execution"]["codeExecution"] is True


def test_human_in_the_loop_is_not_advertised_when_no_channel_exists():
    from ag_ui_antigravity import AntigravityAgent
    from ag_ui_antigravity.endpoint import default_capabilities

    none = AntigravityAgent(
        enable_frontend_tools=False, enable_ask_question=False, tool_approval=False
    )
    assert default_capabilities(none)["humanInTheLoop"]["supported"] is False
    assert default_capabilities(AntigravityAgent())["humanInTheLoop"]["supported"] is True
