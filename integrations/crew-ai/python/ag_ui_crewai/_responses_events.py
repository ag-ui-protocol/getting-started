"""The OpenAI Responses stream-event vocabulary this bridge reads.

One home for two facts that must never disagree: WHICH Responses stream event
types the bridge consumes, and WHAT it consumes each one for. The second fact is
what decides the cost of losing an event, so both decisions that depend on it
derive from the roles here rather than from a list kept next to the decision:

* ``_responses.iter_responses_events`` decides from the role whether an event
  that failed to parse can be skipped or has to be reported.
* ``_capabilities`` decides from the role which types the installed litellm MUST
  be able to model for the channel to be declared available at all.

``tests/test_reasoning.py`` walks the driver's own source and asserts that every
event type it branches on has a role here (and that every non-envelope role here
is branched on), so this map cannot drift away from the code it describes.

The roles, and what losing one event of each costs:

``ENVELOPE``
    Stream bookkeeping: ``response.created`` (the turn's id / model / timestamp,
    each of which has a fallback -- the assistant message id falls back to the
    output item's own id) and ``response.in_progress`` (which the driver does not
    read at all). Losing one costs nothing this bridge maps.
``REASONING``
    A reasoning-summary text delta. Losing ONE leaves a gap in a trace while the
    answer and the outcome stay intact, so it is not fatal. A litellm that cannot
    model them AT ALL is different: it defeats the only reason this channel
    exists, so these types are required for the channel to be available.
``CONTINUATION``
    ``response.output_item.done``, read for the reasoning item's replay identity
    and its encrypted continuation state (when requested). Losing it produces a
    turn that renders once but cannot be replayed safely on the next turn.
``PAYLOAD``
    Answer text, a tool call's identity, a tool call's argument deltas. Losing
    one drops answer text or truncates arguments to invalid JSON while the turn
    still reports success, so nothing downstream can tell content went missing.
``TERMINAL``
    The stream's outcome. Losing one turns a failed stream into an empty
    assistant message with no failure recorded and no RUN_ERROR.

This module is a LEAF: it imports only the stdlib, so ``_capabilities`` /
``_reasoning`` / ``_responses`` can all import it at module-load time without a
circular dependency.
"""

from __future__ import annotations

from typing import Dict, FrozenSet, Optional

# Event ``type`` discriminators, matched as STRINGS throughout. A litellm build
# that predates an event type still delivers the payload on its extras-allowing
# catch-all model, so reading the string keeps the projection working on old and
# new builds alike.
RESPONSES_CREATED = "response.created"
RESPONSES_IN_PROGRESS = "response.in_progress"
RESPONSES_OUTPUT_ITEM_ADDED = "response.output_item.added"
RESPONSES_OUTPUT_ITEM_DONE = "response.output_item.done"
RESPONSES_OUTPUT_TEXT_DELTA = "response.output_text.delta"
RESPONSES_FUNCTION_CALL_ARGS_DELTA = "response.function_call_arguments.delta"
RESPONSES_COMPLETED = "response.completed"
RESPONSES_INCOMPLETE = "response.incomplete"
RESPONSES_FAILED = "response.failed"
RESPONSES_ERROR = "error"

#: Reasoning-summary text deltas. ``summary_text`` is what ``reasoning.summary``
#: produces; ``reasoning_text`` is the raw-reasoning variant some models emit.
RESPONSES_REASONING_SUMMARY_TEXT_DELTA = "response.reasoning_summary_text.delta"
RESPONSES_REASONING_TEXT_DELTA = "response.reasoning_text.delta"
RESPONSES_REASONING_TEXT_DELTAS: FrozenSet[str] = frozenset(
    {RESPONSES_REASONING_SUMMARY_TEXT_DELTA, RESPONSES_REASONING_TEXT_DELTA}
)

#: Terminal event types: the stream carries nothing more after one of these.
RESPONSES_TERMINAL: FrozenSet[str] = frozenset(
    {RESPONSES_COMPLETED, RESPONSES_INCOMPLETE, RESPONSES_FAILED, RESPONSES_ERROR}
)

# Roles. See the module docstring for what losing one event of each role costs.
ENVELOPE = "envelope"
REASONING = "reasoning"
CONTINUATION = "continuation"
PAYLOAD = "payload"
TERMINAL = "terminal"

#: Every Responses event type this bridge reads, and what it reads it for.
EVENT_ROLES: Dict[str, str] = {
    RESPONSES_CREATED: ENVELOPE,
    # Not read by the driver at all. Listed so an unparseable one is provably
    # skippable rather than unattributable.
    RESPONSES_IN_PROGRESS: ENVELOPE,
    RESPONSES_REASONING_SUMMARY_TEXT_DELTA: REASONING,
    RESPONSES_REASONING_TEXT_DELTA: REASONING,
    RESPONSES_OUTPUT_ITEM_DONE: CONTINUATION,
    RESPONSES_OUTPUT_ITEM_ADDED: PAYLOAD,
    RESPONSES_OUTPUT_TEXT_DELTA: PAYLOAD,
    RESPONSES_FUNCTION_CALL_ARGS_DELTA: PAYLOAD,
    **{event_type: TERMINAL for event_type in RESPONSES_TERMINAL},
}

#: Roles whose loss costs replay continuity, answer content, or the stream's
#: outcome. An event of one of these roles that fails to parse is REPORTED,
#: never skipped.
LOAD_BEARING_ROLES: FrozenSet[str] = frozenset(
    {CONTINUATION, PAYLOAD, TERMINAL}
)

#: Roles the channel cannot do its job without, so the installed litellm must be
#: able to model every type carrying one for the channel to be declared
#: available. Reasoning summaries are the visible trace; continuation items are
#: what makes that trace replayable with tool outputs on the next turn.
REQUIRED_ROLES: FrozenSet[str] = frozenset(
    {REASONING, CONTINUATION, PAYLOAD, TERMINAL}
)

#: How bad it is to lose an event of each role, for the one case where a single
#: litellm model class serves several types (its catch-all model): the most
#: severe role any of those types carries is the one that must win.
_ROLE_SEVERITY: Dict[str, int] = {
    ENVELOPE: 0,
    REASONING: 2,
    CONTINUATION: 3,
    PAYLOAD: 3,
    TERMINAL: 3,
}


def event_role(event_type: Optional[str]) -> Optional[str]:
    """The role ``event_type`` plays for this bridge, or ``None`` if unread."""
    if not event_type:
        return None
    return EVENT_ROLES.get(event_type)


def is_load_bearing(role: Optional[str]) -> bool:
    """Whether losing one event of ``role`` loses content or the outcome."""
    return role in LOAD_BEARING_ROLES


def role_severity(role: Optional[str]) -> int:
    """Order roles by the cost of losing one event, for the catch-all case."""
    return _ROLE_SEVERITY.get(role or "", -1)
