#!/usr/bin/env python
"""Tests for route metadata passthrough on the FastAPI endpoint helper.

The agent route used to be registered with a bare decorator, so an
application embedding the middleware could not set its ``name``, ``tags``,
``operation_id``, ``dependencies`` or ``include_in_schema``. Extra keyword
arguments now reach ``app.post`` for the agent route only: the capabilities
and ``/agents/state`` routes keep their own identity, because FastAPI
requires a unique ``operation_id`` and ``name`` per operation.
"""

import pytest
from unittest.mock import MagicMock
from fastapi import Depends, FastAPI, HTTPException
from fastapi.testclient import TestClient

from ag_ui_adk.endpoint import add_adk_fastapi_endpoint, create_adk_app
from ag_ui_adk.adk_agent import ADKAgent


@pytest.fixture
def mock_agent():
    return MagicMock(spec=ADKAgent)


class TestEndpointRouteKwargs:
    def test_metadata_lands_on_the_agent_route(self, mock_agent):
        app = FastAPI()
        add_adk_fastapi_endpoint(
            app,
            mock_agent,
            path="/",
            name="adk_agent",
            tags=["ADK"],
            summary="ADK middleware endpoint",
            operation_id="run_agent",
        )

        operation = app.openapi()["paths"]["/"]["post"]
        assert operation["tags"] == ["ADK"]
        assert operation["summary"] == "ADK middleware endpoint"
        assert operation["operationId"] == "run_agent"
        assert app.url_path_for("adk_agent") == "/"

    def test_other_routes_keep_their_own_identity(self, mock_agent):
        """A duplicated ``operation_id`` is what breaks OpenAPI client
        generators, so the helper's other routes stay untouched."""
        app = FastAPI()
        add_adk_fastapi_endpoint(
            app, mock_agent, path="/", tags=["ADK"], operation_id="run_agent"
        )

        paths = app.openapi()["paths"]
        others = [paths[p][m] for p, m in (("/capabilities", "get"), ("/agents/state", "post"))]
        for operation in others:
            assert operation["operationId"] != "run_agent"
            assert "tags" not in operation

    def test_dependencies_guard_the_agent_route_only(self, mock_agent):
        def deny():
            raise HTTPException(status_code=401, detail="nope")

        app = FastAPI()
        add_adk_fastapi_endpoint(
            app, mock_agent, path="/", dependencies=[Depends(deny)]
        )
        client = TestClient(app)

        # The dependency runs before the body is parsed, so the agent is
        # never invoked.
        assert client.post("/", json={}).status_code == 401

        # The helper's other routes are left unguarded.
        routes = {r.path: r for r in app.routes if hasattr(r, "dependencies")}
        assert routes["/capabilities"].dependencies == []
        assert routes["/agents/state"].dependencies == []

    def test_create_adk_app_forwards_route_kwargs(self, mock_agent):
        app = create_adk_app(mock_agent, path="/", tags=["ADK"], name="adk_agent")

        assert app.openapi()["paths"]["/"]["post"]["tags"] == ["ADK"]
        assert app.url_path_for("adk_agent") == "/"

    def test_default_registration_is_unchanged(self, mock_agent):
        app = FastAPI()
        add_adk_fastapi_endpoint(app, mock_agent, path="/")

        assert "tags" not in app.openapi()["paths"]["/"]["post"]
