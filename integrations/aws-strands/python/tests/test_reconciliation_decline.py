"""Tests for what happens when frontend-result reconciliation corrects nothing.

Reconciliation rewrites the proxy's ``"Forwarded to client"`` placeholder with
the client's real answer. It can decline: an admitted id whose placeholder is no
longer anywhere reconciliation looks has nothing to rewrite. A decline is not a
failure of the turn, but it does mean the answer is not in the history, so the
run has to reach the model with it some other way or say why it cannot.

The message path has a continuation prompt to carry the answer in. The resume
path has none, because it drives Strands with its interrupt responses instead,
so an uncorrected placeholder is what the model would read as the answer.

What the resume path refuses on is that remaining placeholder, not the decline
itself. The two are not the same: an id whose placeholder is already gone
declines every time it is re-admitted, and a long-lived thread accumulates those.
"""

from __future__ import annotations

import copy
import logging
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from ag_ui.core import (
    AssistantMessage,
    EventType,
    FunctionCall,
    ResumeEntry,
    RunAgentInput,
    Tool,
    ToolCall,
    ToolMessage,
    UserMessage,
)
from strands.agent.state import AgentState
from strands.hooks.registry import HookRegistry
from strands.interrupt import Interrupt as StrandsInterrupt

from ag_ui_strands.agent import StrandsAgent
from ag_ui_strands.client_proxy_tool import PROXY_RESULT_PLACEHOLDER
from ag_ui_strands.config import StrandsAgentConfig
from ag_ui_strands.session_reconcile import AG_UI_FRONTEND_CALL_IDS_STATE_KEY
from tests.hook_helpers import invoke_after_model_call, invoke_before_model_call
from tests.interrupt_state_stub import InterruptStateStub

RECONCILE_LOGGER = "ag_ui_strands.agent"


# ---------------------------------------------------------------------------
# Doubles
# ---------------------------------------------------------------------------


def _no_session_core(history) -> "_MockStrandsCore":
    """A cached agent with no session manager, so replay owns the history."""
    core = _MockStrandsCore(session_manager=None)
    core.messages = list(history)
    return core


def _repository_manager(messages=None) -> SimpleNamespace:
    return SimpleNamespace(
        session_id="session-1",
        session_repository=SimpleNamespace(
            list_messages=MagicMock(return_value=list(messages or [])),
            update_message=MagicMock(),
        ),
    )


class _MockStrandsCore:
    """The streaming surface the adapter drives, recording its prompt."""

    def __init__(self, session_manager, interrupts=None):
        self.agent_id = "default"
        self.tool_registry = MagicMock()
        self.tool_registry.registry = {}
        self.state = AgentState()
        self.model = MagicMock()
        self.messages = []
        self.stream_prompts = []
        self.hooks = HookRegistry()
        self.session_manager = session_manager
        self._interrupt_state = InterruptStateStub()
        for interrupt in interrupts or []:
            self._interrupt_state.interrupts[interrupt.id] = interrupt
        if interrupts:
            self._interrupt_state.activate()

    async def stream_async(self, prompt):
        self.stream_prompts.append(prompt)
        self._interrupt_state.resume(prompt)
        invoke_before_model_call(self.hooks, self)
        invoke_after_model_call(self.hooks, self)
        return
        yield  # pragma: no cover - generator marker


def _placeholder_result(tool_use_id: str) -> dict:
    return {
        "toolUseId": tool_use_id,
        "status": "success",
        "content": [{"text": PROXY_RESULT_PLACEHOLDER}],
    }


def _placeholder_message(tool_use_id: str) -> dict:
    return {"role": "user", "content": [{"toolResult": _placeholder_result(tool_use_id)}]}


def _adapter(config: StrandsAgentConfig | None = None) -> StrandsAgent:
    core = MagicMock()
    core.model = MagicMock()
    core.system_prompt = "You are a test assistant."
    core.tool_registry = MagicMock()
    core.tool_registry.registry = {}
    core.record_direct_tool_call = True
    return StrandsAgent(
        agent=core, name="test_agent", config=config or StrandsAgentConfig()
    )


def _run_input(messages, *, resume=None, tools=None) -> RunAgentInput:
    return RunAgentInput(
        thread_id="thread-1",
        run_id="run-1",
        state={},
        messages=messages,
        tools=tools or [Tool(name="approveTool", description="approve", parameters={})],
        context=[],
        forwarded_props={},
        resume=resume,
    )


async def _collect(agent: StrandsAgent, input_data: RunAgentInput) -> list:
    return [event async for event in agent.run(input_data)]


def _errors(events: list) -> list:
    return [event for event in events if event.type == EventType.RUN_ERROR]


# ---------------------------------------------------------------------------
# The message path: the prompt carries what the history could not
# ---------------------------------------------------------------------------


def _answered_call_then_new_question() -> list:
    """A client answer, followed by the user's next turn.

    The newer user message is what puts the answer out of the trailing scan's
    reach, so the derived continuation prompt is the user's own text.
    """
    return [
        UserMessage(id="u1", content="approve it"),
        AssistantMessage(
            id="a1",
            tool_calls=[
                ToolCall(
                    id="fe-1",
                    function=FunctionCall(name="approveTool", arguments="{}"),
                )
            ],
        ),
        ToolMessage(id="t1", tool_call_id="fe-1", content='{"approved": false}'),
        UserMessage(id="u2", content="and now what?"),
    ]


def _declining_core() -> _MockStrandsCore:
    """Admits ``fe-1`` but holds no placeholder anywhere to correct."""
    core = _MockStrandsCore(session_manager=_repository_manager())
    core.state.set(AG_UI_FRONTEND_CALL_IDS_STATE_KEY, ["fe-1"])
    return core


class TestDeclinedCorrectionOnTheMessagePath:
    @pytest.mark.asyncio
    async def test_the_answer_is_carried_ahead_of_the_users_text(self):
        core = _declining_core()

        with patch("ag_ui_strands.agent.StrandsAgentCore", return_value=core):
            events = await _collect(
                _adapter(), _run_input(_answered_call_then_new_question())
            )

        assert _errors(events) == []
        assert core.stream_prompts == [
            'approveTool returned: {"approved": false}\nand now what?'
        ]

    @pytest.mark.asyncio
    async def test_a_client_reported_failure_carries_its_reason(self):
        core = _declining_core()
        messages = _answered_call_then_new_question()
        messages[2] = ToolMessage(
            id="t1", tool_call_id="fe-1", content="", error="user cancelled"
        )

        with patch("ag_ui_strands.agent.StrandsAgentCore", return_value=core):
            await _collect(_adapter(), _run_input(messages))

        assert core.stream_prompts == [
            "approveTool failed: user cancelled\nand now what?"
        ]

    @pytest.mark.asyncio
    async def test_the_decline_is_reported(self, caplog):
        core = _declining_core()

        with (
            patch("ag_ui_strands.agent.StrandsAgentCore", return_value=core),
            caplog.at_level(logging.WARNING, logger=RECONCILE_LOGGER),
        ):
            await _collect(_adapter(), _run_input(_answered_call_then_new_question()))

        reported = [record.getMessage() for record in caplog.records]
        assert any(
            "corrected nothing" in message and "fe-1" in message
            for message in reported
        )

    @pytest.mark.asyncio
    async def test_a_corrected_answer_is_not_told_twice(self):
        # The placeholder is there to rewrite, so the history carries the answer
        # and the prompt stays the user's own text.
        core = _declining_core()
        core.messages = [_placeholder_message("fe-1")]

        with patch("ag_ui_strands.agent.StrandsAgentCore", return_value=core):
            events = await _collect(
                _adapter(), _run_input(_answered_call_then_new_question())
            )

        assert _errors(events) == []
        assert core.stream_prompts == ["and now what?"]

    @pytest.mark.asyncio
    async def test_an_unnameable_answer_is_left_out_rather_than_guessed_at(self):
        # Nothing names the call, so no line can be phrased for it. The user's
        # own turn still reaches the model.
        core = _declining_core()
        messages = _answered_call_then_new_question()
        del messages[1]

        with patch("ag_ui_strands.agent.StrandsAgentCore", return_value=core):
            events = await _collect(_adapter(), _run_input(messages))

        assert _errors(events) == []
        assert core.stream_prompts == ["and now what?"]


# ---------------------------------------------------------------------------
# The resume path: nothing carries anything, so the run is refused
# ---------------------------------------------------------------------------


def _resume_core(*, extra_placeholder: bool) -> _MockStrandsCore:
    """A checkpoint parking one proxy placeholder, admitting two answers.

    ``extra_placeholder`` decides whether ``fe-2`` still has a stub in the live
    history: with one, the model would read it as the client's answer, and
    without one there is nothing left for a decline to leave behind.
    """
    core = _MockStrandsCore(
        session_manager=_repository_manager(),
        interrupts=[StrandsInterrupt(id="native-interrupt", name="confirm")],
    )
    core._interrupt_state.context["tool_results"] = [_placeholder_result("native-proxy")]
    core.messages = [_placeholder_message("native-proxy")]
    if extra_placeholder:
        core.messages.append(_placeholder_message("fe-2"))
    core.state.set(AG_UI_FRONTEND_CALL_IDS_STATE_KEY, ["native-proxy", "fe-2"])
    return core


def _resume_input() -> RunAgentInput:
    return _run_input(
        [
            ToolMessage(
                id="t1", tool_call_id="native-proxy", content='{"approved": true}'
            ),
            ToolMessage(id="t2", tool_call_id="fe-2", content='{"picked": "red"}'),
        ],
        resume=[
            ResumeEntry(
                interrupt_id="native-interrupt", status="resolved", payload=True
            )
        ],
    )


def _refusing_rewrite(corrects: set[str]):
    """A rewriter that corrects only *corrects*, leaving other stubs standing.

    Today's rewriter always corrects a stub it was handed an answer for, so a
    decline and a remaining stub cannot co-occur through it. The gate is about
    what the model would read, not about which rewriter left it there, so the
    refusal is driven from that condition directly.
    """
    return patch(
        "ag_ui_strands.agent.reconcile_frontend_tool_results",
        return_value=set(corrects),
    )


class TestDeclinedCorrectionOnTheResumePath:
    @pytest.mark.asyncio
    async def test_a_remaining_stub_refuses_the_run(self):
        core = _resume_core(extra_placeholder=True)

        with (
            patch("ag_ui_strands.agent.StrandsAgentCore", return_value=core),
            _refusing_rewrite({"native-proxy"}),
        ):
            events = await _collect(_adapter(), _resume_input())

        errors = _errors(events)
        assert len(errors) == 1
        assert errors[0].code == "INTERRUPT_RECONCILIATION_ERROR"
        assert errors[0].message == "Active interrupt tool result reconciliation failed"
        assert not any(event.type == EventType.RUN_FINISHED for event in events)
        # Unlike the pre-write gates this one cannot leave the turn untouched:
        # only the attempt itself says a correction declined, so the corrections
        # that did land are already written. What it does keep from happening is
        # the model reading the uncorrected placeholder as the client's answer,
        # and the checkpoint is still there for a retry.
        assert core.stream_prompts == []
        assert core._interrupt_state.activated

    @pytest.mark.asyncio
    async def test_the_refusal_names_the_stubbed_ids(self, caplog):
        core = _resume_core(extra_placeholder=True)

        with (
            patch("ag_ui_strands.agent.StrandsAgentCore", return_value=core),
            _refusing_rewrite({"native-proxy"}),
            caplog.at_level(logging.ERROR, logger=RECONCILE_LOGGER),
        ):
            await _collect(_adapter(), _resume_input())

        reported = [record.getMessage() for record in caplog.records]
        assert any(
            "reconciliation failed" in message and "fe-2" in message
            for message in reported
        )

    @pytest.mark.asyncio
    async def test_a_decline_with_nothing_left_to_correct_resumes(self):
        # An id kept for retry whose placeholder is already gone. It is
        # re-admitted and re-declined on every later turn, and it is never
        # pruned, so refusing on the decline would wedge the thread for good.
        core = _resume_core(extra_placeholder=False)

        with patch("ag_ui_strands.agent.StrandsAgentCore", return_value=core):
            events = await _collect(_adapter(), _resume_input())

        assert _errors(events) == []
        assert len(core.stream_prompts) == 1

    @pytest.mark.asyncio
    async def test_every_correction_landing_resumes_normally(self):
        core = _resume_core(extra_placeholder=True)


        with patch("ag_ui_strands.agent.StrandsAgentCore", return_value=core):
            events = await _collect(_adapter(), _resume_input())

        assert _errors(events) == []
        assert len(core.stream_prompts) == 1
        assert core._interrupt_state.context["tool_results"][0]["content"] == [
            {"text": '{"approved": true}'}
        ]


# ---------------------------------------------------------------------------
# The replay path stands down rather than replay a history missing the answer
# ---------------------------------------------------------------------------


def _cached_history_awaiting_an_answer() -> list:
    return [
        {"role": "user", "content": [{"text": "what is the weather"}]},
        {
            "role": "assistant",
            "content": [
                {"toolUse": {"toolUseId": "fe-1", "name": "get_weather", "input": {}}}
            ],
        },
        _placeholder_message("fe-1"),
    ]


class TestReplayThatWouldDropTheAnswer:
    @pytest.mark.asyncio
    async def test_a_delta_only_turn_keeps_its_history_and_says_the_answer(self):
        # The payload carries the result without the assistant message that
        # opened the call, so the rebuilt history has no home for it. Replaying
        # what little rebuilt would replace the whole conversation with it.
        core = _no_session_core(_cached_history_awaiting_an_answer())
        before = copy.deepcopy(core.messages)

        with patch("ag_ui_strands.agent.StrandsAgentCore", return_value=core):
            events = await _collect(
                _adapter(),
                _run_input(
                    [ToolMessage(id="t1", tool_call_id="fe-1", content="sunny, 22C")],
                    tools=[
                        Tool(name="get_weather", description="w", parameters={})
                    ],
                ),
            )

        assert _errors(events) == []
        assert core.messages == before
        assert core.stream_prompts == ["get_weather returned: sunny, 22C"]

    @pytest.mark.asyncio
    async def test_a_history_that_answers_itself_still_replays(self):
        core = _no_session_core(_cached_history_awaiting_an_answer())

        with patch("ag_ui_strands.agent.StrandsAgentCore", return_value=core):
            events = await _collect(
                _adapter(),
                _run_input(
                    [
                        UserMessage(id="u1", content="what is the weather"),
                        AssistantMessage(
                            id="a1",
                            tool_calls=[
                                ToolCall(
                                    id="fe-1",
                                    function=FunctionCall(
                                        name="get_weather", arguments="{}"
                                    ),
                                )
                            ],
                        ),
                        ToolMessage(
                            id="t1", tool_call_id="fe-1", content="sunny, 22C"
                        ),
                    ],
                    tools=[Tool(name="get_weather", description="w", parameters={})],
                ),
            )

        assert _errors(events) == []
        # ``None`` tells Strands to stream from the replaced history as-is.
        assert core.stream_prompts == [None]
        assert core.messages[-1]["content"][0]["toolResult"]["content"] == [
            {"text": "sunny, 22C"}
        ]


# ---------------------------------------------------------------------------
# The legacy path has no repaired history to rely on either
# ---------------------------------------------------------------------------


class TestReconciliationDisabled:
    @pytest.mark.asyncio
    async def test_the_answer_is_still_carried(self):
        # Nothing repairs a history when replay is off, so every admitted answer
        # is the prompt's to say.
        core = _declining_core()
        agent = _adapter(StrandsAgentConfig(replay_history_into_strands=False))

        with patch("ag_ui_strands.agent.StrandsAgentCore", return_value=core):
            events = await _collect(
                agent, _run_input(_answered_call_then_new_question())
            )

        assert _errors(events) == []
        assert core.stream_prompts == [
            'approveTool returned: {"approved": false}\nand now what?'
        ]
