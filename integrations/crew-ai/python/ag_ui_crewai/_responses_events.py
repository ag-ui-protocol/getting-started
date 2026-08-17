"""The OpenAI Responses stream-event vocabulary this bridge reads.

One home for the event ``type`` discriminators and the two shape-agnostic reads
every projection needs, so ``_reasoning`` / ``sdk`` cannot drift apart about which
strings they match or how they read a payload.

This module is a LEAF: it imports only the stdlib, so ``_reasoning`` and
``sdk`` can both import it at module-load time without a circular dependency.
"""

from __future__ import annotations

from typing import Any, FrozenSet, Optional

# Event ``type`` discriminators, matched as STRINGS throughout. litellm maps a
# type it has no dedicated model for onto its extras-allowing ``GenericEvent``,
# so reading the string keeps the projection working across the supported
# litellm range (see the ``litellm`` floor in ``pyproject.toml``).
RESPONSES_CREATED = "response.created"
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

#: Every event type the bridge acts on. A Responses turn always carries at least
#: one of these (a terminal event at minimum), so a stream that yields none of
#: them is not a Responses stream at all. Dispatch to the Responses driver is
#: async-iterability alone, and this is what separates a turn that produced
#: nothing from an object that was never a turn. Extend it alongside any new
#: branch, or that branch's events stop counting as a turn.
RESPONSES_RECOGNISED: FrozenSet[str] = (
    frozenset(
        {
            RESPONSES_CREATED,
            RESPONSES_OUTPUT_ITEM_ADDED,
            RESPONSES_OUTPUT_ITEM_DONE,
            RESPONSES_OUTPUT_TEXT_DELTA,
            RESPONSES_FUNCTION_CALL_ARGS_DELTA,
        }
    )
    | RESPONSES_REASONING_TEXT_DELTAS
    | RESPONSES_TERMINAL
)


def responses_attr(payload: Any, key: str) -> Any:
    """Read ``key`` off a Responses payload that may be a dict or an object.

    Both shapes are live inside the supported litellm range: an output item is a
    plain dict at the floor and a response object on recent builds.
    """
    if payload is None:
        return None
    if isinstance(payload, dict):
        return payload.get(key)
    return getattr(payload, key, None)


def responses_event_type(event: Any) -> Optional[str]:
    """Return a Responses stream event's ``type`` as a plain string.

    litellm types the field as a ``str``-mixin enum on the events it knows and as
    a plain string on ``GenericEvent``; normalise both to the wire string.
    """
    raw = responses_attr(event, "type")
    if raw is None:
        return None
    return str(getattr(raw, "value", raw))


def responses_item_id(event: Any) -> Optional[str]:
    """The output-item id a Responses stream event carries, if any.

    Text, reasoning and function-call argument deltas expose it flat as
    ``item_id``, while ``output_item.added`` / ``.done`` define no such field and
    carry the id inside ``item``. Reading both is what keeps a stream on a real id
    from the provider instead of a minted uuid.
    """
    item_id = responses_attr(event, "item_id")
    if isinstance(item_id, str) and item_id:
        return item_id
    nested = responses_attr(responses_attr(event, "item"), "id")
    return nested if isinstance(nested, str) and nested else None
