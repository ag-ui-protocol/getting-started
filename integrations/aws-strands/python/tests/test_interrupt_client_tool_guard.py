"""Regression coverage for interrupt_on_call on client-provided proxy tools."""

from __future__ import annotations

import logging

import pytest
from ag_ui.core import EventType, RunAgentInput, Tool, UserMessage
from strands import Agent as StrandsAgentCore
from strands import tool
from strands.models.model import Model as StrandsModel

from ag_ui_strands.agent import StrandsAgent
from ag_ui_strands.config import StrandsAgentConfig, ToolBehavior


THREAD_ID = "interrupt-client-tool-thread"
TOOL_NAME = "confirm_action"
CLIENT_TOOL = Tool(
    name=TOOL_NAME,
    description="Confirm an action in the client",
    parameters={"type": "object", "properties": {}},
)


@tool
def confirm_action() -> dict:
    """Confirm an action on the server."""
    return {"confirmed": True}


class ToolCallModel(StrandsModel):
    def __init__(self) -> None:
        self.issued_tool_call = False
        self.tool_use_sequence = 0

    def get_config(self):
        return {}

    def update_config(self, **kwargs):
        pass

    def begin_run(self) -> None:
        self.issued_tool_call = False

    async def structured_output(
        self, output_model, prompt=None, system_prompt=None, **kwargs
    ):
        raise NotImplementedError
        yield  # pragma: no cover

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs):
        yield {"messageStart": {"role": "assistant"}}
        if not self.issued_tool_call:
            self.issued_tool_call = True
            self.tool_use_sequence += 1
            yield {
                "contentBlockStart": {
                    "start": {
                        "toolUse": {
                            "toolUseId": f"tool-{self.tool_use_sequence}",
                            "name": TOOL_NAME,
                        }
                    }
                }
            }
            yield {
                "contentBlockDelta": {
                    "delta": {"toolUse": {"input": "{}"}}
                }
            }
            yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "tool_use"}}
            return

        yield {"contentBlockDelta": {"delta": {"text": "done"}}}
        yield {"contentBlockStop": {}}
        yield {"messageStop": {"stopReason": "end_turn"}}


def make_agent(native_tools=None, agents_by_thread=None, model=None):
    model = model or ToolCallModel()
    agents_by_thread = {} if agents_by_thread is None else agents_by_thread
    core = StrandsAgentCore(
        model=model,
        tools=[confirm_action] if native_tools is None else native_tools,
        system_prompt="Call confirm_action.",
    )
    agent = StrandsAgent(
        core,
        name="interrupt-client-tool-test",
        agents_by_thread=agents_by_thread,
        config=StrandsAgentConfig(
            tool_behaviors={
                TOOL_NAME: ToolBehavior(
                    interrupt_on_call=True,
                    continue_after_frontend_call=True,
                ),
            }
        ),
    )
    return agent, agents_by_thread, model


def run_input(run_id: str, tools: list[Tool]) -> RunAgentInput:
    return RunAgentInput(
        thread_id=THREAD_ID,
        run_id=run_id,
        state={},
        messages=[
            UserMessage(
                id=f"user-{run_id}",
                role="user",
                content="Call confirm_action.",
            )
        ],
        tools=tools,
        context=[],
        forwarded_props={},
    )


async def collect(agent: StrandsAgent, input_data: RunAgentInput) -> list:
    return [event async for event in agent.run(input_data)]


def assert_tool_call_lifecycle(events: list) -> None:
    assert [
        event.type
        for event in events
        if event.type
        in {
            EventType.TOOL_CALL_START,
            EventType.TOOL_CALL_ARGS,
            EventType.TOOL_CALL_END,
        }
    ] == [
        EventType.TOOL_CALL_START,
        EventType.TOOL_CALL_ARGS,
        EventType.TOOL_CALL_END,
    ]
    assert any(
        event.type == EventType.TOOL_CALL_START
        and event.tool_call_name == TOOL_NAME
        for event in events
    )


@pytest.mark.asyncio
async def test_warns_and_skips_interrupt_for_current_client_proxy(caplog):
    agent, _, model = make_agent(native_tools=[])
    model.begin_run()

    with caplog.at_level(logging.WARNING, logger="ag_ui_strands.agent"):
        events = await collect(agent, run_input("run-1", [CLIENT_TOOL]))

    assert_tool_call_lifecycle(events)
    finished = events[-1]
    assert finished.type == EventType.RUN_FINISHED
    assert finished.outcome.type == "success"
    assert agent._pending_interrupts_by_thread.get(THREAD_ID, {}) == {}
    matching_warnings = [
        record
        for record in caplog.records
        if record.levelno == logging.WARNING and TOOL_NAME in record.getMessage()
    ]
    assert len(matching_warnings) == 1


@pytest.mark.asyncio
async def test_still_interrupts_backend_tool_with_same_configured_name():
    agent, _, model = make_agent()
    model.begin_run()

    events = await collect(agent, run_input("run-1", []))

    finished = events[-1]
    assert finished.type == EventType.RUN_FINISHED
    assert finished.outcome.type == "interrupt"


@pytest.mark.asyncio
async def test_evaluates_proxy_membership_when_hook_fires_each_request():
    agent, agents_by_thread, model = make_agent(native_tools=[])
    model.begin_run()

    first_events = await collect(agent, run_input("run-1", [CLIENT_TOOL]))
    assert first_events[-1].outcome.type == "success"

    live_agent = agents_by_thread[THREAD_ID]
    live_agent.tool_registry.registry.pop(TOOL_NAME)
    live_agent.tool_registry.dynamic_tools.pop(TOOL_NAME, None)
    live_agent.tool_registry.register_tool(confirm_action)
    recreated_agent, _, _ = make_agent(
        native_tools=[], agents_by_thread=agents_by_thread, model=model
    )
    model.begin_run()

    second_events = await collect(recreated_agent, run_input("run-2", []))

    assert second_events[-1].type == EventType.RUN_FINISHED
    assert second_events[-1].outcome.type == "interrupt"
