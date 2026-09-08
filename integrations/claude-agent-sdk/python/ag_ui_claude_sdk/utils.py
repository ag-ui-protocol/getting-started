"""
Utility functions for Claude Agent SDK adapter.

Helper functions for message processing, tool conversion, and prompt building.
"""

import json
import logging
from collections.abc import AsyncIterable, AsyncIterator
from typing import Any, Dict, List, Optional, Tuple
from ag_ui.core import (
    RunAgentInput,
    AssistantMessage,
    ToolCall,
    FunctionCall,
    ToolMessage,
    TextInputContent,
    ImageInputContent,
    AudioInputContent,
    VideoInputContent,
    DocumentInputContent,
    BinaryInputContent,
    InputContentDataSource,
    InputContentUrlSource,
)

from .config import STATE_MANAGEMENT_TOOL_NAME, STATE_MANAGEMENT_TOOL_FULL_NAME

logger = logging.getLogger(__name__)


def fix_surrogates(s: str) -> str:
    """Re-assemble lone UTF-16 surrogate pairs into proper Unicode codepoints.

    Streamed JSON chunked in JavaScript via ``String.slice()`` operates on
    16-bit code units.  Emoji outside the BMP (e.g. U+1F35D 🍝) are two code
    units in JS (a surrogate pair), and ``slice`` can split them.  When the
    chunks are reassembled in Python the string contains *paired* surrogates
    (e.g. ``\\ud83c\\udf5d``) rather than a single codepoint.  Pydantic rejects
    these during JSON serialisation.

    Round-tripping through UTF-16 reassembles the pairs.
    """
    try:
        return s.encode("utf-16", "surrogatepass").decode("utf-16")
    except (UnicodeDecodeError, UnicodeEncodeError):
        # Fallback: strip surrogates entirely (shouldn't happen for paired ones)
        return s.encode("utf-8", "replace").decode("utf-8")


def fix_surrogates_deep(obj: Any) -> Any:
    """Recursively fix UTF-16 surrogates in all strings within a data structure."""
    if isinstance(obj, str):
        return fix_surrogates(obj)
    if isinstance(obj, dict):
        return {fix_surrogates(k) if isinstance(k, str) else k: fix_surrogates_deep(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [fix_surrogates_deep(item) for item in obj]
    return obj


def extract_tool_names(tools: List[Any]) -> List[str]:
    """
    Extract tool names from AG-UI tool definitions.
    
    Handles both dict format and object format consistently.
    
    Args:
        tools: List of AG-UI Tool definitions (dict or Tool objects)
        
    Returns:
        List of tool name strings
    """
    names = []
    for tool_def in tools:
        name = tool_def.get("name") if isinstance(tool_def, dict) else getattr(tool_def, "name", None)
        if name:
            names.append(name)
    return names


def strip_mcp_prefix(tool_name: str) -> str:
    """
    Strip mcp__servername__ prefix from Claude SDK tool names.
    
    Claude SDK prefixes all MCP tools: mcp__weather__get_weather, mcp__ag_ui__generate_haiku
    Frontend registers unprefixed: get_weather, generate_haiku
    
    Args:
        tool_name: Full MCP-prefixed tool name
        
    Returns:
        Unprefixed tool name for client matching
        
    Examples:
        "mcp__weather__get_weather" -> "get_weather"
        "mcp__ag_ui__generate_haiku" -> "generate_haiku"
        "local_tool" -> "local_tool" (unchanged)
    """
    if tool_name.startswith("mcp__"):
        parts = tool_name.split("__")
        if len(parts) >= 3:  # mcp__servername__toolname
            return "__".join(parts[2:])  # Keep just toolname (handles double underscores in names)
    return tool_name


SUPPORTED_IMAGE_MEDIA_TYPES = {
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
}


def _normalized_media_type(value: Optional[str]) -> Optional[str]:
    if not isinstance(value, str):
        return None
    media_type = value.split(";", 1)[0].strip().lower()
    return media_type or None


def _require_non_empty_string(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{field} must be a non-empty string")
    return value


def _require_remote_url(value: Any, field: str) -> str:
    from urllib.parse import urlsplit

    url = _require_non_empty_string(value, field)
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError(f"{field} must be a valid http or https URL")
    return url


def _image_block(source: Any, field: str) -> Dict[str, Any]:
    media_type = _normalized_media_type(getattr(source, "mime_type", None))
    if isinstance(source, InputContentDataSource):
        if media_type not in SUPPORTED_IMAGE_MEDIA_TYPES:
            raise ValueError(
                f"{field}.mime_type must be image/jpeg, image/png, image/gif, or image/webp"
            )
        return {
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": media_type,
                "data": _require_non_empty_string(source.value, f"{field}.value"),
            },
        }
    if isinstance(source, InputContentUrlSource):
        if media_type is not None and media_type not in SUPPORTED_IMAGE_MEDIA_TYPES:
            raise ValueError(f"{field}.mime_type is not a supported image type")
        return {
            "type": "image",
            "source": {
                "type": "url",
                "url": _require_remote_url(source.value, f"{field}.value"),
            },
        }
    raise ValueError(f"{field} must be a data or URL source")


def _document_block(source: Any, field: str) -> Dict[str, Any]:
    media_type = _normalized_media_type(getattr(source, "mime_type", None))
    if isinstance(source, InputContentDataSource):
        if media_type != "application/pdf":
            raise ValueError(f"{field}.mime_type must be application/pdf")
        return {
            "type": "document",
            "source": {
                "type": "base64",
                "media_type": "application/pdf",
                "data": _require_non_empty_string(source.value, f"{field}.value"),
            },
        }
    if isinstance(source, InputContentUrlSource):
        if media_type is not None and media_type != "application/pdf":
            raise ValueError(f"{field}.mime_type must be application/pdf when provided")
        return {
            "type": "document",
            "source": {
                "type": "url",
                "url": _require_remote_url(source.value, f"{field}.value"),
            },
        }
    raise ValueError(f"{field} must be a data or URL source")


def _legacy_binary_block(block: BinaryInputContent, index: int) -> Dict[str, Any]:
    media_type = _normalized_media_type(block.mime_type)
    if block.data:
        source: Any = InputContentDataSource(
            value=block.data,
            mime_type=media_type or "",
        )
    elif block.url:
        source = InputContentUrlSource(
            value=block.url,
            mime_type=media_type,
        )
    else:
        raise ValueError(
            f"content[{index}] uses an opaque file id, which the Claude Agent SDK adapter cannot resolve"
        )

    if media_type in SUPPORTED_IMAGE_MEDIA_TYPES:
        return _image_block(source, f"content[{index}]")
    if media_type == "application/pdf":
        return _document_block(source, f"content[{index}]")
    raise ValueError(f"content[{index}].mime_type is not supported")


def _convert_content_block(block: Any, index: int) -> Optional[Dict[str, Any]]:
    if isinstance(block, TextInputContent):
        if not block.text.strip():
            return None
        return {
            "type": "text",
            "text": block.text,
        }
    if isinstance(block, ImageInputContent):
        return _image_block(block.source, f"content[{index}].source")
    if isinstance(block, DocumentInputContent):
        return _document_block(block.source, f"content[{index}].source")
    if isinstance(block, BinaryInputContent):
        return _legacy_binary_block(block, index)
    if isinstance(block, (AudioInputContent, VideoInputContent)):
        raise ValueError(f"content[{index}] type {block.type} is not supported")
    raise ValueError(f"content[{index}] has an unsupported type")


async def _structured_user_message(
    content: List[Dict[str, Any]],
    session_id: str,
) -> AsyncIterator[Dict[str, Any]]:
    yield {
        "type": "user",
        "message": {"role": "user", "content": content},
        "parent_tool_use_id": None,
        "session_id": session_id,
    }


ClaudePrompt = str | AsyncIterable[Dict[str, Any]]


def process_messages(input_data: RunAgentInput) -> Tuple[ClaudePrompt, bool]:
    """
    Process and validate all messages from RunAgentInput.
    
    Similar to AWS Strands pattern: validates full message history even though
    Claude SDK manages conversation via session_id.
    
    Args:
        input_data: RunAgentInput with messages array
        
    Returns:
        Tuple of (user_message, has_pending_tool_result). ``user_message`` is
        a string for plain text or a one-message async iterable for structured
        content.
    """
    messages = input_data.messages or []
    
    # Check if last message is a tool result (for re-submission handling)
    has_pending_tool_result = False
    if messages:
        last_msg = messages[-1]
        if hasattr(last_msg, 'role') and last_msg.role == 'tool':
            has_pending_tool_result = True
            logger.debug(
                f"Pending tool result detected: tool_call_id={getattr(last_msg, 'tool_call_id', 'unknown')}, "
                f"thread_id={input_data.thread_id}"
            )
    
    # Log message counts for debugging
    logger.debug(
        f"Processing {len(messages)} messages for thread_id={input_data.thread_id}"
    )
    
    # Validate and log all messages (even though we only use the last one)
    for i, msg in enumerate(messages):
        role = getattr(msg, 'role', msg.get('role') if isinstance(msg, dict) else 'unknown')
        has_tool_calls = hasattr(msg, 'tool_calls') and bool(msg.tool_calls)
        tool_call_id = getattr(msg, 'tool_call_id', None)
        
        logger.debug(
            f"Message [{i}]: role={role}, has_tool_calls={has_tool_calls}, "
            f"tool_call_id={tool_call_id}"
        )
    
    # Extract content from the LAST message (any role - user, tool, or assistant)
    # Claude SDK manages conversation history via session_id, we just need the latest input
    user_message: ClaudePrompt = ""
    has_user_content = False
    if messages:
        last_msg = messages[-1]
        
        # Extract content based on message structure
        if hasattr(last_msg, 'content'):
            content = last_msg.content
        elif isinstance(last_msg, dict):
            content = last_msg.get('content', '')
        else:
            content = ''
        
        # Handle different content formats
        if isinstance(content, str):
            user_message = content
            has_user_content = bool(content)
        elif isinstance(content, list):
            blocks = []
            for index, block in enumerate(content):
                converted = _convert_content_block(block, index)
                if converted is not None:
                    blocks.append(converted)
            if blocks:
                user_message = _structured_user_message(
                    blocks,
                    input_data.thread_id or "default",
                )
                has_user_content = True

    if not has_user_content:
        logger.warning(f"No user message found in {len(messages)} messages")
    
    return user_message, has_pending_tool_result


def build_state_context_addendum(input_data: RunAgentInput) -> str:
    """
    Build state and context addendum for injection into the system prompt.
    
    Returns the formatted text block describing current state and application
    context, or an empty string if neither is present.
    
    This keeps state/context in the system prompt (where it belongs) rather
    than polluting the user message.
    
    Args:
        input_data: RunAgentInput containing state and context
        
    Returns:
        Formatted addendum string, or empty string if nothing to add
    """
    parts = []
    
    # Add context if provided
    if input_data.context:
        parts.append("## Context from the application")
        for ctx in input_data.context:
            parts.append(f"- {ctx.description}: {ctx.value}")
        parts.append("")
    
    # Add current state if provided
    if input_data.state:
        parts.append("## Current Shared State")
        parts.append("This state is shared with the frontend UI and can be updated.")
        try:
            state_json = json.dumps(input_data.state, indent=2)
            parts.append(f"```json\n{state_json}\n```")
        except (TypeError, ValueError) as e:
            logger.warning(f"Failed to serialize state: {e}")
            parts.append(f"State: {str(input_data.state)}")
        
        parts.append("")
        parts.append("To update this state, use the `ag_ui_update_state` tool with your changes.")
        parts.append("")
    
    return "\n".join(parts)


def convert_agui_tool_to_claude_sdk(tool_def: Any) -> Any:
    """
    Convert an AG-UI tool definition to a Claude SDK MCP tool.
    
    Creates a proxy tool that Claude can "see" and call, but with stub implementation
    since actual execution happens on the client side.
    
    Args:
        tool_def: AG-UI Tool definition (dict or Tool object)
        
    Returns:
        Claude SDK tool definition
    """
    from claude_agent_sdk import tool
    
    # Extract tool properties
    if isinstance(tool_def, dict):
        tool_name = tool_def.get("name", "unknown")
        tool_description = tool_def.get("description", "")
        tool_parameters = tool_def.get("parameters", {})
    else:
        tool_name = getattr(tool_def, "name", "unknown")
        tool_description = getattr(tool_def, "description", "")
        tool_parameters = getattr(tool_def, "parameters", {})
    
    # Claude SDK @tool decorator accepts FULL JSON Schema format!
    # From docs: input_schema can be either:
    # 1. Simple type mapping: {"param": str, "count": int}
    # 2. Full JSON Schema: {"type": "object", "properties": {...}, "required": [...]}
    #
    # For frontend tools with complex schemas (arrays, enums, nested objects),
    # we pass the COMPLETE JSON Schema (option 2) which includes:
    # - type: "object"
    # - properties: {...}
    # - required: [...]
    # - items for arrays, enum constraints, etc.
    #
    # This gives Claude proper understanding of nested structures!
    param_schema = tool_parameters if tool_parameters else {}
    
    # Create stub tool with empty implementation (execution happens client-side)
    @tool(tool_name, tool_description, param_schema)
    async def frontend_tool_stub(args: dict) -> dict:
        """
        Stub implementation - actual execution happens on client side.
        When Claude calls this tool, we emit TOOL_CALL events and client executes.
        """
        return {
            "content": [{"type": "text", "text": "Tool call forwarded to client"}]
        }
    
    return frontend_tool_stub


def create_state_management_tool() -> Any:
    """
    Create ag_ui_update_state tool for bidirectional state sync.
    
    This tool allows Claude to update the shared application state,
    which is then emitted to the client via STATE_SNAPSHOT events.
    
    Returns:
        Claude SDK tool definition for state updates
    """
    from claude_agent_sdk import tool
    
    @tool(
        "ag_ui_update_state",
        "Update the shared application state. Use this to persist changes that should be visible in the UI. "
        "Pass the complete updated state object.",
        {"state_updates": dict}
    )
    async def update_state_tool(args: dict) -> dict:
        """
        Stub implementation - actual state emission happens in stream processing.
        When Claude calls this, we intercept and emit STATE_SNAPSHOT events.
        """
        return {
            "content": [{"type": "text", "text": "State updated successfully"}]
        }
    
    return update_state_tool


def apply_forwarded_props(
    forwarded_props: Any, 
    merged_kwargs: Dict[str, Any],
    allowed_keys: set
) -> Dict[str, Any]:
    """
    Apply forwarded_props as per-run Claude SDK option overrides.
    
    Only whitelisted keys are applied for security. forwarded_props enables
    runtime control (model selection, limits, session control) without
    changing agent identity or security boundaries.
    
    Args:
        forwarded_props: Client-provided runtime options
        merged_kwargs: Current merged options dict
        allowed_keys: Set of allowed forwarded_props keys
        
    Returns:
        Updated merged_kwargs dict
    """
    if not forwarded_props or not isinstance(forwarded_props, dict):
        return merged_kwargs
    
    applied_count = 0
    for key, value in forwarded_props.items():
        # Only apply whitelisted keys
        if key in allowed_keys and value is not None:
            merged_kwargs[key] = value
            applied_count += 1
            logger.debug(f"Applied forwarded_prop: {key} = {value}")
        elif key not in allowed_keys:
            logger.warning(
                f"Ignoring non-whitelisted forwarded_prop: {key}. "
                f"See ALLOWED_FORWARDED_PROPS for supported keys."
            )
    
    if applied_count > 0:
        logger.debug(f"Applied {applied_count} forwarded_props as option overrides")
    
    return merged_kwargs


def _is_state_management_tool(name: str) -> bool:
    """Check whether a tool name is the internal state management tool."""
    return name in (STATE_MANAGEMENT_TOOL_NAME, STATE_MANAGEMENT_TOOL_FULL_NAME)


def build_agui_assistant_message(
    sdk_message: Any,
    message_id: str,
) -> Optional[AssistantMessage]:
    """
    Convert a complete Claude SDK AssistantMessage into an AG-UI AssistantMessage.

    Extracts text from TextBlocks and builds ToolCall objects from ToolUseBlocks.
    Filters out internal state management tool calls and reasoning blocks since
    they are not part of the user-visible conversation history.

    Args:
        sdk_message: Complete AssistantMessage from Claude SDK
        message_id: ID to assign to the AG-UI message (matches streamed ID)

    Returns:
        AG-UI AssistantMessage, or None if no user-visible content.
    """
    from claude_agent_sdk.types import TextBlock, ToolUseBlock

    content_blocks = getattr(sdk_message, "content", []) or []

    text_content = ""
    tool_calls: List[ToolCall] = []

    for block in content_blocks:
        # Dispatch on the real SDK block classes. The genuine
        # claude_agent_sdk TextBlock/ToolUseBlock dataclasses do NOT expose a
        # ``.type`` attribute, so keying off ``getattr(block, "type", None)``
        # silently dropped every real block. We keep a ``.type`` string
        # fallback so dict-shaped / mock blocks that carry an explicit type
        # still work.
        block_type = getattr(block, "type", None)

        if isinstance(block, TextBlock) or block_type == "text":
            text_content += getattr(block, "text", "")

        elif isinstance(block, ToolUseBlock) or block_type == "tool_use":
            raw_name = getattr(block, "name", "unknown")

            # Skip internal state management tool — not conversation history
            if _is_state_management_tool(raw_name):
                continue

            tool_id = getattr(block, "id", None) or ""
            tool_input = getattr(block, "input", {}) or {}

            tool_calls.append(
                ToolCall(
                    id=tool_id,
                    type="function",
                    function=FunctionCall(
                        name=strip_mcp_prefix(raw_name),
                        arguments=json.dumps(tool_input),
                    ),
                )
            )
        # Reasoning/ThinkingBlocks are intentionally skipped — not conversation history

    # Nothing user-visible (e.g. reasoning-only message)
    if not text_content and not tool_calls:
        return None

    return AssistantMessage(
        id=message_id,
        role="assistant",
        content=text_content or None,
        tool_calls=tool_calls if tool_calls else None,
    )


def build_agui_tool_message(
    tool_use_id: str,
    content: Any,
) -> ToolMessage:
    """
    Build an AG-UI ToolMessage from a Claude SDK tool result block.

    Extracts the text content from the SDK's content block format and
    normalises it into a simple string for the AG-UI message.

    Args:
        tool_use_id: ID of the tool call this result belongs to
        content: Raw content from the ToolResultBlock

    Returns:
        AG-UI ToolMessage
    """
    def _normalize_text(text: str) -> str:
        """Canonical textual-payload encoding: parse JSON when possible (so the
        frontend can access fields) else pass the raw text through UNQUOTED.

        This mirrors ``handlers.py``'s ``_normalize_text`` for the live
        TOOL_CALL_RESULT path (Item 5). Routing both the list-of-text-blocks
        branch and the bare-string branch through here keeps MESSAGES_SNAPSHOT
        encoding identical to TOOL_CALL_RESULT: the SAME logical tool result
        reaches the frontend with the SAME encoding regardless of which SDK
        shape (list vs. bare string) delivered it — in particular a bare string
        is NOT json.dumps-quoted into '"plain"'."""
        try:
            return json.dumps(json.loads(text))
        except (json.JSONDecodeError, ValueError):
            # Not JSON — raw passthrough (NOT json.dumps, which would quote it
            # and diverge from the list-text-block path).
            return text

    result_str = ""
    try:
        if isinstance(content, list) and len(content) > 0:
            first_block = content[0]
            if isinstance(first_block, dict) and first_block.get("type") == "text":
                result_str = _normalize_text(first_block.get("text", ""))
            else:
                result_str = json.dumps(content)
        elif isinstance(content, str):
            # Bare-string content: normalise identically to the inner text of a
            # text block (Item 5) instead of json.dumps-quoting it.
            result_str = _normalize_text(content)
        elif content is not None:
            result_str = json.dumps(content)
    except (TypeError, ValueError):
        result_str = str(content or "")

    return ToolMessage(
        id=f"{tool_use_id}-result",
        role="tool",
        content=result_str,
        tool_call_id=tool_use_id,
    )
