from ag_ui.core import ToolMessage

from ag_ui_strands.agent import _build_strands_history, _build_snapshot_messages


def _tool_message(**overrides):
    fields = dict(
        id="t1",
        role="tool",
        content="Tool failed: invalid id",
        tool_call_id="tc1",
    )
    fields.update(overrides)
    return ToolMessage(**fields)


class TestBedrockToolResultStatus:
    def test_error_maps_onto_bedrock_status(self):
        # A client-reported tool failure must reach the model as an error, not a
        # silent success -- AG-UI's ToolMessage.error sets Bedrock's toolResult status.
        history = _build_strands_history([_tool_message(error="invalid id")])
        tool_result = history[0]["content"][0]["toolResult"]
        assert tool_result["status"] == "error"

    def test_defaults_to_success_without_error(self):
        history = _build_strands_history([_tool_message(content="42")])
        tool_result = history[0]["content"][0]["toolResult"]
        assert tool_result["status"] == "success"


class TestSnapshotPreservesClientFields:
    def test_preserves_error_and_encrypted_value(self):
        # _build_snapshot_messages rebuilds the client's own message; it must not
        # drop the client's error / encrypted_value on the snapshot echo.
        snapshot = _build_snapshot_messages(
            [_tool_message(error="invalid id", encrypted_value="enc-abc")]
        )
        assert snapshot[0].error == "invalid id"
        assert snapshot[0].encrypted_value == "enc-abc"

    def test_leaves_error_unset_when_absent(self):
        snapshot = _build_snapshot_messages([_tool_message(content="42")])
        assert snapshot[0].error is None
