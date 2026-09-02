"""Tests for ACTIVITY_* passthrough via ADK custom_metadata markers."""

import time

import pytest
from ag_ui.core import EventType
from google.adk.events import Event as ADKEvent
from google.genai import types

from ag_ui_adk.event_translator import (
    EventTranslator,
    ACTIVITY_METADATA_KEY,
    ACTIVITY_DELTA_METADATA_KEY,
)


def _event(custom_metadata=None, text="hi"):
    return ADKEvent(
        timestamp=time.time(),
        author="assistant",
        invocation_id="inv_1",
        content=types.Content(role="model", parts=[types.Part(text=text)]),
        custom_metadata=custom_metadata,
    )


async def _collect(adk_event):
    return [e async for e in EventTranslator().translate(adk_event, "t1", "r1")]


@pytest.mark.asyncio
async def test_no_activity_without_marker():
    events = await _collect(_event())
    assert all(
        e.type not in (EventType.ACTIVITY_SNAPSHOT, EventType.ACTIVITY_DELTA)
        for e in events
    )


@pytest.mark.asyncio
async def test_activity_snapshot_from_marker():
    md = {
        ACTIVITY_METADATA_KEY: {
            "message_id": "act_1",
            "activity_type": "web_search",
            "content": {"query": "AG-UI", "status": "running"},
        }
    }
    events = await _collect(_event(custom_metadata=md))
    snaps = [e for e in events if e.type == EventType.ACTIVITY_SNAPSHOT]
    assert len(snaps) == 1
    assert snaps[0].message_id == "act_1"
    assert snaps[0].activity_type == "web_search"
    assert snaps[0].content == {"query": "AG-UI", "status": "running"}
    # Activity precedes the translated text content.
    assert events[0].type == EventType.ACTIVITY_SNAPSHOT


@pytest.mark.asyncio
async def test_activity_delta_from_marker():
    md = {
        ACTIVITY_DELTA_METADATA_KEY: {
            "message_id": "act_1",
            "activity_type": "web_search",
            "patch": [{"op": "replace", "path": "/status", "value": "done"}],
        }
    }
    events = await _collect(_event(custom_metadata=md))
    deltas = [e for e in events if e.type == EventType.ACTIVITY_DELTA]
    assert len(deltas) == 1
    assert deltas[0].message_id == "act_1"
    assert deltas[0].patch[0]["op"] == "replace"


@pytest.mark.asyncio
async def test_list_of_activity_markers():
    md = {
        ACTIVITY_METADATA_KEY: [
            {"message_id": "a1", "activity_type": "search", "content": {}},
            {"message_id": "a2", "activity_type": "read", "content": {}},
        ]
    }
    events = await _collect(_event(custom_metadata=md))
    snaps = [e for e in events if e.type == EventType.ACTIVITY_SNAPSHOT]
    assert [s.message_id for s in snaps] == ["a1", "a2"]


@pytest.mark.asyncio
async def test_malformed_marker_is_skipped():
    md = {ACTIVITY_METADATA_KEY: {"content": {"x": 1}}}  # missing activity_type
    events = await _collect(_event(custom_metadata=md))
    assert all(e.type != EventType.ACTIVITY_SNAPSHOT for e in events)


@pytest.mark.asyncio
async def test_snapshot_gets_generated_id_when_absent():
    md = {ACTIVITY_METADATA_KEY: {"activity_type": "thinking", "content": {}}}
    events = await _collect(_event(custom_metadata=md))
    snaps = [e for e in events if e.type == EventType.ACTIVITY_SNAPSHOT]
    assert len(snaps) == 1 and snaps[0].message_id  # non-empty generated id
