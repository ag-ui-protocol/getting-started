"""The per-thread kwargs route.

Some template settings cannot be recovered by reading a built Agent: Strands
consumes them during construction and keeps nothing under a name the adapter
can find. Classifying those says what happens to them; it does not give a
caller anywhere to put them. This hook does, and these tests are what make that
claim checkable.

Mirrors the TypeScript ``threadAgentConfig`` suite.
"""

from __future__ import annotations

import logging
import weakref
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from ag_ui.core import EventType, RunAgentInput, UserMessage
from strands import Agent
from strands.tools.registry import ToolRegistry

from ag_ui_strands.agent import StrandsAgent
from ag_ui_strands.config import StrandsAgentConfig


def _mock_model():
    m = MagicMock()
    m.stateful = False
    return m


def _run_input(thread_id: str = "t1") -> RunAgentInput:
    return RunAgentInput(
        thread_id=thread_id,
        run_id="r1",
        state={},
        messages=[UserMessage(id="u1", content="hello")],
        tools=[],
        context=[],
        forwarded_props={},
    )


class _CapturingCore:
    """Stands in for the per-thread agent so the kwargs can be inspected."""

    instances: list["_CapturingCore"] = []

    def __init__(self, **kwargs):
        self.init_kwargs = kwargs
        self.tool_registry = ToolRegistry()
        _CapturingCore.instances.append(self)

    async def stream_async(self, _msg):
        if False:
            yield


async def _build(ag: StrandsAgent, thread_id: str = "t1"):
    _CapturingCore.instances = []
    events = []
    with patch("ag_ui_strands.agent.StrandsAgentCore", _CapturingCore):
        async for event in ag.run(_run_input(thread_id)):
            events.append(event)
            if thread_id in ag._agents_by_thread:
                break
    return events


@pytest.mark.asyncio
async def test_caller_kwargs_reach_the_per_thread_agent():
    """A setting the template cannot carry arrives through the hook."""
    template = Agent(model=_mock_model())
    config = StrandsAgentConfig(
        thread_agent_kwargs=lambda _input: {"callback_handler": "from-hook"}
    )
    ag = StrandsAgent(template, name="test", config=config)

    await _build(ag)

    assert _CapturingCore.instances
    assert _CapturingCore.instances[-1].init_kwargs["callback_handler"] == "from-hook"


@pytest.mark.asyncio
async def test_caller_kwargs_override_a_recovered_value():
    """The hook wins over whatever was read off the template."""
    template = Agent(model=_mock_model(), name="from-template")
    config = StrandsAgentConfig(
        thread_agent_kwargs=lambda _input: {"name": "from-hook"}
    )
    ag = StrandsAgent(template, name="test", config=config)

    await _build(ag)

    assert _CapturingCore.instances[-1].init_kwargs["name"] == "from-hook"


@pytest.mark.asyncio
async def test_adapter_keeps_what_makes_threads_separate():
    """A caller cannot take over the fields that keep threads apart.

    Pointing every thread at one model, tool set or session would undo the
    isolation the per-thread rebuild exists for.
    """
    template = Agent(model=_mock_model())
    hijack = {
        "model": "hijacked",
        "system_prompt": "hijacked",
        "tools": ["hijacked"],
        "session_manager": "hijacked",
    }
    config = StrandsAgentConfig(thread_agent_kwargs=lambda _input: dict(hijack))
    ag = StrandsAgent(template, name="test", config=config)

    await _build(ag)

    kwargs = _CapturingCore.instances[-1].init_kwargs
    for owned in hijack:
        assert kwargs.get(owned) != "hijacked", (
            f"{owned} is the adapter's to set but the caller's value won"
        )


@pytest.mark.asyncio
async def test_hook_runs_once_per_thread_with_that_thread_s_input():
    """Each thread gets its own call, so each can build its own instances."""
    seen: list[str] = []

    def build(input_data: RunAgentInput):
        seen.append(input_data.thread_id)
        return {}

    template = Agent(model=_mock_model())
    ag = StrandsAgent(
        template, name="test", config=StrandsAgentConfig(thread_agent_kwargs=build)
    )

    await _build(ag, "a")
    await _build(ag, "b")

    assert seen == ["a", "b"]


@pytest.mark.asyncio
async def test_hook_failure_ends_the_run_and_leaves_the_thread_uncached():
    """A broken hook must fail loudly and stay retryable."""
    calls = {"n": 0}

    def explode(_input):
        calls["n"] += 1
        raise RuntimeError("no kwargs for you")

    template = Agent(model=_mock_model())
    ag = StrandsAgent(
        template, name="test", config=StrandsAgentConfig(thread_agent_kwargs=explode)
    )

    events = []
    with patch("ag_ui_strands.agent.StrandsAgentCore", _CapturingCore):
        async for event in ag.run(_run_input()):
            events.append(event)

    types = [e.type for e in events]
    assert EventType.RUN_ERROR in types
    # Opened before it failed: a client that brackets a run on the lifecycle
    # events is left with an unopened run otherwise. Every other early-error
    # path in this adapter emits the pair.
    assert types.index(EventType.RUN_STARTED) < types.index(EventType.RUN_ERROR)
    assert "t1" not in ag._agents_by_thread

    # Uncached, so the next request retries rather than reusing a thread that
    # was never built.
    with patch("ag_ui_strands.agent.StrandsAgentCore", _CapturingCore):
        async for _ in ag.run(_run_input()):
            pass
    assert calls["n"] == 2


# ---------------------------------------------------------------------------
# plugins
# ---------------------------------------------------------------------------
#
# ``plugins`` has a dedicated kwarg on the adapter, so it reaches this hook
# with something already in the box. Three sources can name it at once: the
# template, which cannot carry; the kwarg; and this hook. These fix the order
# between them, and fix that using either route silences the warning about
# the template.


# Plain sentinels rather than real plugins: the adapter hands this list to the
# per-thread constructor unexamined, and the stub below is what receives it.
# That keeps these running at the declared strands-agents floor, which has no
# plugin system at all.


class _FakePluginRegistry:
    """A plugin registry in the shape the adapter reads."""

    def __init__(self, owner, names):
        self._agent_ref = weakref.ref(owner)
        self._plugins = {name: SimpleNamespace(name=name) for name in names}


def _template_with_plugins(*names: str):
    agent = Agent(model=_mock_model())
    agent._plugin_registry = _FakePluginRegistry(agent, names)
    return agent


def _as_if_sdk_took_plugins():
    """Declare the capability the stub core already assumes.

    The wrap-time check refuses ``plugins=`` on a release whose Agent has no
    such parameter. The per-thread core here is a stub that takes any kwarg, so
    declaring the capability is what lets the precedence rule be asserted at
    the declared floor instead of skipped there.
    """
    return patch("ag_ui_strands.agent._STRANDS_ACCEPTS_PLUGINS", True)


@pytest.mark.asyncio
async def test_the_hook_can_supply_plugins():
    """The general route still works for the param that gained a kwarg.

    A caller who wants a plugin built per thread, rather than one instance
    shared by every thread, has nowhere else to do it.
    """
    plugin = object()
    template = Agent(model=_mock_model())
    config = StrandsAgentConfig(thread_agent_kwargs=lambda _input: {"plugins": [plugin]})
    ag = StrandsAgent(template, name="test", config=config)

    await _build(ag)

    assert _CapturingCore.instances[-1].init_kwargs["plugins"] == [plugin]


@pytest.mark.asyncio
async def test_hook_plugins_win_over_the_adapter_kwarg():
    """Same precedence every other param has, and for the same reason.

    The hook sees the request; the constructor kwarg was fixed once at
    startup. Whichever knows more about this thread should be the one that
    decides, so the later writer wins.
    """
    from_ctor = object()
    from_hook = object()
    template = Agent(model=_mock_model())
    config = StrandsAgentConfig(
        thread_agent_kwargs=lambda _input: {"plugins": [from_hook]}
    )
    with _as_if_sdk_took_plugins():
        ag = StrandsAgent(template, name="test", plugins=[from_ctor], config=config)
        await _build(ag)

    assert _CapturingCore.instances[-1].init_kwargs["plugins"] == [from_hook]


@pytest.mark.asyncio
async def test_no_warning_about_template_plugins_the_hook_supplies(caplog):
    """Acting on the warning through this route has to make it stop too.

    The message names the constructor kwarg, but the hook answers it just as
    completely, and a caller who took that route has lost nothing.
    """
    template = _template_with_plugins("on-template")
    config = StrandsAgentConfig(
        thread_agent_kwargs=lambda _input: {"plugins": [object()]}
    )
    ag = StrandsAgent(template, name="test", config=config)

    with caplog.at_level(logging.WARNING, logger="ag_ui_strands.agent"):
        await _build(ag)

    assert not [m for m in caplog.messages if "plugins" in m], (
        f"warned about plugins the hook supplied; got {caplog.messages}"
    )
