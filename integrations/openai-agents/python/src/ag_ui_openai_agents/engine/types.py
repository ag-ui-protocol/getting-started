"""Type definitions for the OpenAI Agents integration.

Result containers the translators hand back (``TranslatedInput``), plus the
OpenAI wire-level discriminator values the outbound translator dispatches on
(``OpenAIItemType``, ``OpenAIRawResponseEventType``, ``OpenAIStreamEventType``,
``HOSTED_TOOL_CALL_TYPES``). Members of the ``(str, Enum)`` classes compare
equal to the raw wire strings (``StrEnum`` needs Python 3.11; this package
supports 3.10+). The SDK's own ``Literal[...]`` annotations are the source of
truth for those — see ``tests/engine/test_types_drift.py``. Translator
behavior lives in ``agui_to_openai.py`` and ``openai_to_agui.py``; this module
only describes shapes and constants.
"""

from __future__ import annotations

from enum import Enum
from typing import Any

from agents import FunctionTool, TResponseInputItem
from agents.exceptions import AgentsException
from pydantic import BaseModel, ConfigDict, SkipValidation

from ag_ui.core import Context


# ── ag_ui_openai_agents result types ────────────────────────────────────────

class TranslatedInput(BaseModel):
    """OpenAI Agents SDK-ready bundle produced by translating an AG-UI RunAgentInput.

    Returned by ``AGUITranslator.to_openai()`` (or
    ``AGUIToOpenAITranslator.translate()`` directly, for advanced/per-mapping
    use). Fields mirror ``ag_ui.core.RunAgentInput`` by name, so if you know the
    wire format you already know this shape. (``parent_run_id`` and ``resume``
    are the newest core fields and are read defensively, so an older client may
    not carry them.) Only ``messages`` and ``tools`` are actually
    translated into OpenAI Agents SDK types; everything else passes through
    unchanged for you to use however your app needs.

    Example:
        translated_input = translator.to_openai(run_input)
        result = Runner.run_streamed(
            agent,
            input=translated_input.messages,
            context=translated_input.context,
        )

    Attributes:
        thread_id: Conversation key. Stays the same across turns of one thread.
        run_id: Id for this single run. Goes on the RUN_STARTED / RUN_FINISHED events.
        parent_run_id: Set when this run was kicked off by another run
            (nested/branched); None for a top-level run.
        messages: Responses-API input items, ready to pass to
            ``Runner.run*(input=...)``.
        tools: FunctionTool proxies for the client's tools. Merge these with
            your agent's own tools before running.
        state: Whatever the client sent as state. Any, since AG-UI doesn't
            pin a shape.
        context: Ambient ``{description, value}`` items from the frontend.
            Nothing folds these into the prompt for you.
        forwarded_props: Grab-bag of extra client props (model overrides,
            temperature, flags, ...) that don't have a dedicated field.
        resume: Resume entries when continuing from an interrupt, else None.
    """

    # ── Identity ─────────────────────────────────────────────────────────
    thread_id: str
    """Conversation key. Stays the same across turns of one thread."""

    run_id: str
    """Id for this single run. Goes on the RUN_STARTED / RUN_FINISHED events."""

    parent_run_id: str | None = None
    """Set when this run was kicked off by another run (nested/branched);
    None for a top-level run."""

    # ── Translated payload (the actual work the translator does) ────────
    messages: SkipValidation[list[TResponseInputItem]]
    """Responses-API input items, ready to pass to Runner.run*(input=...).

    Validation is skipped (like ``tools``). Two reasons: (1) audio parts use the
    Chat-Completions ``input_audio`` shape, which is a valid model input for an
    audio-capable agent but is not a member of the Responses input-item union, so
    strict validation would reject an otherwise-usable request; (2) validating a
    reasoning item's ``summary`` (typed ``Iterable`` in the SDK) materializes it as
    a single-use ``ValidatorIterator`` that empties after one read. The SDK
    validates the shape it actually consumes at run time."""

    tools: SkipValidation[list[FunctionTool]] = []
    """FunctionTool proxies for the client's tools. Merge these with your
    agent's own tools before running. The public translators fill this in; if
    you call the inbound engine directly, call translate_tools yourself.
    Validation skipped for the same forward-ref reason as messages."""

    # ── Passthroughs (raw from the wire) ────────────────────────────────
    state: Any
    """Whatever the client sent as state. Any, since AG-UI doesn't pin a shape."""

    context: list[Context]
    """Ambient {description, value} items from the frontend. Nothing folds these
    into the prompt for you — run them through translate_context if you want the
    model to see them."""

    forwarded_props: Any
    """Grab-bag of extra client props (model overrides, temperature, flags, ...)
    that don't have a dedicated field."""

    resume: list[Any] | None = None
    """Resume entries when continuing from an interrupt, else None. Read
    defensively since not every RunAgentInput version carries this field yet."""

    # FunctionTool isn't a Pydantic model, so Pydantic won't accept it unless
    # we explicitly allow arbitrary types.
    model_config = ConfigDict(arbitrary_types_allowed=True)


# FunctionTool's schema points at AgentBase, which Pydantic can't see from
# here. Pull it into scope and rebuild the model so the `tools` field resolves.
from agents.agent import AgentBase  # noqa: E402,F401

TranslatedInput.model_rebuild()


# ── OpenAI wire discriminators (raw events openai-agents emits) ─────────────────

class OpenAIStreamEventType(str, Enum):
    """Top-level StreamEvent.type values yielded by Runner.run_streamed."""

    RAW_RESPONSE = "raw_response_event"
    RUN_ITEM = "run_item_stream_event"
    AGENT_UPDATED = "agent_updated_stream_event"


class OpenAIRawResponseEventType(str, Enum):
    """Raw Responses-API delta type values the outbound translator consumes.

    Non-semantic bookkeeping kinds (response.created / .completed,
    content_part.*, audio) are deliberately absent — they translate to
    nothing.
    """

    OUTPUT_ITEM_ADDED = "response.output_item.added"
    OUTPUT_ITEM_DONE = "response.output_item.done"
    TEXT_DELTA = "response.output_text.delta"
    TEXT_DONE = "response.output_text.done"
    REFUSAL_DELTA = "response.refusal.delta"
    FUNCTION_CALL_ARGUMENTS_DELTA = "response.function_call_arguments.delta"
    REASONING_SUMMARY_DELTA = "response.reasoning_summary_text.delta"
    REASONING_SUMMARY_PART_DONE = "response.reasoning_summary_part.done"
    REASONING_TEXT_DELTA = "response.reasoning_text.delta"
    REASONING_TEXT_DONE = "response.reasoning_text.done"


class OpenAIItemType(str, Enum):
    """Output-item type values carried by output_item.added / .done."""

    MESSAGE = "message"
    FUNCTION_CALL = "function_call"
    REASONING = "reasoning"


# Tools that run on OpenAI's side. We still show them as AG-UI tool calls, but
# the API doesn't stream their arguments, so at the raw level all we can emit is
# START/END. The run-item layer fills in the rest when it has it.
HOSTED_TOOL_CALL_TYPES: frozenset[str] = frozenset(
    {
        "web_search_call",
        "file_search_call",
        "code_interpreter_call",
        "image_generation_call",
        "computer_call",
        "local_shell_call",
        "shell_call",
        "apply_patch_call",
        "mcp_call",
        "custom_tool_call",
        "tool_search_call",
    }
)


# ── Sentinel exception used by client-tool proxies ──────────────────────────

class ClientToolPending(AgentsException):
    """Raised by a client-tool proxy to signal "stop, the UI owns this call".

    The AG-UI run closes normally after forwarding the tool call. The client
    executes it and returns the result in a later request.

    Subclasses AgentsException deliberately: the SDK's own tool executor
    (agents.run_internal.tool_execution._run_single_tool) special-cases
    `isinstance(e, AgentsException)` to re-raise it as-is — anything else
    gets wrapped in a generic UserError first, which would hide this from
    the outer run loop's `except ClientToolPending` and turn every
    client-owned tool call into a hard run failure instead of a clean
    hand-off.

    Args:
        tool_name: Name of the client-owned tool that was called.
        tool_call_id: The SDK's call_id for this invocation.
        arguments: Raw JSON arguments string the model produced.
    """

    def __init__(self, tool_name: str, tool_call_id: str, arguments: str) -> None:
        super().__init__(
            f"Client tool '{tool_name}' (call_id={tool_call_id}) pending UI execution"
        )
        self.tool_name = tool_name
        self.tool_call_id = tool_call_id
        self.arguments = arguments


__all__ = [
    "ClientToolPending",
    "HOSTED_TOOL_CALL_TYPES",
    "OpenAIItemType",
    "OpenAIRawResponseEventType",
    "OpenAIStreamEventType",
    "TranslatedInput",
]
