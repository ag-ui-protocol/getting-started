"""Compatibility contract for the declared Strands Agents minimum version."""

from __future__ import annotations

import copy
from typing import Any

import pytest
from ag_ui.core import Tool as AgUiTool
from strands import Agent
from strands.models.model import Model

from ag_ui_strands.client_proxy_tool import create_proxy_tool
from ag_ui_strands.frontend_tool_interrupt import (
    FRONTEND_TOOL_INTERRUPT_NAME,
    frontend_tool_reason,
    wrap_frontend_tool_response,
)


class _MinimumVersionModel(Model):
    """Emit one deterministic tool use, then finish after its empty result."""

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
                            "toolUseId": "native-115",
                            "name": "compat_tool",
                        }
                    }
                }
            }
            yield {
                "contentBlockDelta": {"delta": {"toolUse": {"input": "{}"}}}
            }
            yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "tool_use"}}
            return
        yield {"contentBlockDelta": {"delta": {"text": "continued"}}}
        yield {"contentBlockStop": {}}
        yield {"messageStop": {"stopReason": "end_turn"}}


@pytest.mark.asyncio
async def test_waiting_proxy_interrupts_and_resumes_empty_result() -> None:
    """The real native loop works on the declared 1.15.0 floor."""
    proxy = create_proxy_tool(
        AgUiTool(
            name="compat_tool",
            description="compatibility tool",
            parameters={},
        ),
        continue_after_frontend_call=False,
    )
    model = _MinimumVersionModel()
    native_agent = Agent(model=model, tools=[proxy])

    first_events = [
        event async for event in native_agent.stream_async("use the tool")
    ]
    first_result = first_events[-1]["result"]
    assert first_result.stop_reason == "interrupt"
    [interrupt] = first_result.interrupts
    assert interrupt.name == FRONTEND_TOOL_INTERRUPT_NAME
    assert interrupt.reason == frontend_tool_reason("native-115")

    resumed_events = [
        event
        async for event in native_agent.stream_async(
            [
                {
                    "interruptResponse": {
                        "interruptId": interrupt.id,
                        "response": wrap_frontend_tool_response(
                            "", is_error=False
                        ),
                    }
                }
            ]
        )
    ]

    assert resumed_events[-1]["result"].stop_reason == "end_turn"
    assert model.calls == 2
    assert model.seen_messages[-1][-1] == {
        "role": "user",
        "content": [
            {
                "toolResult": {
                    "toolUseId": "native-115",
                    "status": "success",
                    "content": [{"text": ""}],
                }
            }
        ],
    }
