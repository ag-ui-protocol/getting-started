"""
Tests to verify that ag-ui-langgraph does not trigger deprecation warnings
from Pydantic V2 or LangGraph V1.
"""

import asyncio
import unittest
import warnings
from unittest.mock import MagicMock

from ag_ui.core import RunAgentInput
from ag_ui_langgraph.agent import LangGraphAgent


class TestPydanticCopyDeprecation(unittest.TestCase):
    """Test that RunAgentInput.copy() deprecation is resolved."""

    def test_run_uses_model_copy_not_deprecated_copy(self):
        """
        Verify that LangGraphAgent.run() uses model_copy() at runtime,
        not the deprecated .copy(), by checking for deprecation warnings.
        """
        mock_graph = MagicMock()
        mock_graph.get_input_jsonschema.return_value = {"properties": {"messages": {}}}
        mock_graph.get_output_jsonschema.return_value = {"properties": {"messages": {}}}
        mock_graph.get_config_jsonschema.return_value = {"properties": {}}

        # Mock astream_events to return an empty async iterator
        async def _empty_stream(*args, **kwargs):
            return
            yield  # noqa: unreachable — makes this an async generator

        mock_graph.astream_events = _empty_stream

        agent = LangGraphAgent(name="test", graph=mock_graph)

        input_data = RunAgentInput(
            thread_id="test-thread",
            run_id="test-run",
            state={},
            messages=[],
            tools=[],
            context=[],
            forwarded_props={},
        )

        with warnings.catch_warnings(record=True) as w:
            warnings.simplefilter("always")
            loop = asyncio.new_event_loop()
            try:
                async def _run():
                    async for _ in agent.run(input_data):
                        pass
                loop.run_until_complete(_run())
            except Exception:
                pass  # We only care about deprecation warnings
            finally:
                loop.close()

            copy_warnings = [
                x for x in w
                if "deprecated" in str(x.message).lower()
                and "copy" in str(x.message).lower()
            ]
            self.assertEqual(
                len(copy_warnings), 0,
                f"run() should not produce .copy() deprecation warnings, got: {[str(x.message) for x in copy_warnings]}"
            )


class TestConfigSchemaDeprecation(unittest.TestCase):
    """Test that config_schema().schema() deprecation is resolved."""

    def test_get_schema_keys_uses_get_config_jsonschema(self):
        """
        Verify that get_schema_keys() uses graph.get_config_jsonschema()
        instead of graph.config_schema().schema(), avoiding both
        LangGraphDeprecatedSinceV10 and PydanticDeprecatedSince20.
        """
        mock_graph = MagicMock(spec=[
            "get_input_jsonschema",
            "get_output_jsonschema",
            "get_config_jsonschema",
            "nodes",
        ])
        mock_graph.nodes = {}
        mock_graph.get_input_jsonschema.return_value = {
            "properties": {"messages": {}, "input_key": {}}
        }
        mock_graph.get_output_jsonschema.return_value = {
            "properties": {"messages": {}, "output_key": {}}
        }
        mock_graph.get_config_jsonschema.return_value = {
            "properties": {"configurable": {}}
        }

        agent = LangGraphAgent(name="test", graph=mock_graph)

        with warnings.catch_warnings(record=True) as w:
            warnings.simplefilter("always")
            schema_keys = agent.get_schema_keys({})
            deprecation_warnings = [
                x for x in w
                if "deprecated" in str(x.message).lower()
            ]
            self.assertEqual(
                len(deprecation_warnings), 0,
                f"get_schema_keys() should not produce deprecation warnings, got: {[str(x.message) for x in deprecation_warnings]}"
            )

        # Verify get_config_jsonschema was called
        mock_graph.get_config_jsonschema.assert_called_once()

        # config_schema is not in spec, so accessing it would raise AttributeError,
        # confirming the code does not fall back to the deprecated path.
        with self.assertRaises(AttributeError):
            mock_graph.config_schema  # noqa: B018

        # Verify results are correct
        self.assertIn("configurable", schema_keys["config"])

    def test_get_schema_keys_uses_get_context_jsonschema(self):
        """
        Verify that get_schema_keys() uses graph.get_context_jsonschema()
        instead of graph.context_schema().schema() when context_schema exists.
        """
        mock_graph = MagicMock()
        mock_graph.get_input_jsonschema.return_value = {
            "properties": {"messages": {}}
        }
        mock_graph.get_output_jsonschema.return_value = {
            "properties": {"messages": {}}
        }
        mock_graph.get_config_jsonschema.return_value = {
            "properties": {"configurable": {}}
        }
        mock_graph.get_context_jsonschema.return_value = {
            "properties": {"user_id": {}, "session": {}}
        }

        agent = LangGraphAgent(name="test", graph=mock_graph)

        with warnings.catch_warnings(record=True) as w:
            warnings.simplefilter("always")
            schema_keys = agent.get_schema_keys({})
            deprecation_warnings = [
                x for x in w
                if "deprecated" in str(x.message).lower()
            ]
            self.assertEqual(
                len(deprecation_warnings), 0,
                f"get_schema_keys() should not produce deprecation warnings, got: {[str(x.message) for x in deprecation_warnings]}"
            )

        # Verify get_context_jsonschema was called
        mock_graph.get_context_jsonschema.assert_called_once()

        # Verify context keys were extracted
        self.assertIn("user_id", schema_keys["context"])
        self.assertIn("session", schema_keys["context"])

    def test_get_schema_keys_handles_context_jsonschema_returns_none(self):
        """
        Verify that get_schema_keys() handles the case where
        get_context_jsonschema exists but returns None.
        """
        mock_graph = MagicMock()
        mock_graph.get_input_jsonschema.return_value = {
            "properties": {"messages": {}}
        }
        mock_graph.get_output_jsonschema.return_value = {
            "properties": {"messages": {}}
        }
        mock_graph.get_config_jsonschema.return_value = {
            "properties": {"configurable": {}}
        }
        mock_graph.get_context_jsonschema.return_value = None

        agent = LangGraphAgent(name="test", graph=mock_graph)
        schema_keys = agent.get_schema_keys({})

        # get_context_jsonschema was called
        mock_graph.get_context_jsonschema.assert_called_once()
        # But since it returned None, context keys should be empty
        self.assertEqual(schema_keys["context"], [])

    def test_get_schema_keys_handles_no_context_schema(self):
        """
        Verify that get_schema_keys() handles the case where
        get_context_jsonschema does not exist on the graph object.
        Uses spec= to ensure hasattr properly returns False.
        """
        mock_graph = MagicMock(spec=[
            "get_input_jsonschema",
            "get_output_jsonschema",
            "get_config_jsonschema",
            "nodes",
        ])
        mock_graph.nodes = {}
        mock_graph.get_input_jsonschema.return_value = {
            "properties": {"messages": {}}
        }
        mock_graph.get_output_jsonschema.return_value = {
            "properties": {"messages": {}}
        }
        mock_graph.get_config_jsonschema.return_value = {
            "properties": {"configurable": {}}
        }

        # Confirm hasattr returns False for get_context_jsonschema
        self.assertFalse(hasattr(mock_graph, "get_context_jsonschema"))

        agent = LangGraphAgent(name="test", graph=mock_graph)
        schema_keys = agent.get_schema_keys({})

        self.assertEqual(schema_keys["context"], [])

    def test_get_schema_keys_fallback_for_old_langgraph(self):
        """
        Verify backward compatibility: when get_config_jsonschema does not exist,
        falls back to config_schema().schema() for older LangGraph versions.
        """
        mock_schema = MagicMock()
        mock_schema.schema.return_value = {
            "properties": {"configurable": {}}
        }

        mock_graph = MagicMock(spec=[
            "get_input_jsonschema",
            "get_output_jsonschema",
            "config_schema",
            "nodes",
        ])
        mock_graph.nodes = {}
        mock_graph.get_input_jsonschema.return_value = {
            "properties": {"messages": {}}
        }
        mock_graph.get_output_jsonschema.return_value = {
            "properties": {"messages": {}}
        }
        mock_graph.config_schema.return_value = mock_schema

        # Confirm the new API is not available
        self.assertFalse(hasattr(mock_graph, "get_config_jsonschema"))

        agent = LangGraphAgent(name="test", graph=mock_graph)
        schema_keys = agent.get_schema_keys({})

        # Should have used the fallback
        mock_graph.config_schema.assert_called_once()
        self.assertIn("configurable", schema_keys["config"])


    def test_get_schema_keys_context_fallback_for_old_langgraph(self):
        """
        Verify backward compatibility: when get_context_jsonschema does not exist
        but context_schema does, falls back to context_schema().schema().
        """
        mock_context_schema = MagicMock()
        mock_context_schema.schema.return_value = {
            "properties": {"user_id": {}, "session": {}}
        }

        mock_graph = MagicMock(spec=[
            "get_input_jsonschema",
            "get_output_jsonschema",
            "get_config_jsonschema",
            "context_schema",
            "nodes",
        ])
        mock_graph.nodes = {}
        mock_graph.get_input_jsonschema.return_value = {
            "properties": {"messages": {}}
        }
        mock_graph.get_output_jsonschema.return_value = {
            "properties": {"messages": {}}
        }
        mock_graph.get_config_jsonschema.return_value = {
            "properties": {"configurable": {}}
        }
        mock_graph.context_schema.return_value = mock_context_schema

        # Confirm the new API is not available but old one is
        self.assertFalse(hasattr(mock_graph, "get_context_jsonschema"))
        self.assertTrue(hasattr(mock_graph, "context_schema"))

        agent = LangGraphAgent(name="test", graph=mock_graph)
        schema_keys = agent.get_schema_keys({})

        # Should have used the fallback
        mock_graph.context_schema.assert_called()
        self.assertIn("user_id", schema_keys["context"])
        self.assertIn("session", schema_keys["context"])


if __name__ == "__main__":
    unittest.main()
