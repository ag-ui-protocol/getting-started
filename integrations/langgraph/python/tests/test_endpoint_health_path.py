"""Tests for health endpoint path registration (#700).

The regression: with the default `path="/"`, the health route was registered
at `//health` (double-slash) because of naive string concatenation. Stripping
the trailing slash before appending `/health` makes every path variant
produce a well-formed route.
"""

import unittest
from unittest.mock import MagicMock

from fastapi import FastAPI
from fastapi.testclient import TestClient
from langgraph.graph.state import CompiledStateGraph

from ag_ui_langgraph import LangGraphAgent
from ag_ui_langgraph.endpoint import add_langgraph_fastapi_endpoint


def _make_app(path: str) -> FastAPI:
    graph = MagicMock(spec=CompiledStateGraph)
    graph.config_specs = []
    graph.nodes = {}
    agent = LangGraphAgent(name="test", graph=graph)
    app = FastAPI()
    add_langgraph_fastapi_endpoint(app, agent, path=path)
    return app


class TestHealthEndpointPath(unittest.TestCase):
    @staticmethod
    def _registered_health_paths(app: FastAPI) -> list[str]:
        """Paths of every GET route whose handler is the health check."""
        return [
            route.path
            for route in app.routes
            if getattr(route, "name", None) == "health"
        ]

    def test_root_path_registers_health_at_slash_health(self):
        """The regression: default path='/' used to produce '//health'."""
        app = _make_app("/")

        # The route is registered at /health, not //health.
        self.assertEqual(self._registered_health_paths(app), ["/health"])

        resp = TestClient(app).get("/health")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["status"], "ok")

    def test_nonroot_path_without_trailing_slash(self):
        app = _make_app("/api")

        self.assertEqual(self._registered_health_paths(app), ["/api/health"])

        resp = TestClient(app).get("/api/health")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["status"], "ok")

    def test_nonroot_path_with_trailing_slash_is_stripped(self):
        """Trailing slashes on any path are normalised, not only on '/'."""
        app = _make_app("/api/")

        # Not /api//health.
        self.assertEqual(self._registered_health_paths(app), ["/api/health"])

        resp = TestClient(app).get("/api/health")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["status"], "ok")

    def test_health_payload_includes_agent_name(self):
        client = TestClient(_make_app("/"))

        body = client.get("/health").json()
        self.assertEqual(body["agent"]["name"], "test")


if __name__ == "__main__":
    unittest.main()
