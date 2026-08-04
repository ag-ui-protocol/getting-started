import asyncio
import logging
import re
from typing import Any, Dict, List, Union

from ag_ui.core import (
    Message,
    TextInputContent,
    ImageInputContent,
    AudioInputContent,
    VideoInputContent,
    DocumentInputContent,
    BinaryInputContent,
    InputContentDataSource,
    InputContentUrlSource,
)

from ._capabilities import warn_multimodal_files_gap

logger = logging.getLogger(__name__)


def camel_to_snake(name: str) -> str:
    """Convert a camelCase key to snake_case.

    Frontend callers send ``forwardedProps`` keys in camelCase; downstream
    CrewAI flow / tool code reads snake_case. This mirrors the LangGraph
    adapter's ``camel_to_snake`` so both bridges normalize identically.
    """
    return re.sub(r'(?<!^)(?=[A-Z])', '_', name).lower()


async def yield_control():
    """
    Yield control to the event loop.
    """
    loop = asyncio.get_running_loop()
    future = loop.create_future()
    loop.call_soon(future.set_result, None)
    await future


# Typed media parts (text and the deprecated BinaryInputContent are handled separately).
_MEDIA_CONTENT_TYPES = (
    ImageInputContent,
    AudioInputContent,
    VideoInputContent,
    DocumentInputContent,
)

AGUIContentItem = Union[
    TextInputContent,
    ImageInputContent,
    AudioInputContent,
    VideoInputContent,
    DocumentInputContent,
    BinaryInputContent,
]


def _media_source_to_url(
    source: Union[InputContentDataSource, InputContentUrlSource],
) -> Union[str, None]:
    """Convert an InputContentDataSource or InputContentUrlSource to a URL.

    For data sources, constructs a ``data:<mime>;base64,<value>`` URL. For URL
    sources, returns the URL directly.
    """
    if isinstance(source, InputContentDataSource):
        return f"data:{source.mime_type};base64,{source.value}"
    if isinstance(source, InputContentUrlSource):
        return source.value
    return None


def convert_agui_multimodal_to_litellm(
    content: List[AGUIContentItem],
) -> List[Dict[str, Any]]:
    """Convert AG-UI multimodal parts to LiteLLM/OpenAI content blocks.

    Text becomes ``{"type": "text", ...}`` and all media route through
    ``{"type": "image_url", ...}``, matching the LangGraph bridge. This is
    correct for images; non-image media (audio/video/document) is a known
    limitation: LiteLLM has native ``input_audio``/``video_url``/``file`` blocks
    that most providers require, so a non-image ``image_url`` block may be
    rejected. ``metadata`` is dropped: an unknown top-level key on a content
    block makes strict providers reject the request with a 400.
    """
    litellm_content: List[Dict[str, Any]] = []
    for item in content:
        if isinstance(item, TextInputContent):
            litellm_content.append({
                "type": "text",
                "text": item.text,
            })
        elif isinstance(item, _MEDIA_CONTENT_TYPES):
            url = _media_source_to_url(item.source)
            if url:
                litellm_content.append({
                    "type": "image_url",
                    "image_url": {"url": url},
                })
            else:
                logger.warning(
                    "Dropping %s content: source could not be converted to URL",
                    type(item).__name__,
                )
        elif isinstance(item, BinaryInputContent):
            # Deprecated legacy shape. Prefer url, then data, then id.
            content_dict: Dict[str, Any] = {"type": "image_url"}

            if item.url:
                content_dict["image_url"] = {"url": item.url}
            elif item.data:
                content_dict["image_url"] = {
                    "url": f"data:{item.mime_type};base64,{item.data}"
                }
            elif item.id:
                # Use id as a reference (some providers may support this).
                content_dict["image_url"] = {"url": item.id}
            else:
                logger.warning(
                    "Dropping BinaryInputContent item: no url, data, or id provided"
                )
                continue

            litellm_content.append(content_dict)
        else:
            logger.warning(
                "Dropping unrecognized content item type: %r", type(item).__name__
            )

    return litellm_content


# AG-UI content-part discriminators that are already in AG-UI shape and must be
# passed through the reverse converter unchanged (not everything in flow state is
# LiteLLM-shaped: an older bridge build, a checkpoint restore, or a user flow can
# leave native AG-UI parts here).
_AGUI_PASSTHROUGH_PART_TYPES = {"image", "audio", "video", "document", "binary"}


def _agui_type_for_mime(mime_type: str) -> str:
    """Best-effort AG-UI part type from a data-URL mime, so a non-image media
    part re-labels correctly on the reverse trip instead of always ``image``."""
    if mime_type.startswith("audio/"):
        return "audio"
    if mime_type.startswith("video/"):
        return "video"
    if mime_type.startswith("image/") or not mime_type:
        return "image"
    return "document"


def convert_litellm_multimodal_to_agui(
    content: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """Convert LiteLLM/OpenAI content blocks back to AG-UI parts.

    The inverse of ``convert_agui_multimodal_to_litellm``, used when replaying
    flow-state messages into MESSAGES_SNAPSHOT: without it the AG-UI ``Message``
    validator rejects the ``image_url`` block and the snapshot is dropped.

    The converter is idempotent: parts already in AG-UI shape (text/image/audio/
    video/document/binary) pass through unchanged, so content that never went
    through the forward converter (older-build flow state, checkpoint restore, a
    user flow appending a native part) is preserved rather than dropped.
    """
    agui_content: List[Dict[str, Any]] = []
    for item in content:
        if not isinstance(item, dict):
            continue
        item_type = item.get("type")
        if item_type == "text":
            agui_content.append({"type": "text", "text": item.get("text", "")})
        elif item_type == "image_url":
            image_url_data = item.get("image_url", {})
            url = (
                image_url_data.get("url", "")
                if isinstance(image_url_data, dict)
                else image_url_data
            )
            # An invalid url can't form a valid source; drop the part (with a
            # log) rather than let one bad part fail validation and void the
            # entire snapshot.
            if not isinstance(url, str) or not url:
                logger.warning("Dropping image_url block: missing or empty url")
                continue
            if url.startswith("data:"):
                # data:<mime>;base64,<data>
                if "," not in url:
                    logger.warning("Dropping malformed data: URL (no comma separator)")
                    continue
                header, data = url.split(",", 1)
                mime_type = header.split(":", 1)[1].split(";")[0]
                agui_content.append({
                    "type": _agui_type_for_mime(mime_type),
                    "source": {"type": "data", "value": data, "mime_type": mime_type},
                })
            else:
                agui_content.append({
                    "type": "image",
                    "source": {"type": "url", "value": url},
                })
        elif item_type in _AGUI_PASSTHROUGH_PART_TYPES:
            agui_content.append(item)
        else:
            logger.warning("Dropping unrecognized content block type: %r", item_type)
    return agui_content


def dump_agui_message(message: Message) -> Dict[str, Any]:
    """Serialize an AG-UI ``Message`` for CrewAI/LiteLLM.

    Like ``message.model_dump()``, but a multimodal user message (list
    ``content``) has its parts converted to LiteLLM's image_url shape so
    ``litellm.acompletion`` does not fail on them. Text messages pass through.
    """
    dumped = message.model_dump()
    content = getattr(message, "content", None)
    if isinstance(content, list):
        # Warn only for non-image media: images ride image_url and work on any
        # vision provider, so warning on them is noise. Audio/video/document are
        # the parts a provider may reject without native block support.
        if any(_is_non_image_media(item) for item in content):
            warn_multimodal_files_gap()
        dumped["content"] = convert_agui_multimodal_to_litellm(content)
    return dumped


_NON_IMAGE_MEDIA_TYPES = (AudioInputContent, VideoInputContent, DocumentInputContent)


def _is_non_image_media(item: Any) -> bool:
    """True for audio/video/document parts (typed or a non-image legacy binary)."""
    if isinstance(item, _NON_IMAGE_MEDIA_TYPES):
        return True
    if isinstance(item, BinaryInputContent):
        return not (item.mime_type or "").startswith("image/")
    return False
