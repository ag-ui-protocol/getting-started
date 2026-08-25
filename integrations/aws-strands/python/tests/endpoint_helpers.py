"""Shared fixtures for the HTTP-layer tests.

The endpoint helpers are the adapter's public transport surface, so these
tests drive them over real HTTP (`TestClient`, or a live uvicorn server
where a genuine socket close is needed) and assert on what a client can
observe: status codes, headers, and stream bytes.
"""

from __future__ import annotations

import json
from typing import Any, AsyncIterator, Iterable

from ag_ui.core import BaseEvent, EventType, RunFinishedEvent, RunStartedEvent

THREAD_ID = "test-thread"
RUN_ID = "test-run"


def valid_run_input(**overrides: Any) -> dict[str, Any]:
    """A RunAgentInput body that passes schema validation.

    Returned fresh each call so a test that mutates its body cannot leak
    that into another test.
    """
    body: dict[str, Any] = {
        "threadId": THREAD_ID,
        "runId": RUN_ID,
        "messages": [],
        "tools": [],
        "context": [],
        "state": {},
        "forwardedProps": {},
    }
    body.update(overrides)
    return body


def run_started(thread_id: str = THREAD_ID, run_id: str = RUN_ID) -> RunStartedEvent:
    return RunStartedEvent(type=EventType.RUN_STARTED, thread_id=thread_id, run_id=run_id)


def run_finished(thread_id: str = THREAD_ID, run_id: str = RUN_ID) -> RunFinishedEvent:
    return RunFinishedEvent(type=EventType.RUN_FINISHED, thread_id=thread_id, run_id=run_id)


class FakeAgent:
    """Stands in for `StrandsAgent`, yielding a fixed event script.

    Records the inputs it was handed so validation tests can assert the
    agent was never reached for a rejected request.
    """

    name = "fake"

    def __init__(self, events: Iterable[BaseEvent] | None = None) -> None:
        self._events = list(events) if events is not None else [run_started(), run_finished()]
        self.received: list[Any] = []

    async def run(self, input_data: Any) -> AsyncIterator[BaseEvent]:
        self.received.append(input_data)
        for event in self._events:
            yield event


def sse_payloads(body: str) -> list[dict[str, Any]]:
    """Parse an SSE response body into the decoded JSON of each frame.

    Raises on anything that is not a `data:` frame rather than skipping it,
    so a malformed stream fails the test that reads it instead of quietly
    shortening the list a negative assertion is counting.
    """
    payloads = []
    for chunk in body.split("\n\n"):
        if not chunk.strip():
            continue
        if not chunk.startswith("data: "):
            raise AssertionError(f"unexpected SSE frame: {chunk!r}")
        payloads.append(json.loads(chunk[len("data: "):]))
    return payloads
