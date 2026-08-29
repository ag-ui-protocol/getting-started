"""Tests for the opt-in RAW passthrough of untranslated ADK events."""

import time

import pytest
from ag_ui.core import EventType
from google.adk.events import Event as ADKEvent
from google.genai import types

from ag_ui_adk.event_translator import EventTranslator


def _text_event(text: str = "hola") -> ADKEvent:
    return ADKEvent(
        timestamp=time.time(),
        author="assistant",
        invocation_id="inv_1",
        content=types.Content(role="model", parts=[types.Part(text=text)]),
    )


async def _collect(translator: EventTranslator, adk_event: ADKEvent):
    return [e async for e in translator.translate(adk_event, "t1", "r1")]


@pytest.mark.asyncio
async def test_raw_events_off_by_default():
    """Without the flag, no RAW event is emitted."""
    translator = EventTranslator()
    events = await _collect(translator, _text_event())
    assert all(e.type != EventType.RAW for e in events)


@pytest.mark.asyncio
async def test_raw_event_emitted_first_when_enabled():
    """With the flag, a RAW event precedes the translated events."""
    translator = EventTranslator(emit_raw_events=True)
    events = await _collect(translator, _text_event("hola"))

    raw = [e for e in events if e.type == EventType.RAW]
    assert len(raw) == 1, "exactly one RAW event expected"
    # RAW comes before the translated text events.
    assert events[0].type == EventType.RAW
    assert any(e.type == EventType.TEXT_MESSAGE_CONTENT for e in events)

    raw_event = raw[0]
    assert raw_event.source == "google-adk"
    # The payload is the serialized ADK event (author + content survive).
    assert isinstance(raw_event.event, dict)
    assert raw_event.event.get("author") == "assistant"


@pytest.mark.asyncio
async def test_raw_event_skipped_for_user_events():
    """User events are skipped entirely — no RAW for them either."""
    translator = EventTranslator(emit_raw_events=True)
    user_event = ADKEvent(
        timestamp=time.time(),
        author="user",
        invocation_id="inv_1",
        content=types.Content(role="user", parts=[types.Part(text="hi")]),
    )
    events = await _collect(translator, user_event)
    assert events == []
