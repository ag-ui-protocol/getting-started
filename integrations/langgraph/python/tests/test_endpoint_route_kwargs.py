"""Tests for route metadata passthrough on the FastAPI endpoint helper.

``add_langgraph_fastapi_endpoint`` used to register the agent route with a
bare decorator, so an application embedding the agent could not set the
route's ``name``, ``tags``, ``operation_id``, ``dependencies`` or
``include_in_schema``. Extra keyword arguments now reach ``app.post`` for the
agent route only: the health route keeps its own identity, because FastAPI
requires a unique ``operation_id`` and ``name`` per operation.
"""

import unittest
from unittest.mock import MagicMock

from fastapi import APIRouter, Depends, FastAPI, HTTPException
from fastapi.testclient import TestClient
from langgraph.graph.state import CompiledStateGraph

from ag_ui_langgraph import LangGraphAgent
from ag_ui_langgraph.endpoint import add_langgraph_fastapi_endpoint


def _make_agent() -> LangGraphAgent:
    graph = MagicMock(spec=CompiledStateGraph)
    graph.config_specs = []
    graph.nodes = {}
    return LangGraphAgent(name="test", graph=graph)


class TestEndpointRouteKwargs(unittest.TestCase):
    def test_metadata_lands_on_the_agent_route(self):
        app = FastAPI()
        add_langgraph_fastapi_endpoint(
            app,
            _make_agent(),
            path="/",
            name="copilotkit",
            tags=["CopilotKit"],
            summary="CopilotKit runtime endpoint",
            operation_id="run_agent",
        )

        operation = app.openapi()["paths"]["/"]["post"]
        self.assertEqual(operation["tags"], ["CopilotKit"])
        self.assertEqual(operation["summary"], "CopilotKit runtime endpoint")
        self.assertEqual(operation["operationId"], "run_agent")

        # ``name`` makes the route reachable by reverse lookup.
        self.assertEqual(app.url_path_for("copilotkit"), "/")

    def test_health_route_keeps_its_own_identity(self):
        """Metadata must not be copied onto the second route: a duplicated
        ``operation_id`` is what breaks OpenAPI client generators."""
        app = FastAPI()
        add_langgraph_fastapi_endpoint(
            app,
            _make_agent(),
            path="/",
            tags=["CopilotKit"],
            operation_id="run_agent",
        )

        health = app.openapi()["paths"]["/health"]["get"]
        self.assertNotEqual(health["operationId"], "run_agent")
        self.assertNotIn("tags", health)

    def test_include_in_schema_hides_the_agent_route_only(self):
        app = FastAPI()
        add_langgraph_fastapi_endpoint(
            app, _make_agent(), path="/", include_in_schema=False
        )

        paths = app.openapi()["paths"]
        self.assertNotIn("/", paths)
        self.assertIn("/health", paths)

    def test_dependencies_guard_the_agent_route_only(self):
        def deny():
            raise HTTPException(status_code=401, detail="nope")

        app = FastAPI()
        add_langgraph_fastapi_endpoint(
            app, _make_agent(), path="/", dependencies=[Depends(deny)]
        )
        client = TestClient(app)

        # The dependency runs before the body is parsed, so the agent is
        # never invoked.
        self.assertEqual(client.post("/", json={}).status_code, 401)
        # A health probe stays reachable without the dependency.
        self.assertEqual(client.get("/health").status_code, 200)

    def test_registers_on_an_api_router(self):
        router = APIRouter()
        add_langgraph_fastapi_endpoint(
            router, _make_agent(), path="/agent", name="copilotkit"
        )

        app = FastAPI()
        app.include_router(router, prefix="/v1")

        self.assertEqual(app.url_path_for("copilotkit"), "/v1/agent")
        self.assertEqual(TestClient(app).get("/v1/agent/health").status_code, 200)

    def test_default_registration_is_unchanged(self):
        app = FastAPI()
        add_langgraph_fastapi_endpoint(app, _make_agent(), path="/")

        operation = app.openapi()["paths"]["/"]["post"]
        self.assertNotIn("tags", operation)
        self.assertEqual(app.url_path_for("langgraph_agent_endpoint"), "/")


if __name__ == "__main__":
    unittest.main()
