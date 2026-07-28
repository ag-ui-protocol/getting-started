"""Translate OpenAI Agents SDK stream events into AG-UI events."""

import logging
from typing import Any, Sequence

from agents import (
    HandoffCallItem,
    HandoffOutputItem,
    ItemHelpers,
    MCPApprovalRequestItem,
    MCPApprovalResponseItem,
    MessageOutputItem,
    ReasoningItem,
    RunItem,
    ToolCallItem,
    ToolCallOutputItem,
)
from agents.items import MCPListToolsItem  # not re-exported at package top level
from agents.models.fake_id import FAKE_RESPONSES_ID

from ag_ui.core import (
    AssistantMessage,
    BaseEvent,
    CustomEvent,
    EventType,
    FunctionCall,
    Message,
    MessagesSnapshotEvent,
    ReasoningEncryptedValueEvent,
    ReasoningEndEvent,
    ReasoningMessageContentEvent,
    ReasoningMessageEndEvent,
    ReasoningMessageStartEvent,
    ReasoningStartEvent,
    RunAgentInput,
    StepFinishedEvent,
    StepStartedEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    TextMessageStartEvent,
    ToolCall,
    ToolCallArgsEvent,
    ToolCallEndEvent,
    ToolCallResultEvent,
    ToolCallStartEvent,
    ToolMessage,
)
from .helpers import (
    new_message_id,
    new_reasoning_id,
    new_tool_call_id,
    new_tool_result_id,
    read_attr,
    to_string,
)
from .types import (
    HOSTED_TOOL_CALL_TYPES,
    OpenAIItemType,
    OpenAIRawResponseEventType,
    OpenAIStreamEventType,
)

logger = logging.getLogger(__name__)


class OpenAIToAGUITranslator:
    """Translate one OpenAI Agents SDK run into AG-UI events.

    This translator is stateful and must be created once per run. It tracks
    open text, tool-call, reasoning, and agent-step sequences so each AG-UI
    sequence follows START, content, and END ordering.

    Raw response events provide incremental content. Completed run items close
    streamed sequences or emit a complete sequence when no deltas arrived.
    ``finalize()`` closes any sequence still open when the stream ends.

    OpenAI Agents SDK item IDs are reused when available. Missing or placeholder
    IDs are replaced with generated AG-UI IDs, while internal correlation keys
    ensure later deltas and completion events update the same sequence.

    ``AGUITranslator`` owns run-level lifecycle and snapshot events, including
    ``RUN_STARTED``, ``RUN_FINISHED``, ``RUN_ERROR``, and message/state snapshots.
    """

    # Prefix marking internal placeholder window keys minted by _window_key.
    # These are correlation keys only and must never be emitted as AG-UI ids
    # (unlike real wire item ids, which _is_real_id also reports truthy).
    _PLACEHOLDER_PREFIX = "__idx_"

    def __init__(self) -> None:
        # Text sequences: defer empty messages and reconcile streamed commits.
        self._open_texts: dict[str, str] = {}  # key -> message_id
        self._pending_text_ids: dict[str, str] = {}  # key -> deferred message_id
        self._closed_text_ids: list[str] = []  # closed message_ids

        # Tool-call sequences: keep streamed arguments and commits deduplicated.
        self._open_tool_calls: dict[str, str] = {}  # key -> tool_call_id
        self._seen_call_ids: set[str] = set()  # emitted tool_call_ids
        # Args that streamed before a START (provider skipped output_item.added):
        # buffered by window key until the real call_id is known, so we never
        # emit a call under a throwaway id the later commit can't reconcile.
        self._pending_tool_args: dict[str, str] = {}  # key -> buffered args

        # Reasoning sequences: track phases, parts, replay data, and reconciliation.
        self._open_reasonings: dict[str, str] = {}  # key -> phase message_id
        self._open_reasoning_parts: dict[str, str] = {}  # key -> part message_id
        self._closed_reasoning_ids: list[str] = []  # closed phase message_ids
        self._emitted_encrypted_keys: set[str] = set()  # emitted keys
        self._reasoning_part_seq: dict[str, int] = {}  # key -> next part index
        self._reasoning_phase_ids: dict[str, str] = {}  # key -> phase message_id

        # Active placeholder IDs: output_index -> unique internal key.
        self._placeholder_window_keys: dict[Any, str] = {}
        self._placeholder_window_seq = 0

        # Agent-step state for ordered STEP_FINISHED and STEP_STARTED events.
        self._current_step: str | None = None  # active step name

        # Completed messages using the same IDs as their streamed events.
        self._snapshot_messages: list[Message] = []  # completed AG-UI messages

    # ─────────────────────────────────────────────────────────────────────
    # LEVEL 1 — Stream lifecycle
    # ─────────────────────────────────────────────────────────────────────

    def translate(self, openai_event: Any) -> list[BaseEvent]:
        """Translate one OpenAI Agents SDK stream event into ordered AG-UI events.

        Raw response events stream START, content, and END sequences. Run-item
        events close those sequences or emit them whole when no deltas arrived.
        Agent updates emit STEP_FINISHED before STEP_STARTED.

        Across a run, ``AGUITranslator.to_agui()`` emits RUN_STARTED, optional
        initial events, translated stream sequences, finalized closing events,
        optional snapshots, and RUN_FINISHED. It emits RUN_ERROR on failure.

        Args:
            openai_event: One event from ``result.stream_events()``.

        Returns:
            Ordered AG-UI events, or an empty list if nothing is translatable.
        """
        event_type = read_attr(openai_event, "type")
        if event_type == OpenAIStreamEventType.RAW_RESPONSE:
            return self.translate_raw_response_event(openai_event)
        if event_type == OpenAIStreamEventType.RUN_ITEM:
            return self.translate_run_item_event(openai_event)
        if event_type == OpenAIStreamEventType.AGENT_UPDATED:
            return self.translate_agent_updated_event(openai_event)
        logger.debug("Unknown OpenAI Agents SDK stream event type: %s", event_type)
        return []

    def finalize(self) -> list[BaseEvent]:
        """Emit pending *_END markers when the OpenAI Agents SDK stream terminates.

        Always call this after the stream ends — even on error — so the
        AG-UI client never sees a window that opened but never closed.

        Returns:
            Closing events, or an empty list if no windows or agent step remain open.
        """
        events: list[BaseEvent] = []
        for key in list(self._open_texts):
            events.extend(self._close_text(key))
        for key in list(self._open_tool_calls):
            events.extend(self._close_tool_call(key))
        # Args that streamed before a START and never got one (no output_item.added
        # and no run-item commit) describe a tool call the SDK never committed —
        # it is incomplete and has no known name/call_id, so drop it rather than
        # surface a phantom empty-name call under a synthesized id.
        for key in list(self._pending_tool_args):
            delta = self._pending_tool_args.pop(key)
            logger.debug(
                "Dropping %d buffered arg chars for uncommitted tool call (key=%s)",
                len(delta),
                key,
            )
        for key in list(self._open_reasonings):
            events.extend(self._close_reasoning(key))
        if self._current_step is not None:
            events.append(
                StepFinishedEvent(
                    type=EventType.STEP_FINISHED,
                    step_name=self._current_step,
                )
            )
            self._current_step = None
        return events

    def build_messages_snapshot(
        self,
        run_input: RunAgentInput | Sequence[Message] | None = None,
    ) -> MessagesSnapshotEvent:
        """Build the end-of-run MESSAGES_SNAPSHOT event.

        The snapshot contains the prior AG-UI message history followed by
        messages completed during this run. Prior messages retain their AG-UI
        IDs, and completed messages reuse the IDs emitted by their streaming
        events, allowing clients to merge the snapshot without duplicates.

        Prior history comes from ``run_input.messages``, not
        ``result.to_input_list()``. The OpenAI Agents SDK represents model input
        as Responses-shaped items even when the underlying model uses Chat
        Completions. Round-tripping prior AG-UI messages through that format
        does not preserve their AG-UI IDs.

        Callers should remove messages that must not be echoed to the client,
        such as server-only system instructions, before passing ``run_input``.

        Args:
            run_input: The original run input, a message sequence, or ``None``
                when there is no prior history.

        Returns:
            A ``MESSAGES_SNAPSHOT`` containing prior and completed messages.
        """
        if run_input is None:
            prior: list[Message] = []
        elif isinstance(run_input, RunAgentInput):
            prior = list(run_input.messages or [])
        else:
            prior = list(run_input)
        return MessagesSnapshotEvent(
            type=EventType.MESSAGES_SNAPSHOT,
            messages=[*prior, *self._snapshot_messages],
        )

    # ─────────────────────────────────────────────────────────────────────
    # LEVEL 2 — Event-family translation
    # ─────────────────────────────────────────────────────────────────────

    def translate_raw_response_event(self, event: Any) -> list[BaseEvent]:
        """Handle a RawResponsesStreamEvent (token-level Responses deltas).

        Args:
            event: The OpenAI Agents SDK's RawResponsesStreamEvent.

        Returns:
            Translated AG-UI events, or an empty list if ignored or invalid.
        """
        data = read_attr(event, "data")
        if data is None:
            return []
        kind = read_attr(data, "type")
        if kind == OpenAIRawResponseEventType.OUTPUT_ITEM_ADDED:
            return self.translate_output_item_added(data)
        if kind == OpenAIRawResponseEventType.OUTPUT_ITEM_DONE:
            return self.translate_output_item_done(data)
        if kind == OpenAIRawResponseEventType.TEXT_DELTA:
            return self.translate_text_delta(data)
        if kind == OpenAIRawResponseEventType.TEXT_DONE:
            return self.translate_text_done(data)
        if kind == OpenAIRawResponseEventType.REFUSAL_DELTA:
            return self.translate_refusal_delta(data)
        if kind == OpenAIRawResponseEventType.FUNCTION_CALL_ARGUMENTS_DELTA:
            return self.translate_function_call_arguments_delta(data)
        if kind in (
            OpenAIRawResponseEventType.REASONING_SUMMARY_DELTA,
            OpenAIRawResponseEventType.REASONING_TEXT_DELTA,
        ):
            return self.translate_reasoning_delta(data)
        if kind in (
            OpenAIRawResponseEventType.REASONING_SUMMARY_PART_DONE,
            OpenAIRawResponseEventType.REASONING_TEXT_DONE,
        ):
            return self.translate_reasoning_part_done(data)
        # Everything else (response.created/.completed, content_part chatter,
        # audio) has nothing to show on the AG-UI side, so we drop it.
        return []

    def translate_run_item_event(self, event: Any) -> list[BaseEvent]:
        """Handle a RunItemStreamEvent (semantic commit signals).

        Args:
            event: The OpenAI Agents SDK's RunItemStreamEvent.

        Returns:
            Translated AG-UI events, or an empty list if the event has no output.
        """
        item = read_attr(event, "item")
        if item is None:
            return []
        return self.translate_item(item)

    def translate_agent_updated_event(self, event: Any) -> list[BaseEvent]:
        """Translate an AgentUpdatedStreamEvent into STEP_FINISHED + STEP_STARTED.

        Each agent (including the first, and each handoff target) is
        surfaced as an AG-UI step named after the agent.

        Args:
            event: The OpenAI Agents SDK's AgentUpdatedStreamEvent.

        Returns:
            STEP_FINISHED for the previous step (if any) followed by
            STEP_STARTED for the new one.
        """
        new_agent = read_attr(event, "new_agent")
        step_name = read_attr(new_agent, "name") or "agent"
        events: list[BaseEvent] = []
        if self._current_step is not None:
            events.append(
                StepFinishedEvent(
                    type=EventType.STEP_FINISHED,
                    step_name=self._current_step,
                )
            )
        self._current_step = step_name
        events.append(
            StepStartedEvent(type=EventType.STEP_STARTED, step_name=step_name)
        )
        return events

    # ─────────────────────────────────────────────────────────────────────
    # LEVEL 3a — Raw Responses event translation
    # ─────────────────────────────────────────────────────────────────────

    def translate_output_item_added(self, data: Any) -> list[BaseEvent]:
        """Prepare the AG-UI sequence for a new Responses output item.

        Messages defer their text sequence until content arrives. Function and
        hosted tool calls open tool-call sequences; reasoning opens its sequence.

        Args:
            data: The raw output_item.added payload.

        Returns:
            The opening event(s) for the window, if any.
        """
        item = read_attr(data, "item")
        item_type = read_attr(item, "type")
        item_id = read_attr(item, "id")
        key = self._window_key(item_id, read_attr(data, "output_index"), start=True)

        if item_type == OpenAIItemType.MESSAGE:
            # Defer text until its first delta to avoid empty messages on tool-only
            # turns. Close reasoning now because some providers send its done late.
            self._pending_text_ids[key] = self._resolve_id(item_id, new_message_id)
            return self._close_all_reasonings()
        if item_type == OpenAIItemType.FUNCTION_CALL:
            call_id = read_attr(item, "call_id") or self._resolve_id(item_id, new_tool_call_id)
            name = read_attr(item, "name") or ""
            return self._open_tool_call(key, call_id, name)
        if item_type == OpenAIItemType.REASONING:
            return self._open_reasoning(key, self._resolve_id(item_id, new_reasoning_id))
        if item_type in HOSTED_TOOL_CALL_TYPES:
            # Some hosted calls (computer, shell, custom tools) carry a call_id
            # distinct from the item id. The run-item commit reconciles by
            # call_id, so open the window under it too — otherwise the same
            # call streams twice, once per id, and the tool result attaches to
            # the second copy instead of the one the client watched stream.
            call_id = read_attr(item, "call_id") or self._resolve_id(item_id, new_tool_call_id)
            return self._open_tool_call(key, call_id, item_type)
        return []

    def translate_output_item_done(self, data: Any) -> list[BaseEvent]:
        """Translate response.output_item.done by closing the matching AG-UI window.

        For reasoning items this also emits REASONING_ENCRYPTED_VALUE
        (subtype "message") when the finished item carries
        encrypted_content.

        Args:
            data: The raw output_item.done payload.

        Returns:
            The closing event(s) for the window, if any.
        """
        item = read_attr(data, "item")
        item_type = read_attr(item, "type")
        item_id = read_attr(item, "id")
        output_index = read_attr(data, "output_index")
        key = self._window_key(item_id, output_index)

        if item_type == OpenAIItemType.MESSAGE:
            # Discard a pending message if no text delta opened it; otherwise
            # _close_text closes the active sequence below.
            self._pending_text_ids.pop(key, None)
            events = self._close_text(key)
        elif item_type == OpenAIItemType.FUNCTION_CALL or item_type in HOSTED_TOOL_CALL_TYPES:
            events = self._close_tool_call(key)
        elif item_type == OpenAIItemType.REASONING:
            events = self._emit_encrypted_value(key, item)
            events.extend(self._close_reasoning(key))
        else:
            events = []

        if not self._is_real_id(item_id):
            self._placeholder_window_keys.pop(output_index, None)
        return events

    def translate_text_delta(self, data: Any) -> list[BaseEvent]:
        """Translate response.output_text.delta into TEXT_MESSAGE_CONTENT (lazy start).

        Args:
            data: The raw output_text.delta payload.

        Returns:
            Content event(s), opening the window first if needed.
        """
        key = self._window_key(read_attr(data, "item_id"), read_attr(data, "output_index"))
        return self._emit_text_content(key, read_attr(data, "delta") or "")

    def translate_text_done(self, data: Any) -> list[BaseEvent]:
        """Handle response.output_text.done without closing the message window.

        This signal marks the end of one text content part, not the whole
        assistant message — a message can carry several parts (multiple
        output_text parts, or text followed by a refusal). Closing here
        would split one wire message into several AG-UI messages, the
        later ones under generated ids the snapshot can't merge. The
        window closes on output_item.done instead, with the run-item
        commit and finalize() as fallbacks when a backend skips it.

        Args:
            data: The raw output_text.done payload.

        Returns:
            Always [] — the window outlives the content part.
        """
        return []

    def translate_refusal_delta(self, data: Any) -> list[BaseEvent]:
        """Translate response.refusal.delta into TEXT_MESSAGE_CONTENT.

        Refusal text is user-visible assistant output, so it streams
        into the same text window as regular content.

        Args:
            data: The raw refusal.delta payload.

        Returns:
            Content event(s), opening the window first if needed.
        """
        key = self._window_key(read_attr(data, "item_id"), read_attr(data, "output_index"))
        return self._emit_text_content(key, read_attr(data, "delta") or "")

    def translate_function_call_arguments_delta(self, data: Any) -> list[BaseEvent]:
        """Translate response.function_call_arguments.delta into TOOL_CALL_ARGS.

        Args:
            data: The raw function_call_arguments.delta payload.

        Returns:
            Args event(s), opening the window first if needed.
        """
        delta = read_attr(data, "delta") or ""
        if not delta:
            return []
        key = self._window_key(read_attr(data, "item_id"), read_attr(data, "output_index"))
        if key not in self._open_tool_calls:
            # No START yet: the provider streamed args before output_item.added,
            # so the real call_id is not known here. Buffer the args; the window
            # opens under the correct id at output_item.added or the run-item
            # commit, and _open_tool_call flushes what we buffered. Opening under
            # a throwaway id here would make the later commit fail to reconcile
            # and emit a duplicate TOOL_CALL_START/ARGS/END.
            self._pending_tool_args[key] = self._pending_tool_args.get(key, "") + delta
            return []
        return [
            ToolCallArgsEvent(
                type=EventType.TOOL_CALL_ARGS,
                tool_call_id=self._open_tool_calls[key],
                delta=delta,
            )
        ]

    def translate_reasoning_delta(self, data: Any) -> list[BaseEvent]:
        """Translate reasoning deltas into REASONING_MESSAGE_CONTENT (lazy part start).

        Covers both sources — response.reasoning_summary_text.delta
        (hosted models: model-written summaries) and
        response.reasoning_text.delta (open-weight models: full chain
        of thought). Whichever arrives streams; each part becomes its
        own REASONING_MESSAGE_* window inside one REASONING_START/END
        phase, matching the other AG-UI integrations.

        Args:
            data: The raw reasoning delta payload.

        Returns:
            Content event(s), opening the phase/part first if needed.
        """
        delta = read_attr(data, "delta") or ""
        if not delta:
            return []
        key = self._window_key(read_attr(data, "item_id"), read_attr(data, "output_index"))
        events: list[BaseEvent] = []
        if key not in self._open_reasonings:
            # Reuse the real wire id when present (mirrors output_item.added), so
            # the phase/part ids and REASONING_ENCRYPTED_VALUE entity_id round-trip.
            events.extend(
                self._open_reasoning(
                    key, self._resolve_id(read_attr(data, "item_id"), new_reasoning_id)
                )
            )
        if key not in self._open_reasoning_parts:
            events.extend(self._open_reasoning_part(key))
        events.append(
            ReasoningMessageContentEvent(
                type=EventType.REASONING_MESSAGE_CONTENT,
                message_id=self._open_reasoning_parts[key],
                delta=delta,
            )
        )
        return events

    def translate_reasoning_part_done(self, data: Any) -> list[BaseEvent]:
        """Translate a summary-part / reasoning-text done signal into REASONING_MESSAGE_END.

        Args:
            data: The raw part-done payload.

        Returns:
            The closing event, or [] if already closed.
        """
        key = self._window_key(read_attr(data, "item_id"), read_attr(data, "output_index"))
        return self._close_reasoning_part(key)

    # ─────────────────────────────────────────────────────────────────────
    # LEVEL 3b — Run-item translation
    # ─────────────────────────────────────────────────────────────────────

    def translate_item(self, item: RunItem) -> list[BaseEvent]:
        """Dispatch one OpenAI Agents SDK RunItem to its per-type translator.

        Usually these act as safety-net closers (raw events already
        streamed the content); when no deltas were ever streamed for the
        item, they emit its full AG-UI sequence instead.

        Args:
            item: A finished OpenAI Agents SDK RunItem.

        Returns:
            Translated AG-UI events, or an empty list if the item has no output.
        """
        if isinstance(item, MessageOutputItem):
            return self.translate_message_output_item(item)
        if isinstance(item, HandoffCallItem):
            return self.translate_handoff_call_item(item)
        if isinstance(item, HandoffOutputItem):
            return self.translate_handoff_output_item(item)
        if isinstance(item, ToolCallItem):
            return self.translate_tool_call_item(item)
        if isinstance(item, ToolCallOutputItem):
            return self.translate_tool_call_output_item(item)
        if isinstance(item, ReasoningItem):
            return self.translate_reasoning_item(item)
        if isinstance(item, MCPApprovalRequestItem):
            return self.translate_mcp_approval_request_item(item)
        if isinstance(item, MCPListToolsItem):
            return self.translate_mcp_list_tools_item(item)
        if isinstance(item, MCPApprovalResponseItem):
            return self.translate_mcp_approval_response_item(item)
        logger.warning("Unknown OpenAI Agents SDK run item type: %s", type(item).__name__)
        return []

    def translate_message_output_item(self, item: MessageOutputItem) -> list[BaseEvent]:
        """Handle an assistant message commit by closing its window or emitting the full triplet.

        Streamed: the raw deltas already carried the text — just close.
        No deltas seen: emit TEXT_MESSAGE_START/CONTENT/END from the
        finished item, using the OpenAI Agents SDK's ItemHelpers extractors (text
        first, refusal as fallback — both are user-visible).

        Args:
            item: The finished MessageOutputItem.

        Returns:
            Closing event, or the full START/CONTENT/END triplet.
        """
        raw = item.raw_item
        raw_id = read_attr(raw, "id")
        # Concatenate text and refusal rather than falling back: extract_text
        # ignores refusals and returns truthy whenever any output_text part
        # exists, so `text or refusal` would drop a refusal that streamed
        # (translate_refusal_delta feeds the same window) from the snapshot.
        text = "".join(
            part
            for part in (ItemHelpers.extract_text(raw), ItemHelpers.extract_refusal(raw))
            if part
        )
        action, key = self._reconcile(raw_id, self._open_texts, self._closed_text_ids)
        if action == "close":
            # key is still open at this point — read its id before _close_text pops it.
            message_id = self._open_texts[key]
            events = self._close_text(key)
            self._record_text(message_id, text)
            return events
        if action == "skip":
            # Already closed via a raw event before this commit arrived —
            # no BaseEvents to emit, but the snapshot still needs this
            # message, under the exact id that earlier close already used.
            self._record_text(key, text)
            return []
        # "new": nothing was ever streamed for this item. A real id also
        # supersedes any deferred window we were holding for it.
        self._pending_text_ids.pop(raw_id, None)
        if not text:
            # An empty assistant commit — emit no window (START+END with no
            # content is exactly the empty-bubble artifact) and keep it out of
            # the snapshot.
            return []
        message_id = self._resolve_id(raw_id, new_message_id)
        events = self._open_text(message_id, message_id)
        events.append(
            TextMessageContentEvent(
                type=EventType.TEXT_MESSAGE_CONTENT,
                message_id=message_id,
                delta=text,
            )
        )
        events.extend(self._close_text(message_id))
        self._record_text(message_id, text)
        return events

    def translate_tool_call_item(self, item: ToolCallItem) -> list[BaseEvent]:
        """Handle a tool call commit by closing its window or emitting START/[ARGS]/END.

        Reconciled by call_id (present and real regardless of backend),
        using the OpenAI Agents SDK's built-in ToolCallItem.call_id / .tool_name
        properties where available — getattr fallbacks because
        HandoffCallItem routes through here too and lacks them.

        Args:
            item: The finished ToolCallItem (or a HandoffCallItem).

        Returns:
            Closing event, or the full START/[ARGS]/END sequence.
        """
        raw = item.raw_item
        call_id = (
            getattr(item, "call_id", None)
            or read_attr(raw, "call_id")
            or self._resolve_id(read_attr(raw, "id"), new_tool_call_id)
        )
        name = (
            getattr(item, "tool_name", None)
            or read_attr(raw, "name")
            or read_attr(raw, "type")
            or ""
        )
        arguments = read_attr(raw, "arguments") or ""
        for key, open_call_id in self._open_tool_calls.items():
            if open_call_id == call_id:
                events = self._close_tool_call(key)
                self._record_tool_call(call_id, name, arguments)
                return events
        if call_id in self._seen_call_ids:
            # Already closed via a raw event before this commit arrived —
            # no BaseEvents to emit, but the snapshot still needs this call.
            self._record_tool_call(call_id, name, arguments)
            return []
        # "new": never streamed as an open window. Any args buffered before a
        # START are superseded by raw.arguments below. Clear a buffer we can
        # positively correlate by real item id; a placeholder buffer we cannot
        # address by id is harmlessly dropped (never re-emitted) by finalize, so
        # we must NOT blind-FIFO-drop here — that could evict a *different*
        # still-streaming call's buffered args.
        self._pending_tool_args.pop(read_attr(raw, "id"), None)
        events = self._open_tool_call(call_id, call_id, name)
        if arguments:
            events.append(
                ToolCallArgsEvent(
                    type=EventType.TOOL_CALL_ARGS,
                    tool_call_id=call_id,
                    delta=arguments,
                )
            )
        events.extend(self._close_tool_call(call_id))
        self._record_tool_call(call_id, name, arguments)
        return events

    def translate_tool_call_output_item(self, item: ToolCallOutputItem) -> list[BaseEvent]:
        """Translate a tool result into TOOL_CALL_RESULT.

        Args:
            item: The finished ToolCallOutputItem.

        Returns:
            A single TOOL_CALL_RESULT event, or [] if call_id is missing.
        """
        # call_id is a property only on newer SDK ToolCallOutputItem; read it
        # defensively (as translate_tool_call_item does) to support the declared
        # openai-agents floor, falling back to the raw item.
        call_id = getattr(item, "call_id", None) or read_attr(item.raw_item, "call_id")
        if not call_id:
            logger.debug("Tool output without call_id; skipping TOOL_CALL_RESULT")
            return []
        content = to_string(item.output)
        result_id = self._record_result(call_id, content)
        return [
            ToolCallResultEvent(
                type=EventType.TOOL_CALL_RESULT,
                message_id=result_id,
                tool_call_id=call_id,
                content=content,
            )
        ]

    def translate_reasoning_item(self, item: ReasoningItem) -> list[BaseEvent]:
        """Handle a reasoning commit by closing its phase or emitting the full sequence.

        Non-streamed emission walks the finished ResponseReasoningItem:
        one REASONING_MESSAGE_* window per summary/content entry, then
        REASONING_ENCRYPTED_VALUE (when present), then REASONING_END.

        Args:
            item: The finished ReasoningItem.

        Returns:
            Closing event(s), or the full reasoning sequence.
        """
        raw = item.raw_item
        raw_id = read_attr(raw, "id")
        action, key = self._reconcile(raw_id, self._open_reasonings, self._closed_reasoning_ids)
        if action == "close":
            events = self._emit_encrypted_value(key, raw)
            events.extend(self._close_reasoning(key))
            return events
        if action == "skip":
            # The phase already closed via a raw event, but the commit may be the
            # only carrier of encrypted_content (some providers omit it on the raw
            # done). Surface it so reasoning replay is not lost — _emit_encrypted_value
            # guards against a double-emit. It arrives after REASONING_END in this
            # path because the value is unknown until the commit; late beats dropped.
            return self._emit_encrypted_value(key, raw)
        phase_id = self._resolve_id(raw_id, new_reasoning_id)
        events = self._open_reasoning(phase_id, phase_id)
        parts = [read_attr(entry, "text") for entry in (read_attr(raw, "summary") or [])]
        parts += [read_attr(entry, "text") for entry in (read_attr(raw, "content") or [])]
        for text in parts:
            if not text:
                continue
            events.extend(self._open_reasoning_part(phase_id))
            events.append(
                ReasoningMessageContentEvent(
                    type=EventType.REASONING_MESSAGE_CONTENT,
                    message_id=self._open_reasoning_parts[phase_id],
                    delta=text,
                )
            )
            events.extend(self._close_reasoning_part(phase_id))
        events.extend(self._emit_encrypted_value(phase_id, raw))
        events.extend(self._close_reasoning(phase_id))
        return events

    def translate_handoff_call_item(self, item: HandoffCallItem) -> list[BaseEvent]:
        """Surface a handoff request as a tool call (it is a function call).

        The same underlying item also arrives through the raw-event
        path, so the call-id reconciliation in translate_tool_call_item
        prevents a duplicate TOOL_CALL_START.

        Args:
            item: The finished HandoffCallItem.

        Returns:
            Closing event, or the full START/[ARGS]/END sequence.
        """
        return self.translate_tool_call_item(item)  # type: ignore[arg-type]

    def translate_handoff_output_item(self, item: HandoffOutputItem) -> list[BaseEvent]:
        """Translate a handoff completion into TOOL_CALL_RESULT.

        Args:
            item: The finished HandoffOutputItem.

        Returns:
            A single TOOL_CALL_RESULT event, or [] if call_id is missing.
        """
        raw = item.raw_item
        call_id = read_attr(raw, "call_id")
        if not call_id:
            logger.debug("Handoff output without call_id; skipping TOOL_CALL_RESULT")
            return []
        target = read_attr(item.target_agent, "name") or ""
        output = read_attr(raw, "output") or f"Handed off to {target}"
        content = to_string(output)
        result_id = self._record_result(call_id, content)
        return [
            ToolCallResultEvent(
                type=EventType.TOOL_CALL_RESULT,
                message_id=result_id,
                tool_call_id=call_id,
                content=content,
            )
        ]

    def translate_mcp_approval_request_item(
        self,
        item: MCPApprovalRequestItem,
    ) -> list[BaseEvent]:
        """Translate an MCP approval request into a CUSTOM event (name="mcp_approval_request").

        AG-UI has no native approval shape yet; forwarding the raw
        request lets a frontend implement approval UI without protocol
        changes.

        Args:
            item: The finished MCPApprovalRequestItem.

        Returns:
            A single CUSTOM event carrying the raw request.
        """
        raw = item.raw_item
        value = raw.model_dump() if hasattr(raw, "model_dump") else raw
        return [
            CustomEvent(
                type=EventType.CUSTOM,
                name="mcp_approval_request",
                value=value,
            )
        ]

    def translate_mcp_list_tools_item(self, item: MCPListToolsItem) -> list[BaseEvent]:
        """Drop an MCP tool listing item (server-side bookkeeping). Overridable.

        Args:
            item: The finished MCPListToolsItem.

        Returns:
            Always [].
        """
        logger.debug("Dropping MCPListToolsItem id=%s", read_attr(item.raw_item, "id"))
        return []

    def translate_mcp_approval_response_item(
        self,
        item: MCPApprovalResponseItem,
    ) -> list[BaseEvent]:
        """Drop an MCP approval response item (echo of client input). Overridable.

        Args:
            item: The finished MCPApprovalResponseItem.

        Returns:
            Always [].
        """
        logger.debug("Dropping MCPApprovalResponseItem")
        return []

    # ─────────────────────────────────────────────────────────────────────
    # LEVEL 4a — ID handling
    # ─────────────────────────────────────────────────────────────────────

    @staticmethod
    def _is_real_id(item_id: Any) -> bool:
        """Check whether an id is usable on the wire (not empty, not a placeholder).

        Some backends stamp every item with the OpenAI Agents SDK's
        FAKE_RESPONSES_ID
        sentinel — sharing it across AG-UI events would collide every
        message of the run. Checked against the OpenAI Agents SDK's constant, so
        it is a no-op on native OpenAI and correct for any backend that
        does not use placeholder ids.

        Args:
            item_id: The item's wire id, or None.

        Returns:
            True if the id is real and usable.
        """
        return bool(item_id) and item_id != FAKE_RESPONSES_ID

    @classmethod
    def _is_placeholder_key(cls, key: Any) -> bool:
        """True for internal placeholder window keys (``__idx_*``).

        ``_is_real_id`` reports these truthy because they are neither empty nor
        ``FAKE_RESPONSES_ID``, so a window-key reuse decision must also exclude
        placeholders explicitly before treating the key as a wire id.
        """
        return isinstance(key, str) and key.startswith(cls._PLACEHOLDER_PREFIX)

    @classmethod
    def _resolve_id(cls, item_id: Any, generate: Any) -> str:
        """Return the id if real, else a freshly generated one.

        Args:
            item_id: The item's wire id, or None.
            generate: A zero-arg callable producing a fresh id.

        Returns:
            The real id, or a freshly generated one.
        """
        return item_id if cls._is_real_id(item_id) else generate()

    def _window_key(self, item_id: Any, output_index: Any, *, start: bool = False) -> str:
        """Return the internal key that correlates one output item's raw events.

        This key indexes open text, tool-call, and reasoning sequences; it is
        never emitted as an AG-UI ID. A real OpenAI item ID is used when
        available. Placeholder IDs use ``output_index`` only while that item
        is active, then receive a new internal key when the index is reused.

        Args:
            item_id: The item's wire id, or None.
            output_index: The item's position in the response.
            start: Whether this event starts a new output item.

        Returns:
            The OpenAI item ID, or a unique internal placeholder key.
        """
        if self._is_real_id(item_id):
            return item_id
        key = self._placeholder_window_keys.get(output_index)
        active = key is not None and (
            key in self._open_texts
            or key in self._pending_text_ids
            or key in self._open_tool_calls
            or key in self._pending_tool_args
            or key in self._open_reasonings
        )
        if key is None or (start and not active):
            key = f"__idx_{output_index}_{self._placeholder_window_seq}"
            self._placeholder_window_seq += 1
            self._placeholder_window_keys[output_index] = key
        return key

    def _reconcile(
        self,
        raw_id: Any,
        open_windows: dict[str, str],
        closed_ids: list[str],
    ) -> tuple[str, str | None]:
        """Match a run-item commit against streamed window state.

        With a real id the match is exact. With a placeholder id run
        items arrive in stream order, so the oldest open window (or one
        queued closed id) is consumed instead.

        Args:
            raw_id: The run item's raw wire id, or None.
            open_windows: Currently open windows for this category.
            closed_ids: Ids already closed via streaming, oldest first.

        Returns:
            A tuple[str, str | None] containing one of:
                - ("close", key): Close the matching open sequence.
                - ("skip", resolved_id): Reuse an already closed sequence's ID.
                - ("new", None): Emit the complete item; no sequence exists.
        """
        if self._is_real_id(raw_id):
            if raw_id in open_windows:
                return ("close", raw_id)
            if raw_id in closed_ids:
                return ("skip", raw_id)
            return ("new", None)
        if open_windows:
            return ("close", next(iter(open_windows)))
        if closed_ids:
            resolved_id = closed_ids.pop(0)
            return ("skip", resolved_id)
        return ("new", None)

    # ─────────────────────────────────────────────────────────────────────
    # LEVEL 4b — Sequence management
    # ─────────────────────────────────────────────────────────────────────

    def _open_text(self, key: str, message_id: str) -> list[BaseEvent]:
        """Open a text sequence, closing active reasoning first."""
        if key in self._open_texts:
            return []
        # Close reasoning before assistant text; its done event may arrive late.
        events = self._close_all_reasonings()
        self._open_texts[key] = message_id
        events.append(
            TextMessageStartEvent(
                type=EventType.TEXT_MESSAGE_START,
                message_id=message_id,
                role="assistant",
            )
        )
        return events

    def _emit_text_content(self, key: str, delta: str) -> list[BaseEvent]:
        """Emit text content, opening its sequence when needed."""
        if not delta:
            return []
        events: list[BaseEvent] = []
        if key not in self._open_texts:
            # Open deferred text on its first delta. Reuse the real item id when
            # the window key is one (honors "IDs are reused when available"); only
            # synthesize an id when the key is an internal placeholder.
            events.extend(
                self._open_text(
                    key,
                    self._pending_text_ids.pop(key, None)
                    or (
                        key
                        if self._is_real_id(key) and not self._is_placeholder_key(key)
                        else new_message_id()
                    ),
                )
            )
        events.append(
            TextMessageContentEvent(
                type=EventType.TEXT_MESSAGE_CONTENT,
                message_id=self._open_texts[key],
                delta=delta,
            )
        )
        return events

    def _close_text(self, key: str) -> list[BaseEvent]:
        """Close a text sequence and remember its message ID."""
        message_id = self._open_texts.pop(key, None)
        if message_id is None:
            return []
        self._closed_text_ids.append(message_id)
        return [
            TextMessageEndEvent(
                type=EventType.TEXT_MESSAGE_END,
                message_id=message_id,
            )
        ]

    def _open_tool_call(self, key: str, call_id: str, name: str) -> list[BaseEvent]:
        """Open a tool-call sequence, closing active reasoning first."""
        if key in self._open_tool_calls:
            return []
        events = self._close_all_reasonings()  # see _open_text
        self._open_tool_calls[key] = call_id
        self._seen_call_ids.add(call_id)
        events.append(
            ToolCallStartEvent(
                type=EventType.TOOL_CALL_START,
                tool_call_id=call_id,
                tool_call_name=name,
            )
        )
        # Flush any args that streamed before this START (see _pending_tool_args).
        buffered = self._pending_tool_args.pop(key, None)
        if buffered:
            events.append(
                ToolCallArgsEvent(
                    type=EventType.TOOL_CALL_ARGS,
                    tool_call_id=call_id,
                    delta=buffered,
                )
            )
        return events

    def _close_tool_call(self, key: str) -> list[BaseEvent]:
        """Close an active tool-call sequence."""
        call_id = self._open_tool_calls.pop(key, None)
        if call_id is None:
            return []
        return [
            ToolCallEndEvent(
                type=EventType.TOOL_CALL_END,
                tool_call_id=call_id,
            )
        ]

    def _open_reasoning(self, key: str, phase_id: str) -> list[BaseEvent]:
        """Open a reasoning sequence."""
        if key in self._open_reasonings:
            return []
        self._open_reasonings[key] = phase_id
        self._reasoning_phase_ids[key] = phase_id
        return [
            ReasoningStartEvent(
                type=EventType.REASONING_START,
                message_id=phase_id,
            )
        ]

    def _open_reasoning_part(self, key: str) -> list[BaseEvent]:
        """Open the next part of a reasoning sequence."""
        if key in self._open_reasoning_parts:
            return []
        seq = self._reasoning_part_seq.get(key, 0)
        self._reasoning_part_seq[key] = seq + 1
        # The first part just reuses the phase id (keeps round-trips clean);
        # extra parts get a -1, -2, ... suffix. Wire ids never contain a
        # hyphen, so anything with one is clearly something we made up.
        phase_id = self._open_reasonings.get(key, key)
        message_id = phase_id if seq == 0 else f"{phase_id}-{seq}"
        self._open_reasoning_parts[key] = message_id
        return [
            ReasoningMessageStartEvent(
                type=EventType.REASONING_MESSAGE_START,
                message_id=message_id,
                role="reasoning",
            )
        ]

    def _close_reasoning_part(self, key: str) -> list[BaseEvent]:
        """Close an active reasoning part."""
        message_id = self._open_reasoning_parts.pop(key, None)
        if message_id is None:
            return []
        return [
            ReasoningMessageEndEvent(
                type=EventType.REASONING_MESSAGE_END,
                message_id=message_id,
            )
        ]

    def _close_reasoning(self, key: str) -> list[BaseEvent]:
        """Close a reasoning part and its parent sequence."""
        phase_id = self._open_reasonings.pop(key, None)
        if phase_id is None:
            return []
        events = self._close_reasoning_part(key)
        self._closed_reasoning_ids.append(phase_id)
        events.append(
            ReasoningEndEvent(
                type=EventType.REASONING_END,
                message_id=phase_id,
            )
        )
        return events

    def _close_all_reasonings(self) -> list[BaseEvent]:
        """Close every active reasoning sequence."""
        events: list[BaseEvent] = []
        for key in list(self._open_reasonings):
            events.extend(self._close_reasoning(key))
        return events

    def _emit_encrypted_value(self, key: str, item: Any) -> list[BaseEvent]:
        """Emit REASONING_ENCRYPTED_VALUE once per reasoning item, if present.

        Args:
            key: The reasoning item's window key.
            item: The raw reasoning item.

        Returns:
            A single REASONING_ENCRYPTED_VALUE event, or [] if absent
            or already emitted.
        """
        encrypted = read_attr(item, "encrypted_content")
        # Dedup on the stable phase id, not the caller's key: the raw-done path
        # passes a window key (a placeholder for FAKE-id backends) while the
        # run-item skip path passes the resolved phase id. Both map to the same
        # phase id here, so keying the guard on it catches the cross-path dup.
        entity_id = self._reasoning_phase_ids.get(key, key)
        if not encrypted or entity_id in self._emitted_encrypted_keys:
            return []
        self._emitted_encrypted_keys.add(entity_id)
        return [
            ReasoningEncryptedValueEvent(
                type=EventType.REASONING_ENCRYPTED_VALUE,
                subtype="message",
                entity_id=entity_id,
                encrypted_value=encrypted,
            )
        ]

    # ─────────────────────────────────────────────────────────────────────
    # LEVEL 4c — Snapshot message builders
    # ─────────────────────────────────────────────────────────────────────
    # Snapshot messages reuse streamed IDs so clients can merge without duplicates.
    # Reasoning is omitted from the snapshot: clients persist replayable reasoning
    # from the streamed REASONING_ENCRYPTED_VALUE events, not from this list.

    def _record_text(self, message_id: str, text: str) -> None:
        """Add an assistant text message to the snapshot."""
        self._snapshot_messages.append(
            AssistantMessage(id=message_id, role="assistant", content=text)
        )

    def _record_tool_call(self, call_id: str, name: str, arguments: str) -> None:
        """Add an assistant tool call to the snapshot."""
        # The streamed TOOL_CALL_START carried no parent message id, so the
        # client keyed the bubble by the tool call id — mirror that here.
        self._snapshot_messages.append(
            AssistantMessage(
                id=call_id,
                role="assistant",
                tool_calls=[
                    ToolCall(
                        id=call_id,
                        type="function",
                        function=FunctionCall(name=name, arguments=arguments),
                    )
                ],
            )
        )

    def _record_result(self, call_id: str, content: str) -> str:
        """Add a tool result and return its derived message ID."""
        # Returns the derived result id so the caller reuses the same value
        # for its TOOL_CALL_RESULT event — snapshot and stream stay in sync.
        result_id = new_tool_result_id(call_id)
        self._snapshot_messages.append(
            ToolMessage(
                id=result_id, role="tool", tool_call_id=call_id, content=content
            )
        )
        return result_id


__all__ = ["OpenAIToAGUITranslator"]
