"""
Tests for add_openai_agents_fastapi_endpoint.

Wiring only — the wrapper's behavior is covered in test_agent.py:

- POST on the given path streams the run as SSE frames.
- A GET health check is registered next to it and reports the agent name.
- Custom (non-root) paths get their health check at <path>/health.
- Health registration can be disabled when the application owns that route.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from agents import Agent
from agents.result import RunResultStreaming
from fastapi import FastAPI
from fastapi.testclient import TestClient

import ag_ui_openai_agents.agent as agent_module
from ag_ui.core import CustomEvent, EventType
from ag_ui_openai_agents import OpenAIAgentsAgent, add_openai_agents_fastapi_endpoint

RUN_INPUT_JSON = {
    "thread_id": "t1",
    "run_id": "r1",
    "messages": [{"id": "m1", "role": "user", "content": "hi"}],
    "tools": [],
    "state": {},
    "context": [],
    "forwarded_props": None,
}


async def _empty_stream():
    return
    yield  # pragma: no cover — makes this an async generator


@pytest.fixture
def client(monkeypatch) -> TestClient:
    def fake_run_streamed(agent, *, input, run_config=None, **kwargs):
        result = MagicMock(spec=RunResultStreaming)
        result.stream_events.return_value = _empty_stream()
        return result

    monkeypatch.setattr(agent_module.Runner, "run_streamed", fake_run_streamed)

    app = FastAPI()
    wrapper = OpenAIAgentsAgent(Agent(name="assistant", instructions="hi"))
    add_openai_agents_fastapi_endpoint(app, wrapper, "/")
    return TestClient(app)


def test_post_streams_sse_run(client):
    with client.stream("POST", "/", json=RUN_INPUT_JSON) as response:
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")
        body = "".join(response.iter_text())
    assert '"RUN_STARTED"' in body
    assert '"RUN_FINISHED"' in body
    assert body.count("data: ") >= 2, "each event must be its own SSE frame"


def test_post_resolves_dynamic_custom_event_values(monkeypatch):
    def fake_run_streamed(agent, *, input, run_config=None, **kwargs):
        result = MagicMock(spec=RunResultStreaming)
        result.stream_events.return_value = _empty_stream()
        return result

    monkeypatch.setattr(agent_module.Runner, "run_streamed", fake_run_streamed)

    app = FastAPI()
    wrapper = OpenAIAgentsAgent(
        Agent(name="assistant", instructions="hi"),
        start_custom_event=CustomEvent(
            type=EventType.CUSTOM,
            name="request_metadata",
            value=lambda: {"status": "dynamic"},
        ),
    )
    add_openai_agents_fastapi_endpoint(app, wrapper, "/")

    with TestClient(app).stream("POST", "/", json=RUN_INPUT_JSON) as response:
        body = "".join(response.iter_text())

    assert response.status_code == 200
    assert '"name":"request_metadata"' in body
    assert '"status":"dynamic"' in body


def test_health_reports_agent_name(client):
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "agent": {"name": "assistant"}}


def test_custom_path_places_health_under_it(monkeypatch):
    def fake_run_streamed(agent, *, input, run_config=None, **kwargs):
        result = MagicMock(spec=RunResultStreaming)
        result.stream_events.return_value = _empty_stream()
        return result

    monkeypatch.setattr(agent_module.Runner, "run_streamed", fake_run_streamed)

    app = FastAPI()
    wrapper = OpenAIAgentsAgent(Agent(name="assistant", instructions="hi"))
    add_openai_agents_fastapi_endpoint(app, wrapper, "/my_agent")
    client = TestClient(app)

    assert client.get("/my_agent/health").status_code == 200
    with client.stream("POST", "/my_agent", json=RUN_INPUT_JSON) as response:
        assert response.status_code == 200


def test_health_can_be_disabled():
    app = FastAPI()
    wrapper = OpenAIAgentsAgent(Agent(name="assistant", instructions="hi"))
    add_openai_agents_fastapi_endpoint(
        app,
        wrapper,
        "/my_agent",
        include_health=False,
    )

    routes = {(route.path, method) for route in app.routes for method in route.methods}
    assert ("/my_agent", "POST") in routes
    assert ("/my_agent/health", "GET") not in routes


def test_multiple_agents_on_one_app_get_unique_operation_ids(monkeypatch):
    def fake_run_streamed(agent, *, input, run_config=None, **kwargs):
        result = MagicMock(spec=RunResultStreaming)
        result.stream_events.return_value = _empty_stream()
        return result

    monkeypatch.setattr(agent_module.Runner, "run_streamed", fake_run_streamed)

    app = FastAPI()
    add_openai_agents_fastapi_endpoint(
        app, OpenAIAgentsAgent(Agent(name="one", instructions="hi")), "/one"
    )
    add_openai_agents_fastapi_endpoint(
        app, OpenAIAgentsAgent(Agent(name="two", instructions="hi")), "/two"
    )

    # Mounting several agents must not collide on FastAPI-derived operation ids.
    op_ids = [
        operation["operationId"]
        for path in app.openapi()["paths"].values()
        for operation in path.values()
    ]
    assert len(op_ids) == len(set(op_ids)), f"operation ids must be unique: {op_ids}"


def test_agent_error_is_logged_not_leaked_through_asgi(monkeypatch, caplog):
    import logging

    def fake_run_streamed(agent, *, input, run_config=None, **kwargs):
        async def boom():
            raise RuntimeError("kaboom")
            yield  # pragma: no cover

        result = MagicMock(spec=RunResultStreaming)
        result.stream_events.return_value = boom()
        return result

    monkeypatch.setattr(agent_module.Runner, "run_streamed", fake_run_streamed)

    app = FastAPI()
    wrapper = OpenAIAgentsAgent(Agent(name="assistant", instructions="hi"))
    add_openai_agents_fastapi_endpoint(app, wrapper, "/")

    # raise_server_exceptions=True (default): if the re-raise escaped the
    # generator it would surface here as a 500/exception. The client must still
    # receive its RUN_ERROR frame and the error must be logged, not leaked.
    with caplog.at_level(logging.ERROR):
        with TestClient(app).stream("POST", "/", json=RUN_INPUT_JSON) as response:
            assert response.status_code == 200
            body = "".join(response.iter_text())

    assert '"RUN_ERROR"' in body
    assert "Agent run failed" in caplog.text


def test_setup_error_before_streaming_still_emits_run_error(monkeypatch, caplog):
    import logging

    # Runner.run_streamed runs inside OpenAIAgentsAgent.run_streamed BEFORE
    # to_agui, so a failure here never reaches to_agui's RUN_ERROR path. The
    # endpoint must still surface a terminal RUN_ERROR rather than an empty 200.
    def boom(agent, *, input, run_config=None, **kwargs):
        raise RuntimeError("setup exploded")

    monkeypatch.setattr(agent_module.Runner, "run_streamed", boom)

    app = FastAPI()
    wrapper = OpenAIAgentsAgent(Agent(name="assistant", instructions="hi"))
    add_openai_agents_fastapi_endpoint(app, wrapper, "/")

    with caplog.at_level(logging.ERROR):
        with TestClient(app).stream("POST", "/", json=RUN_INPUT_JSON) as response:
            assert response.status_code == 200
            body = "".join(response.iter_text())

    assert '"RUN_ERROR"' in body
    assert "Agent run failed" in caplog.text


def test_colliding_path_slugs_get_unique_operation_ids(monkeypatch):
    def fake_run_streamed(agent, *, input, run_config=None, **kwargs):
        result = MagicMock(spec=RunResultStreaming)
        result.stream_events.return_value = _empty_stream()
        return result

    monkeypatch.setattr(agent_module.Runner, "run_streamed", fake_run_streamed)

    # "/a/b" and "/a_b" both normalize to the slug "a_b"; the uniqueness guard
    # must still hand out distinct operation ids.
    app = FastAPI()
    add_openai_agents_fastapi_endpoint(
        app, OpenAIAgentsAgent(Agent(name="one", instructions="hi")), "/a/b"
    )
    add_openai_agents_fastapi_endpoint(
        app, OpenAIAgentsAgent(Agent(name="two", instructions="hi")), "/a_b"
    )
    op_ids = [
        operation["operationId"]
        for path in app.openapi()["paths"].values()
        for operation in path.values()
    ]
    assert len(op_ids) == len(set(op_ids)), f"operation ids must be unique: {op_ids}"
