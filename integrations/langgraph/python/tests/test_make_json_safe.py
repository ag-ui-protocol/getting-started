"""Tests for make_json_safe function."""
import json
import threading
import unittest
import uuid
from dataclasses import dataclass
from enum import Enum
from typing import Any

from ag_ui_langgraph.utils import make_json_safe, json_safe_stringify


class Color(Enum):
    RED = "red"
    GREEN = "green"


@dataclass
class SimpleDataclass:
    name: str
    value: int


@dataclass
class DataclassWithLock:
    """Dataclass containing an unpicklable _thread.lock object."""
    name: str
    lock: threading.Lock


@dataclass
class DataclassWithRuntimeConfig:
    """Simulates LangGraph tool call structure with runtime/config injection."""
    name: str
    args: dict
    runtime: Any = None  # LangGraph-injected, not serializable
    config: Any = None   # LangGraph-injected, not serializable


class TestMakeJsonSafe(unittest.TestCase):
    """Tests for make_json_safe function."""

    def test_primitives(self):
        """Test that primitives are returned as-is."""
        assert make_json_safe(None) is None
        assert make_json_safe(True) is True
        assert make_json_safe(False) is False
        assert make_json_safe(42) == 42
        assert make_json_safe(3.14) == 3.14
        assert make_json_safe("hello") == "hello"

    def test_enum(self):
        """Test that enums are converted to their values."""
        assert make_json_safe(Color.RED) == "red"
        assert make_json_safe(Color.GREEN) == "green"

    def test_dict(self):
        """Test that dicts are recursively processed."""
        result = make_json_safe({"a": 1, "b": {"c": 2}})
        assert result == {"a": 1, "b": {"c": 2}}

    def test_list(self):
        """Test that lists are recursively processed."""
        result = make_json_safe([1, 2, [3, 4]])
        assert result == [1, 2, [3, 4]]

    def test_tuple(self):
        """Test that tuples are converted to lists."""
        result = make_json_safe((1, 2, 3))
        assert result == [1, 2, 3]

    def test_set(self):
        """Test that sets are converted to lists."""
        result = make_json_safe({1, 2, 3})
        assert isinstance(result, list)
        assert set(result) == {1, 2, 3}

    def test_simple_dataclass(self):
        """Test that simple dataclasses are serialized."""
        dc = SimpleDataclass(name="test", value=42)
        result = make_json_safe(dc)
        assert result == {"name": "test", "value": 42}

    def test_dataclass_with_unpicklable_object(self):
        """Test that dataclasses with unpicklable objects don't raise errors.

        This tests the fix for the error:
        TypeError: cannot pickle '_thread.lock' object

        When asdict() fails due to deepcopy issues, the function should
        fall back to __dict__ serialization.
        """
        lock = threading.Lock()
        dc = DataclassWithLock(name="test", lock=lock)

        # Should not raise an error
        result = make_json_safe(dc)

        # Should have the name field
        assert result["name"] == "test"
        # Lock should be repr'd since it's not JSON-serializable
        assert "lock" in result or "Lock" in str(result)

    def test_circular_reference_in_dict(self):
        """Test that circular references in dicts are handled."""
        d: dict[str, Any] = {"a": 1}
        d["self"] = d  # Create circular reference

        result = make_json_safe(d)
        assert result["a"] == 1
        assert result["self"] == "<recursive>"

    def test_circular_reference_in_list(self):
        """Test that circular references in lists are handled."""
        lst: list[Any] = [1, 2]
        lst.append(lst)  # Create circular reference

        result = make_json_safe(lst)
        assert result[0] == 1
        assert result[1] == 2
        assert result[2] == "<recursive>"

    def test_object_with_circular_dict(self):
        """Test that objects with circular __dict__ references are handled."""
        class Circular:
            def __init__(self):
                self.name = "test"
                self.ref = self  # Circular reference

        obj = Circular()
        result = make_json_safe(obj)

        assert result["name"] == "test"
        assert result["ref"] == "<recursive>"

    def test_nested_unpicklable_in_dict(self):
        """Test that unpicklable objects nested in dicts are handled."""
        lock = threading.Lock()
        data = {"name": "test", "lock": lock}

        result = make_json_safe(data)
        assert result["name"] == "test"
        # Lock should be repr'd
        assert "Lock" in result["lock"] or "_thread.lock" in result["lock"]

    def test_dict_excludes_runtime_and_config(self):
        """Test that dicts exclude LangGraph-injected runtime/config keys.

        LangGraph/LangChain tool calls inject non-serializable runtime and config
        objects. These must be skipped during serialization.
        """
        # Simulate tool call args with runtime/config injection
        lock = threading.Lock()  # Non-serializable, like LangGraph runtime
        data = {
            "query": "search term",
            "limit": 10,
            "runtime": lock,   # Should be excluded
            "config": {"run_id": "abc"},  # config often has run_id; exclude entire key
        }
        result = make_json_safe(data)
        assert result["query"] == "search term"
        assert result["limit"] == 10
        assert "runtime" not in result
        assert "config" not in result

    def test_dataclass_excludes_runtime_and_config(self):
        """Test that dataclasses exclude LangGraph-injected runtime/config fields.

        When serializing dataclasses (e.g. Flight/tool call structures), runtime
        and config are injected by LangGraph and are not JSON-serializable.
        """
        lock = threading.Lock()
        dc = DataclassWithRuntimeConfig(
            name="search",
            args={"query": "test", "limit": 5},
            runtime=lock,
            config={"run_id": "xyz"},
        )
        result = make_json_safe(dc)
        assert result["name"] == "search"
        assert result["args"] == {"query": "test", "limit": 5}
        assert "runtime" not in result
        assert "config" not in result

    def test_json_dumps_with_runtime_config_serializes(self):
        """Test that json.dumps succeeds on objects with runtime/config.

        Full round-trip: make_json_safe + json.dumps must not raise when
        runtime/config are present (they are excluded before serialization).
        """
        lock = threading.Lock()
        data = {
            "tool": "search",
            "args": {"query": "hello"},
            "runtime": lock,
            "config": {"callbacks": []},
        }
        safe = make_json_safe(data)
        json_str = json.dumps(safe)
        parsed = json.loads(json_str)
        assert parsed["tool"] == "search"
        assert parsed["args"] == {"query": "hello"}
        assert "runtime" not in parsed
        assert "config" not in parsed

    def test_json_dumps_default_with_dataclass_runtime_config(self):
        """Test json.dumps(default=json_safe_stringify) with dataclass containing runtime/config."""
        lock = threading.Lock()
        dc = DataclassWithRuntimeConfig(
            name="fetch",
            args={"url": "https://example.com"},
            runtime=lock,
            config={"metadata": {}},
        )
        # json_safe_stringify is used as default= for non-JSON types
        json_str = json.dumps({"tool_call": dc}, default=json_safe_stringify)
        parsed = json.loads(json_str)
        assert parsed["tool_call"]["name"] == "fetch"
        assert parsed["tool_call"]["args"] == {"url": "https://example.com"}
        assert "runtime" not in parsed["tool_call"]
        assert "config" not in parsed["tool_call"]

    def test_uuid_value(self):
        """Test that UUID values are converted to their canonical string form."""
        test_uuid = uuid.UUID("550e8400-e29b-41d4-a716-446655440000")
        result = make_json_safe(test_uuid)
        assert result == "550e8400-e29b-41d4-a716-446655440000"
        assert isinstance(result, str)

    def test_uuid_as_dict_key(self):
        """Test that UUID keys in dicts are converted to strings.

        This is the critical case: json.dumps raises TypeError when dict keys
        are not str/int/float/bool/None. make_json_safe must convert UUID keys
        to strings so downstream json.dumps succeeds.
        """
        test_uuid = uuid.UUID("550e8400-e29b-41d4-a716-446655440000")
        data = {test_uuid: "some_value", "normal_key": 42}
        result = make_json_safe(data)
        assert "550e8400-e29b-41d4-a716-446655440000" in result
        assert result["550e8400-e29b-41d4-a716-446655440000"] == "some_value"
        assert result["normal_key"] == 42
        # Verify full round-trip through json.dumps
        json_str = json.dumps(result)
        parsed = json.loads(json_str)
        assert parsed["550e8400-e29b-41d4-a716-446655440000"] == "some_value"

    def test_uuid_in_nested_dict(self):
        """Test UUID keys in nested structures."""
        uid1 = uuid.UUID("11111111-1111-1111-1111-111111111111")
        uid2 = uuid.UUID("22222222-2222-2222-2222-222222222222")
        data = {"outer": {uid1: {"inner": {uid2: "deep_value"}}}}
        result = make_json_safe(data)
        json_str = json.dumps(result)
        parsed = json.loads(json_str)
        assert parsed["outer"]["11111111-1111-1111-1111-111111111111"]["inner"]["22222222-2222-2222-2222-222222222222"] == "deep_value"

    def test_uuid_in_list(self):
        """Test UUID values in lists are converted to strings."""
        uid = uuid.UUID("550e8400-e29b-41d4-a716-446655440000")
        result = make_json_safe([uid, "hello", 42])
        assert result == ["550e8400-e29b-41d4-a716-446655440000", "hello", 42]
