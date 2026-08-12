"""
Drift guard: our wire strings must match the installed SDK's own types.

``types.py`` hardcodes the discriminator strings the translators
dispatch on. The SDK declares the same strings as ``Literal[...]`` annotations
on its event/item classes. Nothing compares the two at runtime — if the SDK
renamed a wire value, dispatch would silently stop matching (graceful
degradation swallows unknowns). These tests make that drift a loud CI failure
instead: bump ``openai-agents`` / ``openai``, run pytest, and any renamed or
newly added wire type shows up as an assertion diff pointing at the exact
enum member to update by hand.
"""

from __future__ import annotations

import dataclasses
from typing import Union, get_args, get_origin

import pytest
from agents.stream_events import (
    AgentUpdatedStreamEvent,
    RawResponsesStreamEvent,
    RunItemStreamEvent,
)
from openai.types.responses import (
    ResponseFunctionCallArgumentsDeltaEvent,
    ResponseFunctionToolCall,
    ResponseOutputItem,
    ResponseOutputItemAddedEvent,
    ResponseOutputItemDoneEvent,
    ResponseOutputMessage,
    ResponseReasoningItem,
    ResponseReasoningSummaryPartDoneEvent,
    ResponseReasoningSummaryTextDeltaEvent,
    ResponseRefusalDeltaEvent,
    ResponseTextDeltaEvent,
    ResponseTextDoneEvent,
)
from openai.types.responses.response_reasoning_text_delta_event import (
    ResponseReasoningTextDeltaEvent,
)
from openai.types.responses.response_reasoning_text_done_event import (
    ResponseReasoningTextDoneEvent,
)

from ag_ui_openai_agents.engine import (
    HOSTED_TOOL_CALL_TYPES,
    OpenAIItemType,
    OpenAIRawResponseEventType,
    OpenAIStreamEventType,
)


def pydantic_wire_value(model_cls: type) -> str:
    """Extract the wire string from a pydantic ``type: Literal['...']`` field."""
    return get_args(model_cls.model_fields["type"].annotation)[0]


def dataclass_wire_value(cls: type) -> str:
    """Extract the wire string from a dataclass ``type`` field default."""
    for field in dataclasses.fields(cls):
        if field.name == "type":
            return field.default
    raise AssertionError(f"{cls.__name__} has no 'type' field")


def output_item_union_members() -> tuple[type, ...]:
    """Unwrap ``ResponseOutputItem`` (``Annotated[Union[...], meta]``)."""
    inner = get_args(ResponseOutputItem)[0]
    assert get_origin(inner) is Union
    return get_args(inner)


@pytest.mark.parametrize(
    ("ours", "sdk_cls"),
    [
        (OpenAIStreamEventType.RAW_RESPONSE, RawResponsesStreamEvent),
        (OpenAIStreamEventType.RUN_ITEM, RunItemStreamEvent),
        (OpenAIStreamEventType.AGENT_UPDATED, AgentUpdatedStreamEvent),
    ],
)
def test_stream_event_types_match_sdk(ours: OpenAIStreamEventType, sdk_cls: type) -> None:
    assert ours == dataclass_wire_value(sdk_cls)


@pytest.mark.parametrize(
    ("ours", "sdk_cls"),
    [
        (OpenAIRawResponseEventType.OUTPUT_ITEM_ADDED, ResponseOutputItemAddedEvent),
        (OpenAIRawResponseEventType.OUTPUT_ITEM_DONE, ResponseOutputItemDoneEvent),
        (OpenAIRawResponseEventType.TEXT_DELTA, ResponseTextDeltaEvent),
        (OpenAIRawResponseEventType.TEXT_DONE, ResponseTextDoneEvent),
        (OpenAIRawResponseEventType.REFUSAL_DELTA, ResponseRefusalDeltaEvent),
        (
            OpenAIRawResponseEventType.FUNCTION_CALL_ARGUMENTS_DELTA,
            ResponseFunctionCallArgumentsDeltaEvent,
        ),
        (
            OpenAIRawResponseEventType.REASONING_SUMMARY_DELTA,
            ResponseReasoningSummaryTextDeltaEvent,
        ),
        (
            OpenAIRawResponseEventType.REASONING_SUMMARY_PART_DONE,
            ResponseReasoningSummaryPartDoneEvent,
        ),
        (OpenAIRawResponseEventType.REASONING_TEXT_DELTA, ResponseReasoningTextDeltaEvent),
        (OpenAIRawResponseEventType.REASONING_TEXT_DONE, ResponseReasoningTextDoneEvent),
    ],
)
def test_raw_response_event_types_match_sdk(
    ours: OpenAIRawResponseEventType, sdk_cls: type
) -> None:
    assert ours == pydantic_wire_value(sdk_cls)


@pytest.mark.parametrize(
    ("ours", "sdk_cls"),
    [
        (OpenAIItemType.MESSAGE, ResponseOutputMessage),
        (OpenAIItemType.FUNCTION_CALL, ResponseFunctionToolCall),
        (OpenAIItemType.REASONING, ResponseReasoningItem),
    ],
)
def test_item_types_match_sdk(ours: OpenAIItemType, sdk_cls: type) -> None:
    assert ours == pydantic_wire_value(sdk_cls)


def test_every_sdk_tool_call_item_type_is_known() -> None:
    """
    Catch the SDK *adding* hosted tool kinds, not just renaming them.

    Every ``*_call`` member of the ``ResponseOutputItem`` union must be either
    ``function_call`` or listed in ``HOSTED_TOOL_CALL_TYPES`` — otherwise a new
    hosted tool would silently translate to nothing.
    """
    sdk_call_types = {
        pydantic_wire_value(member)
        for member in output_item_union_members()
        if pydantic_wire_value(member).endswith("_call")
    }
    known = HOSTED_TOOL_CALL_TYPES | {OpenAIItemType.FUNCTION_CALL.value}
    unknown = sdk_call_types - known
    assert not unknown, f"SDK added tool-call item types we don't map: {unknown}"
