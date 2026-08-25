"""
This file is used to bridge the events from the crewai event bus to the ag-ui event bus.
"""

# ``BaseEvent`` moved from ``crewai.utilities.events.base_events``
# (crewai 0.x) to ``crewai.events.base_events`` (crewai 1.x) and is no longer
# re-exported at the events-package root. ``_capabilities`` resolves whichever
# location exists.
from ._capabilities import BaseEvent
from ag_ui.core.events import (
  ToolCallChunkEvent,
  ToolCallResultEvent,
  TextMessageChunkEvent,
  CustomEvent,
  StateSnapshotEvent,
  ReasoningStartEvent,
  ReasoningMessageStartEvent,
  ReasoningMessageContentEvent,
  ReasoningMessageEndEvent,
  ReasoningEndEvent,
  ReasoningEncryptedValueEvent,
)

# When ``crewai``'s events package doesn't resolve, ``BaseEvent`` is ``None``.
# Subclassing ``None`` (``class X(None, ...)``) crashes at
# class-definition (import) time with an opaque
# ``TypeError: NoneType takes no arguments`` — so the friendly, actionable
# ``_capabilities.warn_on_gaps`` warning (already logged at import naming
# ``crewai>=1.0``) never reaches the operator, who instead sees the raw
# TypeError. Degrade to a plain ``object`` base so importing the package does
# NOT hard-crash (fewer capabilities, not a crash): the ``Bridged*`` events are
# only ever emitted / dispatched on the event-bus path, which is itself
# unavailable when the crewai events package didn't resolve, so a non-crewai
# base here is inert rather than wrong.
#
# The fallback is an empty sibling class, NOT ``object``: the ``Bridged*``
# classes list the base FIRST (``class X(_BridgedBase, ToolCallChunkEvent)``),
# and ``object`` cannot precede a subclass-of-object in the base list (it must
# be last in any MRO) — ``(object, ToolCallChunkEvent)`` raises
# ``TypeError: Cannot create a consistent MRO``. An empty sibling class linearizes
# cleanly ahead of the ag-ui event model just like the real crewai ``BaseEvent``
# (a sibling ``BaseModel``) does.
class _InertBridgedBase:
    """Inert stand-in for crewai's ``BaseEvent`` when its events package didn't resolve."""


_BridgedBase = BaseEvent if BaseEvent is not None else _InertBridgedBase


class BridgedToolCallChunkEvent(_BridgedBase, ToolCallChunkEvent):
    """Bridged tool call chunk event"""

class BridgedToolCallResultEvent(_BridgedBase, ToolCallResultEvent):
    """Bridged tool call result event"""

class BridgedTextMessageChunkEvent(_BridgedBase, TextMessageChunkEvent):
    """Bridged text message chunk event"""

class BridgedCustomEvent(_BridgedBase, CustomEvent):
    """Bridged custom event"""

class BridgedStateSnapshotEvent(_BridgedBase, StateSnapshotEvent):
    """Bridged state snapshot event"""

# Reasoning lifecycle, emitted by ``sdk.copilotkit_stream`` off the litellm
# streaming delta (provider-agnostic: deepseek, Anthropic thinking, ...). Both
# transports translate them: the legacy bus listener and the frame translator.
class BridgedReasoningStartEvent(_BridgedBase, ReasoningStartEvent):
    """Bridged reasoning start event"""

class BridgedReasoningMessageStartEvent(_BridgedBase, ReasoningMessageStartEvent):
    """Bridged reasoning message start event"""

class BridgedReasoningMessageContentEvent(_BridgedBase, ReasoningMessageContentEvent):
    """Bridged reasoning message content event"""

class BridgedReasoningMessageEndEvent(_BridgedBase, ReasoningMessageEndEvent):
    """Bridged reasoning message end event"""

class BridgedReasoningEndEvent(_BridgedBase, ReasoningEndEvent):
    """Bridged reasoning end event"""

class BridgedReasoningEncryptedValueEvent(_BridgedBase, ReasoningEncryptedValueEvent):
    """Bridged reasoning encrypted-value event (signature / redacted thinking)"""


__all__ = [
    "BridgedToolCallChunkEvent",
    "BridgedToolCallResultEvent",
    "BridgedTextMessageChunkEvent",
    "BridgedCustomEvent",
    "BridgedStateSnapshotEvent",
    "BridgedReasoningStartEvent",
    "BridgedReasoningMessageStartEvent",
    "BridgedReasoningMessageContentEvent",
    "BridgedReasoningMessageEndEvent",
    "BridgedReasoningEndEvent",
    "BridgedReasoningEncryptedValueEvent",
]
