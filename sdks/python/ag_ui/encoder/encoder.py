"""
This module contains the EventEncoder class
"""

from ag_ui.core.events import BaseEvent

AGUI_MEDIA_TYPE = "application/vnd.ag-ui.event+proto"

class EventEncoder:
    """
    Encodes Agent User Interaction events.
    """
    def __init__(self, accept: str = None):
        pass

    def get_content_type(self) -> str:
        """
        Returns the content type of the encoder.
        """
        return "text/event-stream"

    def encode(self, event: BaseEvent) -> str:
        """
        Encodes an event.
        """
        return self._encode_sse(event)

    def _encode_sse(self, event: BaseEvent) -> str:
        """
        Encodes an event into an SSE string.

        Optional fields with no value are left out by ``ConfiguredBaseModel``
        itself, so no ``exclude_none`` is passed here — every producer path gets
        the same omission whether or not it goes through this encoder.
        """
        return f"data: {event.model_dump_json(by_alias=True)}\n\n"
