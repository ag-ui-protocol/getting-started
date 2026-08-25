"""Tests for dump_json_safe function.

Validates that dump_json_safe correctly handles non-string dict keys (e.g. UUID)
which cause TypeError in json.dumps if not pre-processed.
"""
import json
import unittest
import uuid

from ag_ui_langgraph.agent import dump_json_safe


class TestDumpJsonSafe(unittest.TestCase):
    """Tests for the dump_json_safe top-level function."""

    def test_string_passthrough(self):
        """Strings are returned verbatim without re-encoding."""
        assert dump_json_safe("hello") == "hello"
        assert dump_json_safe('{"key": "value"}') == '{"key": "value"}'

    def test_simple_dict(self):
        """Plain dicts serialize correctly."""
        result = dump_json_safe({"key": "value", "num": 42})
        parsed = json.loads(result)
        assert parsed == {"key": "value", "num": 42}

    def test_dict_with_uuid_keys(self):
        """Dicts with UUID keys must not raise TypeError.

        This was the original bug: json.dumps only invokes its ``default``
        callback for non-serializable VALUES — not KEYS. UUID keys caused:
            TypeError: keys must be str, int, float, bool or None, not UUID
        """
        uid = uuid.UUID("550e8400-e29b-41d4-a716-446655440000")
        data = {uid: "some_value", "normal": 123}
        result = dump_json_safe(data)
        parsed = json.loads(result)
        assert parsed["550e8400-e29b-41d4-a716-446655440000"] == "some_value"
        assert parsed["normal"] == 123

    def test_nested_uuid_keys(self):
        """Nested dicts with UUID keys serialize correctly."""
        uid1 = uuid.UUID("11111111-1111-1111-1111-111111111111")
        uid2 = uuid.UUID("22222222-2222-2222-2222-222222222222")
        data = {uid1: {uid2: "deep"}}
        result = dump_json_safe(data)
        parsed = json.loads(result)
        assert parsed["11111111-1111-1111-1111-111111111111"]["22222222-2222-2222-2222-222222222222"] == "deep"

    def test_uuid_values(self):
        """UUID values in dicts are also serialized to strings."""
        uid = uuid.UUID("550e8400-e29b-41d4-a716-446655440000")
        data = {"id": uid, "name": "test"}
        result = dump_json_safe(data)
        parsed = json.loads(result)
        assert parsed["id"] == "550e8400-e29b-41d4-a716-446655440000"

    def test_interrupt_value_with_uuid_keys(self):
        """Simulates real-world interrupt values containing UUID keys.

        LangGraph interrupt values often contain UUID-keyed dicts when
        the graph state uses UUID identifiers.
        """
        thread_id = uuid.uuid4()
        checkpoint_id = uuid.uuid4()
        interrupt_value = {
            "question": "Do you approve?",
            "metadata": {thread_id: "thread_info", checkpoint_id: "checkpoint_info"},
        }
        result = dump_json_safe(interrupt_value)
        parsed = json.loads(result)
        assert parsed["question"] == "Do you approve?"
        assert str(thread_id) in parsed["metadata"]
        assert str(checkpoint_id) in parsed["metadata"]

    def test_list_value(self):
        """Lists serialize correctly."""
        result = dump_json_safe([1, "two", 3.0])
        parsed = json.loads(result)
        assert parsed == [1, "two", 3.0]

    def test_none_value(self):
        """None serializes to JSON null."""
        result = dump_json_safe(None)
        assert json.loads(result) is None
