"""Native-checkpoint authority tests for explicitly waiting frontend tools."""

from __future__ import annotations

import copy
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Sequence

import pytest
from ag_ui.core import (
    EventType,
    ResumeEntry,
    RunAgentInput,
    Tool,
    ToolMessage,
    UserMessage,
)
from strands import Agent, ToolContext, tool
from strands.models.model import Model
from strands.session.file_session_manager import FileSessionManager

from ag_ui_strands.agent import StrandsAgent
from ag_ui_strands.config import StrandsAgentConfig, ToolBehavior
from ag_ui_strands.frontend_tool_interrupt import index_frontend_tool_interrupts
from ag_ui_strands.session_reconcile import AG_UI_FRONTEND_CALL_IDS_STATE_KEY

from tests.error_code_table import assert_contract_error


class _ParallelWaitModel(Model):
    """Emit two frontend calls together, then continue once both resolve."""

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
            for index, name in enumerate(("first_client_tool", "second_client_tool")):
                yield {
                    "contentBlockStart": {
                        "start": {
                            "toolUse": {
                                "toolUseId": f"native-{index}",
                                "name": name,
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
        yield {"contentBlockDelta": {"delta": {"text": "continued once"}}}
        yield {"contentBlockStop": {}}
        yield {"messageStop": {"stopReason": "end_turn"}}


class _RefiringWaitModel(_ParallelWaitModel):
    """Call the same waiting frontend tool again after the first is answered."""

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs):
        self.calls += 1
        self.seen_messages.append(copy.deepcopy(messages))
        yield {"messageStart": {"role": "assistant"}}
        if self.calls <= 2:
            yield {
                "contentBlockStart": {
                    "start": {
                        "toolUse": {
                            "toolUseId": f"native-{self.calls}",
                            "name": "first_client_tool",
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
        yield {"contentBlockDelta": {"delta": {"text": "refire done"}}}
        yield {"contentBlockStop": {}}
        yield {"messageStop": {"stopReason": "end_turn"}}


class _MixedWaitModel(_ParallelWaitModel):
    """Emit one frontend wait and one ordinary native interrupt together."""

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs):
        self.calls += 1
        self.seen_messages.append(copy.deepcopy(messages))
        yield {"messageStart": {"role": "assistant"}}
        if self.calls == 1:
            for tool_use_id, name in (
                ("native-client", "first_client_tool"),
                ("native-server", "server_approval"),
            ):
                yield {
                    "contentBlockStart": {
                        "start": {
                            "toolUse": {
                                "toolUseId": tool_use_id,
                                "name": name,
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
        yield {"contentBlockDelta": {"delta": {"text": "mixed continued"}}}
        yield {"contentBlockStop": {}}
        yield {"messageStop": {"stopReason": "end_turn"}}


class _InvalidIdentityModel(_ParallelWaitModel):
    """Emit frontend calls with caller-selected native IDs."""

    def __init__(self, native_ids: Sequence[str | None]) -> None:
        super().__init__()
        self.native_ids = native_ids

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs):
        self.calls += 1
        self.seen_messages.append(copy.deepcopy(messages))
        yield {"messageStart": {"role": "assistant"}}
        for index, native_id in enumerate(self.native_ids):
            yield {
                "contentBlockStart": {
                    "start": {
                        "toolUse": {
                            "toolUseId": native_id,
                            "name": _tools()[index].name,
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


class _ReusedIdentityModel(_ParallelWaitModel):
    """Reuse one completed frontend tool-use ID on the following model turn."""

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs):
        self.calls += 1
        self.seen_messages.append(copy.deepcopy(messages))
        yield {"messageStart": {"role": "assistant"}}
        if self.calls <= 2:
            yield {
                "contentBlockStart": {
                    "start": {
                        "toolUse": {
                            "toolUseId": "native-reused",
                            "name": "first_client_tool",
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


class _FailAnsweredInterruptSyncManager(FileSessionManager):
    """Fail once after Strands has accepted a native interrupt response."""

    def __init__(self, *, failure_counter: dict[str, int], **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.failure_counter = failure_counter

    def sync_agent(self, agent: Any) -> None:
        state = getattr(agent, "_interrupt_state", None)
        interrupts = getattr(state, "interrupts", {})
        has_answered = any(
            getattr(interrupt, "response", None) is not None
            for interrupt in interrupts.values()
        )
        if has_answered and self.failure_counter["count"] == 0:
            self.failure_counter["count"] += 1
            raise RuntimeError("native frontend wait sync failed")
        super().sync_agent(agent)


@tool(name="server_approval", description="Approve server work", context=True)
def _server_approval(tool_context: ToolContext) -> str:
    response = tool_context.interrupt(
        "server_approval",
        reason={"question": "approve?"},
    )
    return f"server response: {response!r}"


@tool(name="first_client_tool", description="A server tool of the same name")
def _squatting_native(value: str = "") -> str:
    return "the server ran this"


def _tools() -> list[Tool]:
    return [
        Tool(name=name, description=name, parameters={"type": "object"})
        for name in ("first_client_tool", "second_client_tool")
    ]


def _input(
    thread_id: str,
    *,
    run_id: str,
    messages: Sequence[Any],
    resume: Sequence[ResumeEntry] | None = None,
    tools: Sequence[Tool] | None = None,
) -> RunAgentInput:
    return RunAgentInput(
        thread_id=thread_id,
        run_id=run_id,
        state={},
        messages=list(messages),
        tools=list(tools) if tools is not None else _tools(),
        context=[],
        forwarded_props={},
        resume=list(resume) if resume is not None else None,
    )


def _adapter(
    model: Model,
    storage_dir: Path,
    thread_id: str,
    *,
    core_tools: Sequence[Any] = (),
) -> StrandsAgent:
    async def session_manager_provider(_input_data: RunAgentInput):
        return FileSessionManager(
            session_id=thread_id,
            storage_dir=str(storage_dir),
        )

    return StrandsAgent(
        Agent(
            model=model,
            tools=list(core_tools),
            agent_id="stable-native-wait-agent",
        ),
        name="native-wait-test",
        config=StrandsAgentConfig(
            session_manager_provider=session_manager_provider,
            tool_behaviors={
                tool.name: ToolBehavior(continue_after_frontend_call=False)
                for tool in _tools()
            },
        ),
    )


async def _collect(
    adapter: StrandsAgent,
    input_data: RunAgentInput,
) -> list[Any]:
    return [event async for event in adapter.run(input_data)]


def _assert_success(events: Sequence[Any]) -> None:
    assert not any(event.type == EventType.RUN_ERROR for event in events)
    [finished] = [
        event for event in events if event.type == EventType.RUN_FINISHED
    ]
    assert getattr(finished.outcome, "type", None) == "success"


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["unconfigured", "continue"])
async def test_legacy_placeholder_modes_also_emit_native_tool_ids(mode: str) -> None:
    model = _ParallelWaitModel()
    behaviors = (
        {}
        if mode == "unconfigured"
        else {
            tool.name: ToolBehavior(continue_after_frontend_call=True)
            for tool in _tools()
        }
    )
    adapter = StrandsAgent(
        Agent(model=model, tools=[]),
        name=f"native-id-{mode}",
        config=StrandsAgentConfig(tool_behaviors=behaviors),
    )

    events = await _collect(
        adapter,
        _input(
            f"native-id-{mode}",
            run_id="run-1",
            messages=[UserMessage(id="user-1", content="call both tools")],
        ),
    )

    assert [
        event.tool_call_id
        for event in events
        if event.type == EventType.TOOL_CALL_START
    ] == ["native-0", "native-1"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("native_ids", "message_fragment"),
    [
        ((None,), "non-empty"),
        (("   ",), "non-empty"),
        (("native-duplicate", "native-duplicate"), "unique"),
    ],
    ids=["missing", "blank", "duplicate"],
)
async def test_invalid_frontend_native_ids_fail_before_handoff(
    tmp_path: Path,
    native_ids: Sequence[str | None],
    message_fragment: str,
) -> None:
    thread_id = f"invalid-native-id-{message_fragment}"
    events = await _collect(
        _adapter(_InvalidIdentityModel(native_ids), tmp_path, thread_id),
        _input(
            thread_id,
            run_id="run-1",
            messages=[UserMessage(id="user-1", content="call frontend tools")],
        ),
    )

    [error] = [event for event in events if event.type == EventType.RUN_ERROR]
    assert_contract_error(error, "FRONTEND_TOOL_IDENTITY_ERROR")
    assert message_fragment in error.message
    assert EventType.TOOL_CALL_END not in [event.type for event in events]
    assert EventType.RUN_FINISHED not in [event.type for event in events]


@pytest.mark.asyncio
async def test_completed_frontend_native_id_cannot_be_reused(
    tmp_path: Path,
) -> None:
    thread_id = "reused-native-id"
    model = _ReusedIdentityModel()
    first = await _collect(
        _adapter(model, tmp_path, thread_id),
        _input(
            thread_id,
            run_id="run-1",
            messages=[UserMessage(id="user-1", content="call frontend tool")],
        ),
    )
    _assert_success(first)

    resumed = await _collect(
        _adapter(model, tmp_path, thread_id),
        _input(
            thread_id,
            run_id="run-2",
            messages=[
                ToolMessage(
                    id="result-1",
                    tool_call_id="native-reused",
                    content="client-value",
                )
            ],
        ),
    )

    [error] = [event for event in resumed if event.type == EventType.RUN_ERROR]
    assert_contract_error(error, "FRONTEND_TOOL_IDENTITY_ERROR")
    assert "reused" in error.message
    assert EventType.TOOL_CALL_END not in [event.type for event in resumed]
    assert EventType.RUN_FINISHED not in [event.type for event in resumed]


def test_malformed_native_checkpoint_identity_fails_loudly() -> None:
    malformed_mapping = SimpleNamespace(
        _interrupt_state=SimpleNamespace(activated=True, interrupts=[])
    )
    mismatched_id = SimpleNamespace(
        _interrupt_state=SimpleNamespace(
            activated=True,
            interrupts={
                "checkpoint-id": SimpleNamespace(
                    id="different-id",
                    name="ag_ui_frontend_tool_wait",
                    reason={
                        "name": "ag_ui_frontend_tool_wait",
                        "tool_use_id": "native-id",
                    },
                )
            },
        )
    )
    duplicate_tool_id = SimpleNamespace(
        _interrupt_state=SimpleNamespace(
            activated=True,
            interrupts={
                interrupt_id: SimpleNamespace(
                    id=interrupt_id,
                    name="ag_ui_frontend_tool_wait",
                    reason={
                        "name": "ag_ui_frontend_tool_wait",
                        "tool_use_id": "native-id",
                    },
                )
                for interrupt_id in ("interrupt-1", "interrupt-2")
            },
        )
    )

    with pytest.raises(ValueError, match="malformed Strands interrupt checkpoint"):
        index_frontend_tool_interrupts(malformed_mapping)
    with pytest.raises(ValueError, match="key does not match"):
        index_frontend_tool_interrupts(mismatched_id)
    with pytest.raises(ValueError, match="duplicate frontend tool-use ID"):
        index_frontend_tool_interrupts(duplicate_tool_id)


@pytest.mark.asyncio
async def test_duplicate_client_results_fail_before_native_resume(
    tmp_path: Path,
) -> None:
    thread_id = "duplicate-client-results"
    model = _ParallelWaitModel()
    first = await _collect(
        _adapter(model, tmp_path, thread_id),
        _input(
            thread_id,
            run_id="run-1",
            messages=[UserMessage(id="user-1", content="call both tools")],
        ),
    )
    _assert_success(first)

    duplicate = await _collect(
        _adapter(model, tmp_path, thread_id),
        _input(
            thread_id,
            run_id="run-2",
            messages=[
                ToolMessage(id="result-1", tool_call_id="native-0", content="one"),
                ToolMessage(id="result-2", tool_call_id="native-0", content="two"),
            ],
        ),
    )

    [error] = [event for event in duplicate if event.type == EventType.RUN_ERROR]
    assert_contract_error(error, "FRONTEND_TOOL_RESULT_DUPLICATE")
    assert model.calls == 1


@pytest.mark.asyncio
async def test_native_resume_sync_failure_is_loud_and_never_finishes(
    tmp_path: Path,
) -> None:
    thread_id = "native-resume-sync-failure"
    model = _ParallelWaitModel()
    failure_counter = {"count": 0}

    async def session_manager_provider(_input_data: RunAgentInput):
        return _FailAnsweredInterruptSyncManager(
            session_id=thread_id,
            storage_dir=str(tmp_path),
            failure_counter=failure_counter,
        )

    adapter = StrandsAgent(
        Agent(model=model, tools=[], agent_id="sync-failure-agent"),
        name="sync-failure",
        config=StrandsAgentConfig(
            session_manager_provider=session_manager_provider,
            tool_behaviors={
                tool.name: ToolBehavior(continue_after_frontend_call=False)
                for tool in _tools()
            },
        ),
    )
    first = await _collect(
        adapter,
        _input(
            thread_id,
            run_id="run-1",
            messages=[UserMessage(id="user-1", content="call both tools")],
        ),
    )
    _assert_success(first)

    failed = await _collect(
        adapter,
        _input(
            thread_id,
            run_id="run-2",
            messages=[
                ToolMessage(
                    id="result-1",
                    tool_call_id="native-0",
                    content="client-value",
                )
            ],
        ),
    )

    [error] = [event for event in failed if event.type == EventType.RUN_ERROR]
    assert "native frontend wait sync failed" in error.message
    assert EventType.RUN_FINISHED not in [event.type for event in failed]
    assert failure_counter == {"count": 1}


@pytest.mark.asyncio
async def test_partial_native_wait_survives_fresh_wrapper_and_continues_once(
    tmp_path: Path,
) -> None:
    thread_id = "partial-native-wait"
    model = _ParallelWaitModel()

    first_adapter = _adapter(model, tmp_path, thread_id)
    first = await _collect(
        first_adapter,
        _input(
            thread_id,
            run_id="run-1",
            messages=[UserMessage(id="user-1", content="call both tools")],
        ),
    )

    _assert_success(first)
    assert model.calls == 1
    assert [
        event.tool_call_id
        for event in first
        if event.type == EventType.TOOL_CALL_START
    ] == ["native-0", "native-1"]

    partial_adapter = _adapter(model, tmp_path, thread_id)
    partial = await _collect(
        partial_adapter,
        _input(
            thread_id,
            run_id="run-2",
            messages=[
                ToolMessage(
                    id="second-result",
                    tool_call_id="native-1",
                    content="second-value",
                )
            ],
        ),
    )

    _assert_success(partial)
    assert model.calls == 1
    partial_core = partial_adapter._agents_by_thread[thread_id]
    partial_interrupts = index_frontend_tool_interrupts(partial_core)
    assert set(partial_interrupts) == {"native-0", "native-1"}
    assert partial_interrupts["native-0"].response is None
    assert partial_interrupts["native-1"].response is not None
    assert "ag_ui_frontend_tool_wait" not in partial_core.state.get()

    final_adapter = _adapter(model, tmp_path, thread_id)
    final = await _collect(
        final_adapter,
        _input(
            thread_id,
            run_id="run-3",
            messages=[
                ToolMessage(
                    id="first-result",
                    tool_call_id="native-0",
                    content="first-value",
                )
            ],
        ),
    )

    _assert_success(final)
    assert model.calls == 2
    assert sum(event.type == EventType.TEXT_MESSAGE_START for event in final) == 1
    assert not any(event.type == EventType.TOOL_CALL_RESULT for event in partial)
    assert not any(event.type == EventType.TOOL_CALL_RESULT for event in final)
    final_messages = repr(model.seen_messages[-1])
    assert "first-value" in final_messages
    assert "second-value" in final_messages


@pytest.mark.asyncio
async def test_mixed_checkpoint_accepts_server_response_before_frontend_result(
    tmp_path: Path,
) -> None:
    thread_id = "mixed-native-wait"
    model = _MixedWaitModel()

    first_adapter = _adapter(
        model,
        tmp_path,
        thread_id,
        core_tools=[_server_approval],
    )
    first = await _collect(
        first_adapter,
        _input(
            thread_id,
            run_id="run-1",
            messages=[UserMessage(id="user-1", content="call both")],
        ),
    )

    assert model.calls == 1
    [first_finished] = [
        event for event in first if event.type == EventType.RUN_FINISHED
    ]
    assert first_finished.outcome.type == "interrupt"
    [server_interrupt] = first_finished.outcome.interrupts
    assert server_interrupt.reason == "server_approval"

    server_adapter = _adapter(
        model,
        tmp_path,
        thread_id,
        core_tools=[_server_approval],
    )
    server_only = await _collect(
        server_adapter,
        _input(
            thread_id,
            run_id="run-2",
            messages=[],
            resume=[
                ResumeEntry(
                    interrupt_id=server_interrupt.id,
                    status="resolved",
                    payload={"approved": True},
                )
            ],
        ),
    )

    _assert_success(server_only)
    assert model.calls == 1

    frontend_adapter = _adapter(
        model,
        tmp_path,
        thread_id,
        core_tools=[_server_approval],
    )
    final = await _collect(
        frontend_adapter,
        _input(
            thread_id,
            run_id="run-3",
            messages=[
                ToolMessage(
                    id="frontend-result",
                    tool_call_id="native-client",
                    content="frontend-value",
                )
            ],
        ),
    )

    _assert_success(final)
    assert model.calls == 2
    final_messages = repr(model.seen_messages[-1])
    assert "frontend-value" in final_messages
    assert "approved" in final_messages


@pytest.mark.asyncio
async def test_mixed_checkpoint_accepts_both_client_channels_in_one_request(
    tmp_path: Path,
) -> None:
    thread_id = "mixed-native-wait-combined"
    model = _MixedWaitModel()
    first_adapter = _adapter(
        model,
        tmp_path,
        thread_id,
        core_tools=[_server_approval],
    )
    first = await _collect(
        first_adapter,
        _input(
            thread_id,
            run_id="run-1",
            messages=[UserMessage(id="user-1", content="call both")],
        ),
    )
    [finished] = [event for event in first if event.type == EventType.RUN_FINISHED]
    [server_interrupt] = finished.outcome.interrupts

    resume_adapter = _adapter(
        model,
        tmp_path,
        thread_id,
        core_tools=[_server_approval],
    )
    resumed = await _collect(
        resume_adapter,
        _input(
            thread_id,
            run_id="run-2",
            messages=[
                ToolMessage(
                    id="frontend-result",
                    tool_call_id="native-client",
                    content="frontend-value",
                )
            ],
            resume=[
                ResumeEntry(
                    interrupt_id=server_interrupt.id,
                    status="resolved",
                    payload={"approved": True},
                )
            ],
        ),
    )

    _assert_success(resumed)
    assert model.calls == 2
    final_messages = repr(model.seen_messages[-1])
    assert "frontend-value" in final_messages
    assert "approved" in final_messages


@pytest.mark.asyncio
async def test_identical_partial_retry_is_a_successful_no_op(tmp_path: Path) -> None:
    """Re-sending a partial answer must not fail and must not resume anything.

    A client that retries a request it already delivered (a dropped response, a
    proxy retry) sends the same ``ToolMessage`` again. The checkpoint already
    holds that exact answer, so the run reports the unchanged pause rather than
    rejecting the retry or handing Strands a second copy.
    """
    thread_id = "idempotent-partial-retry"
    model = _ParallelWaitModel()

    first = await _collect(
        _adapter(model, tmp_path, thread_id),
        _input(
            thread_id,
            run_id="run-1",
            messages=[UserMessage(id="user-1", content="call both tools")],
        ),
    )
    _assert_success(first)

    partial_messages = [
        ToolMessage(id="second-result", tool_call_id="native-1", content="second-value")
    ]
    partial = await _collect(
        _adapter(model, tmp_path, thread_id),
        _input(thread_id, run_id="run-2", messages=partial_messages),
    )
    _assert_success(partial)
    assert model.calls == 1

    retry = await _collect(
        _adapter(model, tmp_path, thread_id),
        _input(thread_id, run_id="run-2-retry", messages=partial_messages),
    )

    _assert_success(retry)
    assert model.calls == 1

    retry_core = _adapter(model, tmp_path, thread_id)
    final = await _collect(
        retry_core,
        _input(
            thread_id,
            run_id="run-3",
            messages=[
                ToolMessage(
                    id="first-result", tool_call_id="native-0", content="first-value"
                )
            ],
        ),
    )
    _assert_success(final)
    assert model.calls == 2


@pytest.mark.asyncio
async def test_identical_completed_retry_does_not_run_the_model_again(
    tmp_path: Path,
) -> None:
    """Retrying the request that completed the wait is a no-op, not a rerun."""
    thread_id = "idempotent-completed-retry"
    model = _ParallelWaitModel()

    first = await _collect(
        _adapter(model, tmp_path, thread_id),
        _input(
            thread_id,
            run_id="run-1",
            messages=[UserMessage(id="user-1", content="call both tools")],
        ),
    )
    _assert_success(first)

    final_messages = [
        ToolMessage(id="first-result", tool_call_id="native-0", content="first-value"),
        ToolMessage(id="second-result", tool_call_id="native-1", content="second-value"),
    ]
    completed = await _collect(
        _adapter(model, tmp_path, thread_id),
        _input(thread_id, run_id="run-2", messages=final_messages),
    )
    _assert_success(completed)
    assert model.calls == 2

    retry = await _collect(
        _adapter(model, tmp_path, thread_id),
        _input(thread_id, run_id="run-2-retry", messages=final_messages),
    )

    _assert_success(retry)
    assert model.calls == 2

    divergent = await _collect(
        _adapter(model, tmp_path, thread_id),
        _input(
            thread_id,
            run_id="run-2-divergent",
            messages=[
                ToolMessage(
                    id="first-result", tool_call_id="native-0", content="changed"
                ),
                ToolMessage(
                    id="second-result",
                    tool_call_id="native-1",
                    content="second-value",
                ),
            ],
        ),
    )

    [error] = [event for event in divergent if event.type == EventType.RUN_ERROR]
    assert_contract_error(error, "FRONTEND_TOOL_RESULT_CONFLICT")
    assert model.calls == 2


@pytest.mark.asyncio
async def test_conflicting_retry_of_a_recorded_result_fails(tmp_path: Path) -> None:
    """A different answer for a call the checkpoint already holds is refused."""
    thread_id = "conflicting-retry"
    model = _ParallelWaitModel()

    await _collect(
        _adapter(model, tmp_path, thread_id),
        _input(
            thread_id,
            run_id="run-1",
            messages=[UserMessage(id="user-1", content="call both tools")],
        ),
    )
    await _collect(
        _adapter(model, tmp_path, thread_id),
        _input(
            thread_id,
            run_id="run-2",
            messages=[
                ToolMessage(
                    id="second-result",
                    tool_call_id="native-1",
                    content="second-value",
                )
            ],
        ),
    )

    conflicting = await _collect(
        _adapter(model, tmp_path, thread_id),
        _input(
            thread_id,
            run_id="run-3",
            messages=[
                ToolMessage(
                    id="second-result-again",
                    tool_call_id="native-1",
                    content="a-different-value",
                )
            ],
        ),
    )

    [error] = [event for event in conflicting if event.type == EventType.RUN_ERROR]
    assert_contract_error(error, "FRONTEND_TOOL_RESULT_CONFLICT")
    assert model.calls == 1


@pytest.mark.asyncio
async def test_full_history_completion_after_a_partial_answer_is_repeatable(
    tmp_path: Path,
) -> None:
    """A client sends its whole history, so a completing request repeats answers.

    The request that closes a partially-answered wait carries the result
    already recorded alongside the new one. Only the new answer is forwarded to
    Strands, but an exact HTTP retry of that request must still be recognised
    as the same request: on the retry the wait is closed, so both results read
    as new. Anything less makes a plain network retry fail.
    """
    thread_id = "full-history-completion-retry"
    model = _ParallelWaitModel()
    user_turn = UserMessage(id="user-1", content="call both tools")

    first = await _collect(
        _adapter(model, tmp_path, thread_id),
        _input(thread_id, run_id="run-1", messages=[user_turn]),
    )
    _assert_success(first)

    second_result = ToolMessage(
        id="second-result", tool_call_id="native-1", content="second-value"
    )
    partial = await _collect(
        _adapter(model, tmp_path, thread_id),
        _input(thread_id, run_id="run-2", messages=[user_turn, second_result]),
    )
    _assert_success(partial)
    assert model.calls == 1

    completing_messages = [
        user_turn,
        second_result,
        ToolMessage(id="first-result", tool_call_id="native-0", content="first-value"),
    ]
    completed = await _collect(
        _adapter(model, tmp_path, thread_id),
        _input(thread_id, run_id="run-3", messages=completing_messages),
    )
    _assert_success(completed)
    assert model.calls == 2

    retry = await _collect(
        _adapter(model, tmp_path, thread_id),
        _input(thread_id, run_id="run-3-retry", messages=completing_messages),
    )
    _assert_success(retry)
    assert model.calls == 2

    divergent = await _collect(
        _adapter(model, tmp_path, thread_id),
        _input(
            thread_id,
            run_id="run-3-divergent",
            messages=[
                user_turn,
                second_result,
                ToolMessage(
                    id="first-result", tool_call_id="native-0", content="changed"
                ),
            ],
        ),
    )
    [error] = [event for event in divergent if event.type == EventType.RUN_ERROR]
    assert_contract_error(error, "FRONTEND_TOOL_RESULT_CONFLICT")
    assert model.calls == 2


@pytest.mark.asyncio
async def test_toolless_continuation_answers_a_parked_wait_without_relooping(
    tmp_path: Path,
) -> None:
    """A continuation declaring no tools must not strip a parked proxy.

    A client that answers a waiting frontend tool without re-declaring its
    tools still owns a live native interrupt whose tool Strands is about to
    resume. Deregistering it makes the framework report the tool missing, and
    the model re-fires the same call instead of seeing the client's answer.
    """
    thread_id = "toolless-native-wait"
    model = _ParallelWaitModel()
    adapter = _adapter(model, tmp_path, thread_id)

    first = await _collect(
        adapter,
        _input(
            thread_id,
            run_id="run-1",
            messages=[UserMessage(id="user-1", content="call both tools")],
        ),
    )
    _assert_success(first)
    assert model.calls == 1

    final = await _collect(
        adapter,
        _input(
            thread_id,
            run_id="run-2",
            tools=[],
            messages=[
                ToolMessage(
                    id="first-result",
                    tool_call_id="native-0",
                    content="first-value",
                ),
                ToolMessage(
                    id="second-result",
                    tool_call_id="native-1",
                    content="second-value",
                ),
            ],
        ),
    )

    _assert_success(final)
    assert model.calls == 2
    assert not any(event.type == EventType.TOOL_CALL_START for event in final)
    final_messages = repr(model.seen_messages[-1])
    assert "first-value" in final_messages
    assert "second-value" in final_messages


@pytest.mark.asyncio
async def test_parked_proxy_exemption_lifts_once_the_wait_is_answered(
    tmp_path: Path,
) -> None:
    """The exemption tracks the checkpoint, so it never pins a proxy forever."""
    thread_id = "toolless-native-wait-release"
    model = _ParallelWaitModel()
    adapter = _adapter(model, tmp_path, thread_id)

    _assert_success(
        await _collect(
            adapter,
            _input(
                thread_id,
                run_id="run-1",
                messages=[UserMessage(id="user-1", content="call both tools")],
            ),
        )
    )

    _assert_success(
        await _collect(
            adapter,
            _input(
                thread_id,
                run_id="run-2",
                tools=[],
                messages=[
                    ToolMessage(
                        id="first-result",
                        tool_call_id="native-0",
                        content="first-value",
                    ),
                    ToolMessage(
                        id="second-result",
                        tool_call_id="native-1",
                        content="second-value",
                    ),
                ],
            ),
        )
    )
    core = adapter._agents_by_thread[thread_id]
    assert {tool.name for tool in _tools()} <= set(core.tool_registry.registry)

    _assert_success(
        await _collect(
            adapter,
            _input(
                thread_id,
                run_id="run-3",
                tools=[],
                messages=[UserMessage(id="user-2", content="anything else")],
            ),
        )
    )

    assert not {tool.name for tool in _tools()} & set(core.tool_registry.registry)
    assert adapter._proxy_tool_names_by_thread[thread_id] == set()


@pytest.mark.asyncio
async def test_retained_proxy_stays_a_frontend_tool_on_a_toolless_turn(
    tmp_path: Path,
) -> None:
    """A proxy kept for a parked wait must not read as a backend tool.

    The turn's frontend-tool set is built from the client's declarations, which
    a toolless continuation leaves empty. A proxy retained for the checkpoint is
    still offered to the model, so classifying it as backend makes the adapter
    answer a re-fire itself: it publishes a result the client never produced and
    parks a fresh interrupt nobody is told about, wedging the next turn.
    """
    thread_id = "toolless-refire"
    model = _RefiringWaitModel()
    adapter = _adapter(model, tmp_path, thread_id)

    _assert_success(
        await _collect(
            adapter,
            _input(
                thread_id,
                run_id="run-1",
                messages=[UserMessage(id="user-1", content="call the tool")],
            ),
        )
    )

    second = await _collect(
        adapter,
        _input(
            thread_id,
            run_id="run-2",
            tools=[],
            messages=[
                ToolMessage(
                    id="first-result",
                    tool_call_id="native-1",
                    content="answer-one",
                )
            ],
        ),
    )

    _assert_success(second)
    # The re-fire is a frontend call: the client is asked to run it, rather than
    # being handed a result the server invented for a tool it never executed.
    assert [
        event.tool_call_name
        for event in second
        if event.type == EventType.TOOL_CALL_START
    ] == ["first_client_tool"]
    assert not any(event.type == EventType.TOOL_CALL_RESULT for event in second)

    # A re-fire the client was actually asked to run can be answered; one the
    # adapter answered itself leaves a checkpoint that refuses every later turn.
    third = await _collect(
        adapter,
        _input(
            thread_id,
            run_id="run-3",
            tools=[],
            messages=[
                ToolMessage(
                    id="second-result",
                    tool_call_id="native-2",
                    content="answer-two",
                )
            ],
        ),
    )
    _assert_success(third)


@pytest.mark.asyncio
async def test_toolless_continuation_after_a_restart_fails_loudly(
    tmp_path: Path,
) -> None:
    """A parked wait whose tool this process never registered must not proceed.

    Proxy registrations live in memory, so a process that restarts between
    turns holds none. A continuation that also declares no tools leaves the
    checkpoint with nothing to resume into: Strands reports the tool missing,
    the client's answer is replaced by an error the model then acts on, and the
    run still reports success. Refusing the turn tells the caller what to do
    (re-declare the tool) instead of silently discarding the answer.
    """
    thread_id = "restarted-native-wait"
    model = _ParallelWaitModel()

    _assert_success(
        await _collect(
            _adapter(model, tmp_path, thread_id),
            _input(
                thread_id,
                run_id="run-1",
                messages=[UserMessage(id="user-1", content="call both tools")],
            ),
        )
    )

    restarted = _adapter(model, tmp_path, thread_id)
    events = await _collect(
        restarted,
        _input(
            thread_id,
            run_id="run-2",
            tools=[],
            messages=[
                ToolMessage(
                    id="first-result",
                    tool_call_id="native-0",
                    content="first-value",
                )
            ],
        ),
    )

    [error] = [e for e in events if e.type == EventType.RUN_ERROR]
    assert_contract_error(error, "FRONTEND_TOOL_NOT_REGISTERED")
    assert "first_client_tool" in error.message
    assert not any(e.type == EventType.RUN_FINISHED for e in events)
    assert model.calls == 1

    # Re-declaring the tools is the documented way out, and it still works.
    recovered = await _collect(
        _adapter(model, tmp_path, thread_id),
        _input(
            thread_id,
            run_id="run-3",
            messages=[
                ToolMessage(
                    id="first-result",
                    tool_call_id="native-0",
                    content="first-value",
                ),
                ToolMessage(
                    id="second-result",
                    tool_call_id="native-1",
                    content="second-value",
                ),
            ],
        ),
    )
    _assert_success(recovered)
    assert "first-value" in repr(model.seen_messages[-1])


@pytest.mark.asyncio
async def test_partial_tool_list_keeps_a_parked_proxy_registered(
    tmp_path: Path,
) -> None:
    """Declaring some tools must not strip a parked one.

    A client that re-declares only the tools it still offers is the same hazard
    as one that declares none: the proxy Strands is about to resume disappears
    from the registry because this turn's list omits it.
    """
    thread_id = "partial-list-native-wait"
    model = _ParallelWaitModel()
    adapter = _adapter(model, tmp_path, thread_id)

    _assert_success(
        await _collect(
            adapter,
            _input(
                thread_id,
                run_id="run-1",
                messages=[UserMessage(id="user-1", content="call both tools")],
            ),
        )
    )

    final = await _collect(
        adapter,
        _input(
            thread_id,
            run_id="run-2",
            tools=[_tools()[1]],
            messages=[
                ToolMessage(
                    id="first-result",
                    tool_call_id="native-0",
                    content="first-value",
                ),
                ToolMessage(
                    id="second-result",
                    tool_call_id="native-1",
                    content="second-value",
                ),
            ],
        ),
    )

    _assert_success(final)
    assert model.calls == 2
    final_messages = repr(model.seen_messages[-1])
    assert "first-value" in final_messages
    assert "second-value" in final_messages


@pytest.mark.asyncio
async def test_a_native_wait_is_not_recorded_as_a_reconcilable_call(
    tmp_path: Path,
) -> None:
    """Waiting tools produce no placeholder, so they belong in no provenance.

    The recorded ids exist to admit a returning result into placeholder
    reconciliation. A native wait never writes a placeholder, so recording it
    makes the next turn try to correct one that was never there, fail, and drop
    the whole turn to the legacy path.
    """
    thread_id = "native-wait-not-recorded"
    adapter = _adapter(_ParallelWaitModel(), tmp_path, thread_id)

    _assert_success(
        await _collect(
            adapter,
            _input(
                thread_id,
                run_id="run-1",
                messages=[UserMessage(id="user-1", content="call both tools")],
            ),
        )
    )

    core = adapter._agents_by_thread[thread_id]
    assert not core.state.get(AG_UI_FRONTEND_CALL_IDS_STATE_KEY)


@pytest.mark.asyncio
async def test_cancelling_a_parked_wait_needs_the_tool_too(tmp_path: Path) -> None:
    """Cancelling is delivered into the tool body, so it needs it registered.

    A cancelled entry carries a real response that Strands hands to the proxy,
    exactly like an answer. Waving cancellation past the registration check
    lets the same silent substitution through: the run reports success while
    the framework's "tool not found" text lands in the thread's history.
    """
    thread_id = "restarted-cancel"
    model = _ParallelWaitModel()

    first_adapter = _adapter(model, tmp_path, thread_id)
    _assert_success(
        await _collect(
            first_adapter,
            _input(
                thread_id,
                run_id="run-1",
                messages=[UserMessage(id="user-1", content="call both tools")],
            ),
        )
    )
    parked = index_frontend_tool_interrupts(
        first_adapter._agents_by_thread[thread_id]
    )
    assert set(parked) == {"native-0", "native-1"}
    cancellations = [
        ResumeEntry(interrupt_id=interrupt.id, status="cancelled")
        for interrupt in parked.values()
    ]

    refused_adapter = _adapter(model, tmp_path, thread_id)
    refused = await _collect(
        refused_adapter,
        _input(
            thread_id,
            run_id="run-2",
            tools=[],
            messages=[UserMessage(id="user-2", content="never mind")],
            resume=cancellations,
        ),
    )
    [error] = [e for e in refused if e.type == EventType.RUN_ERROR]
    assert_contract_error(error, "FRONTEND_TOOL_NOT_REGISTERED")
    assert not any(e.type == EventType.RUN_FINISHED for e in refused)
    # This is where the regression would land: without the gate the checkpoint
    # resumes into nothing and the framework's text replaces the cancellation.
    refused_core = refused_adapter._agents_by_thread[thread_id]
    assert "Unknown tool" not in repr(refused_core.messages)

    # Re-declaring the tools is the way out, and cancelling then works.
    accepted = await _collect(
        _adapter(model, tmp_path, thread_id),
        _input(
            thread_id,
            run_id="run-3",
            messages=[UserMessage(id="user-3", content="never mind")],
            resume=cancellations,
        ),
    )
    _assert_success(accepted)


@pytest.mark.asyncio
async def test_a_native_tool_under_the_parked_name_does_not_satisfy_the_gate(
    tmp_path: Path,
) -> None:
    """The parked wait needs OUR proxy back, not merely the name occupied.

    Checking the registry for the name alone lets an unrelated server tool
    stand in: the run proceeds, Strands resumes into that tool instead, and the
    client's answer is swallowed by something it never called.
    """
    thread_id = "squatted-native-wait"
    model = _RefiringWaitModel()

    _assert_success(
        await _collect(
            _adapter(model, tmp_path, thread_id),
            _input(
                thread_id,
                run_id="run-1",
                messages=[UserMessage(id="user-1", content="call the tool")],
            ),
        )
    )

    restarted = _adapter(
        model, tmp_path, thread_id, core_tools=[_squatting_native]
    )
    events = await _collect(
        restarted,
        _input(
            thread_id,
            run_id="run-2",
            tools=[],
            messages=[
                ToolMessage(
                    id="first-result",
                    tool_call_id="native-1",
                    content="first-value",
                )
            ],
        ),
    )

    [error] = [e for e in events if e.type == EventType.RUN_ERROR]
    assert_contract_error(error, "FRONTEND_TOOL_NOT_REGISTERED")
    assert not any(e.type == EventType.RUN_FINISHED for e in events)
    core = restarted._agents_by_thread[thread_id]
    assert "the server ran this" not in repr(core.messages)
