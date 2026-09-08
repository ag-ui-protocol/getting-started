#!/usr/bin/env python
"""Test ClientProxyTool class functionality."""

import pytest
import asyncio
import json
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

from ag_ui.core import Tool as AGUITool, EventType
from ag_ui.core import ToolCallStartEvent, ToolCallArgsEvent, ToolCallEndEvent, CustomEvent

from ag_ui_adk.client_proxy_tool import ClientProxyTool, _clean_schema_for_genai
from ag_ui_adk.config import PredictStateMapping


class TestClientProxyTool:
    """Test cases for ClientProxyTool class."""

    @pytest.fixture
    def sample_tool_definition(self):
        """Create a sample AG-UI tool definition."""
        return AGUITool(
            name="test_calculator",
            description="Performs basic arithmetic operations",
            parameters={
                "type": "object",
                "properties": {
                    "operation": {
                        "type": "string",
                        "enum": ["add", "subtract", "multiply", "divide"],
                        "description": "The arithmetic operation to perform"
                    },
                    "a": {
                        "type": "number",
                        "description": "First number"
                    },
                    "b": {
                        "type": "number",
                        "description": "Second number"
                    }
                },
                "required": ["operation", "a", "b"]
            }
        )

    @pytest.fixture
    def mock_event_queue(self):
        """Create a mock event queue."""
        return AsyncMock()


    @pytest.fixture
    def proxy_tool(self, sample_tool_definition, mock_event_queue):
        """Create a ClientProxyTool instance."""
        return ClientProxyTool(
            ag_ui_tool=sample_tool_definition,
            event_queue=mock_event_queue
        )

    def test_initialization(self, proxy_tool, sample_tool_definition, mock_event_queue):
        """Test ClientProxyTool initialization."""
        assert proxy_tool.name == "test_calculator"
        assert proxy_tool.description == "Performs basic arithmetic operations"
        assert proxy_tool.ag_ui_tool == sample_tool_definition
        assert proxy_tool.event_queue == mock_event_queue

    def test_get_declaration(self, proxy_tool):
        """Test _get_declaration method."""
        declaration = proxy_tool._get_declaration()

        assert declaration is not None
        assert declaration.name == "test_calculator"
        assert declaration.description == "Performs basic arithmetic operations"
        assert declaration.parameters is not None

        # Check that parameters schema was converted properly
        params = declaration.parameters
        assert hasattr(params, 'type')

    def test_get_declaration_with_invalid_parameters(self, mock_event_queue):
        """Test _get_declaration with invalid parameters."""
        invalid_tool = AGUITool(
            name="invalid_tool",
            description="Tool with invalid params",
            parameters="invalid_schema"  # Should be dict
        )

        proxy_tool = ClientProxyTool(
            ag_ui_tool=invalid_tool,
            event_queue=mock_event_queue
        )

        declaration = proxy_tool._get_declaration()

        # Should default to empty object schema
        assert declaration is not None
        assert declaration.parameters is not None

    @pytest.mark.asyncio
    async def test_run_async_success(self, proxy_tool, mock_event_queue):
        """Test successful tool execution with long-running behavior."""
        args = {"operation": "add", "a": 5, "b": 3}
        mock_context = MagicMock()
        mock_context.function_call_id = "test_function_call_id"

        # Mock UUID generation for predictable tool_call_id
        with patch('uuid.uuid4') as mock_uuid:
            mock_uuid.return_value = MagicMock()
            mock_uuid.return_value.hex = "abc123456789abcdef012345"  # Valid hex string

            # Execute the tool - should return None immediately (long-running)
            result = await proxy_tool.run_async(args=args, tool_context=mock_context)

            # All client tools are long-running and return None
            assert result is None

            # Verify events were emitted in correct order
            assert mock_event_queue.put.call_count == 3

            # Check TOOL_CALL_START event
            start_event = mock_event_queue.put.call_args_list[0][0][0]
            assert isinstance(start_event, ToolCallStartEvent)
            assert start_event.tool_call_id == "test_function_call_id"  # Uses ADK function call ID
            assert start_event.tool_call_name == "test_calculator"

            # Check TOOL_CALL_ARGS event
            args_event = mock_event_queue.put.call_args_list[1][0][0]
            assert isinstance(args_event, ToolCallArgsEvent)
            assert args_event.tool_call_id == "test_function_call_id"  # Uses ADK function call ID
            assert json.loads(args_event.delta) == args

            # Check TOOL_CALL_END event
            end_event = mock_event_queue.put.call_args_list[2][0][0]
            assert isinstance(end_event, ToolCallEndEvent)
            assert end_event.tool_call_id == "test_function_call_id"  # Uses ADK function call ID


    @pytest.mark.asyncio
    async def test_run_async_event_queue_error(self, proxy_tool):
        """Test handling of event queue errors."""
        args = {"operation": "add", "a": 5, "b": 3}
        mock_context = MagicMock()
        mock_context.function_call_id = "test_function_call_id"

        # Mock event queue to raise error
        error_queue = AsyncMock()
        error_queue.put.side_effect = RuntimeError("Queue error")

        proxy_tool.event_queue = error_queue

        with pytest.raises(RuntimeError) as exc_info:
            await proxy_tool.run_async(args=args, tool_context=mock_context)

        assert "Queue error" in str(exc_info.value)


    def test_string_representation(self, proxy_tool):
        """Test __repr__ method."""
        repr_str = repr(proxy_tool)

        assert "ClientProxyTool" in repr_str
        assert "test_calculator" in repr_str
        # The repr shows the tool name, not the description
        assert "name='test_calculator'" in repr_str
        assert "ag_ui_tool='test_calculator'" in repr_str

    @pytest.mark.asyncio
    async def test_multiple_concurrent_executions(self, proxy_tool, mock_event_queue):
        """Test multiple concurrent tool executions with long-running behavior."""
        args1 = {"operation": "add", "a": 1, "b": 2}
        args2 = {"operation": "subtract", "a": 10, "b": 5}
        mock_context = MagicMock()
        mock_context.function_call_id = "test_function_call_id"

        # Start two concurrent executions - both should return None immediately
        task1 = asyncio.create_task(
            proxy_tool.run_async(args=args1, tool_context=mock_context)
        )
        task2 = asyncio.create_task(
            proxy_tool.run_async(args=args2, tool_context=mock_context)
        )

        # Both should complete successfully with None (long-running)
        result1 = await task1
        result2 = await task2

        assert result1 is None
        assert result2 is None

        # Should have emitted events for both executions
        # Each execution emits 3 events, so 6 total
        assert mock_event_queue.put.call_count == 6

    @pytest.mark.asyncio
    async def test_json_serialization_in_args(self, proxy_tool, mock_event_queue):
        """Test that complex arguments are properly JSON serialized."""
        complex_args = {
            "operation": "custom",
            "config": {
                "precision": 2,
                "rounding": "up",
                "metadata": ["tag1", "tag2"]
            },
            "values": [1.5, 2.7, 3.9]
        }
        mock_context = MagicMock()
        mock_context.function_call_id = "test_function_call_id"

        with patch('uuid.uuid4') as mock_uuid:
            mock_uuid.return_value = MagicMock()
            mock_uuid.return_value.__str__ = MagicMock(return_value="complex-test")

            # Execute the tool - should return None immediately
            result = await proxy_tool.run_async(args=complex_args, tool_context=mock_context)

            # Should return None (long-running behavior)
            assert result is None

            # Check that args were properly serialized in the event
            args_event = mock_event_queue.put.call_args_list[1][0][0]
            serialized_args = json.loads(args_event.delta)
            assert serialized_args == complex_args


class TestClientProxyToolPredictState:
    """Test cases for PredictState emission in ClientProxyTool."""

    @pytest.fixture
    def tool_with_predict_state(self):
        """Create a tool definition that has a predict_state mapping."""
        return AGUITool(
            name="write_document",
            description="Writes a document",
            parameters={
                "type": "object",
                "properties": {
                    "document": {"type": "string"},
                }
            }
        )

    @pytest.fixture
    def predict_state_mappings(self):
        """Create predict_state mappings for the tool."""
        return [
            PredictStateMapping(
                state_key="document",
                tool="write_document",
                tool_argument="document"
            )
        ]

    @pytest.mark.asyncio
    async def test_predict_state_emitted_before_tool_call(self, tool_with_predict_state, predict_state_mappings):
        """Test that PredictState CustomEvent is emitted before TOOL_CALL_START."""
        mock_queue = AsyncMock()
        shared_tracking = set()

        proxy_tool = ClientProxyTool(
            ag_ui_tool=tool_with_predict_state,
            event_queue=mock_queue,
            predict_state_mappings=predict_state_mappings,
            emitted_predict_state=shared_tracking,
        )

        mock_context = MagicMock()
        mock_context.function_call_id = "test_call_id"

        await proxy_tool.run_async(args={"document": "test"}, tool_context=mock_context)

        # Should have emitted 4 events: PredictState, TOOL_CALL_START, TOOL_CALL_ARGS, TOOL_CALL_END
        # Note: No STATE_SNAPSHOT - frontend handles state from TOOL_CALL_ARGS via PredictState mapping
        assert mock_queue.put.call_count == 4

        # First event should be PredictState CustomEvent
        first_event = mock_queue.put.call_args_list[0][0][0]
        assert isinstance(first_event, CustomEvent)
        assert first_event.name == "PredictState"
        assert first_event.value == [{"state_key": "document", "tool": "write_document", "tool_argument": "document"}]

        # Second event should be TOOL_CALL_START
        second_event = mock_queue.put.call_args_list[1][0][0]
        assert isinstance(second_event, ToolCallStartEvent)

        # Fourth event should be TOOL_CALL_END
        fourth_event = mock_queue.put.call_args_list[3][0][0]
        assert isinstance(fourth_event, ToolCallEndEvent)

    @pytest.mark.asyncio
    async def test_predict_state_only_emitted_once_with_shared_tracking(self, tool_with_predict_state, predict_state_mappings):
        """Test that PredictState is only emitted once per tool when using shared tracking."""
        mock_queue = AsyncMock()
        shared_tracking = set()

        # Create two tools with the same name, sharing tracking set
        tool1 = ClientProxyTool(
            ag_ui_tool=tool_with_predict_state,
            event_queue=mock_queue,
            predict_state_mappings=predict_state_mappings,
            emitted_predict_state=shared_tracking,
        )
        tool2 = ClientProxyTool(
            ag_ui_tool=tool_with_predict_state,
            event_queue=mock_queue,
            predict_state_mappings=predict_state_mappings,
            emitted_predict_state=shared_tracking,
        )

        mock_context = MagicMock()
        mock_context.function_call_id = "test_call_id"

        # First tool execution
        await tool1.run_async(args={"document": "doc1"}, tool_context=mock_context)

        # Should have 4 events: PredictState + TOOL_CALL_START + TOOL_CALL_ARGS + TOOL_CALL_END
        assert mock_queue.put.call_count == 4
        first_event = mock_queue.put.call_args_list[0][0][0]
        assert isinstance(first_event, CustomEvent)
        assert first_event.name == "PredictState"

        # Second tool execution (same tool name)
        mock_queue.reset_mock()
        await tool2.run_async(args={"document": "doc2"}, tool_context=mock_context)

        # Should only have 3 events (no PredictState - already emitted)
        assert mock_queue.put.call_count == 3
        # First event should be TOOL_CALL_START, not PredictState
        first_event = mock_queue.put.call_args_list[0][0][0]
        assert isinstance(first_event, ToolCallStartEvent)

    @pytest.mark.asyncio
    async def test_predict_state_tracking_isolates_between_instances(self, tool_with_predict_state, predict_state_mappings):
        """Test that separate tracking sets are isolated."""
        mock_queue = AsyncMock()

        # Two separate tracking sets (simulating two different runs/toolsets)
        tracking1 = set()
        tracking2 = set()

        tool1 = ClientProxyTool(
            ag_ui_tool=tool_with_predict_state,
            event_queue=mock_queue,
            predict_state_mappings=predict_state_mappings,
            emitted_predict_state=tracking1,
        )
        tool2 = ClientProxyTool(
            ag_ui_tool=tool_with_predict_state,
            event_queue=mock_queue,
            predict_state_mappings=predict_state_mappings,
            emitted_predict_state=tracking2,
        )

        mock_context = MagicMock()
        mock_context.function_call_id = "test_call_id"

        # First tool execution
        await tool1.run_async(args={"document": "doc1"}, tool_context=mock_context)
        assert mock_queue.put.call_count == 4  # PredictState + TOOL_CALL_START + TOOL_CALL_ARGS + TOOL_CALL_END

        # Second tool execution (different tracking set)
        mock_queue.reset_mock()
        await tool2.run_async(args={"document": "doc2"}, tool_context=mock_context)
        assert mock_queue.put.call_count == 4  # PredictState AGAIN + TOOL_CALL_START + TOOL_CALL_ARGS + TOOL_CALL_END

        # Both should have emitted PredictState because of isolated tracking
        first_event = mock_queue.put.call_args_list[0][0][0]
        assert isinstance(first_event, CustomEvent)
        assert first_event.name == "PredictState"

    @pytest.mark.asyncio
    async def test_no_predict_state_when_no_mapping(self):
        """Test no PredictState is emitted when tool has no mapping."""
        mock_queue = AsyncMock()
        shared_tracking = set()

        tool = AGUITool(
            name="unrelated_tool",
            description="A tool without predict_state mapping",
            parameters={"type": "object", "properties": {"x": {"type": "number"}}}
        )

        # Mapping is for different tool
        mappings = [
            PredictStateMapping(
                state_key="document",
                tool="write_document",  # Different tool name
                tool_argument="document"
            )
        ]

        proxy_tool = ClientProxyTool(
            ag_ui_tool=tool,
            event_queue=mock_queue,
            predict_state_mappings=mappings,
            emitted_predict_state=shared_tracking,
        )

        mock_context = MagicMock()
        mock_context.function_call_id = "test_call_id"

        await proxy_tool.run_async(args={"x": 42}, tool_context=mock_context)

        # Should only have 3 events (no PredictState)
        assert mock_queue.put.call_count == 3
        first_event = mock_queue.put.call_args_list[0][0][0]
        assert isinstance(first_event, ToolCallStartEvent)

    @pytest.mark.asyncio
    async def test_default_tracking_set_when_none_provided(self, tool_with_predict_state, predict_state_mappings):
        """Test that tool creates its own tracking set when none provided."""
        mock_queue = AsyncMock()

        # No emitted_predict_state parameter - should default to empty set
        proxy_tool = ClientProxyTool(
            ag_ui_tool=tool_with_predict_state,
            event_queue=mock_queue,
            predict_state_mappings=predict_state_mappings,
            # No emitted_predict_state provided
        )

        mock_context = MagicMock()
        mock_context.function_call_id = "test_call_id"

        await proxy_tool.run_async(args={"document": "test"}, tool_context=mock_context)

        # Should still emit PredictState
        assert mock_queue.put.call_count == 4
        first_event = mock_queue.put.call_args_list[0][0][0]
        assert isinstance(first_event, CustomEvent)
        assert first_event.name == "PredictState"


class TestCleanSchemaForGenai:
    """Test cases for _clean_schema_for_genai helper."""

    # --- Positive tests: valid fields are preserved ---

    def test_preserves_valid_genai_fields(self):
        """Valid genai.types.Schema fields pass through unchanged."""
        schema = {
            "type": "object",
            "title": "MyTool",
            "description": "A tool",
            "default": {"key": "value"},
            "properties": {
                "amount": {"type": "number", "minimum": 0, "maximum": 100}
            },
            "required": ["amount"],
            "additionalProperties": False,
            "minProperties": 1,
            "maxProperties": 10,
        }
        result = _clean_schema_for_genai(schema)
        assert result["title"] == "MyTool"
        assert result["default"] == {"key": "value"}
        # additionalProperties is stripped: the Gemini Developer API rejects it
        # in function declarations with a 400 even though genai.Schema accepts it.
        assert "additionalProperties" not in result
        assert result["minProperties"] == 1
        assert result["maxProperties"] == 10
        assert result["properties"]["amount"]["minimum"] == 0

    def test_preserves_nested_valid_fields(self):
        """Valid fields inside nested properties are preserved."""
        schema = {
            "type": "object",
            "properties": {
                "address": {
                    "type": "object",
                    "title": "Address",
                    "description": "Mailing address",
                    "properties": {
                        "street": {"type": "string", "minLength": 1}
                    }
                }
            }
        }
        result = _clean_schema_for_genai(schema)
        assert result["properties"]["address"]["title"] == "Address"
        assert result["properties"]["address"]["properties"]["street"]["minLength"] == 1

    # --- Negative tests: invalid fields are stripped ---

    def test_strips_dollar_prefixed_keys(self):
        """$schema, $id, $comment, $defs, $ref are always stripped."""
        schema = {
            "$schema": "http://json-schema.org/draft-07/schema#",
            "$id": "https://example.com/tool.schema.json",
            "$comment": "Generated by Zod",
            "type": "object",
            "properties": {"x": {"type": "number"}},
            "required": ["x"]
        }
        result = _clean_schema_for_genai(schema)
        assert "$schema" not in result
        assert "$id" not in result
        assert "$comment" not in result
        assert result["type"] == "object"
        assert result["required"] == ["x"]

    def test_strips_unknown_json_schema_fields(self):
        """Fields not in genai.types.Schema are stripped."""
        schema = {
            "type": "object",
            "readOnly": True,
            "writeOnly": False,
            "deprecated": True,
            "contentMediaType": "application/json",
            "contentEncoding": "base64",
            "dependentRequired": {"a": ["b"]},
            "properties": {"x": {"type": "string"}}
        }
        result = _clean_schema_for_genai(schema)
        assert "readOnly" not in result
        assert "writeOnly" not in result
        assert "deprecated" not in result
        assert "contentMediaType" not in result
        assert "contentEncoding" not in result
        assert "dependentRequired" not in result
        assert result["type"] == "object"
        assert "x" in result["properties"]

    def test_strips_nested_dollar_keys(self):
        """$-prefixed keys inside nested properties are stripped recursively."""
        schema = {
            "type": "object",
            "properties": {
                "address": {
                    "$ref": "#/$defs/Address",
                    "type": "object",
                    "properties": {
                        "street": {"type": "string"}
                    }
                }
            },
            "$defs": {
                "Address": {"type": "object"}
            }
        }
        result = _clean_schema_for_genai(schema)
        assert "$defs" not in result
        assert "$ref" not in result["properties"]["address"]
        assert result["properties"]["address"]["type"] == "object"

    def test_strips_inside_lists(self):
        """Invalid keys inside arrays (anyOf, etc.) are stripped."""
        schema = {
            "type": "object",
            "properties": {
                "value": {
                    "anyOf": [
                        {"$comment": "branch A", "type": "string"},
                        {"$comment": "branch B", "type": "number"},
                    ]
                }
            }
        }
        result = _clean_schema_for_genai(schema)
        any_of = result["properties"]["value"]["anyOf"]
        assert len(any_of) == 2
        assert "$comment" not in any_of[0]
        assert any_of[0]["type"] == "string"

    # --- Mapping tests: examples -> example, const -> enum ---

    def test_maps_examples_to_example(self):
        """examples array is mapped to example (first element only)."""
        schema = {
            "type": "string",
            "examples": ["foo", "bar", "baz"]
        }
        result = _clean_schema_for_genai(schema)
        assert "examples" not in result
        assert result["example"] == "foo"

    def test_maps_examples_empty_array_no_example(self):
        """Empty examples array is stripped (no example to extract)."""
        schema = {"type": "string", "examples": []}
        result = _clean_schema_for_genai(schema)
        assert "examples" not in result
        assert "example" not in result

    def test_maps_const_to_enum(self):
        """const is mapped to a single-value enum list (stringified)."""
        schema = {"type": "string", "const": "fixed_value"}
        result = _clean_schema_for_genai(schema)
        assert "const" not in result
        assert result["enum"] == ["fixed_value"]

    def test_maps_const_int_to_enum_string(self):
        """const with non-string value is JSON-serialized for genai enum compatibility."""
        schema = {"type": "integer", "const": 42}
        result = _clean_schema_for_genai(schema)
        assert result["enum"] == ["42"]

    def test_maps_const_structured_to_enum_json(self):
        """const with a dict/list value is JSON-serialized, not Python repr'd."""
        schema = {"type": "object", "const": {"foo": 1}}
        result = _clean_schema_for_genai(schema)
        assert result["enum"] == ['{"foo": 1}']

    # --- Mapping tests: oneOf -> anyOf ---

    def test_maps_oneof_to_anyof(self):
        """oneOf is mapped to anyOf (genai accepts anyOf but not oneOf)."""
        schema = {
            "oneOf": [
                {"type": "string"},
                {"type": "number"},
            ]
        }
        result = _clean_schema_for_genai(schema)
        assert "oneOf" not in result
        assert len(result["anyOf"]) == 2
        assert result["anyOf"][0]["type"] == "string"
        assert result["anyOf"][1]["type"] == "number"

    def test_maps_oneof_recursively_and_cleans_branches(self):
        """A nested oneOf (e.g. from a zod discriminatedUnion) is mapped to
        anyOf and each branch is cleaned, so the union structure survives
        instead of being dropped by the allowlist."""
        schema = {
            "type": "object",
            "properties": {
                "config": {
                    "description": "discriminated union",
                    "oneOf": [
                        {
                            "$comment": "branch A",
                            "type": "object",
                            "additionalProperties": False,
                            "properties": {
                                "kind": {"const": "a"},
                            },
                        },
                        {
                            "type": "object",
                            "properties": {"kind": {"const": "b"}},
                        },
                    ],
                }
            },
        }
        result = _clean_schema_for_genai(schema)
        config = result["properties"]["config"]
        assert "oneOf" not in config
        any_of = config["anyOf"]
        assert len(any_of) == 2
        # branches are recursively cleaned: $-keys / rejected keys stripped,
        # const mapped to enum
        assert "$comment" not in any_of[0]
        assert "additionalProperties" not in any_of[0]
        assert any_of[0]["properties"]["kind"]["enum"] == ["a"]
        # the sibling description is preserved alongside the mapped anyOf
        assert config["description"] == "discriminated union"

    # --- Edge cases ---

    def test_handles_non_dict_input(self):
        """Non-dict/non-list values pass through unchanged."""
        assert _clean_schema_for_genai("string_value") == "string_value"
        assert _clean_schema_for_genai(42) == 42
        assert _clean_schema_for_genai(None) is None
        assert _clean_schema_for_genai(True) is True

    def test_handles_empty_dict(self):
        assert _clean_schema_for_genai({}) == {}

    def test_handles_empty_list(self):
        assert _clean_schema_for_genai([]) == []


class TestGetDeclarationWithJsonSchemaMeta:
    """Test _get_declaration strips JSON Schema meta-fields (issue #1349)."""

    def test_get_declaration_with_schema_field(self):
        """Test that $schema in tool parameters does not cause ValidationError."""
        tool = AGUITool(
            name="mcp_tool",
            description="Tool from MCP server with $schema",
            parameters={
                "$schema": "http://json-schema.org/draft-07/schema#",
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Search query"}
                },
                "required": ["query"]
            }
        )
        mock_queue = AsyncMock()
        proxy = ClientProxyTool(ag_ui_tool=tool, event_queue=mock_queue)

        declaration = proxy._get_declaration()

        assert declaration is not None
        assert declaration.name == "mcp_tool"
        assert declaration.parameters is not None

    def test_get_declaration_with_multiple_meta_fields(self):
        """Test that multiple $-prefixed fields are all stripped."""
        tool = AGUITool(
            name="zod_tool",
            description="Tool generated by Zod with extra meta",
            parameters={
                "$schema": "http://json-schema.org/draft-07/schema#",
                "$id": "https://example.com/zod-tool",
                "$comment": "Auto-generated",
                "type": "object",
                "properties": {
                    "input": {"type": "string"}
                }
            }
        )
        mock_queue = AsyncMock()
        proxy = ClientProxyTool(ag_ui_tool=tool, event_queue=mock_queue)

        declaration = proxy._get_declaration()

        assert declaration is not None
        assert declaration.name == "zod_tool"
        assert declaration.parameters is not None

    def test_get_declaration_without_meta_fields_unchanged(self):
        """Test that schemas without $-prefixed keys still work correctly."""
        tool = AGUITool(
            name="normal_tool",
            description="Normal tool without meta fields",
            parameters={
                "type": "object",
                "properties": {
                    "x": {"type": "number"},
                    "y": {"type": "number"}
                },
                "required": ["x", "y"]
            }
        )
        mock_queue = AsyncMock()
        proxy = ClientProxyTool(ag_ui_tool=tool, event_queue=mock_queue)

        declaration = proxy._get_declaration()

        assert declaration is not None
        assert declaration.name == "normal_tool"
        assert declaration.parameters is not None


class TestEndToEndSchemaValidation:
    """End-to-end tests: _get_declaration() produces schemas that pass
    types.Schema.model_validate() — validates the actual issue #1003 use case."""

    def test_e2e_schema_with_title_default_examples(self):
        """Schema with title, default, and examples passes model_validate."""
        tool = AGUITool(
            name="search_tool",
            description="Search with rich schema",
            parameters={
                "$schema": "http://json-schema.org/draft-07/schema#",
                "type": "object",
                "title": "SearchParams",
                "properties": {
                    "query": {
                        "type": "string",
                        "title": "Search Query",
                        "description": "The search term",
                        "default": "hello world",
                        "examples": ["machine learning", "deep learning", "NLP"],
                    },
                    "limit": {
                        "type": "integer",
                        "title": "Result Limit",
                        "default": 10,
                        "minimum": 1,
                        "maximum": 100,
                    }
                },
                "required": ["query"]
            }
        )
        mock_queue = AsyncMock()
        proxy = ClientProxyTool(ag_ui_tool=tool, event_queue=mock_queue)
        declaration = proxy._get_declaration()

        assert declaration is not None
        assert declaration.parameters is not None
        # Verify title preserved
        assert declaration.parameters.title == "SearchParams"
        # Verify example mapped from examples[0]
        query_prop = declaration.parameters.properties["query"]
        assert query_prop.example == "machine learning"
        assert query_prop.default == "hello world"

    def test_e2e_schema_with_additional_properties_stripped(self):
        """additionalProperties is stripped from the function declaration.

        The Gemini Developer API rejects ``additionalProperties`` in function
        declarations with a 400 ("Unknown name additional_properties ... Cannot
        find field"), even though ``genai.types.Schema`` accepts it as a model
        field. zod-to-json-schema (CopilotKit / AG-UI frontend tools) emits it on
        every object, so leaving it in breaks every client-supplied tool on the
        Developer API. It must be stripped.
        """
        tool = AGUITool(
            name="recipe_tool",
            description="Recipe schema per Google docs",
            parameters={
                "type": "object",
                "properties": {
                    "recipe_name": {"type": "string"},
                    "ingredients": {
                        "type": "array",
                        "items": {"type": "string"}
                    }
                },
                "required": ["recipe_name"],
                "additionalProperties": False,
            }
        )
        mock_queue = AsyncMock()
        proxy = ClientProxyTool(ag_ui_tool=tool, event_queue=mock_queue)
        declaration = proxy._get_declaration()

        assert declaration is not None
        assert declaration.parameters is not None
        # Stripped, not preserved — otherwise the Developer API 400s on this tool.
        assert declaration.parameters.additional_properties is None

    def test_e2e_dojo_hitl_tool_has_no_additional_properties_at_any_depth(self):
        """Regression for the AG-UI HITL dojo "nothing renders" report.

        CopilotKit's ``useHumanInTheLoop`` registers a frontend tool whose zod
        schema is serialized via ``zodToJsonSchema(..., {$refStrategy: "none"})``,
        which stamps ``additionalProperties: false`` on every object (root *and*
        array items) plus a ``$schema`` key. Forwarded verbatim, the Gemini
        Developer API returns 400 ("Unknown name additional_properties ... Cannot
        find field"), the run emits RUN_ERROR, and no tool call reaches the UI.

        The cleaned declaration must therefore contain ``additional_properties``
        nowhere — at any nesting depth — while keeping the real schema intact.
        """
        tool = AGUITool(
            name="generate_task_steps",
            description="Generates a list of steps for the user to perform",
            parameters={
                "type": "object",
                "properties": {
                    "steps": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "description": {"type": "string"},
                                "status": {
                                    "type": "string",
                                    "enum": ["enabled", "disabled", "executing"],
                                },
                            },
                            "required": ["description", "status"],
                            "additionalProperties": False,  # nested — must also be stripped
                        },
                    }
                },
                "required": ["steps"],
                "additionalProperties": False,  # root
                "$schema": "http://json-schema.org/draft-07/schema#",
            },
        )
        proxy = ClientProxyTool(ag_ui_tool=tool, event_queue=AsyncMock())
        declaration = proxy._get_declaration()

        assert declaration is not None
        assert declaration.parameters is not None

        # Serialize exactly as it goes on the wire to Gemini; the rejected key
        # must appear at no depth (and neither must the $schema meta key).
        dumped = declaration.parameters.model_dump_json(by_alias=True, exclude_none=True)
        assert "additionalProperties" not in dumped
        assert "additional_properties" not in dumped
        assert "$schema" not in dumped

        # The real schema survived: steps -> array of objects with the enum intact.
        steps = declaration.parameters.properties["steps"]
        assert steps.items is not None
        assert steps.items.properties["status"].enum == ["enabled", "disabled", "executing"]

    def test_e2e_schema_with_const_mapped_to_enum(self):
        """Schema with const is mapped to enum and passes model_validate."""
        tool = AGUITool(
            name="fixed_tool",
            description="Tool with const field",
            parameters={
                "type": "object",
                "properties": {
                    "action": {"type": "string", "const": "submit"},
                    "value": {"type": "number"}
                }
            }
        )
        mock_queue = AsyncMock()
        proxy = ClientProxyTool(ag_ui_tool=tool, event_queue=mock_queue)
        declaration = proxy._get_declaration()

        assert declaration is not None
        action_prop = declaration.parameters.properties["action"]
        assert action_prop.enum == ["submit"]  # already a string, str() is no-op

    def test_e2e_schema_with_min_max_properties(self):
        """Schema with minProperties/maxProperties passes model_validate."""
        tool = AGUITool(
            name="bounded_tool",
            description="Tool with property count constraints",
            parameters={
                "type": "object",
                "properties": {
                    "data": {"type": "string"}
                },
                "minProperties": 1,
                "maxProperties": 5,
            }
        )
        mock_queue = AsyncMock()
        proxy = ClientProxyTool(ag_ui_tool=tool, event_queue=mock_queue)
        declaration = proxy._get_declaration()

        assert declaration is not None
        assert declaration.parameters.min_properties == 1
        assert declaration.parameters.max_properties == 5

    def test_e2e_schema_with_unknown_fields_stripped(self):
        """Schema with readOnly/writeOnly/deprecated stripped, still validates."""
        tool = AGUITool(
            name="annotated_tool",
            description="Tool with JSON Schema annotations",
            parameters={
                "$schema": "http://json-schema.org/draft-07/schema#",
                "$comment": "Generated by openapi-generator",
                "type": "object",
                "readOnly": True,
                "deprecated": True,
                "properties": {
                    "id": {
                        "type": "string",
                        "readOnly": True,
                        "writeOnly": False,
                        "contentMediaType": "text/plain",
                    }
                }
            }
        )
        mock_queue = AsyncMock()
        proxy = ClientProxyTool(ag_ui_tool=tool, event_queue=mock_queue)
        declaration = proxy._get_declaration()

        assert declaration is not None
        assert declaration.parameters is not None
        # readOnly, deprecated etc should not cause ValidationError

    def test_e2e_schema_with_nested_anyof_and_meta(self):
        """Complex schema with anyOf, nested $ref/$defs, and meta fields."""
        tool = AGUITool(
            name="complex_tool",
            description="Complex schema",
            parameters={
                "$schema": "http://json-schema.org/draft-07/schema#",
                "$defs": {
                    "Color": {"type": "string", "enum": ["red", "green", "blue"]}
                },
                "type": "object",
                "properties": {
                    "value": {
                        "anyOf": [
                            {"type": "string", "$comment": "branch A"},
                            {"type": "number", "title": "Numeric"},
                        ]
                    },
                    "color": {
                        "$ref": "#/$defs/Color",
                        "type": "string",
                        "title": "Favorite Color",
                        "examples": ["red"],
                    }
                }
            }
        )
        mock_queue = AsyncMock()
        proxy = ClientProxyTool(ag_ui_tool=tool, event_queue=mock_queue)
        declaration = proxy._get_declaration()

        assert declaration is not None
        assert declaration.parameters is not None
        # anyOf should have 2 branches, $comment stripped
        value_prop = declaration.parameters.properties["value"]
        assert len(value_prop.any_of) == 2
        assert value_prop.any_of[1].title == "Numeric"
        # color should have example mapped from examples[0], $ref stripped
        color_prop = declaration.parameters.properties["color"]
        assert color_prop.example == "red"
        assert color_prop.title == "Favorite Color"

    def test_e2e_kitchen_sink_issue_1003(self):
        """Reproduces the exact scenario from issue #1003 — a real MCP tool
        schema with every problematic field type that caused ValidationError."""
        tool = AGUITool(
            name="mcp_database_query",
            description="Query a database via MCP",
            parameters={
                "$schema": "http://json-schema.org/draft-07/schema#",
                "$id": "https://mcp.example.com/db-query.schema.json",
                "$comment": "Generated by Zod-to-JSON-Schema",
                "type": "object",
                "title": "DatabaseQuery",
                "description": "Execute a database query",
                "properties": {
                    "sql": {
                        "type": "string",
                        "title": "SQL Statement",
                        "description": "The SQL query to execute",
                        "examples": ["SELECT * FROM users", "SELECT count(*) FROM orders"],
                        "minLength": 1,
                        "maxLength": 10000,
                    },
                    "database": {
                        "type": "string",
                        "title": "Database Name",
                        "default": "production",
                        "enum": ["production", "staging", "test"],
                    },
                    "timeout": {
                        "type": "integer",
                        "title": "Timeout (seconds)",
                        "default": 30,
                        "minimum": 1,
                        "maximum": 300,
                        "const": 30,
                    },
                    "format": {
                        "type": "string",
                        "title": "Output Format",
                        "enum": ["json", "csv", "table"],
                        "default": "json",
                        "readOnly": False,
                        "deprecated": False,
                    },
                    "options": {
                        "type": "object",
                        "title": "Query Options",
                        "additionalProperties": True,
                        "default": {},
                        "properties": {
                            "explain": {"type": "boolean", "default": False}
                        }
                    }
                },
                "required": ["sql"],
                "additionalProperties": False,
                "minProperties": 1,
                "maxProperties": 10,
                "readOnly": False,
                "writeOnly": False,
                "deprecated": False,
                "contentMediaType": "application/json",
                "dependentRequired": {"timeout": ["database"]},
            }
        )
        mock_queue = AsyncMock()
        proxy = ClientProxyTool(ag_ui_tool=tool, event_queue=mock_queue)
        declaration = proxy._get_declaration()

        # This is the core assertion — model_validate must not throw
        assert declaration is not None
        assert declaration.parameters is not None

        params = declaration.parameters
        # Valid fields preserved
        assert params.title == "DatabaseQuery"
        # additionalProperties stripped (Developer API rejects it; see
        # test_e2e_schema_with_additional_properties_stripped).
        assert params.additional_properties is None
        assert params.min_properties == 1
        assert params.max_properties == 10
        # sql: examples[0] mapped to example, minLength/maxLength preserved
        sql_prop = params.properties["sql"]
        assert sql_prop.example == "SELECT * FROM users"
        assert sql_prop.min_length == 1
        assert sql_prop.max_length == 10000
        # database: default and enum preserved
        db_prop = params.properties["database"]
        assert db_prop.default == "production"
        assert db_prop.enum == ["production", "staging", "test"]
        # timeout: const mapped to enum (stringified)
        timeout_prop = params.properties["timeout"]
        assert timeout_prop.enum == ["30"]
        # format: readOnly/deprecated stripped, valid fields kept
        format_prop = params.properties["format"]
        assert format_prop.title == "Output Format"
        assert format_prop.enum == ["json", "csv", "table"]
        assert format_prop.default == "json"
        # options: nested additionalProperties also stripped (Developer API
        # rejects it at any depth, not just the root).
        options_prop = params.properties["options"]
        assert options_prop.additional_properties is None
        # Invalid fields stripped at root level
        # (readOnly, writeOnly, deprecated, contentMediaType, dependentRequired)
