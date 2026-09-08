"""
Event handlers for Claude SDK stream processing.

Breaks down stream processing into focused handler functions.
"""

import json
import logging
import uuid
from typing import AsyncIterator, Any, Optional

from ag_ui.core import (
    EventType,
    BaseEvent,
    ToolCallStartEvent,
    ToolCallArgsEvent,
    ToolCallEndEvent,
    ToolCallResultEvent,
    StateSnapshotEvent,
    CustomEvent,
)

from .utils import strip_mcp_prefix, _is_state_management_tool, fix_surrogates, fix_surrogates_deep

logger = logging.getLogger(__name__)


async def handle_tool_use_block(
    block: Any,
    message: Any,
    thread_id: str,
    run_id: str,
    current_state: Optional[Any],
    parent_message_id: Optional[str] = None,
) -> tuple[Optional[Any], AsyncIterator[BaseEvent]]:
    """
    Handle ToolUseBlock from Claude SDK.

    Intercepts state management tool calls and emits STATE_SNAPSHOT.
    For regular tools, emits TOOL_CALL_START/ARGS events.

    Args:
        block: ToolUseBlock from Claude SDK
        message: Parent message containing the block
        thread_id: Thread identifier
        run_id: Run identifier
        current_state: Current state for state management tools
        parent_message_id: ID of the assistant message that owns this tool
            call. The streaming path uses the current assistant message id for
            ``ToolCallStartEvent.parent_message_id``; this mirrors that
            semantics on the non-streaming fallback path.

    Returns:
        Tuple of (updated_state, event_generator)
    """
    tool_name = getattr(block, 'name', '') or 'unknown'
    tool_input = getattr(block, 'input', {}) or {}
    tool_id = getattr(block, 'id', None) or str(uuid.uuid4())

    # Strip MCP prefix for client matching (same as streaming path)
    tool_display_name = strip_mcp_prefix(tool_name)
    if tool_display_name != tool_name:
        logger.debug(f"Stripped MCP prefix in handler: {tool_name} -> {tool_display_name}")
    
    logger.debug(f"ToolUseBlock detected: {tool_name}")

    # Compute the merged state SYNCHRONOUSLY, before building the generator, so
    # the returned first element reflects the post-merge state. The adapter
    # persists this returned value (self._per_thread_state[thread_id]) BEFORE it
    # iterates the event generator, so a value computed inside event_gen() would
    # not yet exist when the tuple is built — the adapter would persist the
    # stale pre-merge state while the emitted STATE_SNAPSHOT carried the merged
    # state. Computing here keeps the returned/persisted state == the snapshot.
    merged_state = current_state
    # When the state_updates JSON fails to parse we emit ONLY a CUSTOM error and
    # must NOT mutate state nor emit a STATE_SNAPSHOT (mirrors the streaming
    # path in adapter.py). This flag carries that decision out to the generator.
    state_parse_error: Optional[str] = None
    # Whether the merge actually changed state. The streaming path only emits a
    # STATE_SNAPSHOT when the merged state differs from the prior; mirror that
    # here so a no-op update doesn't emit a spurious snapshot (Item 3).
    state_changed: bool = False

    if _is_state_management_tool(tool_name):
        logger.debug("Intercepting ag_ui_update_state tool call")

        # Extract state updates from tool input. Mirror the streaming path
        # (adapter.py): when the "state_updates" key is absent, fall back to the
        # whole tool_input object instead of an empty {} (Item 4).
        state_updates = tool_input.get("state_updates", tool_input)

        # Parse if it's a JSON string (streaming re-parses nested JSON strings
        # too — Item 4).
        if isinstance(state_updates, str):
            try:
                state_updates = json.loads(state_updates)
                logger.debug("Parsed state_updates from JSON string")
            except json.JSONDecodeError as e:
                logger.warning(f"Failed to parse state_updates JSON: {e}")
                state_parse_error = str(e)

        if state_parse_error is None:
            prev_state_json = json.dumps(merged_state, sort_keys=True, default=str)

            # Update current state
            if isinstance(merged_state, dict) and isinstance(state_updates, dict):
                merged_state = {**merged_state, **state_updates}
            else:
                merged_state = state_updates

            # Fix any UTF-16 surrogates before Pydantic serialisation
            merged_state = fix_surrogates_deep(merged_state)

            # Mirror the streaming change check (adapter.py): only emit a
            # snapshot if the merge actually changed the persisted state.
            new_state_json = json.dumps(merged_state, sort_keys=True, default=str)
            state_changed = new_state_json != prev_state_json

    async def event_gen():
        # Intercept state management tool calls (check both prefixed and unprefixed names)
        if _is_state_management_tool(tool_name):
            if state_parse_error is not None:
                yield CustomEvent(
                    type=EventType.CUSTOM,
                    name="state_update_error",
                    value={"error": state_parse_error},
                )
                # Emit ONLY the error event — do not fall through and emit a
                # spurious STATE_SNAPSHOT with un-updated state. Mirrors the
                # streaming path (adapter.py), which emits the error alone.
                return

            # Emit STATE_SNAPSHOT only when the merge actually changed state,
            # matching the streaming path (Item 3). The snapshot carries the
            # SAME merged state we return below, so the persisted state and the
            # snapshot never diverge.
            if state_changed:
                yield StateSnapshotEvent(
                    type=EventType.STATE_SNAPSHOT,
                    snapshot=merged_state
                )
                logger.debug("Emitted STATE_SNAPSHOT with updated state")
            else:
                logger.debug("State unchanged — suppressing no-op STATE_SNAPSHOT")
            return  # Skip normal tool call events

        # Regular tool handling for non-state tools
        yield ToolCallStartEvent(
            type=EventType.TOOL_CALL_START,
            thread_id=thread_id,
            run_id=run_id,
            tool_call_id=tool_id,
            tool_call_name=tool_display_name,  # Use unprefixed name
            parent_message_id=parent_message_id,
        )
        
        if tool_input:
            args_json = json.dumps(tool_input)
            yield ToolCallArgsEvent(
                type=EventType.TOOL_CALL_ARGS,
                thread_id=thread_id,
                run_id=run_id,
                tool_call_id=tool_id,
                delta=args_json,
            )

        # Emit TOOL_CALL_END so the runtime doesn't think the tool call is still active.
        # In the streaming path this is emitted at content_block_stop, but when tools
        # arrive only via the complete AssistantMessage (non-streaming), this fallback
        # is the only place that closes the tool call.
        yield ToolCallEndEvent(
            type=EventType.TOOL_CALL_END,
            thread_id=thread_id,
            run_id=run_id,
            tool_call_id=tool_id,
        )

    return merged_state, event_gen()


async def handle_tool_result_block(
    block: Any,
    thread_id: str,
    run_id: str,
    parent_tool_use_id: Optional[str] = None,
) -> AsyncIterator[BaseEvent]:
    """
    Handle ToolResultBlock from Claude SDK.
    
    Emits TOOL_CALL_END and TOOL_CALL_RESULT events.
    Nested tool results (with parent_tool_use_id) are also emitted - they represent
    sub-agent calls (e.g., Task calling WebSearch).
    
    Args:
        block: ToolResultBlock from Claude SDK
        thread_id: Thread identifier
        run_id: Run identifier
        parent_tool_use_id: Parent tool ID if this is a nested result
        
    Yields:
        AG-UI tool result events
    """
    tool_use_id = getattr(block, 'tool_use_id', None)
    content = getattr(block, 'content', None)
    is_error = getattr(block, 'is_error', None)
    
    # Parse tool result content for frontend rendering
    # Claude SDK tools return: [{"type": "text", "text": "{json_data}"}]
    # Frontend expects just the parsed json_data
    #
    # We track both the final string AND, when the content is a JSON *object*,
    # the parsed object. The error path (below) needs the parsed object so it
    # can add an "error" marker WITHOUT double-encoding it into a string.
    result_str = ""
    parsed_obj = None  # set only when the content is a JSON object (dict)

    def _normalize_text(text: str) -> None:
        """Normalise a plain-text payload: parse JSON when possible (so the
        frontend can access fields) else pass the raw text through unquoted.

        This is the single canonical encoding for textual content. Both the
        list-of-text-blocks path and the bare-string path route through here so
        the SAME logical payload reaches the frontend with the SAME encoding
        regardless of which SDK shape delivered it (Item 5)."""
        nonlocal result_str, parsed_obj
        try:
            parsed_json = json.loads(text)
            result_str = json.dumps(parsed_json)
            if isinstance(parsed_json, dict):
                parsed_obj = parsed_json
        except (json.JSONDecodeError, ValueError):
            # Not JSON — pass the raw text through unquoted (NOT json.dumps,
            # which would quote it and diverge from the list-text-block path).
            result_str = text

    if content is not None:
        try:
            # If content is a list of content blocks (Claude SDK format)
            if isinstance(content, list) and len(content) > 0:
                first_block = content[0]
                if isinstance(first_block, dict) and first_block.get("type") == "text":
                    _normalize_text(first_block.get("text", ""))
                else:
                    # Fallback: stringify the whole content
                    result_str = json.dumps(content)
            elif isinstance(content, str):
                # Bare-string content: normalise identically to the inner text
                # of a text block (Item 5) instead of json.dumps-quoting it.
                _normalize_text(content)
            else:
                # Fallback: stringify as-is (dicts, scalars, empty lists, ...)
                result_str = json.dumps(content)
        except (TypeError, ValueError):
            result_str = str(content)

    # Propagate the SDK's error indication. AG-UI's ToolCallResultEvent has no
    # dedicated error field, so a failed tool result would otherwise look
    # identical to a successful one. Surface the error indicator (and log it)
    # so downstream consumers can distinguish failures — but do it WITHOUT
    # corrupting the payload:
    #   * JSON-object content: add an "error": True key to the object and emit
    #     the single-encoded object (consistent with the success shape).
    #   * Plain-string content: wrap as {"error": True, "content": <string>}
    #     exactly once (no nested re-encode).
    #
    # Surrogate repair must happen on the string VALUE *before* it is embedded
    # in any json.dumps: json.dumps (ensure_ascii) escapes lone surrogates into
    # literal "\ud83c" text, which fix_surrogates (a UTF-16 round-trip) cannot
    # subsequently repair. So we fix the raw content first, then serialise, and
    # do not re-escape the already-repaired value.
    if is_error:
        logger.warning(
            f"Tool result for tool_use_id={tool_use_id} reported is_error=True"
        )
        if parsed_obj is not None:
            result_str = json.dumps(fix_surrogates_deep({**parsed_obj, "error": True}))
        else:
            result_str = json.dumps({"error": True, "content": fix_surrogates(result_str)})
    else:
        result_str = fix_surrogates(result_str)

    if tool_use_id:
        # NOTE: Do NOT emit TOOL_CALL_END here — it was already emitted
        # during content_block_stop (streaming path) or by handle_tool_use_block
        # (non-streaming path). Emitting it again causes "No active tool call"
        # errors in the CopilotKit runtime. The TS adapter follows the same
        # pattern: tool result handling only emits TOOL_CALL_RESULT.

        # Emit ToolCallResult with the actual result content.
        #
        # Nested / sub-agent results (e.g. Task calling WebSearch) carry a
        # parent_tool_use_id. AG-UI's ToolCallResultEvent has no first-class
        # field for it, so we surface the linkage via the protocol-standard
        # ``raw_event`` escape hatch — only when present, so top-level results
        # don't gain a spurious raw_event. (Item 8: previously this argument was
        # accepted but never used, leaving the documented nested behavior inert.)
        result_message_id = f"{tool_use_id}-result"
        raw_event = {"parent_tool_use_id": parent_tool_use_id} if parent_tool_use_id else None
        yield ToolCallResultEvent(
            type=EventType.TOOL_CALL_RESULT,
            thread_id=thread_id,
            run_id=run_id,
            message_id=result_message_id,
            tool_call_id=tool_use_id,
            content=result_str,
            role="tool",
            raw_event=raw_event,
        )
