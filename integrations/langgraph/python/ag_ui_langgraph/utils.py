import json
import logging
import re
from enum import Enum
from uuid import UUID

from pydantic import TypeAdapter
from pydantic_core import PydanticSerializationError
from typing import List, Any, Dict, Union
from dataclasses import is_dataclass, asdict, fields
from datetime import date, datetime

from langchain_core.messages import BaseMessage, HumanMessage, AIMessage, SystemMessage, ToolMessage
from ag_ui.core import (
    Message as AGUIMessage,
    UserMessage as AGUIUserMessage,
    AssistantMessage as AGUIAssistantMessage,
    SystemMessage as AGUISystemMessage,
    ToolMessage as AGUIToolMessage,
    ReasoningMessage as AGUIReasoningMessage,
    ToolCall as AGUIToolCall,
    FunctionCall as AGUIFunctionCall,
    TextInputContent,
    BinaryInputContent,
    ImageInputContent,
    AudioInputContent,
    VideoInputContent,
    DocumentInputContent,
    InputContentDataSource,
    InputContentUrlSource,
)
from .types import State, SchemaKeys, LangGraphReasoning

logger = logging.getLogger(__name__)

# Type alias for the AG-UI multimodal content union
AGUIContentItem = Union[
    TextInputContent,
    ImageInputContent,
    AudioInputContent,
    VideoInputContent,
    DocumentInputContent,
    BinaryInputContent,
]

DEFAULT_SCHEMA_KEYS = ["tools"]

def filter_object_by_schema_keys(obj: Dict[str, Any], schema_keys: List[str]) -> Dict[str, Any]:
    if not obj:
        return {}
    return {k: v for k, v in obj.items() if k in schema_keys}

def get_stream_payload_input(
    *,
    mode: str,
    state: State,
    schema_keys: SchemaKeys,
) -> Union[State, None]:
    input_payload = state if mode == "start" else None
    if input_payload and schema_keys and schema_keys.get("input"):
        input_payload = filter_object_by_schema_keys(input_payload, [*DEFAULT_SCHEMA_KEYS, *schema_keys["input"]])
    return input_payload

def stringify_if_needed(item: Any) -> str:
    if item is None:
        return ''
    if isinstance(item, str):
        return item
    return json.dumps(item)

_AGUI_MEDIA_BY_MIME_PREFIX = (
    ("image/", ImageInputContent, "image"),
    ("audio/", AudioInputContent, "audio"),
    ("video/", VideoInputContent, "video"),
)


def _agui_media_for_mime(mime_type: str):
    """Pick the AG-UI content class and ``type`` literal for a mime type.

    Anything that is not image/audio/video is a document. That default is the
    point: a mime type this adapter has never heard of is still not a picture,
    and calling it one is what makes a client try to decode it as one.
    """
    for prefix, content_class, type_literal in _AGUI_MEDIA_BY_MIME_PREFIX:
        if mime_type.startswith(prefix):
            return content_class, type_literal
    return DocumentInputContent, "document"


def convert_langchain_multimodal_to_agui(content: List[Dict[str, Any]]) -> List[Union[TextInputContent, ImageInputContent]]:
    """Convert LangChain's multimodal content to AG-UI format.

    LangChain only supports ``text`` and ``image_url`` content blocks, so
    EVERYTHING media-shaped left for LangChain as ``image_url`` regardless of
    what it actually was (see ``convert_agui_multimodal_to_langchain``). The
    mime type carried in a data URL is therefore the only surviving record of
    the original modality, and reading it is what keeps a PDF a PDF across the
    round trip.

    A ``data:`` URL is mapped back to the content class its mime type belongs
    to. A bare ``https://`` URL announces no mime type, so there is nothing to
    decide on and it stays an image — the case that has always worked.
    """
    agui_content: List[Union[TextInputContent, ImageInputContent]] = []
    for item in content:
        if isinstance(item, dict):
            if item.get("type") == "text":
                agui_content.append(TextInputContent(
                    type="text",
                    text=item.get("text", "")
                ))
            elif item.get("type") == "image_url":
                image_url_data = item.get("image_url", {})
                url = image_url_data.get("url", "") if isinstance(image_url_data, dict) else image_url_data

                # Parse data URLs to extract base64 data
                if url.startswith("data:"):
                    # Format: data:mime_type;base64,data
                    parts = url.split(",", 1)
                    header = parts[0]
                    data = parts[1] if len(parts) > 1 else ""
                    mime_type = header.split(":")[1].split(";")[0] if ":" in header else "image/png"

                    content_class, type_literal = _agui_media_for_mime(mime_type)
                    agui_content.append(content_class(
                        type=type_literal,
                        source=InputContentDataSource(
                            type="data",
                            value=data,
                            mime_type=mime_type,
                        ),
                    ))
                else:
                    # Regular URL
                    agui_content.append(ImageInputContent(
                        type="image",
                        source=InputContentUrlSource(
                            type="url",
                            value=url,
                        ),
                    ))
    return agui_content

def _reasoning_block_summary_text(block: Dict[str, Any]) -> str:
    """Extract the human-readable reasoning text from a LangChain reasoning
    content block (OpenAI Responses ``responses/v1`` shape)."""
    summary = block.get("summary")
    if isinstance(summary, list):
        parts = [
            s.get("text", "")
            for s in summary
            if isinstance(s, dict) and s.get("text")
        ]
        if parts:
            # Join multi-part summaries with a newline so the parts stay
            # legible instead of being mashed together ("A\nB", not "AB").
            return "\n".join(parts)
    # Fallbacks for non-OpenAI shapes that still carry a flat text field.
    for key in ("reasoning", "text"):
        val = block.get(key)
        if isinstance(val, str) and val:
            return val
    return ""


def _reasoning_block_to_agui_message(
    block: Dict[str, Any], assistant_id: str, index: int = 0
) -> "AGUIReasoningMessage | None":
    """Turn a LangChain reasoning content block into an AG-UI
    ReasoningMessage, preserving the block id (so it round-trips back to the
    provider as the same reasoning item) and any encrypted content (needed when
    the provider is run statelessly with ``store=False``).

    Returns ``None`` for a block with neither text nor encrypted content — there
    is nothing the client could render or round-trip.
    """
    text = _reasoning_block_summary_text(block)
    encrypted = block.get("encrypted_content")
    block_id = block.get("id")
    # The provider id (e.g. OpenAI ``rs_…``) is the round-trip handle: under
    # ``store=True`` the summary/encrypted content are empty and the id alone is
    # what lets the next request reference the stored reasoning. So emit whenever
    # we have an id, text, or encrypted content; only a wholly empty block is
    # dropped (nothing to render or round-trip).
    if not block_id and not text and not encrypted:
        return None
    # Fall back to a deterministic id derived from the owning assistant message
    # when the provider didn't supply one. Include the block index so multiple
    # id-less reasoning blocks on one message don't collide on the same id.
    block_id = block_id or f"{assistant_id}-reasoning-{index}"
    return AGUIReasoningMessage(
        id=str(block_id),
        role="reasoning",
        content=text,
        encrypted_value=encrypted,
    )


def _agui_reasoning_message_to_block(message: AGUIReasoningMessage) -> Dict[str, Any]:
    """Rebuild the LangChain reasoning content block from an AG-UI
    ReasoningMessage so it can be re-attached to the adjacent assistant message
    (the inverse of :func:`_reasoning_block_to_agui_message`)."""
    block: Dict[str, Any] = {
        "type": "reasoning",
        "id": message.id,
        "summary": (
            [{"type": "summary_text", "text": message.content}]
            if message.content
            else []
        ),
    }
    if getattr(message, "encrypted_value", None):
        block["encrypted_content"] = message.encrypted_value
    return block


def langchain_messages_to_agui(messages: List[BaseMessage]) -> List[AGUIMessage]:
    agui_messages: List[AGUIMessage] = []
    for message in messages:
        if isinstance(message, HumanMessage):
            # Handle multimodal content
            if isinstance(message.content, list):
                content = convert_langchain_multimodal_to_agui(message.content)
            else:
                content = stringify_if_needed(resolve_message_content(message.content))

            agui_messages.append(AGUIUserMessage(
                id=str(message.id),
                role="user",
                content=content,
                name=message.name,
            ))
        elif isinstance(message, AIMessage):
            # Surface reasoning content blocks as standalone
            # ReasoningMessages placed BEFORE the assistant message (matching
            # streaming-event ordering), so a client with no persistent
            # checkpoint can round-trip them back to the model.
            if isinstance(message.content, list):
                for index, block in enumerate(message.content):
                    if isinstance(block, dict) and block.get("type") == "reasoning":
                        reasoning_msg = _reasoning_block_to_agui_message(
                            block, str(message.id), index
                        )
                        if reasoning_msg is not None:
                            agui_messages.append(reasoning_msg)

            tool_calls = None
            if message.tool_calls:
                tool_calls = [
                    AGUIToolCall(
                        id=str(tc["id"]),
                        type="function",
                        function=AGUIFunctionCall(
                            name=tc["name"],
                            arguments=json.dumps(tc.get("args", {})),
                        ),
                    )
                    for tc in message.tool_calls
                ]

            agui_messages.append(AGUIAssistantMessage(
                id=str(message.id),
                role="assistant",
                content=stringify_if_needed(resolve_message_content(message.content)),
                tool_calls=tool_calls,
                name=message.name,
            ))
        elif isinstance(message, SystemMessage):
            agui_messages.append(AGUISystemMessage(
                id=str(message.id),
                role="system",
                content=stringify_if_needed(resolve_message_content(message.content)),
                name=message.name,
            ))
        elif isinstance(message, ToolMessage):
            agui_messages.append(AGUIToolMessage(
                id=str(message.id),
                role="tool",
                content=stringify_if_needed(resolve_message_content(message.content)),
                tool_call_id=message.tool_call_id,
                # A LangChain tool result signals failure only through `status`, with
                # no error text. Restore AG-UI's `error` so the failure survives the
                # round trip; the value is a fixed sentinel (#2305) because the
                # original text is not recoverable from the flag alone.
                error="error" if message.status == "error" else None,
            ))
        else:
            raise TypeError(f"Unsupported message type: {type(message)}")
    return agui_messages

_MEDIA_CONTENT_TYPES = (ImageInputContent, AudioInputContent, VideoInputContent, DocumentInputContent)


def _media_source_to_url(source: Union[InputContentDataSource, InputContentUrlSource]) -> str | None:
    """Convert an InputContentDataSource or InputContentUrlSource to a URL string.

    For data sources, constructs a ``data:<mime>;base64,<value>`` URL.
    For URL sources, returns the URL directly.
    """
    if isinstance(source, InputContentDataSource):
        return f"data:{source.mime_type};base64,{source.value}"
    if isinstance(source, InputContentUrlSource):
        return source.value
    return None


def convert_agui_multimodal_to_langchain(content: List[AGUIContentItem]) -> List[Dict[str, Any]]:
    """Convert AG-UI multimodal content to LangChain's multimodal format.

    Handles the new typed content classes (ImageInputContent, AudioInputContent,
    VideoInputContent, DocumentInputContent) as well as legacy BinaryInputContent
    for backwards compatibility. All media types are routed through LangChain's
    ``image_url`` format since that is the only media block type LangChain supports.

    AG-UI ``InputContent.metadata`` is intentionally NOT copied onto the content
    blocks: these blocks are passed straight to the model, and a non-standard
    top-level ``metadata`` key makes strict OpenAI-compatible providers reject the
    request with a 400 ("Unexpected keys in a message content image dict"). The
    metadata is never read back on the LangChain->AG-UI return path, so nothing is
    lost by keeping the model payload spec-compliant. See issue #2100.
    """
    langchain_content: List[Dict[str, Any]] = []
    for item in content:
        if isinstance(item, TextInputContent):
            langchain_content.append({
                "type": "text",
                "text": item.text
            })
        elif isinstance(item, _MEDIA_CONTENT_TYPES):
            url = _media_source_to_url(item.source)
            if url:
                langchain_content.append({
                    "type": "image_url",
                    "image_url": {"url": url}
                })
            else:
                logger.warning("Dropping %s content: source could not be converted to URL", type(item).__name__)
        elif isinstance(item, BinaryInputContent):
            # Legacy BinaryInputContent — backwards compatibility
            content_dict: Dict[str, Any] = {"type": "image_url"}

            # Prioritize url, then data, then id
            if item.url:
                content_dict["image_url"] = {"url": item.url}
            elif item.data:
                # Construct data URL from base64 data
                content_dict["image_url"] = {"url": f"data:{item.mime_type};base64,{item.data}"}
            elif item.id:
                # Use id as a reference (some providers may support this)
                content_dict["image_url"] = {"url": item.id}
            else:
                logger.warning(
                    "Dropping BinaryInputContent item: no url, data, or id provided"
                )
                continue

            langchain_content.append(content_dict)

    return langchain_content

def agui_messages_to_langchain(messages: List[AGUIMessage]) -> List[BaseMessage]:
    langchain_messages = []
    # Reasoning AG-UI messages are display-only at the AG-UI layer, but
    # at the LangChain layer reasoning lives as a content block ON the assistant
    # AIMessage. To round-trip reasoning without loss (so a stateless client can
    # hand the model back its own chain-of-thought), buffer each reasoning message and
    # re-attach it as a content block on the assistant message that follows it
    # (matching the order reasoning is streamed: reasoning first, then text).
    # Developer messages stay dropped — they are configured on the agent itself.
    #
    # Reasoning that is NOT immediately followed by an assistant message (a
    # trailing reasoning message, or one followed by a user/tool/system message)
    # is intentionally discarded: there is no assistant to attach it to, and
    # re-materializing it as a standalone message causes exponential message
    # duplication and tool-call loops under the add_messages reducer. The
    # snapshot side (langchain_messages_to_agui) only ever emits reasoning
    # immediately before its assistant, so this drop never affects a real
    # round-trip — only hand-crafted/ partial inputs.
    pending_reasoning: list = []
    for message in messages:
        role = message.role
        if role == "reasoning":
            pending_reasoning.append(_agui_reasoning_message_to_block(message))
            continue
        if role == "developer":
            continue
        if role == "user":
            pending_reasoning = []
            # Handle multimodal content
            if isinstance(message.content, str):
                content = message.content
            elif isinstance(message.content, list):
                content = convert_agui_multimodal_to_langchain(message.content)
            else:
                content = str(message.content)

            langchain_messages.append(HumanMessage(
                id=message.id,
                content=content,
                name=message.name,
            ))
        elif role == "assistant":
            tool_calls = []
            if hasattr(message, "tool_calls") and message.tool_calls:
                for tc in message.tool_calls:
                    tool_calls.append({
                        "id": tc.id,
                        "name": tc.function.name,
                        "args": json.loads(tc.function.arguments) if hasattr(tc, "function") and tc.function.arguments else {},
                        "type": "tool_call",
                    })
            # Fold any buffered reasoning blocks onto this assistant message.
            if pending_reasoning:
                content = list(pending_reasoning)
                if message.content:
                    content.append({"type": "text", "text": message.content})
                pending_reasoning = []
            else:
                content = message.content or ""
            langchain_messages.append(AIMessage(
                id=message.id,
                content=content,
                tool_calls=tool_calls,
                name=message.name,
            ))
        elif role == "system":
            pending_reasoning = []
            langchain_messages.append(SystemMessage(
                id=message.id,
                content=message.content,
                name=message.name,
            ))
        elif role == "tool":
            pending_reasoning = []
            langchain_messages.append(ToolMessage(
                id=message.id,
                content=message.content,
                tool_call_id=message.tool_call_id,
                # Carry the AG-UI failure signal onto LangChain's tool-result status, so a
                # client-reported tool failure is not delivered to the model as a success.
                status="error" if message.error else "success",
            ))
        else:
            raise ValueError(f"Unsupported message role: {role}")
    return langchain_messages

def _dual_get(obj: Any, key: str, default: Any = None) -> Any:
    """Fetch ``key`` from either a mapping or an attribute-bearing object.

    Chunks arrive as LangChain ``BaseMessage`` instances on most paths but
    some upstream integrations deliver raw dicts. Use this helper anywhere
    chunk shape is not guaranteed so we don't AttributeError on dicts or
    KeyError on objects."""
    if obj is None:
        return default
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def resolve_reasoning_content(chunk: Any) -> LangGraphReasoning | None:
    content = _dual_get(chunk, "content")
    if not content:
        # Fall through to check additional_kwargs for OpenAI legacy format
        pass

    if isinstance(content, list) and content and content[0]:
        block = content[0]
        block_type = block.get("type") if isinstance(block, dict) else None

        # Old langchain-anthropic format: { type: "thinking", thinking: "..." }
        if block_type == "thinking" and block.get("thinking"):
            result = LangGraphReasoning(
                text=block["thinking"],
                type="text",
                index=block.get("index", 0)
            )
            # Extract signature if present (Anthropic extended thinking signature)
            if block.get("signature"):
                result["signature"] = block["signature"]
            return result

        # New LangChain standardized format: { type: "reasoning", reasoning: "..." }
        if block_type == "reasoning" and block.get("reasoning"):
            return LangGraphReasoning(
                text=block["reasoning"],
                type="text",
                index=block.get("index", 0)
            )

        # AWS Bedrock Converse format: { type: "reasoning_content", reasoning_content: { text: "...", signature: "..." } }
        if block_type == "reasoning_content" and isinstance(block.get("reasoning_content"), dict):
            rc = block["reasoning_content"]
            if rc.get("text"):
                result = LangGraphReasoning(
                    text=rc["text"],
                    type="text",
                    index=rc.get("index", 0),
                )
                if rc.get("signature"):
                    result["signature"] = rc["signature"]
                return result

        # OpenAI Responses API v1 format: { type: "reasoning", summary: [{ text: "..." }] }
        #
        # The reasoning item's canonical id (OpenAI ``rs_…``) only travels on
        # text-less chunks: the `response.output_item.added` chunk
        # ({ id, summary: [] }) and — depending on the langchain-openai
        # version — the `…summary_part.added` chunk ({ id, summary:
        # [{ text: "" }] }). The `…summary_text.delta` chunks carry text but
        # no id. Surface the id carriers (instead of dropping them for having
        # no text) so the streamed reasoning message can adopt the canonical
        # id — the id the snapshot converter
        # (_reasoning_block_to_agui_message) emits for the same block;
        # handle_reasoning_event stashes the id without opening a message, so
        # summary-less (store=true) items still render nothing. Only the
        # first summary part takes the id: later parts belong to the same
        # item, and reusing its id would mint two messages with one id.
        if block_type == "reasoning" and isinstance(block.get("summary"), list):
            summaries = block["summary"]
            if not summaries and block.get("id"):
                return LangGraphReasoning(
                    type="text",
                    text="",
                    index=block.get("index", 0),
                    id=str(block["id"]),
                )
            if summaries and isinstance(summaries[0], dict):
                data = summaries[0]
                if data.get("text") or block.get("id"):
                    result = LangGraphReasoning(
                        type="text",
                        text=data.get("text") or "",
                        index=data.get("index", 0)
                    )
                    if block.get("id") and data.get("index", 0) == 0:
                        result["id"] = str(block["id"])
                    return result

        # Bedrock Converse API format: { type: "reasoning_content", reasoning_content: { type: "text", text: "..." } }
        if block_type == "reasoning_content" and isinstance(block.get("reasoning_content"), dict):
            inner = block["reasoning_content"]
            if inner.get("text"):
                return LangGraphReasoning(
                    type="text",
                    text=inner["text"],
                    index=inner.get("index", 0)
                )

    # OpenAI legacy format via additional_kwargs
    additional_kwargs = _dual_get(chunk, "additional_kwargs")
    if isinstance(additional_kwargs, dict):
        reasoning = additional_kwargs.get("reasoning", {})
        summary = reasoning.get("summary", []) if isinstance(reasoning, dict) else []
        if summary:
            data = summary[0]
            if not data or not data.get("text"):
                return None
            return LangGraphReasoning(
                type="text",
                text=data["text"],
                index=data.get("index", 0)
            )

        # DeepSeek / Qwen / xAI format: additional_kwargs.reasoning_content is a string
        reasoning_content = additional_kwargs.get("reasoning_content")
        if reasoning_content and isinstance(reasoning_content, str):
            return LangGraphReasoning(
                type="text",
                text=reasoning_content,
                index=0,
            )

    return None


def resolve_encrypted_reasoning_content(chunk: Any) -> str | None:
    """
    Resolves encrypted reasoning content from Anthropic responses.
    This handles:
    - `redacted_thinking` blocks with encrypted `data` (redacted chain-of-thought)
    """
    content = _dual_get(chunk, "content") if chunk is not None else None
    if not content or not isinstance(content, list) or not content or not content[0]:
        return None

    # Anthropic redacted_thinking block: { type: "redacted_thinking", data: "..." }
    if content[0].get("type") == "redacted_thinking" and content[0].get("data"):
        return content[0]["data"]

    return None

def resolve_message_content(content: Any) -> str | None:
    # Distinguish None (absent) from "" (explicit empty delta): some
    # providers emit zero-length content during tool-call / structured-
    # output transitions, and the caller in _handle_single_event relies on
    # preserving the empty string so the delta still flows through.
    if content is None:
        return None

    if isinstance(content, str):
        return content

    if isinstance(content, list) and content:
        content_text = next((c.get("text") for c in content if isinstance(c, dict) and c.get("type") == "text"), None)
        return content_text

    return None


def _flatten_media_content(item: Union[ImageInputContent, AudioInputContent, VideoInputContent, DocumentInputContent], label: str) -> str:
    """Return a placeholder string for a typed media content item."""
    source = item.source
    if isinstance(source, InputContentUrlSource):
        return f"[{label}: {source.value}]"
    if isinstance(source, InputContentDataSource):
        return f"[{label}: {source.mime_type}]"
    return f"[{label}]"


_MEDIA_LABEL_MAP = {
    ImageInputContent: "Image",
    AudioInputContent: "Audio",
    VideoInputContent: "Video",
    DocumentInputContent: "Document",
}


def flatten_user_content(content: Any) -> str:
    """
    Flatten multimodal content into plain text.
    Used for backwards compatibility or when multimodal is not supported.
    """
    if content is None:
        return ""

    if isinstance(content, str):
        return content

    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, TextInputContent):
                if item.text:
                    parts.append(item.text)
            elif isinstance(item, _MEDIA_CONTENT_TYPES):
                label = _MEDIA_LABEL_MAP.get(type(item), "Media")
                parts.append(_flatten_media_content(item, label))
            elif isinstance(item, BinaryInputContent):
                # Legacy BinaryInputContent — backwards compatibility
                if item.filename:
                    parts.append(f"[Binary content: {item.filename}]")
                elif item.url:
                    parts.append(f"[Binary content: {item.url}]")
                else:
                    parts.append(f"[Binary content: {item.mime_type}]")
        return "\n".join(parts)

    return str(content)


def normalize_tool_content(content: Any) -> str:
    """
    Normalize tool message content to a string.
    Handles the various content block formats from LangChain/LangGraph.

    Content can be:
    - A plain string
    - A list of strings or content blocks (e.g., {"type": "text", "text": "..."})
    """
    if isinstance(content, str):
        return content

    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict) and block.get('type') == 'text':
                parts.append(block.get('text', ''))
            else:
                parts.append(json.dumps(block))
        return ''.join(parts)

    return json.dumps(content)


# Used by run() to normalize forwarded_props keys from camelCase (JS frontend convention)
# to snake_case (Python convention). Appears isolated but is called from agent.py and
# removing it would silently break all streaming options forwarded from the frontend
# (stream_subgraphs, node_name, command.resume, etc.).
def camel_to_snake(name):
    return re.sub(r'(?<!^)(?=[A-Z])', '_', name).lower()

def json_safe_stringify(o):
    """Fallback encoder used by json.dumps(default=...)."""
    if isinstance(o, (datetime, date)):
        return o.isoformat()
    try:
        return make_json_safe(o)
    except Exception:
        return str(o)

def make_json_safe(value: Any, _seen: set[int] | None = None) -> Any:
    """
    Convert `value` into something that `json.dumps` can always handle.

    Rules (in order):
    - primitives → as-is
    - Enum → its .value (recursively made safe)
    - dict → keys & values made safe
    - list/tuple/set/frozenset → list of safe values
    - dataclasses → asdict() then recurse
    - Pydantic-style models → model_dump()/dict()/to_dict() then recurse
    - objects with __dict__ → vars(obj) then recurse
    - everything else → repr(obj)

    Cycles are detected and replaced with the string "<recursive>".
    """
    if _seen is None:
        _seen = set()

    obj_id = id(value)
    if obj_id in _seen:
        return "<recursive>"

    # --- 1. Primitives -----------------------------------------------------
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value

    # --- 2. Enum → use underlying value -----------------------------------
    if isinstance(value, Enum):
        return make_json_safe(value.value, _seen)

    # --- 2b. UUID → canonical string form ---------------------------------
    if isinstance(value, UUID):
        return str(value)

    # --- 3. Dicts ----------------------------------------------------------
    if isinstance(value, dict):
        _seen.add(obj_id)
        # LangGraph/LangChain tool calls inject non-serializable runtime/config; skip them.
        return {
            make_json_safe(k, _seen): make_json_safe(v, _seen)
            for k, v in value.items()
            if k not in ("runtime", "config")
        }

    # --- 4. Iterable containers -------------------------------------------
    if isinstance(value, (list, tuple, set, frozenset)):
        _seen.add(obj_id)
        return [make_json_safe(v, _seen) for v in value]

    # --- 5. Dataclasses ----------------------------------------------------
    if is_dataclass(value):
        _seen.add(obj_id)
        # Skip runtime/config (LangGraph-injected, not serializable)
        d = {f.name: getattr(value, f.name) for f in fields(value) if f.name not in ("runtime", "config")}
        return make_json_safe(d, _seen)

    # --- 6. Pydantic-like models (v2: model_dump) -------------------------
    if hasattr(value, "model_dump") and callable(getattr(value, "model_dump")):
        _seen.add(obj_id)
        try:
            return make_json_safe(value.model_dump(), _seen)
        except Exception:
            # fall through to other options
            pass

    # --- 7. Pydantic v1-style / other libs with .dict() -------------------
    if hasattr(value, "dict") and callable(getattr(value, "dict")):
        _seen.add(obj_id)
        try:
            return make_json_safe(value.dict(), _seen)
        except Exception:
            pass

    # --- 8. Generic "to_dict" pattern -------------------------------------
    if hasattr(value, "to_dict") and callable(getattr(value, "to_dict")):
        _seen.add(obj_id)
        try:
            return make_json_safe(value.to_dict(), _seen)
        except Exception:
            pass

    # --- 9. Generic Python objects with __dict__ --------------------------
    if hasattr(value, "__dict__"):
        _seen.add(obj_id)
        try:
            return make_json_safe(vars(value), _seen)
        except Exception:
            pass

    # --- 10. Last resort ---------------------------------------------------
    return repr(value)
