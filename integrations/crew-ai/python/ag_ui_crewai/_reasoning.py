"""Provider-agnostic reasoning extraction for the CrewAI AG-UI bridge.

Two channels carry model reasoning to the bridge and both funnel through the
helpers here:

* the litellm streaming delta (``copilotkit_stream``): ``delta.reasoning_content``
  (a string; o1/o3, deepseek-reasoner, and most reasoning models normalised by
  litellm) and ``delta.thinking_blocks`` (Anthropic extended thinking: ``thinking``
  text + ``signature``, and ``redacted_thinking`` blocks carrying encrypted
  ``data``). ``reasoning_from_delta`` projects one delta onto text + encrypted
  blobs; ``reasoning_content`` wins as the text source per delta, since litellm
  mirrors the same text into a thinking block for Anthropic.
* crewai's native ``LLMThinkingChunkEvent`` (its Gemini provider, crewai
  >= 1.10.1), whose text rides on the ``chunk`` attribute. ``is_thinking_event``
  / ``thinking_event_text`` read it by ``type`` string so the frame translator
  stays decoupled from importing crewai.

This module is a LEAF: it imports only the stdlib, so ``sdk`` / ``_frames`` can
import it at module-load time without a circular dependency.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

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
    extended thinking), surfaced as ``REASONING_ENCRYPTED_VALUE``.
    """

    text: str = ""
    encrypted: tuple[str, ...] = field(default_factory=tuple)

    def __bool__(self) -> bool:
        return bool(self.text or self.encrypted)


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
