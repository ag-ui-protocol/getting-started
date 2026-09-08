#!/usr/bin/env python
"""Regression tests for resuming a turn with MULTIPLE long-running tool calls.

When a single model turn emits more than one long-running (client / HITL) tool
call, the client returns the results independently — an instant frontend
``render`` tool resolves before a human-in-the-loop ``ask_user_choice`` tool, so
they arrive in separate submissions. Before the "all-results" gate, ag-ui-adk
treated each tool result as a standalone resume (``_handle_tool_result_submission``:
*"all tool results are standalone and should start new executions"*), so the
first result resumed the model while the other call was still unanswered. The
replayed turn then carried N function-call parts but fewer than N
function-response parts, which Gemini rejects with::

    400 INVALID_ARGUMENT: Please ensure that the number of function response
    parts is equal to the number of function call parts of the function call
    turn.

The fix gates the resume: while any long-running call from the turn is still
pending, the arriving results are persisted (so they survive and ADK merges
them later) but the model is NOT resumed. It resumes once — when the last
result lands and ``pending_tool_calls`` is empty.

These tests use a scripted LLM (no network) so the mismatch is caught
deterministically: the LLM records the function-call/function-response balance
of every request it receives, and we assert it is never handed a turn whose
responses don't match its calls. A single-call control test guards that the
gate does NOT defer the ordinary one-tool HITL case.
"""

from __future__ import annotations

import logging
import uuid
from typing import AsyncGenerator, Dict, List, Tuple

import pytest
import pytest_asyncio
from pydantic import Field

from ag_ui.core import (
    AssistantMessage,
    FunctionCall,
    RunAgentInput,
    Tool as AGUITool,
    ToolCall,
    ToolMessage,
    UserMessage,
)

from ag_ui_adk import ADKAgent
from ag_ui_adk.agui_toolset import AGUIToolset
from ag_ui_adk.session_manager import SessionManager

from google.adk.agents import LlmAgent
from google.adk.apps import App, ResumabilityConfig
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.adk.sessions import InMemorySessionService
from google.genai import types


TOOL_A = "render_card"  # instant client tool (resolves immediately)
TOOL_B = "ask_choice"  # HITL client tool (waits for the user)


def _count_calls_and_responses(llm_request) -> Tuple[int, int]:
    """Count function_call vs function_response parts in an ADK LlmRequest."""
    fc = fr = 0
    for content in getattr(llm_request, "contents", None) or []:
        for part in getattr(content, "parts", None) or []:
            if getattr(part, "function_call", None) is not None:
                fc += 1
            if getattr(part, "function_response", None) is not None:
                fr += 1
    return fc, fr


class _LroThenTextLlm(BaseLlm):
    """Turn 1: emit one function call per name in ``tool_names`` (all wired as
    long-running client tools). Every later turn: emit final text.

    Records the ``(function_calls, function_responses)`` balance of each request
    so a test can assert the model is never handed a turn whose function
    responses don't match its function calls (the exact thing Gemini 400s on).
    """

    tool_names: List[str] = Field(default_factory=lambda: [TOOL_A, TOOL_B])
    turn_count: int = 0
    request_balances: List[Tuple[int, int]] = Field(default_factory=list)

    async def generate_content_async(
        self, llm_request, stream: bool = False
    ) -> AsyncGenerator[LlmResponse, None]:
        self.turn_count += 1
        self.request_balances.append(_count_calls_and_responses(llm_request))
        if self.turn_count == 1:
            yield LlmResponse(
                content=types.Content(
                    role="model",
                    parts=[
                        types.Part(
                            function_call=types.FunctionCall(name=name, args={})
                        )
                        for name in self.tool_names
                    ],
                ),
                partial=False,
                turn_complete=True,
            )
        else:
            yield LlmResponse(
                content=types.Content(
                    role="model",
                    parts=[types.Part(text="All tools are done.")],
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


def _make_agent(llm: _LroThenTextLlm) -> ADKAgent:
    return ADKAgent.from_app(
        App(
            name="multi_lro",
            root_agent=LlmAgent(
                name="MultiLroAgent",
                model=llm,
                tools=[AGUIToolset()],
                instruction="Call the tools.",
            ),
            resumability_config=ResumabilityConfig(is_resumable=True),
        ),
        user_id="user_1",
        session_service=InMemorySessionService(),
    )


async def _run(adk: ADKAgent, thread_id: str, run_id: str, messages):
    """Drive one AG-UI run; return (tool_call_ids_by_name, run_error_or_None).

    The second element is the ``RunErrorEvent`` if one was emitted (falsy
    otherwise), so callers can both ``assert not err`` and inspect ``err.code``.
    """
    start_ids: Dict[str, str] = {}
    run_error = None
    async for event in adk.run(
        RunAgentInput(
            thread_id=thread_id,
            run_id=run_id,
            state={},
            messages=messages,
            tools=[_tool(TOOL_A), _tool(TOOL_B)],
            context=[],
            forwarded_props={},
        )
    ):
        name = type(event).__name__
        if name == "ToolCallStartEvent":
            start_ids[event.tool_call_name] = event.tool_call_id
        elif name == "RunErrorEvent":
            run_error = event
    return start_ids, run_error


def _assert_no_mismatch(llm: _LroThenTextLlm) -> None:
    """The model must never be handed a turn whose function responses don't
    match its function calls (a Gemini 400)."""
    mismatched = [
        (fc, fr) for (fc, fr) in llm.request_balances if fr > 0 and fc != fr
    ]
    assert not mismatched, (
        f"Model received request(s) with mismatched function call/response "
        f"counts {mismatched} (would 400 on Gemini). "
        f"All balances seen: {llm.request_balances}"
    )


class TestMultiLroResumeGating:
    @pytest.mark.asyncio
    async def test_partial_result_does_not_resume_model(
        self, reset_session_manager
    ):
        """Two long-running calls in one turn → the first result must NOT resume
        the model; the model resumes once, after the second result."""
        llm = _LroThenTextLlm(model="scripted", tool_names=[TOOL_A, TOOL_B])
        adk = _make_agent(llm)
        thread_id = str(uuid.uuid4())

        # --- Run 1: one model turn emits two long-running tool calls ---
        start_ids, err1 = await _run(
            adk, thread_id, "r1", [UserMessage(id="u1", content="Use both tools.")]
        )
        assert not err1
        assert set(start_ids) == {TOOL_A, TOOL_B}, start_ids
        assert llm.turn_count == 1
        id_a, id_b = start_ids[TOOL_A], start_ids[TOOL_B]

        pending = await adk._get_pending_tool_call_ids(thread_id, "user_1")
        assert set(pending or []) == {id_a, id_b}, (
            f"both LRO calls should be pending after run 1, got {pending}"
        )

        assistant = AssistantMessage(
            id="a1",
            content=None,
            tool_calls=[
                ToolCall(id=id_a, function=FunctionCall(name=TOOL_A, arguments="{}")),
                ToolCall(id=id_b, function=FunctionCall(name=TOOL_B, arguments="{}")),
            ],
        )
        history = [UserMessage(id="u1", content="Use both tools."), assistant]

        # --- Run 2: only tool_a's result (tool_b still pending) ---
        _, err2 = await _run(
            adk,
            thread_id,
            "r2",
            history + [ToolMessage(id="t_a", content='{"ok": true}', tool_call_id=id_a)],
        )
        assert not err2
        assert llm.turn_count == 1, (
            f"Model was resumed after only the first of two long-running results "
            f"(turn_count={llm.turn_count}); that turn has 2 calls / 1 response "
            f"→ Gemini 400."
        )
        pending = await adk._get_pending_tool_call_ids(thread_id, "user_1")
        assert set(pending or []) == {id_b}, (
            f"tool_a resolved, tool_b still pending; got {pending}"
        )

        # --- Run 3: tool_b's result → turn complete, resume once ---
        _, err3 = await _run(
            adk,
            thread_id,
            "r3",
            history
            + [
                ToolMessage(id="t_a", content='{"ok": true}', tool_call_id=id_a),
                ToolMessage(id="t_b", content='{"ok": true}', tool_call_id=id_b),
            ],
        )
        assert not err3
        assert llm.turn_count == 2, (
            f"Model should resume exactly once, after BOTH results are in "
            f"(turn_count={llm.turn_count})."
        )
        pending = await adk._get_pending_tool_call_ids(thread_id, "user_1")
        assert not (pending or []), f"no calls should remain pending, got {pending}"

        _assert_no_mismatch(llm)

    @pytest.mark.asyncio
    async def test_single_lro_resumes_immediately(self, reset_session_manager):
        """Control: a turn with ONE long-running call must resume as soon as its
        result arrives — the gate must not defer the ordinary HITL case."""
        llm = _LroThenTextLlm(model="scripted", tool_names=[TOOL_A])
        adk = _make_agent(llm)
        thread_id = str(uuid.uuid4())

        start_ids, err1 = await _run(
            adk, thread_id, "r1", [UserMessage(id="u1", content="Use one tool.")]
        )
        assert not err1
        assert set(start_ids) == {TOOL_A}, start_ids
        assert llm.turn_count == 1
        id_a = start_ids[TOOL_A]

        assistant = AssistantMessage(
            id="a1",
            content=None,
            tool_calls=[
                ToolCall(id=id_a, function=FunctionCall(name=TOOL_A, arguments="{}"))
            ],
        )

        # Submit the single result → the model resumes immediately.
        _, err2 = await _run(
            adk,
            thread_id,
            "r2",
            [
                UserMessage(id="u1", content="Use one tool."),
                assistant,
                ToolMessage(id="t_a", content='{"ok": true}', tool_call_id=id_a),
            ],
        )
        assert not err2
        assert llm.turn_count == 2, (
            f"Single-call turn must resume on its result (turn_count={llm.turn_count})."
        )
        pending = await adk._get_pending_tool_call_ids(thread_id, "user_1")
        assert not (pending or []), f"no calls should remain pending, got {pending}"

        _assert_no_mismatch(llm)

    @pytest.mark.asyncio
    async def test_orphaned_pending_call_does_not_gate_resume(
        self, reset_session_manager, caplog
    ):
        """A leaked/orphaned ``pending_tool_calls`` entry from OUTSIDE the
        arriving turn must not gate the resume forever.

        ``pending_tool_calls`` is thread-global. If a stale id lingers — e.g. a
        call the model re-issued under a fresh id, orphaning the original
        (observed on main) — the unscoped gate would treat every later
        single-result submission as "still pending" and buffer it forever, so
        the model silently stops responding. The gate is scoped to the arriving
        turn's invocation, so an orphan that matches no FunctionCall in this turn
        is ignored (and surfaced at WARNING for diagnosability), and the resume
        proceeds.
        """
        llm = _LroThenTextLlm(model="scripted", tool_names=[TOOL_A])
        adk = _make_agent(llm)
        thread_id = str(uuid.uuid4())

        # --- Run 1: a single long-running call ---
        start_ids, err1 = await _run(
            adk, thread_id, "r1", [UserMessage(id="u1", content="Use one tool.")]
        )
        assert not err1
        id_a = start_ids[TOOL_A]

        # Inject a leaked pending entry belonging to NO call in this turn,
        # simulating orphaned pending state left behind by an earlier turn.
        session_id, app_name, user_id = adk._get_session_metadata(thread_id, "user_1")
        await adk._add_pending_tool_call_with_context(
            thread_id, "orphan-call-id", app_name, user_id
        )
        pending = await adk._get_pending_tool_call_ids(thread_id, "user_1")
        assert set(pending or []) == {id_a, "orphan-call-id"}, pending

        assistant = AssistantMessage(
            id="a1",
            content=None,
            tool_calls=[
                ToolCall(id=id_a, function=FunctionCall(name=TOOL_A, arguments="{}"))
            ],
        )

        # --- Run 2: submit the real call's result ---
        # Pre-fix: the orphan keeps the (unscoped) pending set non-empty → the
        # result is buffered forever and the model never resumes. Post-fix: the
        # orphan isn't part of this turn, so it's dropped from the gate and the
        # model resumes.
        with caplog.at_level(logging.WARNING, logger="ag_ui_adk.adk_agent"):
            _, err2 = await _run(
                adk,
                thread_id,
                "r2",
                [
                    UserMessage(id="u1", content="Use one tool."),
                    assistant,
                    ToolMessage(id="t_a", content='{"ok": true}', tool_call_id=id_a),
                ],
            )
        assert not err2
        assert llm.turn_count == 2, (
            f"An orphaned pending entry must not gate the resume forever "
            f"(turn_count={llm.turn_count})."
        )
        # The orphan was surfaced (diagnosable, not a silent stall).
        assert any(
            r.levelno == logging.WARNING and "orphan-call-id" in r.getMessage()
            for r in caplog.records
        ), "expected a WARNING naming the orphaned pending id"
        _assert_no_mismatch(llm)

    @pytest.mark.asyncio
    async def test_buffer_failure_errors_without_mutating_state(
        self, reset_session_manager
    ):
        """If persisting a buffered result fails, the submission must surface a
        dedicated RUN_ERROR and mutate NOTHING — pending state untouched, the
        message left unprocessed, the model not resumed — so the client can
        resubmit cleanly. (Pre-fix the call was removed from pending and the
        message marked processed before/around the append, so a failed or
        no-op persist left the turn unable to ever balance with the result
        silently dropped.)
        """
        llm = _LroThenTextLlm(model="scripted", tool_names=[TOOL_A, TOOL_B])
        adk = _make_agent(llm)
        thread_id = str(uuid.uuid4())

        # --- Run 1: one turn emits two long-running tool calls ---
        start_ids, err1 = await _run(
            adk, thread_id, "r1", [UserMessage(id="u1", content="Use both tools.")]
        )
        assert not err1
        id_a, id_b = start_ids[TOOL_A], start_ids[TOOL_B]
        assistant = AssistantMessage(
            id="a1",
            content=None,
            tool_calls=[
                ToolCall(id=id_a, function=FunctionCall(name=TOOL_A, arguments="{}")),
                ToolCall(id=id_b, function=FunctionCall(name=TOOL_B, arguments="{}")),
            ],
        )
        history = [UserMessage(id="u1", content="Use both tools."), assistant]

        # Force the buffer persistence to fail.
        async def _boom(*_args, **_kwargs):
            raise RuntimeError("simulated persistence failure")

        original_buffer = adk._buffer_tool_results
        adk._buffer_tool_results = _boom

        # --- Run 2: tool_a's result (tool_b pending) → buffer attempt fails ---
        _, err2 = await _run(
            adk,
            thread_id,
            "r2",
            history + [ToolMessage(id="t_a", content='{"ok": true}', tool_call_id=id_a)],
        )
        assert err2 is not None and err2.code == "TOOL_RESULT_BUFFER_ERROR", err2
        # Model not resumed.
        assert llm.turn_count == 1, (
            f"buffer failure must not resume the model (turn_count={llm.turn_count})."
        )
        # Mutate-nothing: BOTH calls remain pending (tool_a not removed).
        pending = await adk._get_pending_tool_call_ids(thread_id, "user_1")
        assert set(pending or []) == {id_a, id_b}, (
            f"buffer failure must not mutate pending state; got {pending}"
        )
        # The message was not marked processed, so it is still re-extractable.
        processed = adk._session_manager.get_processed_message_ids(
            adk._get_session_metadata(thread_id, "user_1")[1], thread_id
        )
        assert "t_a" not in processed, (
            "buffer failure must not mark the result message processed"
        )

        # --- Recovery: persistence restored, resubmit both together ---
        adk._buffer_tool_results = original_buffer
        _, err3 = await _run(
            adk,
            thread_id,
            "r3",
            history
            + [
                ToolMessage(id="t_a", content='{"ok": true}', tool_call_id=id_a),
                ToolMessage(id="t_b", content='{"ok": true}', tool_call_id=id_b),
            ],
        )
        assert not err3, f"recovery submission should succeed, got {err3}"
        assert llm.turn_count == 2, (
            f"with all results answered the model resumes once "
            f"(turn_count={llm.turn_count})."
        )
        pending = await adk._get_pending_tool_call_ids(thread_id, "user_1")
        assert not (pending or []), f"no calls should remain pending, got {pending}"
        _assert_no_mismatch(llm)

    @pytest.mark.asyncio
    async def test_user_message_while_call_pending_is_rejected_then_recovers(
        self, reset_session_manager
    ):
        """A trailing user message that arrives while ANOTHER long-running call
        from the same turn is still unanswered is rejected with a clear,
        dedicated error — not resumed (which would 400) and not silently
        dropped. State is left untouched so the client can resolve the pending
        call and resubmit; once both results arrive together the message rides
        along and the model resumes normally.
        """
        llm = _LroThenTextLlm(model="scripted", tool_names=[TOOL_A, TOOL_B])
        adk = _make_agent(llm)
        thread_id = str(uuid.uuid4())

        # --- Run 1: one turn emits two long-running tool calls ---
        start_ids, err1 = await _run(
            adk, thread_id, "r1", [UserMessage(id="u1", content="Use both tools.")]
        )
        assert not err1
        id_a, id_b = start_ids[TOOL_A], start_ids[TOOL_B]
        assistant = AssistantMessage(
            id="a1",
            content=None,
            tool_calls=[
                ToolCall(id=id_a, function=FunctionCall(name=TOOL_A, arguments="{}")),
                ToolCall(id=id_b, function=FunctionCall(name=TOOL_B, arguments="{}")),
            ],
        )
        history = [UserMessage(id="u1", content="Use both tools."), assistant]
        followup = UserMessage(id="u2", content="actually, do something else")

        # --- Run 2: tool_a's result + a trailing user message, tool_b pending ---
        _, err2 = await _run(
            adk,
            thread_id,
            "r2",
            history
            + [
                ToolMessage(id="t_a", content='{"ok": true}', tool_call_id=id_a),
                followup,
            ],
        )
        # Rejected loudly with the dedicated code — not the opaque provider 400.
        assert err2 is not None and err2.code == "PENDING_TOOL_CALLS", err2
        # The model was never resumed (an under-answered turn would 400).
        assert llm.turn_count == 1, (
            f"Model must not resume on a turn that is still under-answered "
            f"(turn_count={llm.turn_count})."
        )
        # Mutate-nothing: BOTH calls remain pending (tool_a's result was not even
        # consumed), so the client can resolve the rest and resubmit cleanly.
        pending = await adk._get_pending_tool_call_ids(thread_id, "user_1")
        assert set(pending or []) == {id_a, id_b}, (
            f"rejection must not mutate pending state; got {pending}"
        )

        # --- Run 3 (recovery): both results submitted together, message trails ---
        _, err3 = await _run(
            adk,
            thread_id,
            "r3",
            history
            + [
                ToolMessage(id="t_a", content='{"ok": true}', tool_call_id=id_a),
                ToolMessage(id="t_b", content='{"ok": true}', tool_call_id=id_b),
                followup,
            ],
        )
        assert not err3, f"recovery submission should succeed, got {err3}"
        assert llm.turn_count == 2, (
            f"With all results answered, the model resumes once and the trailing "
            f"message rides along (turn_count={llm.turn_count})."
        )
        pending = await adk._get_pending_tool_call_ids(thread_id, "user_1")
        assert not (pending or []), f"no calls should remain pending, got {pending}"

        _assert_no_mismatch(llm)
