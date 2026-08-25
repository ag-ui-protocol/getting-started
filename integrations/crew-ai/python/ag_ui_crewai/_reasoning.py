"""Provider-agnostic reasoning extraction for the CrewAI AG-UI bridge.

Three channels carry model reasoning to the bridge and all funnel through the
helpers here:

* the litellm chat-completions streaming delta (``copilotkit_stream``):
  ``delta.reasoning_content`` (a string; o1/o3, deepseek-reasoner, and most
  reasoning models normalised by litellm) and ``delta.thinking_blocks``
  (Anthropic extended thinking: ``thinking`` text + ``signature``, and
  ``redacted_thinking`` blocks carrying encrypted ``data``).
  ``reasoning_from_delta`` projects one delta onto text + encrypted blobs;
  ``reasoning_content`` wins as the text source per delta, since litellm mirrors
  the same text into a thinking block for Anthropic.
* crewai's native ``LLMThinkingChunkEvent`` (its Gemini provider, crewai
  >= 1.10.1), whose text rides on the ``chunk`` attribute. ``is_thinking_event``
  / ``thinking_event_text`` read it by ``type`` string so the frame translator
  stays decoupled from importing crewai.
* the OpenAI Responses-API stream (``copilotkit_responses``), whose reasoning
  summaries never appear on the chat-completions delta at all.
  ``reasoning_from_responses_event`` projects one Responses stream event onto
  the same ``DeltaReasoning``, so all three channels share one shape and one
  emission lifecycle.

This module is a LEAF: it imports only the stdlib and the stdlib-only
``_responses_events`` vocabulary, so ``sdk`` / ``_frames`` / ``endpoint`` can
import it at module-load time without a circular dependency.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from ._responses_events import (
    RESPONSES_OUTPUT_ITEM_DONE,
    RESPONSES_REASONING_TEXT_DELTAS,
    responses_attr,
    responses_event_type,
    responses_item_id,
)

# crewai's native thinking-chunk event ``type`` discriminator (its Gemini
# provider emits it via ``BaseLLM._emit_thinking_chunk_event``, crewai
# >= 1.10.1). Matched by string so this stays importable without crewai.
LLM_THINKING_CHUNK = "llm_thinking_chunk"


def is_thinking_event(event: Any) -> bool:
    """Return True when ``event`` is crewai's native LLM thinking-chunk event."""
    return getattr(event, "type", None) == LLM_THINKING_CHUNK


def thinking_event_text(event: Any) -> str | None:
    """Return the reasoning text carried by a native thinking-chunk event.

    crewai carries it on ``chunk``; return ``None`` for a chunk-less event so
    the caller can skip opening an empty reasoning message.
    """
    chunk = getattr(event, "chunk", None)
    return chunk if isinstance(chunk, str) and chunk else None


@dataclass(frozen=True)
class DeltaReasoning:
    """Reasoning projected out of a single litellm streaming delta.

    ``text`` is the concatenated reasoning text in this delta;
    ``encrypted`` holds any signature / redacted-thinking blobs (Anthropic
    extended thinking), surfaced as ``REASONING_ENCRYPTED_VALUE``; and
    ``item_id`` is the provider's replayable reasoning-item identity when the
    payload came from OpenAI Responses.
    """

    text: str = ""
    encrypted: tuple[str, ...] = field(default_factory=tuple)
    item_id: str | None = None

    def __bool__(self) -> bool:
        return bool(self.text or self.encrypted or self.item_id)


def reasoning_from_delta(delta: Any) -> DeltaReasoning:
    """Project one litellm streaming ``delta`` onto its reasoning content.

    Reads ``reasoning_content`` (string) and ``thinking_blocks`` (list of
    ``{type, thinking, signature}`` / ``{type: "redacted_thinking", data}``
    dicts). Forgiving: a missing or oddly-shaped field yields an empty result
    rather than raising, so a provider that carries no reasoning is a no-op.
    """
    getter = getattr(delta, "get", None)
    if not callable(getter):
        return DeltaReasoning()

    text_parts: list[str] = []
    encrypted: list[str] = []

    reasoning_content = getter("reasoning_content")
    has_reasoning_content = isinstance(reasoning_content, str) and bool(reasoning_content)
    if has_reasoning_content:
        text_parts.append(reasoning_content)

    blocks = getter("thinking_blocks")
    if isinstance(blocks, list):
        for block in blocks:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "redacted_thinking":
                data = block.get("data")
                if data:
                    encrypted.append(str(data))
                continue
            # litellm mirrors a thinking block's text into ``reasoning_content``
            # for Anthropic extended thinking, so taking both would emit every
            # token twice. Take the block text only when the delta carried no
            # reasoning_content. The signature is always kept: it rides on a
            # thinking block, never on reasoning_content.
            if not has_reasoning_content:
                thinking = block.get("thinking")
                if isinstance(thinking, str) and thinking:
                    text_parts.append(thinking)
            signature = block.get("signature")
            if signature:
                encrypted.append(str(signature))

    return DeltaReasoning(text="".join(text_parts), encrypted=tuple(encrypted))


# --------------------------------------------------------------------------
# OpenAI Responses-API channel
# --------------------------------------------------------------------------
# OpenAI streams reasoning SUMMARIES only over the Responses API; the
# chat-completions delta above carries none for its reasoning models. The event
# ``type`` discriminators below are matched as STRINGS rather than against
# litellm's ``ResponsesAPIStreamEvents`` enum: a litellm build that predates an
# event type maps it onto its extras-allowing ``GenericEvent``, so the payload
# still arrives on ``.delta`` / ``.item`` and reading the string keeps the
# projection working on old and new builds alike.
#
# The two type strings this projection reads are imported from
# ``_responses_events``, which keeps every Responses type next to the ROLE it
# plays for this bridge: ``RESPONSES_REASONING_TEXT_DELTAS`` are the
# reasoning-summary deltas (``summary_text`` is what ``reasoning.summary``
# produces, ``reasoning_text`` the raw variant some models emit), and
# ``RESPONSES_OUTPUT_ITEM_DONE`` is the completed output item carrying the
# encrypted reasoning blob when the caller asked for
# ``include=["reasoning.encrypted_content"]``.


def _require_reasoning_item_id(event: Any) -> str:
    """Return a replayable reasoning id, failing rather than minting one."""
    item_id = responses_item_id(event)
    if item_id is None:
        raise RuntimeError(
            "OpenAI Responses reasoning event is missing its reasoning item id"
        )
    return item_id


def reasoning_from_responses_event(event: Any) -> DeltaReasoning:
    """Project one OpenAI Responses-API stream event onto its reasoning content.

    A summary/reasoning text delta yields ``text``; a finished ``reasoning``
    output item yields its ``encrypted_content`` as an encrypted blob. Every
    other event is a no-op, so a non-reasoning model simply emits nothing.
    """
    event_type = responses_event_type(event)
    if event_type is None:
        return DeltaReasoning()

    if event_type in RESPONSES_REASONING_TEXT_DELTAS:
        delta = responses_attr(event, "delta")
        if isinstance(delta, str) and delta:
            return DeltaReasoning(
                text=delta,
                item_id=_require_reasoning_item_id(event),
            )
        return DeltaReasoning()

    if event_type == RESPONSES_OUTPUT_ITEM_DONE:
        item = responses_attr(event, "item")
        if item is None or responses_attr(item, "type") != "reasoning":
            return DeltaReasoning()
        item_id = _require_reasoning_item_id(event)
        encrypted = responses_attr(item, "encrypted_content")
        if encrypted:
            return DeltaReasoning(
                encrypted=(str(encrypted),),
                item_id=item_id,
            )
        return DeltaReasoning(item_id=item_id)

    return DeltaReasoning()
