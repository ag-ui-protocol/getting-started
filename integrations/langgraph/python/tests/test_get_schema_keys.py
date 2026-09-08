"""Tests for LangGraphAgent.get_schema_keys() exception handling.

The catch in get_schema_keys is intentionally narrow: it falls back to the
constant schema keys for exceptions that legitimately indicate the graph does
not expose schema introspection (AttributeError) or returned an unexpected
shape (TypeError/KeyError). Unexpected exceptions must propagate so programmer
errors and infrastructure failures are not silently swallowed.
"""

import unittest
from unittest.mock import MagicMock

from ag_ui_langgraph import LangGraphAgent


class TestGetSchemaKeysFallback(unittest.TestCase):
    """Verify narrowed exception handling in get_schema_keys."""

    def _make_agent(self, graph):
        return LangGraphAgent(name="test", graph=graph)

    def _config(self):
        return {"configurable": {"thread_id": "t1"}}

    def test_attribute_error_falls_back_and_logs_warning(self):
        """AttributeError (graph lacks introspection) -> fallback + warning."""
        graph = MagicMock()
        graph.config_specs = []
        graph.get_input_jsonschema.side_effect = AttributeError("no schema")
        agent = self._make_agent(graph)

        with self.assertLogs("ag_ui_langgraph.agent", level="WARNING") as log_ctx:
            result = agent.get_schema_keys(self._config())

        self.assertEqual(result["input"], agent.constant_schema_keys)
        self.assertEqual(result["output"], agent.constant_schema_keys)
        self.assertEqual(result["config"], [])
        self.assertEqual(result["context"], [])
        joined = "\n".join(log_ctx.output)
        self.assertIn("AttributeError", joined)
        self.assertIn("no schema", joined)

    def test_type_error_on_unexpected_shape_falls_back(self):
        """TypeError from unexpected schema shape -> fallback + warning."""
        graph = MagicMock()
        graph.config_specs = []
        # Return something that breaks `"properties" in input_schema`.
        graph.get_input_jsonschema.return_value = 42
        agent = self._make_agent(graph)

        with self.assertLogs("ag_ui_langgraph.agent", level="WARNING") as log_ctx:
            result = agent.get_schema_keys(self._config())

        self.assertEqual(result["input"], agent.constant_schema_keys)
        self.assertIn("TypeError", "\n".join(log_ctx.output))

    def test_key_error_falls_back(self):
        """KeyError (missing expected key) -> fallback + warning."""
        graph = MagicMock()
        graph.config_specs = []

        def raise_key_error(_config):
            raise KeyError("properties")

        graph.get_input_jsonschema.side_effect = raise_key_error
        agent = self._make_agent(graph)

        with self.assertLogs("ag_ui_langgraph.agent", level="WARNING") as log_ctx:
            result = agent.get_schema_keys(self._config())

        self.assertEqual(result["input"], agent.constant_schema_keys)
        self.assertIn("KeyError", "\n".join(log_ctx.output))

    def test_unexpected_exception_propagates(self):
        """RuntimeError (not a legitimate fallback) must propagate, not be swallowed."""
        graph = MagicMock()
        graph.config_specs = []
        graph.get_input_jsonschema.side_effect = RuntimeError("boom")
        agent = self._make_agent(graph)

        with self.assertRaises(RuntimeError):
            agent.get_schema_keys(self._config())

    def test_value_error_falls_back(self):
        """ValueError (Pydantic v2 raises it via PydanticUserError /
        PydanticSchemaGenerationError when a schema model can't be
        built for runtime-only types) must fall back to defaults, not
        propagate.
        """
        graph = MagicMock()
        graph.config_specs = []
        graph.get_input_jsonschema.side_effect = ValueError("bad value")
        agent = self._make_agent(graph)

        with self.assertLogs("ag_ui_langgraph.agent", level="WARNING") as log_ctx:
            result = agent.get_schema_keys(self._config())

        self.assertEqual(result["input"], agent.constant_schema_keys)
        self.assertIn("ValueError", "\n".join(log_ctx.output))

    def test_happy_path_no_warning(self):
        """Well-formed schemas return extracted keys and emit no warning."""
        graph = MagicMock()
        graph.config_specs = []
        graph.get_input_jsonschema.return_value = {"properties": {"foo": {}, "bar": {}}}
        graph.get_output_jsonschema.return_value = {"properties": {"baz": {}}}
        # Production now prefers the non-deprecated get_config_jsonschema().
        graph.get_config_jsonschema.return_value = {"properties": {"cfg": {}}}
        # context_schema is optional; set it to None so the hasattr branch short-circuits.
        graph.context_schema = None
        agent = self._make_agent(graph)

        with self.assertNoLogs("ag_ui_langgraph.agent", level="WARNING"):
            result = agent.get_schema_keys(self._config())

        self.assertEqual(
            result["input"],
            ["foo", "bar", *agent.constant_schema_keys],
        )
        self.assertEqual(
            result["output"],
            ["baz", *agent.constant_schema_keys],
        )
        self.assertEqual(result["config"], ["cfg"])
        self.assertEqual(result["context"], [])


if __name__ == "__main__":
    unittest.main()
