"""A scripted stand-in for the Anthropic client's managed-agents surface.

Nothing here touches the network. Stream events are plain dicts shaped like
the SDK's session events; the adapter reads them through attribute-or-key
access, so dicts and models behave the same.
"""

import asyncio
from types import SimpleNamespace
from typing import Any

import anthropic
import httpx


class FakeAPIError(Exception):
    """Shaped like an SDK API error: carries an HTTP status code."""

    def __init__(self, status_code: int, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code


def parked_race_error() -> anthropic.BadRequestError:
    """The 400 the API returns for a user message posted while still parked.

    Built from the real SDK error class rather than a stand-in, so the retry
    matcher is exercised against the exception the default client actually
    raises (`status_code` + the body wording), not an invented shape.
    """
    body = {
        "type": "error",
        "error": {
            "type": "invalid_request_error",
            "message": "session is waiting on responses to events [ctu_1]",
        },
    }
    response = httpx.Response(
        400,
        request=httpx.Request("POST", "https://api.anthropic.com/v1/sessions/sesn_1/events"),
        json=body,
    )
    return anthropic.BadRequestError(
        "session is waiting on responses to events [ctu_1]", response=response, body=body
    )


class FakeStream:
    """An async-iterable of scripted events. An `asyncio.Event` entry blocks
    the stream until it is set (used to keep a run in flight); a `BaseException`
    entry is raised at that point (a mid-stream failure)."""

    def __init__(self, events: list[Any]) -> None:
        self._events = list(events)
        self.closed = False

    def __aiter__(self):
        return self._iterate()

    async def _iterate(self):
        for event in self._events:
            if self.closed:
                return
            if isinstance(event, asyncio.Event):
                await event.wait()
                continue
            if isinstance(event, BaseException):
                raise event
            yield event

    async def close(self) -> None:
        self.closed = True


class FakeClient:
    """`send_failures` maps a 0-based send attempt index to an exception that
    attempt raises (failed attempts are not recorded in `sent`). `create_gate`
    blocks session creation until it is set."""

    def __init__(
        self,
        *,
        streams: list[list[Any]] | None = None,
        agent_tools: list[Any] | None = None,
        session_id: str = "sesn_1",
        send_failures: dict[int, BaseException] | None = None,
        create_gate: asyncio.Event | None = None,
        create_error: BaseException | None = None,
    ) -> None:
        self._streams = list(streams or [])
        self.agent_tools = (
            agent_tools
            if agent_tools is not None
            else [
                {"type": "agent_toolset_20260401", "configs": [], "default_config": {}}
            ]
        )
        self.session_id = session_id
        self.send_failures = dict(send_failures or {})
        self.send_attempts = 0
        self.create_gate = create_gate
        self.create_error = create_error
        self.sent: list[dict[str, Any]] = []
        self.create_calls: list[dict[str, Any]] = []
        self.update_calls: list[tuple[str, dict[str, Any]]] = []
        self.retrieve_calls: list[tuple[str, dict[str, Any]]] = []
        self.stream_calls: list[tuple[str, dict[str, Any]]] = []
        self.streams_opened: list[FakeStream] = []

        events = SimpleNamespace(stream=self._stream, send=self._send)
        self.beta = SimpleNamespace(
            agents=SimpleNamespace(retrieve=self._retrieve),
            sessions=SimpleNamespace(
                create=self._create, update=self._update, events=events
            ),
        )

    async def _stream(self, session_id: str, **kwargs: Any) -> FakeStream:
        self.stream_calls.append((session_id, kwargs))
        events = self._streams.pop(0) if self._streams else []
        stream = FakeStream(events)
        self.streams_opened.append(stream)
        return stream

    async def _send(self, session_id: str, *, events: list[Any]) -> SimpleNamespace:
        attempt = self.send_attempts
        self.send_attempts += 1
        failure = self.send_failures.get(attempt)
        if failure is not None:
            raise failure
        self.sent.append({"session_id": session_id, "events": list(events)})
        return SimpleNamespace(data=[])

    async def _create(self, **kwargs: Any) -> SimpleNamespace:
        self.create_calls.append(kwargs)
        if self.create_gate is not None:
            await self.create_gate.wait()
        if self.create_error is not None:
            raise self.create_error
        return SimpleNamespace(id=self.session_id)

    async def _update(self, session_id: str, **kwargs: Any) -> SimpleNamespace:
        self.update_calls.append((session_id, kwargs))
        return SimpleNamespace(id=session_id)

    async def _retrieve(self, agent_id: str, **kwargs: Any) -> SimpleNamespace:
        self.retrieve_calls.append((agent_id, kwargs))
        return SimpleNamespace(tools=self.agent_tools)
