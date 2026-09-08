"""Tests for route metadata passthrough on the FastAPI endpoint helper.

The agent route used to be registered with a bare decorator, so an
application embedding the agent could not set its ``name``, ``tags``,
``operation_id``, ``dependencies`` or ``include_in_schema``. Extra keyword
arguments now reach ``app.post`` for the agent route only.
"""

import unittest
from unittest.mock import MagicMock

from fastapi import APIRouter, Depends, FastAPI, HTTPException
from fastapi.testclient import TestClient

from ag_ui_agentspec.agent import AgentSpecAgent
from ag_ui_agentspec.endpoint import add_agentspec_fastapi_endpoint


def _make_agent():
    return MagicMock(spec=AgentSpecAgent)


def _register(app, **kwargs):
    return add_agentspec_fastapi_endpoint(app, _make_agent(), "/agent", **kwargs)


class TestEndpointRouteKwargs(unittest.TestCase):
    def test_metadata_lands_on_the_agent_route(self):
        app = FastAPI()
        _register(
            app,
            name="agent_run",
            tags=["Agent"],
            summary="AG-UI agent endpoint",
            operation_id="run_agent",
        )

        operation = app.openapi()["paths"]["/agent"]["post"]
        self.assertEqual(operation["tags"], ["Agent"])
        self.assertEqual(operation["summary"], "AG-UI agent endpoint")
        self.assertEqual(operation["operationId"], "run_agent")

        # ``name`` makes the route reachable by reverse lookup.
        self.assertEqual(app.url_path_for("agent_run"), "/agent")

    def test_include_in_schema_hides_the_agent_route(self):
        app = FastAPI()
        _register(app, include_in_schema=False)

        self.assertNotIn("/agent", app.openapi()["paths"])

    def test_dependencies_guard_the_agent_route(self):
        def deny():
            raise HTTPException(status_code=401, detail="nope")

        app = FastAPI()
        _register(app, dependencies=[Depends(deny)])

        # The dependency runs before the body is parsed, so the agent is
        # never invoked.
        self.assertEqual(
            TestClient(app).post("/agent", json={}).status_code, 401
        )

    def test_registers_on_an_api_router(self):
        router = APIRouter()
        _register(router, name="agent_run")

        app = FastAPI()
        app.include_router(router, prefix="/v1")

        self.assertEqual(app.url_path_for("agent_run"), "/v1/agent")

    def test_default_registration_is_unchanged(self):
        app = FastAPI()
        _register(app)

        self.assertNotIn("tags", app.openapi()["paths"]["/agent"]["post"])


if __name__ == "__main__":
    unittest.main()
