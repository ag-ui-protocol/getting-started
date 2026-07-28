"""
This file is used to bridge the events from the crewai event bus to the ag-ui event bus.
"""

# CPK-7718: ``BaseEvent`` moved from ``crewai.utilities.events.base_events``
# (crewai 0.x) to ``crewai.events.base_events`` (crewai 1.x) and is no longer
# re-exported at the events-package root. ``_capabilities`` resolves whichever
# location exists.
from ._capabilities import BaseEvent
from ag_ui.core.events import (
  ToolCallChunkEvent,
  TextMessageChunkEvent,
  CustomEvent,
  StateSnapshotEvent
)

class BridgedToolCallChunkEvent(BaseEvent, ToolCallChunkEvent):
    """Bridged tool call chunk event"""

class BridgedTextMessageChunkEvent(BaseEvent, TextMessageChunkEvent):
    """Bridged text message chunk event"""

class BridgedCustomEvent(BaseEvent, CustomEvent):
    """Bridged custom event"""

class BridgedStateSnapshotEvent(BaseEvent, StateSnapshotEvent):
    """Bridged state snapshot event"""