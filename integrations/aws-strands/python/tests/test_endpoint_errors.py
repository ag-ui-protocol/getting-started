"""Failures raised mid-stream, after the response has already begun.

Once the endpoint has returned 200 and started streaming, the status code
is spent. A failure from here on can only be reported inside the stream, as
a RUN_ERROR frame. The `code` values are part of the wire contract and are
matched literally by clients.

Two behaviours here are Python-only: synthesizing a RUN_STARTED so an early
failure is not reported unattached, and suppressing a RUN_ERROR that would
contradict a run's own terminal frame. The Express adapter emits the error
frame unconditionally in both cases.
"""

from __future__ import annotations

from typing import Any, AsyncIterator

from fastapi import FastAPI
from fastapi.testclient import TestClient

from ag_ui.core import BaseEvent, EventType, RunErrorEvent, TextMessageStartEvent
from ag_ui_strands.endpoint import SSE_MEDIA_TYPE, add_strands_fastapi_endpoint

import asyncio

import httpx
import pytest

from ag_ui_strands import endpoint as endpoint_module

from tests.endpoint_helpers import (
    RUN_ID,
    THREAD_ID,
    valid_run_input,
    FakeAgent,
    run_finished,
    run_started,
    sse_payloads,
)


class ExplodingAgent:
    """Raises after streaming one event, escaping the agent's own error handling."""

    name = "exploding"

    def __init__(self, error: Exception) -> None:
        self._error = error

    async def run(self, input_data: Any) -> AsyncIterator[BaseEvent]:
        yield run_started()
        raise self._error


class UnencodableEvent:
    """Not a pydantic model, so the encoder fails when it reaches this."""

    type = "NOT_A_REAL_EVENT"


class FailsBeforeYielding:
    """Raises before producing any event at all."""

    name = "immediate"

    async def run(self, input_data: Any) -> AsyncIterator[BaseEvent]:
        raise RuntimeError("failed on entry")
        yield  # pragma: no cover - makes this an async generator


class FinishesThenRaises:
    """Completes its run, then fails during teardown."""

    name = "late"

    async def run(self, input_data: Any) -> AsyncIterator[BaseEvent]:
        yield run_started()
        yield run_finished()
        raise RuntimeError("failure after the run ended")


class TwoRunsThenRaises:
    """Completes one run, opens a second, then fails inside it."""

    name = "two-runs"

    async def run(self, input_data: Any) -> AsyncIterator[BaseEvent]:
        yield run_started()
        yield run_finished()
        yield run_started()
        raise RuntimeError("second run failed")


class ReportsErrorThenRaises:
    """Emits its own RUN_ERROR, then escapes as well."""

    name = "self-reporting"

    async def run(self, input_data: Any) -> AsyncIterator[BaseEvent]:
        yield run_started()
        yield RunErrorEvent(
            type=EventType.RUN_ERROR, message="handled", code="AGENT_CODE"
        )
        raise RuntimeError("and then escaped")


class RecordsCleanup:
    """Reports whether its finally block ran."""

    name = "records-cleanup"

    def __init__(self, events) -> None:
        self._events = list(events)
        self.cleaned_up = False

    async def run(self, input_data: Any) -> AsyncIterator[BaseEvent]:
        try:
            for event in self._events:
                yield event
        finally:
            self.cleaned_up = True


class CleanupRaisesOnClose:
    """Streams past an unencodable event, then fails while being closed.

    The endpoint breaks out on the encoding failure, leaving this suspended,
    so closing it is what runs the finally.
    """

    name = "cleanup-raises"

    async def run(self, input_data: Any) -> AsyncIterator[BaseEvent]:
        try:
            yield run_started()
            yield UnencodableEvent()
            yield run_finished()
        finally:
            raise RuntimeError("cleanup failed")


class FinishesWithoutStarting:
    """Reports a terminal frame with no RUN_STARTED, then raises."""

    name = "finishes-only"

    async def run(self, input_data: Any) -> AsyncIterator[BaseEvent]:
        yield run_finished()
        raise RuntimeError("after the terminal frame")


class NotAGenerator:
    """An async iterable that is not an async generator, so it has no aclose."""

    name = "plain-iterable"

    def run(self, input_data: Any):
        events = [run_started(), run_finished()]

        class _Iterator:
            def __aiter__(self):
                return self

            async def __anext__(self):
                if not events:
                    raise StopAsyncIteration
                return events.pop(0)

        return _Iterator()


class EncoderFailingOn:
    """Encodes everything except the event types it was told to reject."""

    rejected: tuple[str, ...] = ()

    def __init__(self, accept: str | None = None) -> None:
        pass

    def get_content_type(self) -> str:
        return SSE_MEDIA_TYPE

    def encode(self, event) -> str:
        if getattr(event, "type", None) in type(self).rejected:
            raise RuntimeError("cannot encode this type")
        return f"data: {event.model_dump_json(by_alias=True, exclude_none=True)}\n\n"


class RaisesOnRun:
    """Fails synchronously when `run` is called, before any iteration."""

    name = "raises-on-run"

    def run(self, input_data: Any):
        raise RuntimeError("could not start")


class RetainingWrapperAgent:
    """`run` returns a wrapper that builds, and keeps, its own generator.

    Holding the reference is what makes this meaningful: without it CPython
    would close the abandoned generator by refcounting and hide whether the
    endpoint closed it deliberately.
    """

    name = "retaining-wrapper"

    def __init__(self, events) -> None:
        self._events = list(events)
        self.cleaned_up = False
        self._generator = None

    def run(self, input_data: Any):
        outer = self

        class _Iterable:
            def __aiter__(self):
                async def _gen():
                    try:
                        for event in outer._events:
                            yield event
                    finally:
                        outer.cleaned_up = True

                outer._generator = _gen()
                return outer._generator

        return _Iterable()


class UnprintableError(Exception):
    """An exception whose str() raises, as a __str__ override can."""

    def __str__(self) -> str:
        raise RuntimeError("cannot render this exception")


class CleanupCancels:
    """Fails to encode, then raises CancelledError while being closed."""

    name = "cleanup-cancels"

    async def run(self, input_data: Any) -> AsyncIterator[BaseEvent]:
        try:
            yield run_started()
            yield UnencodableEvent()
        finally:
            raise asyncio.CancelledError()


class BrokenEncoder:
    """Refuses to encode anything, including the frames reporting failure."""

    def __init__(self, accept: str | None = None) -> None:
        pass

    def get_content_type(self) -> str:
        return SSE_MEDIA_TYPE

    def encode(self, event) -> str:
        raise RuntimeError("encoder is broken")


def _client(agent: Any) -> TestClient:
    app = FastAPI()
    add_strands_fastapi_endpoint(app, agent, "/")
    return TestClient(app)


def test_an_agent_error_mid_stream_becomes_a_run_error_frame() -> None:
    response = _client(ExplodingAgent(RuntimeError("agent exploded"))).post(
        "/", json=valid_run_input()
    )

    assert response.status_code == 200
    frames = sse_payloads(response.text)
    assert [f["type"] for f in frames] == [EventType.RUN_STARTED, EventType.RUN_ERROR]
    assert frames[-1]["code"] == "STRANDS_ERROR"
    assert frames[-1]["message"] == "agent exploded"


def test_events_streamed_before_an_agent_error_still_reach_the_client() -> None:
    response = _client(ExplodingAgent(ValueError("late failure"))).post(
        "/", json=valid_run_input()
    )

    frames = sse_payloads(response.text)
    assert frames[0]["type"] == EventType.RUN_STARTED
    assert frames[-1]["type"] == EventType.RUN_ERROR
    assert frames[-1]["message"] == "late failure"


def test_an_encoding_failure_becomes_a_run_error_frame_and_ends_the_stream() -> None:
    agent = FakeAgent([run_started(), UnencodableEvent(), run_started()])

    response = _client(agent).post("/", json=valid_run_input())

    frames = sse_payloads(response.text)
    assert [f["type"] for f in frames] == [EventType.RUN_STARTED, EventType.RUN_ERROR]
    assert frames[-1]["code"] == "ENCODING_ERROR"
    assert frames[-1]["message"].startswith("Encoding error: ")


def test_the_stream_stops_at_the_first_encoding_failure() -> None:
    """Events after the unencodable one are not delivered."""
    agent = FakeAgent(
        [run_started(run_id="before"), UnencodableEvent(), run_started(run_id="after")]
    )

    response = _client(agent).post("/", json=valid_run_input())

    run_ids = [f.get("runId") for f in sse_payloads(response.text)]
    assert "before" in run_ids
    assert "after" not in run_ids


def test_a_failure_before_the_first_event_still_opens_the_run() -> None:
    """RUN_ERROR belongs inside a run, so a bare one would be unattached."""
    response = _client(FailsBeforeYielding()).post("/", json=valid_run_input())

    frames = sse_payloads(response.text)
    assert [f["type"] for f in frames] == [EventType.RUN_STARTED, EventType.RUN_ERROR]
    assert frames[0]["threadId"] == THREAD_ID
    assert frames[0]["runId"] == RUN_ID
    assert frames[-1]["code"] == "STRANDS_ERROR"


def test_no_run_error_is_appended_after_the_run_already_finished() -> None:
    """A trailing RUN_ERROR would contradict the RUN_FINISHED just sent."""
    response = _client(FinishesThenRaises()).post("/", json=valid_run_input())

    assert [f["type"] for f in sse_payloads(response.text)] == [
        EventType.RUN_STARTED,
        EventType.RUN_FINISHED,
    ]


def test_an_encoder_that_cannot_report_the_failure_ends_the_stream_quietly(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The error frame must not raise its way out and abort the response body."""
    monkeypatch.setattr(endpoint_module, "EventEncoder", BrokenEncoder)

    response = _client(FakeAgent([run_started()])).post("/", json=valid_run_input())

    assert response.status_code == 200
    assert response.text == ""


def test_a_failure_in_a_later_run_of_the_stream_still_reports() -> None:
    """Each RUN_STARTED reopens, so an earlier run's completion cannot mute this."""
    response = _client(TwoRunsThenRaises()).post("/", json=valid_run_input())

    assert [f["type"] for f in sse_payloads(response.text)] == [
        EventType.RUN_STARTED,
        EventType.RUN_FINISHED,
        EventType.RUN_STARTED,
        EventType.RUN_ERROR,
    ]


def test_an_agent_that_reported_its_own_error_is_not_given_a_second_one() -> None:
    """RUN_ERROR ends the run, so appending another would contradict it."""
    response = _client(ReportsErrorThenRaises()).post("/", json=valid_run_input())

    frames = sse_payloads(response.text)
    assert [f["type"] for f in frames] == [EventType.RUN_STARTED, EventType.RUN_ERROR]
    assert frames[-1]["code"] == "AGENT_CODE"


def test_the_agent_is_closed_when_an_encoding_failure_abandons_the_stream() -> None:
    """Breaking out of the loop must not leave the agent suspended."""
    agent = RecordsCleanup([run_started(), UnencodableEvent(), run_started()])

    _client(agent).post("/", json=valid_run_input())

    assert agent.cleaned_up


def test_the_agent_is_closed_after_a_normal_run() -> None:
    agent = RecordsCleanup([run_started(), run_finished()])

    _client(agent).post("/", json=valid_run_input())

    assert agent.cleaned_up


def test_a_throwing_agent_cleanup_does_not_swallow_the_error_frame() -> None:
    """Closing the agent must not abort the body before the failure is reported."""
    response = _client(CleanupRaisesOnClose()).post("/", json=valid_run_input())

    frames = sse_payloads(response.text)
    assert [f["type"] for f in frames] == [EventType.RUN_STARTED, EventType.RUN_ERROR]
    assert frames[-1]["code"] == "ENCODING_ERROR"


def test_no_error_frame_when_its_opening_run_started_cannot_be_encoded(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An unattached RUN_ERROR is worse than silence, so emit neither."""

    class RejectsRunStarted(EncoderFailingOn):
        rejected = (EventType.RUN_STARTED,)

    monkeypatch.setattr(endpoint_module, "EventEncoder", RejectsRunStarted)

    response = _client(FailsBeforeYielding()).post("/", json=valid_run_input())

    assert response.status_code == 200
    assert response.text == ""


def test_no_run_error_after_a_terminal_frame_that_had_no_run_started() -> None:
    """The suppression keys on the terminal frame, not on having seen a start."""
    response = _client(FinishesWithoutStarting()).post("/", json=valid_run_input())

    assert [f["type"] for f in sse_payloads(response.text)] == [
        EventType.RUN_FINISHED
    ]


def test_an_agent_returning_a_plain_async_iterable_is_streamed() -> None:
    """`run` is typed as an AsyncIterator, which need not offer aclose."""
    response = _client(NotAGenerator()).post("/", json=valid_run_input())

    assert response.status_code == 200
    assert [f["type"] for f in sse_payloads(response.text)] == [
        EventType.RUN_STARTED,
        EventType.RUN_FINISHED,
    ]


def test_an_agent_that_fails_to_start_still_reports_in_the_body() -> None:
    """Headers are committed by then, so a 500 is no longer available."""
    response = _client(RaisesOnRun()).post("/", json=valid_run_input())

    assert response.status_code == 200
    frames = sse_payloads(response.text)
    assert [f["type"] for f in frames] == [EventType.RUN_STARTED, EventType.RUN_ERROR]
    assert frames[-1]["code"] == "STRANDS_ERROR"
    assert frames[-1]["message"] == "could not start"


async def test_the_iterator_is_closed_when_its_iterable_is_a_wrapper() -> None:
    """Closing the iterable would miss a generator its __aiter__ created.

    Driven through ASGI on the running loop rather than TestClient, whose
    per-request loop teardown closes stray generators itself and would mask
    the difference.
    """
    agent = RetainingWrapperAgent([run_started(), UnencodableEvent(), run_finished()])
    app = FastAPI()
    add_strands_fastapi_endpoint(app, agent, "/")

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post("/", json=valid_run_input())
        assert response.status_code == 200

    assert agent.cleaned_up


def test_no_opening_frame_when_the_error_frame_cannot_be_encoded(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A run opened and never terminated is worse than silence, so emit neither."""

    class RejectsRunError(EncoderFailingOn):
        rejected = (EventType.RUN_ERROR,)

    monkeypatch.setattr(endpoint_module, "EventEncoder", RejectsRunError)

    response = _client(FailsBeforeYielding()).post("/", json=valid_run_input())

    assert response.status_code == 200
    assert response.text == ""


class ScriptedThenRaises:
    """Emits a lifecycle prefix, then fails."""

    name = "scripted"

    def __init__(self, events) -> None:
        self._events = list(events)

    async def run(self, input_data: Any) -> AsyncIterator[BaseEvent]:
        for event in self._events:
            yield event
        raise RuntimeError("boom")


def _run_error() -> BaseEvent:
    return RunErrorEvent(
        type=EventType.RUN_ERROR, message="handled", code="AGENT_CODE"
    )


# Whether a failure earns a terminal frame depends only on whether a run is
# open when it lands. Enumerated rather than sampled, because every previous
# round of review found another combination this logic got wrong.
@pytest.mark.parametrize(
    "prefix, expected",
    [
        pytest.param([], [EventType.RUN_STARTED, EventType.RUN_ERROR], id="nothing-yet"),
        pytest.param(
            [run_started()],
            [EventType.RUN_STARTED, EventType.RUN_ERROR],
            id="run-open",
        ),
        pytest.param(
            [run_started(), run_finished()],
            [EventType.RUN_STARTED, EventType.RUN_FINISHED],
            id="run-closed-by-finished",
        ),
        pytest.param(
            [run_started(), _run_error()],
            [EventType.RUN_STARTED, EventType.RUN_ERROR],
            id="run-closed-by-error",
        ),
        pytest.param(
            [run_finished()],
            [EventType.RUN_FINISHED],
            id="terminal-without-start",
        ),
        pytest.param(
            [run_started(), run_finished(), run_started()],
            [
                EventType.RUN_STARTED,
                EventType.RUN_FINISHED,
                EventType.RUN_STARTED,
                EventType.RUN_ERROR,
            ],
            id="second-run-open",
        ),
        pytest.param(
            [
                TextMessageStartEvent(
                    type=EventType.TEXT_MESSAGE_START, message_id="m", role="assistant"
                )
            ],
            [EventType.TEXT_MESSAGE_START, EventType.RUN_ERROR],
            id="content-without-a-start",
        ),
        pytest.param(
            [run_started(), run_finished(), run_started(), run_finished()],
            [
                EventType.RUN_STARTED,
                EventType.RUN_FINISHED,
                EventType.RUN_STARTED,
                EventType.RUN_FINISHED,
            ],
            id="second-run-closed",
        ),
    ],
)
def test_terminal_frame_decision_table(prefix, expected) -> None:
    response = _client(ScriptedThenRaises(prefix)).post("/", json=valid_run_input())

    assert [f["type"] for f in sse_payloads(response.text)] == expected


def test_an_exception_that_cannot_be_rendered_still_produces_a_frame() -> None:
    """Describing the failure must not become a second failure."""
    response = _client(ExplodingAgent(UnprintableError())).post(
        "/", json=valid_run_input()
    )

    frames = sse_payloads(response.text)
    assert [f["type"] for f in frames] == [EventType.RUN_STARTED, EventType.RUN_ERROR]
    assert frames[-1]["code"] == "STRANDS_ERROR"
    assert frames[-1]["message"] == "UnprintableError"


def test_cancellation_from_the_agents_teardown_is_not_swallowed() -> None:
    """Widening the close handler to BaseException would keep streaming.

    A cancelled teardown means the run is going away, so it has to end the
    response rather than be caught and answered with an error frame.
    """
    response = _client(CleanupCancels()).post("/", json=valid_run_input())

    assert b"RUN_ERROR" not in response.content
