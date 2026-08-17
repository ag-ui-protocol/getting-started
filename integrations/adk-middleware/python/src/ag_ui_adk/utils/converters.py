# src/utils/converters.py

"""Conversion utilities between AG-UI and ADK formats."""

from typing import List, Dict, Any, Optional, Tuple, Union
import json
import base64
import binascii
import logging

from ag_ui.core import (
    Message, UserMessage, AssistantMessage, SystemMessage, ToolMessage,
    ToolCall, FunctionCall, TextInputContent, BinaryInputContent, InputContent,
    ImageInputContent, AudioInputContent, VideoInputContent, DocumentInputContent,
    InputContentDataSource, InputContentUrlSource,
)
from google.adk.events import Event as ADKEvent
from google.genai import types

from ..serialization import serialize_tool_args

logger = logging.getLogger(__name__)

def _get_text_value(item: Union[dict, TextInputContent]) -> Optional[str]:
    """Get text value from dict or TextInputContent."""
    if isinstance(item, TextInputContent):
        return item.text
    else:
        return item.get("text")

def _get_binary_attributes(item: Union[dict, BinaryInputContent]) -> Tuple[Optional[str], Optional[str], Optional[str], Optional[str], Optional[str]]:
    """Get binary attributes (data, mime_type, url, id, filename) from dict or BinaryInputContent."""
    if isinstance(item, BinaryInputContent):
        return (
            item.data,
            item.mime_type,
            item.url,
            item.id,
            item.filename,
        )
    else:
        return (
            item.get("data"),
            item.get("mimeType") or item.get("mime_type"),
            item.get("url"),
            item.get("id"),
            item.get("filename"),
        )

def _to_binary_part(data: Optional[str], mime_type: Optional[str], url: Optional[str], binary_id: Optional[str], filename: Optional[str] = None) -> Optional[types.Part]:
    """Create a types.Part from binary data."""
    # currently, only data is supported
    if not data:
        logger.warning(
            "BinaryInputContent: data is required; ignoring item without data."
        )
        return None
    
    if url or binary_id:
        logger.warning(
            "BinaryInputContent: only data is supported; ignoring url/id fields."
        )
        return None

    if not mime_type:
        logger.warning("BinaryInputContent: missing mimeType; ignoring.")
        return None

    try:
        decoded = base64.b64decode(data, validate=True)
        blob_kwargs: Dict[str, Any] = {"mime_type": mime_type, "data": decoded}
        if filename:
            blob_kwargs["display_name"] = filename
        return types.Part(inline_data=types.Blob(**blob_kwargs))
    except (binascii.Error, ValueError) as e:
        logger.warning("Failed to base64 decode BinaryInputContent.data: %s", e)
        return None

def _to_text_part(text: Optional[str]) -> Optional[types.Part]:
    """Create a types.Part from text."""
    if not text:
        return None
    return types.Part(text=text)

def _is_text_content(item: Union[dict, InputContent]) -> bool:
    is_text_dict = isinstance(item, dict) and item.get("type") == "text"
    is_text_input_content = isinstance(item, TextInputContent)
    return is_text_dict or is_text_input_content

def _is_binary_content(item: Union[dict, InputContent]) -> bool:
    is_binary_dict = isinstance(item, dict) and item.get("type") == "binary"
    is_binary_input_content = isinstance(item, BinaryInputContent)
    return is_binary_dict or is_binary_input_content

_MEDIA_CONTENT_TYPES = (ImageInputContent, AudioInputContent, VideoInputContent, DocumentInputContent)
_MEDIA_TYPE_STRINGS = {"image", "audio", "video", "document"}

def _is_media_content(item: Union[dict, InputContent]) -> bool:
    if isinstance(item, _MEDIA_CONTENT_TYPES):
        return True
    return isinstance(item, dict) and item.get("type") in _MEDIA_TYPE_STRINGS

def _media_content_to_part(item: Union[dict, InputContent]) -> Optional[types.Part]:
    """Convert a media content item (image/audio/video/document) to a types.Part."""
    if isinstance(item, _MEDIA_CONTENT_TYPES):
        source = item.source
    elif isinstance(item, dict):
        source = item.get("source")
    else:
        return None

    if source is None:
        logger.warning("Media content item has no source; ignoring.")
        return None

    # Handle InputContentDataSource (inline base64)
    if isinstance(source, InputContentDataSource):
        mime_type = source.mime_type
        data_value = source.value
    elif isinstance(source, dict) and source.get("type") == "data":
        mime_type = source.get("mimeType") or source.get("mime_type")
        data_value = source.get("value")
    else:
        mime_type = None
        data_value = None

    if data_value is not None:
        if not mime_type:
            logger.warning("Media content data source missing mime_type; ignoring.")
            return None
        try:
            decoded = base64.b64decode(data_value, validate=True)
            return types.Part(
                inline_data=types.Blob(
                    mime_type=mime_type,
                    data=decoded,
                )
            )
        except (binascii.Error, ValueError) as e:
            logger.warning("Failed to base64 decode media content data: %s", e)
            return None

    # Handle InputContentUrlSource (URI reference)
    if isinstance(source, InputContentUrlSource):
        url_value = source.value
        url_mime = source.mime_type
    elif isinstance(source, dict) and source.get("type") == "url":
        url_value = source.get("value")
        url_mime = source.get("mimeType") or source.get("mime_type")
    else:
        logger.warning("Media content has unrecognized source type; ignoring.")
        return None

    if not url_value:
        logger.warning("Media content URL source missing value; ignoring.")
        return None

    return types.Part(
        file_data=types.FileData(
            file_uri=url_value,
            mime_type=url_mime,
        )
    )

def convert_message_content_to_parts(content: Optional[Union[str, List[Any]]]) -> List[types.Part]:
    """Convert AG-UI message content into google.genai types.Part list.

    Supports:
    - str -> [Part(text=...)]
    - List[InputContent] -> text parts + media parts (image/audio/video/document) + binary parts
    - Media data sources (base64) -> Part(inline_data=Blob(...))
    - Media URL sources -> Part(file_data=FileData(file_uri=...))
    - Legacy BinaryInputContent -> Part(inline_data=Blob(...)) (deprecated)
    """
    if content is None:
        return []

    if isinstance(content, str):
        return [types.Part(text=content)] if content else []

    parts: List[types.Part] = []
    for item in content:
        if _is_text_content(item):
            text_value = _get_text_value(item)
            part = _to_text_part(text_value)
            if part:
                parts.append(part)
        elif _is_media_content(item):
            part = _media_content_to_part(item)
            if part:
                parts.append(part)
        elif _is_binary_content(item):
            data, mime_type, url, binary_id, filename = _get_binary_attributes(item)
            part = _to_binary_part(data, mime_type, url, binary_id, filename)
            if part:
                parts.append(part)
        else:
            item_type_name = item.get("type") if isinstance(item, dict) else type(item).__name__
            logger.debug("Ignoring unknown multimodal content item: %s", item_type_name)
    return parts


def convert_ag_ui_messages_to_adk(messages: List[Message]) -> List[ADKEvent]:
    """Convert AG-UI messages to ADK events.

    Args:
        messages: List of AG-UI messages

    Returns:
        List of ADK events
    """
    adk_events = []

    # Build a tool_call_id -> function_name lookup so we can populate
    # `FunctionResponse.name` correctly when we hit a ToolMessage. AG-UI's
    # ToolMessage doesn't carry the function name (only `tool_call_id`),
    # but Gemini's `FunctionResponse.name` MUST equal the called
    # function's name so providers (real Gemini and proxies like aimock)
    # can correlate the response back to the originating FunctionCall.
    # Without this, `name` would be set to the tool_call_id, which is a
    # UUID-like string that no prior FunctionCall.name will match — the
    # round-trip silently breaks (e.g. multi-leg fixture proxies fall
    # back to a generated id and stop matching second-leg responses).
    tool_call_id_to_name: dict[str, str] = {}
    for prior in messages:
        if isinstance(prior, AssistantMessage) and prior.tool_calls:
            for tool_call in prior.tool_calls:
                tool_call_id_to_name[tool_call.id] = tool_call.function.name

    for message in messages:
        try:
            # Create base event
            event = ADKEvent(
                id=message.id,
                author=message.role,
                content=None
            )
            
            # Convert content based on message type
            if isinstance(message, (UserMessage, SystemMessage)):
                parts = convert_message_content_to_parts(message.content)
                if parts:
                    event.content = types.Content(
                        role=message.role,
                        parts=parts
                    )

            elif isinstance(message, AssistantMessage):
                event.author = message.name or "model"
                parts = []

                # Add text content if present
                if message.content:
                    parts.extend(convert_message_content_to_parts(message.content))
                
                # Add tool calls if present
                if message.tool_calls:
                    for tool_call in message.tool_calls:
                        parts.append(types.Part(
                            function_call=types.FunctionCall(
                                name=tool_call.function.name,
                                args=json.loads(tool_call.function.arguments) if isinstance(tool_call.function.arguments, str) else tool_call.function.arguments,
                                id=tool_call.id
                            )
                        ))
                
                if parts:
                    event.content = types.Content(
                        role="model",  # ADK uses "model" for assistant
                        parts=parts
                    )
            
            elif isinstance(message, ToolMessage):
                # Tool messages become function responses. `name` must be
                # the called function's name (looked up from the prior
                # AssistantMessage's tool_calls by id); falling back to
                # the tool_call_id only when the lookup misses (e.g. the
                # caller sent a ToolMessage without the originating
                # AssistantMessage in the same batch — rare, but the old
                # behaviour). `id` carries the tool_call_id so providers
                # that key on it directly still see it.
                function_name = tool_call_id_to_name.get(
                    message.tool_call_id, message.tool_call_id
                )
                event.content = types.Content(
                    role="function",
                    parts=[types.Part(
                        function_response=types.FunctionResponse(
                            name=function_name,
                            response={"result": message.content} if isinstance(message.content, str) else message.content,
                            id=message.tool_call_id
                        )
                    )]
                )
            
            adk_events.append(event)
            
        except Exception as e:
            logger.error(f"Error converting message {message.id}: {e}")
            continue
    
    return adk_events


def convert_adk_event_to_ag_ui_message(event: ADKEvent) -> Optional[Message]:
    """Convert an ADK event to an AG-UI message.
    
    Args:
        event: ADK event
        
    Returns:
        AG-UI message or None if not convertible
    """
    try:
        # Skip events without content
        if not event.content or not event.content.parts:
            return None
        
        # Determine message type based on author/role
        if event.author == "user":
            # Extract text content
            text_parts = [part.text for part in event.content.parts if part.text]
            if text_parts:
                return UserMessage(
                    id=event.id,
                    role="user",
                    content="\n".join(text_parts)
                )
        
        else:  # Assistant/model response
            # Extract text and tool calls
            text_parts = []
            tool_calls = []
            
            for part in event.content.parts:
                if part.text:
                    text_parts.append(part.text)
                elif part.function_call:
                    tool_calls.append(ToolCall(
                        id=getattr(part.function_call, 'id', event.id),
                        type="function",
                        function=FunctionCall(
                            name=part.function_call.name,
                            arguments=serialize_tool_args(part.function_call.args) if hasattr(part.function_call, 'args') else "{}"
                        )
                    ))
            
            assistant_name = (
                event.author
                if isinstance(event.author, str) and event.author != "model"
                else None
            )
            return AssistantMessage(
                id=event.id,
                role="assistant",
                name=assistant_name,
                content="\n".join(text_parts) if text_parts else None,
                tool_calls=tool_calls if tool_calls else None
            )
        
    except Exception as e:
        logger.error(f"Error converting ADK event {event.id}: {e}")
    
    return None


def convert_state_to_json_patch(state_delta: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Convert a state delta to JSON Patch format (RFC 6902).
    
    Args:
        state_delta: Dictionary of state changes
        
    Returns:
        List of JSON Patch operations
    """
    patches = []
    
    for key, value in state_delta.items():
        # Determine operation type
        if value is None:
            # Remove operation
            patches.append({
                "op": "remove",
                "path": f"/{key}"
            })
        else:
            # Add/replace operation
            # We use "replace" as it works for both existing and new keys
            patches.append({
                "op": "replace",
                "path": f"/{key}",
                "value": value
            })
    
    return patches


def convert_json_patch_to_state(patches: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Convert JSON Patch operations to a state delta dictionary.
    
    Args:
        patches: List of JSON Patch operations
        
    Returns:
        Dictionary of state changes
    """
    state_delta = {}
    
    for patch in patches:
        op = patch.get("op")
        path = patch.get("path", "")
        
        # Extract key from path (remove leading slash)
        key = path.lstrip("/")
        
        if op == "remove":
            state_delta[key] = None
        elif op in ["add", "replace"]:
            state_delta[key] = patch.get("value")
        # Ignore other operations for now (copy, move, test)
    
    return state_delta


def extract_text_from_content(content: types.Content) -> str:
    """Extract all text from ADK Content object."""
    if not content or not content.parts:
        return ""

    text_parts = []
    for part in content.parts:
        if part.text:
            text_parts.append(part.text)

    return "\n".join(text_parts)


def flatten_message_content(content: Any) -> str:
    if content is None:
        return ""

    if isinstance(content, str):
        return content

    if isinstance(content, list):
        text_parts = [part.text for part in content if isinstance(part, TextInputContent) and part.text]
        return "\n".join(text_parts)

    return str(content)


def create_error_message(error: Exception, context: str = "") -> str:
    """Create a user-friendly error message.
    
    Args:
        error: The exception
        context: Additional context about where the error occurred
        
    Returns:
        Formatted error message
    """
    error_type = type(error).__name__
    error_msg = str(error)
    
    if context:
        return f"{context}: {error_type} - {error_msg}"
    else:
        return f"{error_type}: {error_msg}"
