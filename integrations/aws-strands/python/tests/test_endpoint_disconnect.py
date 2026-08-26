"""Client disconnect part-way through a stream.

When a client goes away mid-run the agent generator must be closed so its
`finally` block runs and releases whatever the run holds: proxy tools
registered on the shared Strands registry, session-manager handles, and any
per-thread bookkeeping the agent set up on entry. Nothing in the response
reveals a leak, so this runs against a real server over a real socket.
`TestClient` never closes a connection early, so it cannot exercise it.

The endpoint has no disconnect handling of its own, and its own call to
close the agent is never reached on this path. Starlette cancels the task
running the response body; `CancelledError` and `GeneratorExit` derive from
`BaseException`, so none of the `except Exception` arms in
`event_generator` intercept them, and the runtime tears the whole chain
down. A refactor that puts the agent behind a queue or a background task
would sever that silently, which is the mutation these were verified
against.

Two of those arms are pinned against being widened to `BaseException`:
the one around the agent's own iteration, here, and the one around its
teardown, in test_endpoint_errors.py. The remaining arms are narrower and
unpinned.

What these assert is that the agent's cleanup is *entered*. They cannot
assert it completes: the cancellation is already in flight, so a teardown
that awaits is cut short at its first await, and whatever it releases after
that point is not released. That is pre-existing and unchanged here.
"""

from __future__ import annotations

import asyncio
import json
import threading
import time
from typing import Any, AsyncIterator, Iterator

import httpx
import pytest
import uvicorn
from fastapi import FastAPI

from ag_ui.core import BaseEvent
from ag_ui_strands.endpoint import add_strands_fastapi_endpoint

from tests.endpoint_helpers import valid_run_input, run_started

CLEANUP_TIMEOUT_SECONDS = 10
SERVER_START_TIMEOUT_SECONDS = 10
SERVER_STOP_TIMEOUT_SECONDS = 10
REQUEST_TIMEOUT_SECONDS = 10


class NeverEndingAgent:
    """Streams until it is closed, recording that its cleanup ran."""

    name = "never-ending"

    def __init__(self) -> None:
        self.first_event_sent = threading.Event()
        self.cleanup_ran = threading.Event()

    async def run(self, input_data: Any) -> AsyncIterator[BaseEvent]:
        try:
            while True:
                # Set before yielding: after the yield this line only runs
                # once the consumer asks for the next event, which a client
                # that reads one frame and leaves never does.
                self.first_event_sent.set()
                yield run_started()
                await asyncio.sleep(0.02)
        finally:
            self.cleanup_ran.set()


class AwaitingTeardownAgent:
    """Streams forever, and awaits during its own cleanup.

    The await is the point: releasing anything real (closing a session,
    unregistering proxy tools) is asynchronous, so a teardown that cannot
    await is a teardown that cannot release.
    """

    name = "awaiting-teardown"

    def __init__(self) -> None:
        self.cleanup_entered = threading.Event()
        self.cleanup_completed = threading.Event()

    async def run(self, input_data: Any) -> AsyncIterator[BaseEvent]:
        try:
            while True:
                yield run_started()
                await asyncio.sleep(0.02)
        finally:
            self.cleanup_entered.set()
            await asyncio.sleep(0.05)
            self.cleanup_completed.set()


class BlockedStepAgent:
    """Streams one frame, then blocks forever waiting for something.

    A long model call that never returns looks exactly like this. The step
    the endpoint is waiting on never settles, so anything that waits for it
    before closing the agent waits forever, and the run leaks.
    """

    name = "blocked-step"

    def __init__(self) -> None:
        self.blocked = threading.Event()
        self.cleanup_entered = threading.Event()
        self.cleanup_completed = threading.Event()

    async def run(self, input_data: Any) -> AsyncIterator[BaseEvent]:
        try:
            yield run_started()
            self.blocked.set()
            await asyncio.Event().wait()
        finally:
            self.cleanup_entered.set()
            await asyncio.sleep(0.05)
            self.cleanup_completed.set()


@pytest.fixture
def blocked_step_server() -> Iterator[tuple[BlockedStepAgent, str]]:
    yield from _serve(BlockedStepAgent())


def test_a_blocked_step_does_not_keep_the_agent_open_after_a_disconnect(
    blocked_step_server,
) -> None:
    """Waiting for a step that never settles never gets to the close.

    The agent has to be cancelled for its teardown to start at all, and that
    cancellation has to come from outside the request's own scope so the
    teardown can still await.
    """
    agent, url = blocked_step_server

    _abandon_stream_after_first_frame(url)
    assert agent.blocked.wait(CLEANUP_TIMEOUT_SECONDS), "agent never reached its block"

    assert agent.cleanup_entered.wait(CLEANUP_TIMEOUT_SECONDS), (
        "the agent was never closed, so its teardown never started and the run "
        "leaked for as long as the step stayed blocked"
    )
    assert agent.cleanup_completed.wait(CLEANUP_TIMEOUT_SECONDS), (
        "the teardown started but could not finish awaiting"
    )


def _serve(agent: Any) -> Iterator[tuple[Any, str]]:
    app = FastAPI()
    add_strands_fastapi_endpoint(app, agent, "/")
    server = uvicorn.Server(
        uvicorn.Config(app, host="127.0.0.1", port=0, log_level="error")
    )
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    try:
        deadline = time.monotonic() + SERVER_START_TIMEOUT_SECONDS
        while not server.started:
            if not thread.is_alive():
                raise RuntimeError("uvicorn exited before it finished starting")
            if time.monotonic() > deadline:
                raise RuntimeError("uvicorn did not start within the timeout")
            time.sleep(0.02)
        port = server.servers[0].sockets[0].getsockname()[1]
        yield agent, f"http://127.0.0.1:{port}/"
    finally:
        server.should_exit = True
        thread.join(timeout=SERVER_STOP_TIMEOUT_SECONDS)
        assert not thread.is_alive(), "uvicorn thread outlived its shutdown"


@pytest.fixture
def awaiting_teardown_server() -> Iterator[tuple[AwaitingTeardownAgent, str]]:
    yield from _serve(AwaitingTeardownAgent())


def test_an_awaiting_teardown_runs_to_completion_after_a_disconnect(
    awaiting_teardown_server,
) -> None:
    """Entering cleanup is not enough; it has to be able to finish.

    Awaited directly, the agent is cancelled at its own await, its teardown
    starts, and the first await inside that teardown is cancelled as well, so
    anything released after that point leaks with nothing raised to catch.
    """
    agent, url = awaiting_teardown_server

    _abandon_stream_after_first_frame(url)

    assert agent.cleanup_entered.wait(CLEANUP_TIMEOUT_SECONDS)
    assert agent.cleanup_completed.wait(CLEANUP_TIMEOUT_SECONDS), (
        "the agent's teardown was cut short at its first await, so whatever it "
        "releases after that point was never released"
    )


@pytest.fixture
def live_server() -> Iterator[tuple[NeverEndingAgent, str]]:
    """Run the endpoint on a real uvicorn server bound to an ephemeral port."""
    agent = NeverEndingAgent()
    app = FastAPI()
    add_strands_fastapi_endpoint(app, agent, "/")

    server = uvicorn.Server(
        uvicorn.Config(app, host="127.0.0.1", port=0, log_level="error")
    )
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    try:
        deadline = time.monotonic() + SERVER_START_TIMEOUT_SECONDS
        while not server.started:
            if not thread.is_alive():
                raise RuntimeError("uvicorn exited before it finished starting")
            if time.monotonic() > deadline:
                raise RuntimeError("uvicorn did not start within the timeout")
            time.sleep(0.02)

        port = server.servers[0].sockets[0].getsockname()[1]
        yield agent, f"http://127.0.0.1:{port}/"
    finally:
        # Inside the try, so a startup failure still stops the thread.
        server.should_exit = True
        thread.join(timeout=SERVER_STOP_TIMEOUT_SECONDS)
        assert not thread.is_alive(), "uvicorn thread outlived its shutdown"


def _abandon_stream_after_first_frame(url: str) -> None:
    async def drive() -> None:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS) as client:
            async with client.stream("POST", url, json=valid_run_input()) as response:
                assert response.status_code == 200
                async for line in response.aiter_lines():
                    if line.startswith("data: "):
                        break

    asyncio.run(drive())


def test_client_disconnect_closes_the_agent_generator(live_server) -> None:
    agent, url = live_server

    _abandon_stream_after_first_frame(url)

    assert agent.cleanup_ran.wait(CLEANUP_TIMEOUT_SECONDS), (
        "agent generator was never closed after the client disconnected, "
        "so its finally block never released the run"
    )


def test_the_agent_really_started_before_the_disconnect(live_server) -> None:
    """Guards the test above: cleanup must follow a run that actually began."""
    agent, url = live_server

    _abandon_stream_after_first_frame(url)

    assert agent.first_event_sent.is_set()


async def test_a_disconnect_is_never_turned_into_a_run_error() -> None:
    """Widening any handler to BaseException would catch the disconnect itself.

    The endpoint would then answer a departed client with an error frame
    rather than letting the teardown propagate. Driven through ASGI directly,
    delivering a real `http.disconnect`, so the frames the endpoint emits
    stay observable after the client is gone.
    """
    agent = NeverEndingAgent()
    app = FastAPI()
    add_strands_fastapi_endpoint(app, agent, "/")

    body = json.dumps(valid_run_input()).encode()
    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.1"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": "/",
        "raw_path": b"/",
        "query_string": b"",
        "root_path": "",
        "headers": [
            (b"host", b"testserver"),
            (b"content-type", b"application/json"),
            (b"content-length", str(len(body)).encode()),
        ],
        "client": ("127.0.0.1", 1234),
        "server": ("testserver", 80),
    }
    sent: list[dict] = []
    delivered_request = False

    async def receive() -> dict:
        nonlocal delivered_request
        if not delivered_request:
            delivered_request = True
            return {"type": "http.request", "body": body, "more_body": False}
        # Let the run stream a little, then drop the client.
        await asyncio.sleep(0.1)
        return {"type": "http.disconnect"}

    async def send(message: dict) -> None:
        sent.append(message)

    await asyncio.wait_for(app(scope, receive, send), timeout=REQUEST_TIMEOUT_SECONDS)

    # The close runs on a task deliberately detached from the cancelled scope,
    # so it settles just after the response ends rather than during it.
    deadline = time.monotonic() + CLEANUP_TIMEOUT_SECONDS
    while not agent.cleanup_ran.is_set() and time.monotonic() < deadline:
        await asyncio.sleep(0.01)
    assert agent.cleanup_ran.is_set()
    streamed = b"".join(
        m.get("body", b"") for m in sent if m["type"] == "http.response.body"
    )
    assert b"RUN_STARTED" in streamed
    assert b"RUN_ERROR" not in streamed


def test_the_server_still_serves_requests_after_a_disconnect(live_server) -> None:
    agent, url = live_server

    _abandon_stream_after_first_frame(url)
    assert agent.cleanup_ran.wait(CLEANUP_TIMEOUT_SECONDS)

    with httpx.Client(timeout=REQUEST_TIMEOUT_SECONDS) as client:
        with client.stream("POST", url, json=valid_run_input()) as response:
            assert response.status_code == 200
            for line in response.iter_lines():
                if line.startswith("data: "):
                    break
