"""
Tests for the OpenAIAgentsAgent wrapper.

Covers orchestration only — the event mapping itself is the translator's job
and has its own coverage:

- ``run_streamed`` yields the translator-wrapped stream (RUN_STARTED first,
  RUN_FINISHED last) for one AG-UI request.
- Client-declared tools are merged onto a per-request ``clone`` — the wrapped
  static agent is never mutated; without tools no clone happens.
- ``run_config`` and context pass through to ``Runner.run_streamed``.
- Every ``to_agui`` option is forwarded with the same public name.
- ``name`` defaults to the SDK agent's name.
"""

from __future__ import annotations

import asyncio
from unittest.mock import MagicMock

import pytest
from agents import Agent, RunConfig, function_tool
from agents.result import RunResultStreaming

import ag_ui_openai_agents.agent as agent_module
from ag_ui.core import (
    CustomEvent,
    Context,
    EventType,
    RunAgentInput,
    Tool,
    UserMessage,
)
from ag_ui_openai_agents import OpenAIAgentsAgent


def _run_input(with_tool: bool = False) -> RunAgentInput:
    return RunAgentInput(
        thread_id="t1",
        run_id="r1",
        messages=[UserMessage(id="m1", role="user", content="hi")],
        tools=[
            Tool(
                name="confirm",
                description="Ask the user to confirm.",
                parameters={"type": "object", "properties": {}},
            )
        ]
        if with_tool
        else [],
        state={},
        context=[],
        forwarded_props=None,
    )


async def _empty_stream():
    return
    yield  # pragma: no cover — makes this an async generator


@pytest.fixture
def patched_runner(monkeypatch):
    """Replace Runner.run_streamed with a capture that returns an empty stream."""
    calls: list[dict] = []

    def fake_run_streamed(agent, *, input, run_config=None, **kwargs):
        calls.append(
            {"agent": agent, "input": input, "run_config": run_config, **kwargs}
        )
        result = MagicMock(spec=RunResultStreaming)
        result.stream_events.return_value = _empty_stream()
        return result

    monkeypatch.setattr(agent_module.Runner, "run_streamed", fake_run_streamed)
    return calls


def _collect(wrapper: OpenAIAgentsAgent, run_input: RunAgentInput) -> list:
    async def go():
        return [event async for event in wrapper.run_streamed(run_input)]

    return asyncio.run(go())


def test_run_wraps_stream_with_lifecycle(patched_runner):
    wrapper = OpenAIAgentsAgent(Agent(name="assistant", instructions="hi"))
    events = _collect(wrapper, _run_input())
    assert events[0].type == EventType.RUN_STARTED
    assert events[-1].type == EventType.RUN_FINISHED
    assert events[0].thread_id == "t1"
    assert events[0].run_id == "r1"


def test_run_without_client_tools_uses_static_agent(patched_runner):
    sdk_agent = Agent(name="assistant", instructions="hi")
    wrapper = OpenAIAgentsAgent(sdk_agent)
    _collect(wrapper, _run_input())
    assert patched_runner[0]["agent"] is sdk_agent


def test_run_merges_client_tools_onto_clone(patched_runner):
    sdk_agent = Agent(name="assistant", instructions="hi")
    wrapper = OpenAIAgentsAgent(sdk_agent)
    _collect(wrapper, _run_input(with_tool=True))
    ran_agent = patched_runner[0]["agent"]
    assert ran_agent is not sdk_agent, "client tools must go on a clone"
    assert [t.name for t in ran_agent.tools] == ["confirm"]
    assert sdk_agent.tools == [], "the static agent must stay untouched"


def test_run_keeps_server_tool_when_client_name_conflicts(patched_runner, caplog):
    @function_tool
    def confirm() -> str:
        """Confirm on the server."""
        return "confirmed"

    sdk_agent = Agent(name="assistant", instructions="hi", tools=[confirm])
    wrapper = OpenAIAgentsAgent(sdk_agent)

    import logging

    with caplog.at_level(logging.WARNING):
        _collect(wrapper, _run_input(with_tool=True))

    assert patched_runner[0]["agent"] is sdk_agent
    assert [tool.name for tool in sdk_agent.tools] == ["confirm"]
    assert "Ignoring client tool 'confirm'" in caplog.text


def test_run_config_passes_through(patched_runner):
    run_config = RunConfig()
    wrapper = OpenAIAgentsAgent(
        Agent(name="assistant", instructions="hi"), run_config=run_config
    )
    _collect(wrapper, _run_input())
    assert patched_runner[0]["run_config"] is run_config


def test_context_passes_through(patched_runner):
    run_input = _run_input()
    run_input.context = [Context(description="Response language", value="German")]
    wrapper = OpenAIAgentsAgent(Agent(name="assistant", instructions="hi"))
    _collect(wrapper, run_input)
    assert patched_runner[0]["context"] == run_input.context


def test_explicit_context_overrides_agui_context(patched_runner):
    # A caller that supplies its own SDK context gets exactly that object,
    # not the AG-UI ambient context list.
    sentinel = {"app": "context"}
    run_input = _run_input()
    run_input.context = [Context(description="Response language", value="German")]
    wrapper = OpenAIAgentsAgent(
        Agent(name="assistant", instructions="hi"), context=sentinel
    )
    _collect(wrapper, run_input)
    assert patched_runner[0]["context"] is sentinel


def test_no_context_defaults_to_none_not_empty_list(patched_runner):
    # A context-less request must run with the SDK default (None), not [] —
    # agents branching on `ctx.context is None` depend on this.
    wrapper = OpenAIAgentsAgent(Agent(name="assistant", instructions="hi"))
    _collect(wrapper, _run_input())  # _run_input has context=[]
    assert patched_runner[0]["context"] is None


def test_explicit_context_none_is_honored(patched_runner):
    # context=None is a real SDK context, distinct from "not provided".
    run_input = _run_input()
    run_input.context = [Context(description="x", value="y")]
    wrapper = OpenAIAgentsAgent(Agent(name="assistant", instructions="hi"), context=None)
    _collect(wrapper, run_input)
    assert patched_runner[0]["context"] is None


def test_duplicate_client_tool_names_are_deduped(patched_runner, caplog):
    import logging

    run_input = RunAgentInput(
        thread_id="t1",
        run_id="r1",
        messages=[UserMessage(id="m1", role="user", content="hi")],
        tools=[
            Tool(name="dup", description="a", parameters={"type": "object", "properties": {}}),
            Tool(name="dup", description="b", parameters={"type": "object", "properties": {}}),
        ],
        state={},
        context=[],
        forwarded_props=None,
    )
    wrapper = OpenAIAgentsAgent(Agent(name="assistant", instructions="hi"))
    with caplog.at_level(logging.WARNING):
        _collect(wrapper, run_input)
    ran_agent = patched_runner[0]["agent"]
    assert [t.name for t in ran_agent.tools] == ["dup"], "duplicate client tool must be dropped"
    assert "Ignoring duplicate client tool 'dup'" in caplog.text


def test_to_agui_options_pass_through(patched_runner, monkeypatch):
    start_value = lambda: {"phase": "start"}
    end_value = lambda: {"phase": "end"}
    start = CustomEvent(type=EventType.CUSTOM, name="start", value=start_value)
    end = CustomEvent(type=EventType.CUSTOM, name="end", value=end_value)
    initial_state = lambda: {"phase": "initial"}
    final_state = lambda: {"phase": "final"}
    translated_calls: list[dict] = []
    wrapper = OpenAIAgentsAgent(
        Agent(name="assistant", instructions="hi"),
        start_custom_event=start,
        initial_state=initial_state,
        final_state=final_state,
        emit_messages_snapshot=False,
        end_custom_event=end,
        emit_run_error=False,
        run_error_message="safe error",
    )

    original_to_agui = wrapper._translator.to_agui

    async def spy_to_agui(result, run_input, **kwargs):
        translated_calls.append(kwargs)
        async for event in original_to_agui(result, run_input, **kwargs):
            yield event

    monkeypatch.setattr(wrapper._translator, "to_agui", spy_to_agui)
    _collect(wrapper, _run_input())
    assert translated_calls == [
        {
            "start_custom_event": start,
            "initial_state": initial_state,
            "final_state": final_state,
            "emit_messages_snapshot": False,
            "end_custom_event": end,
            "emit_run_error": False,
            "run_error_message": "safe error",
        }
    ]


def test_custom_event_value_factories_run_once_per_request(patched_runner):
    calls = {"start": 0, "end": 0}

    def start_value():
        calls["start"] += 1
        return {"call": calls["start"]}

    def end_value():
        calls["end"] += 1
        return {"call": calls["end"]}

    wrapper = OpenAIAgentsAgent(
        Agent(name="assistant", instructions="hi"),
        start_custom_event=CustomEvent(
            type=EventType.CUSTOM, name="start", value=start_value
        ),
        end_custom_event=CustomEvent(
            type=EventType.CUSTOM, name="end", value=end_value
        ),
    )
    first = _collect(wrapper, _run_input())
    second = _collect(wrapper, _run_input())

    assert calls == {"start": 2, "end": 2}
    assert [event.value for event in first if isinstance(event, CustomEvent)] == [
        {"call": 1},
        {"call": 1},
    ]
    assert [event.value for event in second if isinstance(event, CustomEvent)] == [
        {"call": 2},
        {"call": 2},
    ]


@pytest.mark.parametrize("custom_event_arg", ["start_custom_event", "end_custom_event"])
def test_custom_event_value_factory_failure_emits_run_error_and_cancels(
    monkeypatch,
    custom_event_arg,
):
    def failing_factory():
        raise RuntimeError("event factory failed")

    captured: list = []
    collected: list = []

    def fake_run_streamed(agent, *, input, run_config=None, **kwargs):
        result = MagicMock(spec=RunResultStreaming)
        result.stream_events.return_value = _empty_stream()
        result.new_items = []
        captured.append(result)
        return result

    wrapper = OpenAIAgentsAgent(
        Agent(name="assistant", instructions="hi"),
        **{
            custom_event_arg: CustomEvent(
                type=EventType.CUSTOM,
                name="failing",
                value=failing_factory,
            )
        },
    )

    monkeypatch.setattr(agent_module.Runner, "run_streamed", fake_run_streamed)

    async def collect():
        async for event in wrapper.run_streamed(_run_input()):
            collected.append(event)

    with pytest.raises(RuntimeError, match="event factory failed"):
        asyncio.run(collect())

    assert len(captured) == 1, "the run must have started"
    captured[0].cancel.assert_called_once()
    assert [
        event.type
        for event in collected
        if event.type in {EventType.RUN_STARTED, EventType.RUN_ERROR}
    ] == [EventType.RUN_STARTED, EventType.RUN_ERROR]


def test_name_defaults_to_agent_name():
    assert OpenAIAgentsAgent(Agent(name="helper", instructions="hi")).name == "helper"
    assert (
        OpenAIAgentsAgent(Agent(name="helper", instructions="hi"), name="api").name
        == "api"
    )
