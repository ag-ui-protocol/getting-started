"""Regression tests for terminal Strands stream events.

``force_stop`` reports a failed model cycle, while ``result`` reports a normal
terminal result. The adapter must preserve that distinction and consume the
underlying async generator to completion in both cases.
"""

from __future__ import annotations

import logging
from types import SimpleNamespace

import pytest
import strands.event_loop.event_loop as strands_event_loop
from ag_ui.core import EventType, RunAgentInput, UserMessage
from ag_ui_strands.agent import StrandsAgent
from strands import Agent
from strands.models import Model
from strands.types.exceptions import ModelThrottledException

_THREAD_ID = "terminal-event-thread"
_THROTTLE_REASON = "Too many requests"


class _UnusedModel(Model):
    """Complete Model implementation for agents whose stream is scripted."""

    def get_config(self):
        return {"model_id": "unused-test-model"}

    def update_config(self, **kwargs):
        pass

    async def structured_output(
        self, output_model, prompt, **kwargs
    ):  # pragma: no cover
        if False:
            yield {}

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs):
        raise AssertionError("the scripted stream should bypass the model")
        yield  # pragma: no cover


class _ThrottledModel(_UnusedModel):
    """Model that drives Strands' real ``ForceStopEvent`` failure path."""

    def get_config(self):
        return {"model_id": "throttled-test-model"}

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs):
        raise ModelThrottledException(_THROTTLE_REASON)
        yield  # pragma: no cover


class _StreamProbe:
    finalized = False


def _run_input() -> RunAgentInput:
    return RunAgentInput(
        thread_id=_THREAD_ID,
        run_id="terminal-event-run",
        state={},
        messages=[UserMessage(id="user-1", role="user", content="Hello")],
        tools=[],
        context=[],
        forwarded_props={},
    )


def _adapter(core: Agent) -> StrandsAgent:
    return StrandsAgent(
        core,
        name="terminal-event-agent",
        agents_by_thread={_THREAD_ID: core},
    )


def _scripted_adapter(
    events: list[dict], *, stream_error: Exception | None = None
) -> tuple[StrandsAgent, _StreamProbe]:
    """Use a real Agent container with an instrumented deterministic stream."""

    core = Agent(model=_UnusedModel(), tools=[])
    probe = _StreamProbe()

    async def stream_async(_prompt):
        try:
            for event in events:
                yield event
            if stream_error is not None:
                raise stream_error
        finally:
            probe.finalized = True

    core.stream_async = stream_async
    return _adapter(core), probe


async def _collect(adapter: StrandsAgent) -> list:
    return [event async for event in adapter.run(_run_input())]


@pytest.mark.asyncio
async def test_real_force_stop_emits_run_error_and_logs_reason(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
):
    """A provider failure is a failed run, not successful assistant content."""

    monkeypatch.setattr(strands_event_loop, "MAX_ATTEMPTS", 1)

    with caplog.at_level(logging.ERROR, logger="ag_ui_strands.agent"):
        events = await _collect(_adapter(Agent(model=_ThrottledModel(), tools=[])))

    event_types = [event.type for event in events]
    assert event_types[-1] == EventType.RUN_ERROR
    assert EventType.RUN_FINISHED not in event_types
    assert EventType.TEXT_MESSAGE_START not in event_types
    assert EventType.TEXT_MESSAGE_CONTENT not in event_types

    error = events[-1]
    assert _THROTTLE_REASON in error.message
    assert any(
        record.levelno >= logging.ERROR and _THROTTLE_REASON in record.getMessage()
        for record in caplog.records
    )


@pytest.mark.asyncio
async def test_force_stop_is_an_error_even_if_stream_ends_without_raising():
    """Legacy/custom streams cannot turn ``force_stop`` into RUN_FINISHED."""

    reason = "ValidationException: Tool use is not supported for this model"
    adapter, probe = _scripted_adapter(
        [{"force_stop": True, "force_stop_reason": reason}]
    )

    events = await _collect(adapter)

    assert probe.finalized
    assert events[-1].type == EventType.RUN_ERROR
    assert events[-1].message == reason
    assert all(event.type != EventType.RUN_FINISHED for event in events)


@pytest.mark.asyncio
async def test_force_stop_preserves_a_followup_stream_exception_in_error_logs(
    caplog: pytest.LogCaptureFixture,
):
    """A distinct unwind failure must not disappear below production log level."""

    cleanup_error = RuntimeError("cleanup callback exploded")
    adapter, _ = _scripted_adapter(
        [{"force_stop": True, "force_stop_reason": "provider throttled"}],
        stream_error=cleanup_error,
    )

    with caplog.at_level(logging.ERROR, logger="ag_ui_strands.agent"):
        events = await _collect(adapter)

    assert events[-1].type == EventType.RUN_ERROR
    assert any(
        record.levelno >= logging.ERROR
        and record.exc_info is not None
        and record.exc_info[1] is cleanup_error
        for record in caplog.records
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("stop_reason", "expect_agent_stopped"),
    [
        ("end_turn", False),
        ("max_tokens", True),
        ("guardrail_intervened", True),
        ("content_filtered", True),
    ],
)
async def test_result_event_is_consumed_before_run_finishes(
    stop_reason: str,
    expect_agent_stopped: bool,
):
    """A normal result retains cleanup and optional stop-reason signaling."""

    adapter, probe = _scripted_adapter(
        [{"result": SimpleNamespace(stop_reason=stop_reason)}]
    )

    events = await _collect(adapter)

    assert probe.finalized, "the adapter left the Strands result stream suspended"
    assert events[-1].type == EventType.RUN_FINISHED

    stopped = [
        event
        for event in events
        if event.type == EventType.CUSTOM and event.name == "AgentStopped"
    ]
    assert bool(stopped) is expect_agent_stopped
    if expect_agent_stopped:
        assert stopped[0].value == {"stop_reason": stop_reason}
