"""A run whose message batches are all skipped must still emit a terminal event.

`ADKAgent.run` walks `unseen_messages` in batches and has three `continue` paths that
dispatch nothing: an orphaned tool-result batch (no matching pending tool call), an
assistant-only batch, and a non-tool batch whose following tool batch will be skipped.
When *every* batch takes one of those paths the loop used to fall off the end having
called `_start_new_execution` zero times, so the generator yielded nothing at all — no
RUN_STARTED, no RUN_FINISHED, no RUN_ERROR. A conforming client has nothing to finalize
on and hangs (CopilotKit surfaces this as INCOMPLETE_STREAM, "Run ended without emitting
a terminal event").

The most common way in is a client re-sending history the server no longer recognizes as
processed — `AbstractAgent.prepareRunAgentInput` re-sends the whole list on every run, and
`_processed_message_ids` is in-memory, so it is empty after a restart or a session-timeout
eviction.

The fix emits a bare RUN_STARTED/RUN_FINISHED pair rather than falling through to
`_start_new_execution(input)`: that path re-answers the latest message in `input.messages`
(see `_convert_latest_message`), which would turn a no-op request into a duplicate agent
turn.
"""

from __future__ import annotations

from typing import AsyncGenerator, List, Tuple

import pytest
import pytest_asyncio

from ag_ui.core import (
    AssistantMessage,
    RunAgentInput,
    Tool as AGUITool,
    ToolMessage,
    UserMessage,
)
from ag_ui_adk import ADKAgent
from ag_ui_adk.agui_toolset import AGUIToolset
from ag_ui_adk.session_manager import SessionManager

from google.adk.agents import LlmAgent
from google.adk.apps import App
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.adk.sessions import InMemorySessionService
from google.genai import types


HITL_TOOL = "ask_choice"


class _RecordingLlm(BaseLlm):
    """Answers with fixed text and records that it was called at all.

    The point of these tests is mostly that this model is *never* reached: a run with no
    new work must not produce an agent turn.
    """

    model: str = "recording-llm"
    calls: int = 0

    async def generate_content_async(
        self, llm_request, stream: bool = False
    ) -> AsyncGenerator[LlmResponse, None]:
        self.calls += 1
        yield LlmResponse(
            content=types.Content(
                role="model", parts=[types.Part(text="model was invoked")]
            )
        )


class _CallsToolThenAnswersLlm(BaseLlm):
    """Turn 1 calls a client-side tool (long-running, so the run pauses on it);
    every later turn answers with text.

    Needed to exercise the `_handle_tool_result_submission` dispatch path — the other
    place the terminal-event flag is set. Without a genuinely *pending* tool call, a
    submitted tool result is skipped rather than dispatched.
    """

    model: str = "calls-tool-llm"
    tool_name: str = HITL_TOOL
    calls: int = 0

    async def generate_content_async(
        self, llm_request, stream: bool = False
    ) -> AsyncGenerator[LlmResponse, None]:
        self.calls += 1
        if self.calls == 1:
            yield LlmResponse(
                content=types.Content(
                    role="model",
                    parts=[
                        types.Part(
                            function_call=types.FunctionCall(
                                name=self.tool_name, args={}
                            )
                        )
                    ],
                ),
                partial=False,
                turn_complete=True,
            )
        else:
            yield LlmResponse(
                content=types.Content(
                    role="model", parts=[types.Part(text="thanks, done")]
                ),
                partial=False,
                turn_complete=True,
            )


def _tool(name: str) -> AGUITool:
    return AGUITool(
        name=name,
        description=f"{name} tool",
        parameters={"type": "object", "properties": {}},
    )


@pytest_asyncio.fixture
async def reset_session_manager():
    SessionManager.reset_instance()
    yield
    SessionManager.reset_instance()


def _make_agent(llm: BaseLlm) -> ADKAgent:
    return ADKAgent.from_app(
        App(
            name="skipped_run",
            root_agent=LlmAgent(
                name="SkippedRunAgent",
                model=llm,
                tools=[AGUIToolset()],
                instruction="Answer the user.",
            ),
        ),
        user_id="user_1",
        session_service=InMemorySessionService(),
    )


async def _run(adk: ADKAgent, thread_id: str, messages, tools=None) -> Tuple[List[str], List]:
    """Drive one AG-UI run; return (event type names, events)."""
    events = []
    async for event in adk.run(
        RunAgentInput(
            thread_id=thread_id,
            run_id="run_1",
            state={},
            messages=messages,
            tools=tools if tools is not None else [_tool("some_tool")],
            context=[],
            forwarded_props={},
        )
    ):
        events.append(event)
    return [type(e).__name__ for e in events], events


_HISTORY = [
    UserMessage(id="m1", role="user", content="build me an audience"),
    AssistantMessage(id="m2", role="assistant", content="working on it"),
    ToolMessage(id="m3", role="tool", content='{"ok": true}', tool_call_id="call_stale"),
]


async def _settled_thread_with_lost_dedupe(adk: ADKAgent, thread_id: str) -> None:
    """Reach the state where every batch will be skipped.

    Two conditions have to hold together, and neither is reachable from a bare replay:

    1. **The session must already exist**, so `_get_pending_tool_call_ids` returns `[]`
       rather than `None`. On a thread the middleware has never seen it returns `None`,
       and `should_process_tool_batch` is left `True` — the batch dispatches and the
       skip path is never taken.
    2. **The in-memory dedupe map must be empty**, which is what a process restart or a
       `session_timeout_seconds` eviction produces, and is why the client's replayed
       history reads as entirely unseen.
    """
    await _run(adk, thread_id, [UserMessage(id="m0", role="user", content="hi")])
    adk._session_manager._processed_message_ids.clear()


@pytest.mark.asyncio
async def test_all_batches_skipped_still_emits_a_terminal_event(reset_session_manager):
    """The regression: this yielded zero events, so the client hung."""
    llm = _RecordingLlm()
    adk = _make_agent(llm)
    await _settled_thread_with_lost_dedupe(adk, "thread_skipped")

    names, _ = await _run(adk, "thread_skipped", _HISTORY)

    assert names, "run emitted no events at all — the client has nothing to finalize on"
    assert "RunFinishedEvent" in names or "RunErrorEvent" in names, (
        f"no terminal event in {names}"
    )


@pytest.mark.asyncio
async def test_skipped_run_does_not_fabricate_an_agent_turn(reset_session_manager):
    """The reason for a bare pair rather than a fall-through to _start_new_execution.

    That path calls `_convert_latest_message(input, input.messages)`, which reverse-scans
    for the last user message — so a no-op request would re-answer the previous question:
    a duplicate reply, a duplicate session event, and a billed model call.
    """
    llm = _RecordingLlm()
    adk = _make_agent(llm)
    await _settled_thread_with_lost_dedupe(adk, "thread_no_turn")
    calls_before = llm.calls

    names, _ = await _run(adk, "thread_no_turn", _HISTORY)

    assert llm.calls == calls_before, (
        f"the model was invoked {llm.calls - calls_before}x on a run with no new work — "
        "the skipped-run path is re-answering history"
    )
    assert "TextMessageStartEvent" not in names, f"unexpected assistant turn in {names}"


@pytest.mark.asyncio
async def test_a_dispatchable_batch_is_unaffected(reset_session_manager):
    """Control: a run carrying real new work still reaches the model and streams a reply."""
    llm = _RecordingLlm()
    adk = _make_agent(llm)

    names, _ = await _run(
        adk,
        "thread_dispatch",
        [UserMessage(id="m1", role="user", content="hello")],
    )

    assert llm.calls == 1, f"expected exactly one model call, got {llm.calls}"
    assert "RunFinishedEvent" in names, f"no clean terminal in {names}"


@pytest.mark.asyncio
async def test_synthesized_pair_is_exactly_two_correlated_events(reset_session_manager):
    """Pins the shape and the correlation ids, not just "a terminal appeared".

    Membership assertions let two bugs through: emitting the pair unconditionally, and
    emitting it with ids the client cannot correlate to the run it asked for.
    """
    llm = _RecordingLlm()
    adk = _make_agent(llm)
    await _settled_thread_with_lost_dedupe(adk, "thread_shape")

    names, events = await _run(adk, "thread_shape", _HISTORY)

    assert names == ["RunStartedEvent", "RunFinishedEvent"], (
        f"expected exactly a terminal pair, got {names}"
    )
    for event in events:
        assert event.thread_id == "thread_shape", f"wrong thread_id on {type(event).__name__}"
        assert event.run_id == "run_1", f"wrong run_id on {type(event).__name__}"


@pytest.mark.asyncio
async def test_pending_tool_result_dispatches_without_an_extra_pair(reset_session_manager):
    """Covers the second place the flag is set — `_handle_tool_result_submission`.

    Every other test reaches the loop's `_start_new_execution` branch, so without this
    the tool-result branch could stop setting the flag and nothing would notice: a HITL
    resume would gain a spurious trailing RUN_STARTED/RUN_FINISHED.
    """
    llm = _CallsToolThenAnswersLlm()
    adk = _make_agent(llm)
    tools = [_tool(HITL_TOOL)]

    # Turn 1: the model calls the client tool, so the run pauses with it pending.
    _, events = await _run(
        adk, "thread_pending", [UserMessage(id="p1", role="user", content="ask me")], tools
    )
    tool_call_ids = [e.tool_call_id for e in events if type(e).__name__ == "ToolCallStartEvent"]
    assert tool_call_ids, "fixture did not produce a pending client tool call"

    # Turn 2: answer it. This must dispatch, not skip.
    names, _ = await _run(
        adk,
        "thread_pending",
        [
            UserMessage(id="p1", role="user", content="ask me"),
            ToolMessage(
                id="p2", role="tool", content='{"choice": "a"}', tool_call_id=tool_call_ids[0]
            ),
        ],
        tools,
    )

    assert names.count("RunStartedEvent") == 1, (
        f"expected one run, got {names.count('RunStartedEvent')} — a spurious pair was "
        f"appended to a dispatched turn: {names}"
    )
    assert llm.calls >= 2, "the tool result did not resume the agent"


@pytest.mark.asyncio
async def test_new_message_alongside_skipped_history_runs_once(reset_session_manager):
    """The realistic reload-then-type flow: stale history plus genuine new work.

    Some batches skip and one dispatches, so the guard must NOT fire. Asserting the
    count rather than membership is what catches an unconditional pair.
    """
    llm = _RecordingLlm()
    adk = _make_agent(llm)
    await _settled_thread_with_lost_dedupe(adk, "thread_mixed")
    calls_before = llm.calls

    names, _ = await _run(
        adk,
        "thread_mixed",
        [*_HISTORY, UserMessage(id="m4", role="user", content="make it broader")],
    )

    assert llm.calls == calls_before + 1, (
        f"expected exactly one model call, got {llm.calls - calls_before}"
    )
    assert names.count("RunStartedEvent") == 1, (
        f"a spurious terminal pair was appended to a dispatched turn: {names}"
    )


@pytest.mark.asyncio
async def test_assistant_only_batch_is_skipped_and_terminated(reset_session_manager):
    """Covers the assistant-only `continue` on its own.

    In `_HISTORY` the assistant message is absorbed into the preceding user batch, so
    that path is never taken alone there — it is a distinct branch that can regress
    independently.
    """
    llm = _RecordingLlm()
    adk = _make_agent(llm)
    await _settled_thread_with_lost_dedupe(adk, "thread_assistant_only")
    calls_before = llm.calls

    names, _ = await _run(
        adk,
        "thread_assistant_only",
        [AssistantMessage(id="a1", role="assistant", content="an earlier reply")],
    )

    assert names == ["RunStartedEvent", "RunFinishedEvent"], (
        f"expected a terminal pair, got {names}"
    )
    assert llm.calls == calls_before, "an assistant-only batch must not drive a turn"


@pytest.mark.asyncio
async def test_no_messages_at_all_terminates_without_a_turn(reset_session_manager):
    """An empty message list has nothing to act on."""
    llm = _RecordingLlm()
    adk = _make_agent(llm)

    names, _ = await _run(adk, "thread_empty", [])

    assert names == ["RunStartedEvent", "RunFinishedEvent"], (
        f"expected a terminal pair, got {names}"
    )
    assert llm.calls == 0, "an empty message list must not drive a turn"


@pytest.mark.asyncio
async def test_fully_processed_history_does_not_re_answer(reset_session_manager):
    """The empty-`unseen` branch must not recover a message by scanning history.

    `_start_new_execution` resolves a missing `new_message` via
    `_convert_latest_message`, which reverse-scans `input.messages` for the last user
    message. Reaching it with a fully-processed history re-answers a question that was
    already answered.
    """
    llm = _RecordingLlm()
    adk = _make_agent(llm)
    first = [UserMessage(id="q1", role="user", content="what is in my cart?")]
    await _run(adk, "thread_answered", first)
    calls_before = llm.calls

    # Same list again: everything is now processed, so nothing is unseen.
    names, _ = await _run(adk, "thread_answered", first)

    assert llm.calls == calls_before, (
        f"the model ran {llm.calls - calls_before}x on a fully-processed history — "
        "the last user message is being re-answered"
    )
    assert names == ["RunStartedEvent", "RunFinishedEvent"], (
        f"expected a terminal pair, got {names}"
    )


@pytest.mark.asyncio
async def test_two_consecutive_no_work_runs_are_both_inert(reset_session_manager):
    """The skipped run marks its messages processed, so the *second* identical request
    reaches the empty-`unseen` branch by a different route. Both must be inert.

    Before this change the first hung and the second re-answered history.
    """
    llm = _RecordingLlm()
    adk = _make_agent(llm)
    await _settled_thread_with_lost_dedupe(adk, "thread_twice")
    calls_before = llm.calls

    first, _ = await _run(adk, "thread_twice", _HISTORY)
    second, _ = await _run(adk, "thread_twice", _HISTORY)

    assert first == ["RunStartedEvent", "RunFinishedEvent"], f"run 1: {first}"
    assert second == ["RunStartedEvent", "RunFinishedEvent"], f"run 2: {second}"
    assert llm.calls == calls_before, (
        f"the model ran {llm.calls - calls_before}x across two no-work runs"
    )
