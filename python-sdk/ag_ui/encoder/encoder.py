"""
This module contains the EventEncoder class
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ag_ui.core.events import BaseEvent


AGUI_MEDIA_TYPE = "application/vnd.ag-ui.event+proto"

class EventEncoder:
    """
    Encodes Agent User Interaction events.
    """
    def __init__(self, accept: str | None = None) -> None:
        """
        Initializes the EventEncoder.
        """
        self.accept = accept

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
        """
        return f"data: {event.model_dump_json(by_alias=True, exclude_none=True)}\n\n"
