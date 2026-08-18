"""Tests for the AG-UI binary protocol (protobuf over HTTP) encoder path.

These exercise ``EventEncoder`` when the client negotiates
``application/vnd.ag-ui.event+proto``. They require the optional ``protobuf``
runtime (``pip install "ag-ui-protocol[proto]"``) and are skipped otherwise.
"""

import unittest

from ag_ui.core import events as E
from ag_ui.core.types import AssistantMessage
from ag_ui.encoder.encoder import EventEncoder, AGUI_MEDIA_TYPE

try:
    from google.protobuf import json_format

    from ag_ui.proto import events_pb2, patch_pb2

    _HAS_PROTO = True
except ImportError:  # pragma: no cover
    _HAS_PROTO = False


@unittest.skipUnless(_HAS_PROTO, "requires ag-ui-protocol[proto] (protobuf)")
class TestProtoEncoder(unittest.TestCase):
    def setUp(self):
        self.enc = EventEncoder(accept=AGUI_MEDIA_TYPE)

    def _decode(self, event):
        data = self.enc.encode(event)
        self.assertIsInstance(data, (bytes, bytearray))
        msg = events_pb2.Event()
        msg.ParseFromString(data)
        return msg

    def test_content_type_negotiation(self):
        self.assertEqual(EventEncoder(accept=AGUI_MEDIA_TYPE).get_content_type(), AGUI_MEDIA_TYPE)
        self.assertEqual(EventEncoder().get_content_type(), "text/event-stream")
        self.assertEqual(EventEncoder(accept="text/event-stream").get_content_type(), "text/event-stream")

    def test_sse_still_default(self):
        sse = EventEncoder().encode(E.TextMessageContentEvent(message_id="m1", delta="x"))
        self.assertIsInstance(sse, str)
        self.assertTrue(sse.startswith("data: "))

    def test_text_message_content(self):
        msg = self._decode(E.TextMessageContentEvent(message_id="m1", delta="hola"))
        self.assertEqual(msg.WhichOneof("event"), "text_message_content")
        self.assertEqual(msg.text_message_content.delta, "hola")
        self.assertEqual(
            msg.text_message_content.base_event.type,
            events_pb2.EventType.TEXT_MESSAGE_CONTENT,
        )

    def test_tool_and_step_and_run(self):
        self.assertEqual(
            self._decode(E.ToolCallStartEvent(tool_call_id="c1", tool_call_name="foo"))
            .tool_call_start.tool_call_name,
            "foo",
        )
        self.assertEqual(
            self._decode(E.StepStartedEvent(step_name="node_a")).step_started.step_name,
            "node_a",
        )
        self.assertEqual(
            self._decode(E.RunStartedEvent(thread_id="t", run_id="r")).run_started.run_id,
            "r",
        )

    def test_state_snapshot_arbitrary_json(self):
        msg = self._decode(E.StateSnapshotEvent(snapshot={"user_story": {"title": "X"}, "n": 3}))
        d = json_format.MessageToDict(msg)
        self.assertEqual(d["stateSnapshot"]["snapshot"]["user_story"]["title"], "X")
        self.assertEqual(d["stateSnapshot"]["snapshot"]["n"], 3)

    def test_state_delta_op_enum_mapping(self):
        msg = self._decode(
            E.StateDeltaEvent(
                delta=[
                    {"op": "add", "path": "/a", "value": 1},
                    {"op": "replace", "path": "/b", "value": 2},
                ]
            )
        )
        self.assertEqual(msg.state_delta.delta[0].op, patch_pb2.JsonPatchOperationType.ADD)
        self.assertEqual(msg.state_delta.delta[1].op, patch_pb2.JsonPatchOperationType.REPLACE)
        self.assertEqual(msg.state_delta.delta[0].path, "/a")

    def test_run_finished_without_outcome(self):
        msg = self._decode(E.RunFinishedEvent(thread_id="t", run_id="r"))
        self.assertEqual(msg.WhichOneof("event"), "run_finished")

    def test_messages_snapshot_string_content(self):
        msg = self._decode(
            E.MessagesSnapshotEvent(
                messages=[AssistantMessage(id="a1", role="assistant", content="hi")]
            )
        )
        self.assertEqual(msg.messages_snapshot.messages[0].content, "hi")

    def test_custom(self):
        self.assertEqual(
            self._decode(E.CustomEvent(name="PredictState", value={"k": "v"})).custom.name,
            "PredictState",
        )


if __name__ == "__main__":
    unittest.main()
