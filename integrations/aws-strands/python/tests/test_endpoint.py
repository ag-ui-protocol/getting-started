"""Event streaming and the health route on the Strands FastAPI endpoint."""

from __future__ import annotations

import typing

import pytest

from fastapi import Depends, FastAPI, HTTPException
from fastapi.testclient import TestClient

from ag_ui.core import EventType
from ag_ui_strands import InvocationStateProvider
from ag_ui_strands.endpoint import SSE_MEDIA_TYPE, add_ping, add_strands_fastapi_endpoint
from ag_ui_strands.utils import create_strands_app

from tests.endpoint_helpers import (
    valid_run_input,
    FakeAgent,
    run_finished,
    run_started,
    sse_payloads,
)


def _client(agent: FakeAgent) -> TestClient:
    app = FastAPI()
    add_strands_fastapi_endpoint(app, agent, "/")
    return TestClient(app)


def test_streams_one_sse_frame_per_yielded_event() -> None:
    agent = FakeAgent([run_started(), run_finished()])

    response = _client(agent).post("/", json=valid_run_input())

    assert response.status_code == 200
    assert response.headers["content-type"].split(";")[0] == SSE_MEDIA_TYPE
    assert [p["type"] for p in sse_payloads(response.text)] == [
        EventType.RUN_STARTED,
        EventType.RUN_FINISHED,
    ]


def test_preserves_event_field_values_on_the_wire() -> None:
    agent = FakeAgent([run_started(thread_id="thread-9", run_id="run-9")])

    response = _client(agent).post("/", json=valid_run_input())

    assert sse_payloads(response.text) == [
        {"type": EventType.RUN_STARTED, "threadId": "thread-9", "runId": "run-9"}
    ]


def test_an_empty_event_script_yields_an_empty_body() -> None:
    response = _client(FakeAgent([])).post("/", json=valid_run_input())

    assert response.status_code == 200
    assert response.text == ""


def test_streams_every_event_of_a_long_run() -> None:
    agent = FakeAgent([run_started(run_id=f"run-{i}") for i in range(50)])

    response = _client(agent).post("/", json=valid_run_input())

    assert [p["runId"] for p in sse_payloads(response.text)] == [
        f"run-{i}" for i in range(50)
    ]


def test_the_endpoint_is_mounted_at_the_requested_path() -> None:
    app = FastAPI()
    add_strands_fastapi_endpoint(app, FakeAgent(), "/agent/run")
    client = TestClient(app)

    assert client.post("/agent/run", json=valid_run_input()).status_code == 200
    assert client.post("/", json=valid_run_input()).status_code == 404


def test_ping_reports_healthy() -> None:
    app = FastAPI()
    add_ping(app, "/ping")

    response = TestClient(app).get("/ping")

    assert response.status_code == 200
    assert response.json() == {"status": "healthy"}


def test_ping_is_mounted_at_the_requested_path() -> None:
    app = FastAPI()
    add_ping(app, "/healthz")
    client = TestClient(app)

    assert client.get("/healthz").json() == {"status": "healthy"}
    assert client.get("/ping").status_code == 404


def test_the_stream_is_marked_uncacheable() -> None:
    """Frames of a live run must not be cached or replayed to a later client."""
    response = _client(FakeAgent()).post("/", json=valid_run_input())

    assert response.headers["cache-control"] == "no-cache"


def test_other_route_options_are_forwarded_to_fastapi() -> None:
    """Options other than dependencies reach the route too.

    `dependencies` is merged separately, so it cannot stand in for the
    passthrough: without it the rest would be dropped in silence.
    """
    app = FastAPI()
    add_strands_fastapi_endpoint(
        app, FakeAgent(), "/agent", tags=["strands"], summary="Run the agent"
    )

    operation = app.openapi()["paths"]["/agent"]["post"]

    assert operation["tags"] == ["strands"]
    assert operation["summary"] == "Run the agent"


def test_a_dependency_passed_here_runs_alongside_the_built_in_ones() -> None:
    """Merged with the content-type check rather than replacing it."""
    seen: list[str] = []

    async def note() -> None:
        seen.append("called")

    app = FastAPI()
    agent = FakeAgent()
    add_strands_fastapi_endpoint(app, agent, "/", dependencies=[Depends(note)])
    client = TestClient(app)

    assert client.post("/", json=valid_run_input()).status_code == 200
    assert seen == ["called"]
    # The helper's own content-type dependency survived the merge.
    assert client.post("/", content="hello").status_code == 415


def test_request_provider_supplies_trusted_invocation_state() -> None:
    seen: list[tuple[str, str]] = []

    async def provide_invocation_state(request, input_data):
        seen.append((request.headers["x-tenant"], input_data.thread_id))
        return {"tenant_id": request.headers["x-tenant"]}

    app = FastAPI()
    agent = FakeAgent()
    add_strands_fastapi_endpoint(
        app,
        agent,
        "/",
        invocation_state_provider=provide_invocation_state,
    )

    response = TestClient(app).post(
        "/",
        json=valid_run_input(threadId="thread-from-body"),
        headers={"x-tenant": "tenant-from-auth"},
    )

    assert response.status_code == 200
    assert seen == [("tenant-from-auth", "thread-from-body")]
    assert agent.invocation_states == [{"tenant_id": "tenant-from-auth"}]


def test_sync_request_provider_is_forwarded_by_create_strands_app() -> None:
    agent = FakeAgent()

    def provide_invocation_state(request, input_data):
        return {"request_id": f"{request.method}:{input_data.run_id}"}

    app = create_strands_app(
        agent,
        cors_enabled=False,
        invocation_state_provider=provide_invocation_state,
    )

    response = TestClient(app).post("/", json=valid_run_input(runId="run-from-body"))

    assert response.status_code == 200
    assert agent.invocation_states == [{"request_id": "POST:run-from-body"}]


def test_invalid_invocation_state_provider_result_fails_loudly() -> None:
    app = FastAPI()
    agent = FakeAgent()
    add_strands_fastapi_endpoint(
        app,
        agent,
        "/",
        invocation_state_provider=lambda _request, _input: "not-a-dict",
    )

    with pytest.raises(TypeError, match="must return a dict or None"):
        TestClient(app).post("/", json=valid_run_input())

    assert agent.received == []


def test_public_invocation_state_provider_annotation_is_resolvable() -> None:
    provider_annotation = typing.get_type_hints(create_strands_app)[
        "invocation_state_provider"
    ]

    assert provider_annotation == InvocationStateProvider | None


def test_route_options_are_forwarded_to_fastapi() -> None:
    """A dependency passed here must reach the route, not be dropped."""
    rejected: list[str] = []

    async def deny() -> None:
        rejected.append("called")
        raise HTTPException(status_code=403, detail="nope")

    app = FastAPI()
    agent = FakeAgent()
    add_strands_fastapi_endpoint(app, agent, "/", dependencies=[Depends(deny)])

    response = TestClient(app).post("/", json=valid_run_input())

    assert response.status_code == 403
    assert rejected == ["called"]
    assert agent.received == []


def test_the_sse_parser_rejects_a_frame_it_cannot_read() -> None:
    """Skipping junk would let a negative assertion pass on a truncated list."""
    with pytest.raises(AssertionError):
        sse_payloads('data: {"a": 1}\n\nnot-an-sse-frame\n\n')


def test_the_sse_parser_reads_every_data_frame() -> None:
    assert sse_payloads('data: {"a": 1}\n\ndata: {"b": 2}\n\n') == [
        {"a": 1},
        {"b": 2},
    ]


def test_ping_route_options_are_forwarded_to_fastapi() -> None:
    """A dependency passed to the ping helper must reach its route too."""

    async def deny() -> None:
        raise HTTPException(status_code=403, detail="nope")

    app = FastAPI()
    add_ping(app, "/ping", dependencies=[Depends(deny)])

    assert TestClient(app).get("/ping").status_code == 403
