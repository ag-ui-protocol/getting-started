"""
This module contains the EventEncoder class.

The encoder supports two wire formats, negotiated from the client's ``Accept``
header via :meth:`EventEncoder.get_content_type`:

* ``text/event-stream`` (default) — Server-Sent Events (``data: {json}\\n\\n``).
* ``application/vnd.ag-ui.event+proto`` — the AG-UI binary protocol: each event
  is serialized as a protobuf ``Event`` message. This mirrors the TypeScript
  ``@ag-ui/proto`` ``encode`` (same ``.proto`` schemas), so a client using
  ``parseProtoStream`` decodes it directly. The 4-byte big-endian length prefix
  that frames each message on a stream is added by the transport layer (e.g.
  ``ag-ui-adk``), matching the TS ``encode`` which also returns the bare message.
"""

from ag_ui.core.events import BaseEvent, EventType

AGUI_MEDIA_TYPE = "application/vnd.ag-ui.event+proto"


def _to_camel_case(screaming_snake: str) -> str:
    """``TEXT_MESSAGE_CONTENT`` -> ``textMessageContent`` (the proto oneof / JSON name)."""
    parts = screaming_snake.lower().split("_")
    return parts[0] + "".join(part.capitalize() for part in parts[1:])


class EventEncoder:
    """
    Encodes Agent User Interaction events.
    """
    def __init__(self, accept: str = None):
        self._accept = accept or ""

    def get_content_type(self) -> str:
        """
        Returns the content type negotiated from the ``accept`` header.

        Returns ``application/vnd.ag-ui.event+proto`` when the client accepts the
        AG-UI binary protocol, otherwise ``text/event-stream``.
        """
        if AGUI_MEDIA_TYPE in self._accept:
            return AGUI_MEDIA_TYPE
        return "text/event-stream"

    def encode(self, event: BaseEvent):
        """
        Encodes an event.

        Returns an SSE ``str`` for the default content type, or protobuf
        ``bytes`` (a bare ``Event`` message, no length prefix) when the binary
        protocol was negotiated.
        """
        if self.get_content_type() == AGUI_MEDIA_TYPE:
            return self._encode_proto(event)
        return self._encode_sse(event)

    def _encode_sse(self, event: BaseEvent) -> str:
        """
        Encodes an event into an SSE string.
        """
        return f"data: {event.model_dump_json(by_alias=True, exclude_none=True)}\n\n"

    def _encode_proto(self, event: BaseEvent) -> bytes:
        """
        Encodes an event into a protobuf ``Event`` message (bare, unframed).
        """
        # Imported lazily so the SSE path has no hard dependency on the protobuf
        # runtime / generated modules.
        try:
            from google.protobuf import json_format

            from ag_ui.proto import events_pb2
        except ImportError as exc:  # pragma: no cover - import guard
            raise ImportError(
                "The AG-UI binary protocol requires the 'protobuf' runtime. "
                'Install it with: pip install "ag-ui-protocol[proto]"'
            ) from exc

        payload = event.model_dump(by_alias=True, exclude_none=True, mode="json")
        event_type = payload.pop("type")
        timestamp = payload.pop("timestamp", None)
        raw_event = payload.pop("rawEvent", None)

        base_event = {"type": event_type}
        if timestamp is not None:
            base_event["timestamp"] = timestamp
        if raw_event is not None:
            base_event["rawEvent"] = raw_event

        payload = self._apply_proto_special_cases(event_type, payload)

        oneof_field = _to_camel_case(event_type)
        event_dict = {oneof_field: {"baseEvent": base_event, **payload}}

        message = json_format.ParseDict(
            event_dict, events_pb2.Event(), ignore_unknown_fields=True
        )
        return message.SerializeToString()

    @staticmethod
    def _apply_proto_special_cases(event_type: str, payload: dict) -> dict:
        """Reshape a few events to match the proto schema (mirrors the TS encoder).

        - ``STATE_DELTA``: JSON-Patch ``op`` string -> ``JsonPatchOperationType``
          enum name (upper-case).
        - ``RUN_FINISHED``: flatten the ``outcome`` discriminated union into the
          proto's ``outcome`` (string) + ``interrupts`` (repeated) fields.
        - ``MESSAGES_SNAPSHOT``: drop non-string ``content`` (multimodal arrays)
          so it doesn't clash with the proto ``content`` string field; full
          content-part mapping is left as a follow-up.
        """
        if event_type == EventType.STATE_DELTA:
            delta = payload.get("delta")
            if isinstance(delta, list):
                payload["delta"] = [
                    {**op, "op": str(op["op"]).upper()}
                    if isinstance(op, dict) and "op" in op
                    else op
                    for op in delta
                ]
        elif event_type == EventType.RUN_FINISHED:
            outcome = payload.pop("outcome", None)
            if isinstance(outcome, dict) and outcome.get("type") == "interrupt":
                payload["outcome"] = "interrupt"
                payload["interrupts"] = outcome.get("interrupts", [])
            elif outcome is not None:
                payload["outcome"] = "success"
                payload["interrupts"] = []
        elif event_type == EventType.MESSAGES_SNAPSHOT:
            messages = payload.get("messages")
            if isinstance(messages, list):
                for message in messages:
                    if isinstance(message, dict) and not isinstance(
                        message.get("content"), (str, type(None))
                    ):
                        message.pop("content", None)
        return payload
