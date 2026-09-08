"""End-to-end test of the FastAPI endpoint helper over ASGI (no network)."""

import json

import httpx
from fastapi import FastAPI

from ag_ui_claude_managed_agents import (
    ManagedAgentsAgent,
    add_managed_agents_fastapi_endpoint,
)

from .fake_client import FakeClient

IDLE_END_TURN = {
    "type": "session.status_idle",
    "id": "idle_1",
    "stop_reason": {"type": "end_turn"},
}


def make_app(fake: FakeClient) -> FastAPI:
    app = FastAPI()
    agent = ManagedAgentsAgent(
        managed_agent_id="agent_1", environment_id="env_1", client=fake
    )  # type: ignore[arg-type]
    add_managed_agents_fastapi_endpoint(app=app, agent=agent, path="/agentic_chat")
    return app


def parse_sse(body: str) -> list[dict]:
    return [
        json.loads(line[len("data: ") :])
        for line in body.splitlines()
        if line.startswith("data: ")
    ]


async def test_streams_encoded_events_and_serves_health():
    fake = FakeClient(
        streams=[
            [
                {
                    "type": "agent.message",
                    "id": "msg_1",
                    "content": [{"type": "text", "text": "Hi!"}],
                },
                IDLE_END_TURN,
            ]
        ]
    )
    transport = httpx.ASGITransport(app=make_app(fake))
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        health = await client.get("/agentic_chat/health")
        # A liveness probe and nothing else: the managed agent id is an internal
        # identifier and this route is as reachable as the endpoint itself.
        assert health.json() == {"status": "ok"}

        payload = {
            "threadId": "thread_1",
            "runId": "run_1",
            "state": {},
            "messages": [{"id": "u1", "role": "user", "content": "Hello"}],
            "tools": [],
            "context": [],
            "forwardedProps": {},
        }
        response = await client.post(
            "/agentic_chat", json=payload, headers={"accept": "text/event-stream"}
        )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    types = [event["type"] for event in parse_sse(response.text)]
    assert types == [
        "RUN_STARTED",
        "STATE_SNAPSHOT",
        "CUSTOM",
        "TEXT_MESSAGE_START",
        "TEXT_MESSAGE_CONTENT",
        "TEXT_MESSAGE_END",
        "RUN_FINISHED",
    ]


async def test_health_route_is_well_formed_when_mounted_at_root():
    app = FastAPI()
    agent = ManagedAgentsAgent(
        managed_agent_id="agent_1", environment_id="env_1", client=FakeClient()
    )  # type: ignore[arg-type]
    add_managed_agents_fastapi_endpoint(app=app, agent=agent)  # default path "/"
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        health = await client.get("/health")
    assert health.status_code == 200
    assert health.json() == {"status": "ok"}
