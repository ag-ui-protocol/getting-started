"""Tests for route metadata passthrough on the FastAPI endpoint helpers.

The agent route used to be registered with a bare decorator, so an
application embedding a flow or a crew could not set its ``name``, ``tags``,
``operation_id``, ``dependencies`` or ``include_in_schema``. Extra keyword
arguments now reach ``app.post``.
"""

from fastapi import APIRouter, Depends, FastAPI, HTTPException
from fastapi.testclient import TestClient

import ag_ui_crewai.endpoint as ep


class _Flow:
    def kickoff_async(self, inputs=None):  # pragma: no cover - never called
        raise AssertionError


class _Crew:
    def crew(self):  # pragma: no cover - construction is deferred to a request
        raise AssertionError


def _register_flow(app, **kwargs):
    ep.add_crewai_flow_fastapi_endpoint(app, _Flow(), "/agent", **kwargs)


def test_metadata_lands_on_the_flow_route():
    app = FastAPI()
    _register_flow(
        app,
        name="agent_run",
        tags=["Agent"],
        summary="AG-UI agent endpoint",
        operation_id="run_agent",
    )

    operation = app.openapi()["paths"]["/agent"]["post"]
    assert operation["tags"] == ["Agent"]
    assert operation["summary"] == "AG-UI agent endpoint"
    assert operation["operationId"] == "run_agent"

    # ``name`` makes the route reachable by reverse lookup.
    assert app.url_path_for("agent_run") == "/agent"


def test_include_in_schema_hides_the_flow_route():
    app = FastAPI()
    _register_flow(app, include_in_schema=False)

    assert "/agent" not in app.openapi()["paths"]


def test_dependencies_guard_the_flow_route():
    def deny():
        raise HTTPException(status_code=401, detail="nope")

    app = FastAPI()
    _register_flow(app, dependencies=[Depends(deny)])

    # The dependency runs before the body is parsed, so the flow is never
    # kicked off.
    assert TestClient(app).post("/agent", json={}).status_code == 401


def test_registers_on_an_api_router():
    router = APIRouter()
    _register_flow(router, name="agent_run")

    app = FastAPI()
    app.include_router(router, prefix="/v1")

    assert app.url_path_for("agent_run") == "/v1/agent"


def test_default_registration_is_unchanged():
    app = FastAPI()
    _register_flow(app)

    assert "tags" not in app.openapi()["paths"]["/agent"]["post"]


def test_metadata_lands_on_the_crew_route():
    app = FastAPI()
    ep.add_crewai_crew_fastapi_endpoint(
        app, _Crew(), "/agent", tags=["Agent"], name="crew_run"
    )

    assert app.openapi()["paths"]["/agent"]["post"]["tags"] == ["Agent"]
    assert app.url_path_for("crew_run") == "/agent"
