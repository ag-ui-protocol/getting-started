"""Request-scoped state must reach the underlying Strands invocation."""

from __future__ import annotations

import inspect
from typing import ClassVar
from unittest.mock import MagicMock, patch

import pytest
from ag_ui.core import (
    AssistantMessage,
    FunctionCall,
    RunAgentInput,
    Tool,
    ToolCall,
    ToolMessage,
    UserMessage,
)
from ag_ui_strands.agent import StrandsAgent
from ag_ui_strands.config import StrandsAgentConfig
from ag_ui_strands.session_reconcile import AG_UI_FRONTEND_CALL_IDS_STATE_KEY
from strands import Agent
from strands.agent.state import AgentState
from strands.tools.registry import ToolRegistry


def _mock_model():
    model = MagicMock()
    model.stateful = False
    return model


def _run_input(thread_id: str, *, reconcile: bool = False) -> RunAgentInput:
    messages = (
        [
            AssistantMessage(
                id="assistant-1",
                content="",
                tool_calls=[
                    ToolCall(
                        id="native-1",
                        function=FunctionCall(name="approve", arguments="{}"),
                    )
                ],
            ),
            ToolMessage(
                id="tool-1",
                role="tool",
                content="approved",
                tool_call_id="native-1",
            )
        ]
        if reconcile
        else [UserMessage(id="user-1", content="hello")]
    )
    return RunAgentInput(
        thread_id=thread_id,
        run_id=f"run-{thread_id}",
        state={},
        messages=messages,
        tools=(
            [Tool(name="approve", description="Approve", parameters={})]
            if reconcile
            else []
        ),
        context=[],
        forwarded_props={},
    )


class _CapturingCore:
    instances: ClassVar[list[_CapturingCore]] = []

    def __init__(self, **_kwargs):
        self.tool_registry = ToolRegistry()
        self.state = AgentState()
        self.state.set(AG_UI_FRONTEND_CALL_IDS_STATE_KEY, ["native-1"])
        self.messages = []
        self.calls: list[tuple[object, dict]] = []
        type(self).instances.append(self)

    async def stream_async(self, prompt, **kwargs):
        self.calls.append((prompt, kwargs))
        if False:
            yield


async def _run(
    *,
    invocation_state: dict | None,
    replay_history: bool,
) -> _CapturingCore:
    template = Agent(model=_mock_model())
    adapter = StrandsAgent(
        template,
        name="test",
        config=StrandsAgentConfig(
            replay_history_into_strands=replay_history,
        ),
    )
    _CapturingCore.instances.clear()
    with patch("ag_ui_strands.agent.StrandsAgentCore", _CapturingCore):
        kwargs = (
            {"invocation_state": invocation_state}
            if invocation_state is not None
            else {}
        )
        async for _ in adapter.run(_run_input(str(replay_history)), **kwargs):
            pass
    return _CapturingCore.instances[-1]


@pytest.mark.asyncio
@pytest.mark.parametrize("replay_history", [True, False])
async def test_invocation_state_is_forwarded_unchanged(replay_history):
    invocation_state = {"request_id": "request-1"}

    core = await _run(
        invocation_state=invocation_state,
        replay_history=replay_history,
    )

    forwarded = core.calls[0][1]["invocation_state"]
    assert forwarded == invocation_state
    assert forwarded is not invocation_state

    forwarded["mutated_by_strands"] = True
    assert invocation_state == {"request_id": "request-1"}


@pytest.mark.asyncio
async def test_omitted_invocation_state_preserves_legacy_call_shape():
    core = await _run(invocation_state=None, replay_history=False)

    assert core.calls[0][1] == {}


@pytest.mark.asyncio
async def test_invocation_state_is_forwarded_during_session_reconciliation():
    invocation_state = {"request_id": "request-reconcile"}
    template = Agent(model=_mock_model())
    adapter = StrandsAgent(template, name="test")
    _CapturingCore.instances.clear()

    with (
        patch("ag_ui_strands.agent.StrandsAgentCore", _CapturingCore),
        patch(
            "ag_ui_strands.agent._get_strands_session_manager",
            return_value=object(),
        ),
        patch(
            "ag_ui_strands.agent.reconcile_frontend_tool_results",
            return_value={"native-1"},
        ),
        patch("ag_ui_strands.agent.has_placeholder_results", return_value=False),
    ):
        async for _ in adapter.run(
            _run_input("reconcile", reconcile=True),
            invocation_state=invocation_state,
        ):
            pass

    core = _CapturingCore.instances[-1]
    forwarded = core.calls[0][1]["invocation_state"]
    assert forwarded == invocation_state
    assert forwarded is not invocation_state


def test_strands_stream_async_accepts_invocation_state_by_keyword_only():
    parameter = inspect.signature(Agent.stream_async).parameters["invocation_state"]

    assert parameter.kind is inspect.Parameter.KEYWORD_ONLY
