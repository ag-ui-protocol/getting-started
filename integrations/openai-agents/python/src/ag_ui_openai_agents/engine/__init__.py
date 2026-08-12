"""Engine layer — the per-direction translation logic.

Advanced use only: subclass an engine to customize a single mapping and
inject it into the public translator via inbound_cls / outbound_cls. For
everything else, import AGUITranslator from the package root instead.
"""

from .agui_to_openai import AGUIToOpenAITranslator
from .helpers import (
    new_message_id,
    new_tool_call_id,
    new_tool_result_id,
    read_attr,
    to_string,
)
from .openai_to_agui import OpenAIToAGUITranslator
from .types import (
    ClientToolPending,
    HOSTED_TOOL_CALL_TYPES,
    OpenAIItemType,
    OpenAIRawResponseEventType,
    OpenAIStreamEventType,
    TranslatedInput,
)

__all__ = [
    "AGUIToOpenAITranslator",
    "ClientToolPending",
    "HOSTED_TOOL_CALL_TYPES",
    "new_message_id",
    "new_tool_call_id",
    "new_tool_result_id",
    "OpenAIItemType",
    "OpenAIRawResponseEventType",
    "OpenAIStreamEventType",
    "OpenAIToAGUITranslator",
    "read_attr",
    "to_string",
    "TranslatedInput",
]
