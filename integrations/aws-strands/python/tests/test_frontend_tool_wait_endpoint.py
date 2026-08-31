"""HTTP contract for frontend tools, waiting and not.

Three shapes share the frontend-tool channel and must stay distinguishable:

* a plain action the client runs and never answers (change a background, draw a
  card) — the run must not wait for a reply that will never come;
* a human-in-the-loop tool the client answers with a ``ToolMessage`` — the run
  waits, then continues from that answer;
* an interrupt, where the agent itself pauses — that one is a
  ``RunFinishedInterruptOutcome`` and lives in the interrupt tests.

The first two both close the run successfully. Neither may report an interrupt
outcome: a client with a generic interrupt handler would otherwise fire it on a
tool card it does not own.
"""

from __future__ import annotations

import copy
import json
from typing import Any

import httpx
import pytest
from ag_ui.core import RunAgentInput, Tool, ToolMessage, UserMessage
from strands import Agent
from strands.models.model import Model

from ag_ui_strands import create_strands_app
from ag_ui_strands.agent import StrandsAgent
from ag_ui_strands.config import StrandsAgentConfig, ToolBehavior


class _WaitingToolModel(Model):
    """Emit one deterministic frontend tool call, then continue from its result."""

    def __init__(self) -> None:
        self.calls = 0
        self.seen_messages: list[list[dict[str, Any]]] = []

    def get_config(self):
        return {}

    def update_config(self, **kwargs):
        pass

    async def structured_output(
        self, output_model, prompt, **kwargs
    ):  # pragma: no cover
        if False:
            yield {}

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs):
        self.calls += 1
        self.seen_messages.append(copy.deepcopy(messages))
        yield {"messageStart": {"role": "assistant"}}
        if self.calls == 1:
            yield {
                "contentBlockStart": {
                    "start": {
                        "toolUse": {
                            "toolUseId": "native-client-wait",
                            "name": "client_wait",
                        }
                    }
                }
            }
            yield {
                "contentBlockDelta": {
                    "delta": {"toolUse": {"input": '{"value":"requested"}'}}
                }
            }
            yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "tool_use"}}
            return
        yield {"contentBlockDelta": {"delta": {"text": "continued"}}}
        yield {"contentBlockStop": {}}
        yield {"messageStop": {"stopReason": "end_turn"}}


def _input(*, run_id: str, messages: list[Any]) -> RunAgentInput:
    return RunAgentInput(
        thread_id="client-contract-thread",
        run_id=run_id,
        state={},
        messages=messages,
        tools=[
            Tool(
                name="client_wait",
                description="Wait for the client",
                parameters={
                    "type": "object",
                    "properties": {"value": {"type": "string"}},
                },
            )
        ],
        context=[],
        forwarded_props={},
    )


def _decode_sse(body: str) -> list[dict[str, Any]]:
    return [
        json.loads(line.removeprefix("data: "))
        for line in body.splitlines()
        if line.startswith("data: ")
    ]


async def _post(app: Any, input_data: RunAgentInput) -> list[dict[str, Any]]:
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        response = await client.post(
            "/agent",
            json=input_data.model_dump(mode="json", by_alias=True, exclude_none=True),
            headers={"accept": "text/event-stream"},
        )
    assert response.status_code == 200
    return _decode_sse(response.text)


@pytest.mark.asyncio
async def test_false_mode_preserves_tool_message_endpoint_contract() -> None:
    model = _WaitingToolModel()
    adapter = StrandsAgent(
        Agent(model=model, tools=[]),
        name="client-contract",
        config=StrandsAgentConfig(
            tool_behaviors={
                "client_wait": ToolBehavior(continue_after_frontend_call=False)
            }
        ),
    )
    app = create_strands_app(adapter, path="/agent", ping_path=None)

    first = await _post(
        app,
        _input(
            run_id="run-1",
            messages=[UserMessage(id="user-1", content="use the client tool")],
        ),
    )

    first_types = [event["type"] for event in first]
    assert first_types.count("TOOL_CALL_START") == 1
    assert first_types.count("TOOL_CALL_ARGS") == 1
    assert first_types.count("TOOL_CALL_END") == 1
    assert not any(event["type"] == "TOOL_CALL_RESULT" for event in first)
    first_finished = next(event for event in first if event["type"] == "RUN_FINISHED")
    assert first_finished["outcome"] == {"type": "success"}
    tool_call_id = next(
        event["toolCallId"] for event in first if event["type"] == "TOOL_CALL_START"
    )
    assert tool_call_id == "native-client-wait"

    second = await _post(
        app,
        _input(
            run_id="run-2",
            messages=[
                ToolMessage(
                    id="client-result",
                    tool_call_id=tool_call_id,
                    content='{"accepted":true}',
                )
            ],
        ),
    )

    assert model.calls == 2
    assert any(event.get("delta") == "continued" for event in second)
    assert not any(event["type"] == "TOOL_CALL_START" for event in second)
    assert not any(event["type"] == "TOOL_CALL_RESULT" for event in second)
    second_finished = next(
        event for event in second if event["type"] == "RUN_FINISHED"
    )
    assert second_finished["outcome"] == {"type": "success"}
    assert "{\"accepted\":true}" in repr(model.seen_messages[-1])


@pytest.mark.asyncio
async def test_plain_action_tool_does_not_wait_for_an_answer() -> None:
    """An unconfigured frontend tool is a plain action, so the run cannot park.

    Nothing in the tool definition says whether the client will answer, so
    waiting stays opt-in. A plain action that never answers would otherwise
    leave the thread parked and every later message would be refused.
    """
    model = _WaitingToolModel()
    adapter = StrandsAgent(
        Agent(model=model, tools=[]),
        name="plain-action-contract",
        config=StrandsAgentConfig(),
    )
    app = create_strands_app(adapter, path="/agent", ping_path=None)

    events = await _post(
        app,
        _input(
            run_id="run-1",
            messages=[UserMessage(id="user-1", content="use the client tool")],
        ),
    )

    finished = next(event for event in events if event["type"] == "RUN_FINISHED")
    assert finished["outcome"] == {"type": "success"}

    core = adapter._agents_by_thread["client-contract-thread"]
    assert (
        getattr(getattr(core, "_interrupt_state", None), "activated", False) is not True
    ), "a plain action must leave no checkpoint for the next turn to trip over"


@pytest.mark.asyncio
async def test_a_waiting_tool_never_reports_an_interrupt_outcome() -> None:
    """A parked frontend tool is not the agent pausing, and must not say it is."""
    model = _WaitingToolModel()
    adapter = StrandsAgent(
        Agent(model=model, tools=[]),
        name="no-interrupt-contract",
        config=StrandsAgentConfig(
            tool_behaviors={
                "client_wait": ToolBehavior(continue_after_frontend_call=False)
            }
        ),
    )
    app = create_strands_app(adapter, path="/agent", ping_path=None)

    events = await _post(
        app,
        _input(
            run_id="run-1",
            messages=[UserMessage(id="user-1", content="use the client tool")],
        ),
    )

    assert not any(
        (event.get("outcome") or {}).get("type") == "interrupt" for event in events
    )
