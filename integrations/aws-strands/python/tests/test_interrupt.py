"""Tests for native Strands interrupt <-> AG-UI interrupt round-trip.

Covers the four behaviors added to bridge ``tool_context.interrupt()`` to the
AG-UI interrupt lifecycle:

1. A paused run finishes with ``RunFinishedInterruptOutcome``.
2. ``RunAgentInput.resume`` is translated into the Strands resume prompt shape.
3. ``status == "cancelled"`` resumes with the documented denial sentinel.
4. Runs that never interrupt finish with a success outcome.
"""

from __future__ import annotations

import ast
import copy
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from ag_ui.core import (
    CustomEvent,
    EventType,
    Interrupt,
    ResumeEntry,
    RunAgentInput,
    RunFinishedSuccessOutcome,
    Tool,
    ToolMessage,
    UserMessage,
)
from strands import Agent as StrandsAgentCore
from strands import ToolContext, tool
from strands.agent.state import AgentState
from strands.interrupt import Interrupt as StrandsInterrupt
from strands.models.model import Model as StrandsModel
from strands.session import FileSessionManager
from strands.types.session import SessionAgent, SessionMessage

from ag_ui_strands.agent import (
    INTERRUPT_CANCELLED,
    _INTERRUPT_BOOKKEEPING_STATE_KEY,
    StrandsAgent,
)
from ag_ui_strands.client_proxy_tool import PROXY_RESULT_PLACEHOLDER
from ag_ui_strands.config import StrandsAgentConfig, ToolBehavior
from ag_ui_strands.session_reconcile import (
    AG_UI_TOOL_CALL_MAP_STATE_KEY,
    AG_UI_WIRE_MAP_STATE_KEY,
)
from tests.interrupt_state_stub import InterruptStateStub

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_run_input(
    thread_id: str = "thread-1",
    run_id: str = "run-1",
    messages=None,
    resume=None,
    tools=None,
) -> RunAgentInput:
    return RunAgentInput(
        thread_id=thread_id,
        run_id=run_id,
        state={},
        messages=messages or [],
        tools=tools or [],
        context=[],
        forwarded_props={},
        resume=resume,
    )


async def _collect_events(agent: StrandsAgent, input_data: RunAgentInput) -> list:
    events = []
    async for event in agent.run(input_data):
        events.append(event)
    return events


def _make_base_agent(config: StrandsAgentConfig | None = None) -> StrandsAgent:
    mock_core = MagicMock()
    mock_core.model = MagicMock()
    mock_core.system_prompt = "You are a test assistant."
    mock_core.tool_registry = MagicMock()
    mock_core.tool_registry.registry = {}
    mock_core.record_direct_tool_call = True
    # replay_history_into_strands defaults True; with no session manager this
    # takes the in-memory replay path (stream_async(None)). Disable it so the
    # legacy/resume paths are exercised straightforwardly in these unit tests.
    return StrandsAgent(
        agent=mock_core,
        name="test_agent",
        config=config or StrandsAgentConfig(replay_history_into_strands=False),
    )


_UNSET = object()


class _MockStrandsCore:
    """A minimal stand-in for ``StrandsAgentCore`` driving the stream loop.

    ``stream_async`` records the prompt it was called with, applies Strands' own
    checkpoint-resume step, and then yields whatever ``_stream_body`` produces.
    When ``interrupts`` are supplied it also flips its ``_interrupt_state`` to
    activated, mirroring a paused native run.
    """

    def __init__(self, terminal_events=None, interrupts=None, session_manager=_UNSET):
        self.agent_id = "default"
        self.tool_registry = MagicMock()
        self.tool_registry.registry = {}
        self.state = AgentState()
        self.model = MagicMock()
        self.messages = []
        self.stream_prompts = []
        # Default to a mock session manager: the ``session_manager is None``
        # guard now rejects interrupts/resume without one, and most tests
        # here exercise the resume-translation logic, not that guard. Pass
        # ``session_manager=None`` explicitly to exercise the guard itself.
        self.session_manager = MagicMock() if session_manager is _UNSET else session_manager
        self._terminal_events = terminal_events or []
        self._interrupt_state = InterruptStateStub()
        if interrupts:
            for itr in interrupts:
                self._interrupt_state.interrupts[itr.id] = itr
            self._interrupt_state.activate()

    async def stream_async(self, prompt):
        """Record the prompt and apply Strands' own checkpoint-resume step.

        Real ``stream_async`` resumes the checkpoint from the prompt before
        anything else, so an activated checkpoint rejects a prompt that is not a
        list of interrupt responses. Doubles supply a ``_stream_body`` instead of
        replacing this method, so none of them can skip that step: one that skips
        it certifies prompts production would reject.
        """
        self.stream_prompts.append(prompt)
        self._interrupt_state.resume(prompt)
        async for event in self._stream_body(prompt):
            yield event

    async def _stream_body(self, prompt):
        for event in self._terminal_events:
            yield event


class _PostStreamMixedCore(_MockStrandsCore):
    """Create an exact mixed checkpoint only after streaming starts."""

    async def _stream_body(self, prompt):
        interrupt = StrandsInterrupt(id="native-interrupt", name="confirm")
        self._interrupt_state.interrupts[interrupt.id] = interrupt
        self._interrupt_state.context["tool_results"] = [
            {
                "toolUseId": "native-proxy",
                "status": "success",
                "content": [{"text": PROXY_RESULT_PLACEHOLDER}],
            }
        ]
        self._interrupt_state.activate()
        yield {"result": _agent_result_with_interrupt([interrupt])}


def _agent_result_with_interrupt(interrupts):
    result = MagicMock()
    result.stop_reason = "interrupt"
    result.interrupts = interrupts
    return result


def _snapshot_mutable_core_state(core: _MockStrandsCore) -> dict:
    """Capture every adapter/checkpoint surface invalid resume must preserve."""
    return {
        "interrupt_state": copy.deepcopy(core._interrupt_state.to_dict()),
        "messages": copy.deepcopy(core.messages),
        "registry_names": set(core.tool_registry.registry),
        "state": copy.deepcopy(core.state.get()),
    }


def _assert_single_run_error(events: list, code: str) -> None:
    errors = [event for event in events if event.type == EventType.RUN_ERROR]
    assert len(errors) == 1
    assert errors[0].code == code
    assert not any(event.type == EventType.RUN_FINISHED for event in events)


# ---------------------------------------------------------------------------
# Stream-double contract
# ---------------------------------------------------------------------------


class TestStreamDoubleContract:
    """Every core double drives Strands' checkpoint-resume step.

    Overriding ``_stream_body`` keeps that step in place; overriding or reassigning
    ``stream_async`` would skip a call the real one makes unconditionally.
    """

    def test_only_the_shared_core_defines_stream_async(self):
        tree = ast.parse(Path(__file__).read_text())
        definitions = [
            node.name
            for node in ast.walk(tree)
            if isinstance(node, ast.ClassDef)
            and any(
                isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef))
                and child.name == "stream_async"
                for child in node.body
            )
        ]
        reassignments = [
            node
            for node in ast.walk(tree)
            if isinstance(node, ast.Assign)
            and any(
                isinstance(target, ast.Attribute) and target.attr == "stream_async"
                for target in node.targets
            )
        ]
        assert definitions == ["_MockStrandsCore"]
        assert reassignments == []

    @pytest.mark.asyncio
    async def test_core_double_rejects_a_prompt_the_sdk_rejects(self):
        core = _MockStrandsCore(
            interrupts=[StrandsInterrupt(id="native-interrupt", name="confirm")]
        )

        with pytest.raises(TypeError):
            async for _ in core.stream_async("what now?"):
                pass

    @pytest.mark.asyncio
    async def test_core_double_records_the_submitted_answer(self):
        interrupt = StrandsInterrupt(id="native-interrupt", name="confirm")
        core = _MockStrandsCore(interrupts=[interrupt])

        async for _ in core.stream_async(
            [
                {
                    "interruptResponse": {
                        "interruptId": interrupt.id,
                        "response": {"approved": True},
                    }
                }
            ]
        ):
            pass

        assert interrupt.response == {"approved": True}


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestInterruptOutcome:
    @pytest.mark.asyncio
    async def test_pause_emits_interrupt_outcome(self):
        """A native interrupt produces RUN_FINISHED with an interrupt outcome."""
        strands_interrupt = StrandsInterrupt(
            id="v1:tool_call:tu-1:00000000-0000-0000-0000-000000000000",
            name="confirm",
            reason={"summary": "delete all"},
        )
        core = _MockStrandsCore(
            terminal_events=[{"result": _agent_result_with_interrupt([strands_interrupt])}],
        )
        agent = _make_base_agent()

        with patch("ag_ui_strands.agent.StrandsAgentCore", return_value=core):
            events = await _collect_events(agent, _make_run_input())

        finished = next(e for e in events if e.type == EventType.RUN_FINISHED)
        assert finished.outcome is not None
        assert finished.outcome.type == "interrupt"
        assert len(finished.outcome.interrupts) == 1

        agui_interrupt = finished.outcome.interrupts[0]
        assert agui_interrupt.id == "v1:tool_call:tu-1:00000000-0000-0000-0000-000000000000"
        assert agui_interrupt.tool_call_id is None
        assert agui_interrupt.reason == "confirm"
        assert agui_interrupt.metadata == {"reason": {"summary": "delete all"}}

    @pytest.mark.asyncio
    async def test_terminal_result_captured_despite_halt_in_same_cycle(self):
        """The terminal ``AgentResult`` capture must run before the
        ``halt_event_stream`` break check — otherwise a native interrupt whose
        terminal event arrives on/after the same cycle that triggers a
        frontend-tool halt is silently dropped (the run finishes bare instead
        of surfacing the interrupt).
        """
        open_interrupt = StrandsInterrupt(
            id="v1:tool_call:tu-native:00000000-0000-0000-0000-000000000000",
            name="confirm",
        )
        events = [
            {
                "current_tool_use": {
                    "toolUseId": "tu-fe",
                    "name": "get_cell",
                    "input": '{"cell": "B4"}',
                }
            },
            {"event": {"contentBlockStop": {}}},
            # Empty content models the interrupted turn skipping
            # ToolResultMessageEvent; pending_halt still
            # latches halt_event_stream here regardless.
            {"message": {"role": "user", "content": []}},
            {"result": _agent_result_with_interrupt([open_interrupt])},
        ]
        core = _MockStrandsCore(terminal_events=events)
        agent = _make_base_agent()
        frontend_tool = Tool(name="get_cell", description="Read a cell", parameters={})

        with patch("ag_ui_strands.agent.StrandsAgentCore", return_value=core):
            events_out = await _collect_events(agent, _make_run_input(tools=[frontend_tool]))

        finished = next(e for e in events_out if e.type == EventType.RUN_FINISHED)
        assert (
            finished.outcome is not None
        ), "terminal interrupt result was dropped on the halt path (round1.md #7a)"
        assert finished.outcome.type == "interrupt"
        assert finished.outcome.interrupts[0].id == open_interrupt.id

    @pytest.mark.asyncio
    async def test_fallback_excludes_already_answered_interrupts(self):
        """When the terminal ``AgentResult`` is unavailable and ``_extract_interrupts``
        falls back to the live ``_interrupt_state``, an interrupt that was already
        answered by a prior partial resume (truthy ``.response``) must not be
        re-reported as still pending alongside the genuinely open one.
        """
        answered = StrandsInterrupt(
            id="v1:tool_call:tu-answered:00000000-0000-0000-0000-000000000000",
            name="answered",
            response={"response": "yes"},
        )
        open_interrupt = StrandsInterrupt(
            id="v1:tool_call:tu-open:00000000-0000-0000-0000-000000000000",
            name="open",
        )
        # No terminal ``{"result": ...}`` event — mirrors the halt-event-stream
        # path where the stream breaks before a terminal AgentResult is captured.
        core = _MockStrandsCore(
            terminal_events=[],
        )

        async def _activate_during_stream(prompt):
            core._interrupt_state.interrupts = {
                answered.id: answered,
                open_interrupt.id: open_interrupt,
            }
            core._interrupt_state.activate()
            if False:
                yield None

        core._stream_body = _activate_during_stream
        agent = _make_base_agent()

        with patch("ag_ui_strands.agent.StrandsAgentCore", return_value=core):
            events = await _collect_events(agent, _make_run_input())

        finished = next(e for e in events if e.type == EventType.RUN_FINISHED)
        assert finished.outcome is not None
        assert finished.outcome.type == "interrupt"
        reported_ids = {i.id for i in finished.outcome.interrupts}
        assert reported_ids == {open_interrupt.id}

    @pytest.mark.asyncio
    async def test_no_interrupt_finishes_with_success(self):
        """A normal run finishes with the protocol's explicit success outcome."""
        result = MagicMock()
        result.stop_reason = "end_turn"
        result.interrupts = None
        core = _MockStrandsCore(terminal_events=[{"result": result}])
        agent = _make_base_agent()

        with patch("ag_ui_strands.agent.StrandsAgentCore", return_value=core):
            events = await _collect_events(agent, _make_run_input())

        finished = next(e for e in events if e.type == EventType.RUN_FINISHED)
        assert isinstance(finished.outcome, RunFinishedSuccessOutcome)


class TestResumeConsumption:
    @pytest.mark.asyncio
    async def test_resolved_resume_builds_interrupt_response_prompt(self):
        """A resolved ResumeEntry is translated into the Strands resume prompt.

        The raw payload is wrapped in ``{"response": ...}`` so Strands' truthiness
        gate always passes; the tool destructures via ``.get("response")``.
        """
        core = _MockStrandsCore(
            terminal_events=[],
            interrupts=[StrandsInterrupt(id="int-1", name="confirm")],
        )
        agent = _make_base_agent()
        resume = [ResumeEntry(interrupt_id="int-1", status="resolved", payload="yes")]

        with patch("ag_ui_strands.agent.StrandsAgentCore", return_value=core):
            await _collect_events(agent, _make_run_input(resume=resume))

        assert core.stream_prompts == [
            [{"interruptResponse": {"interruptId": "int-1", "response": {"response": "yes"}}}]
        ]

    @pytest.mark.parametrize("falsy_payload", [None, False, "", 0, [], {}])
    @pytest.mark.asyncio
    async def test_resolved_resume_wraps_falsy_payload_in_truthy_envelope(self, falsy_payload):
        """Falsy resume payloads must be wrapped so Strands' ``if response:`` gate passes.

        Regression for ``round1.md`` #1: without the envelope, ``None``/``False``/
        ``""``/``0``/``[]``/``{}`` re-emit the same interrupt id on the resume
        run, re-running the tool body forever.
        """
        core = _MockStrandsCore(
            terminal_events=[],
            interrupts=[StrandsInterrupt(id="int-1", name="confirm")],
        )
        agent = _make_base_agent()
        resume = [ResumeEntry(interrupt_id="int-1", status="resolved", payload=falsy_payload)]

        with patch("ag_ui_strands.agent.StrandsAgentCore", return_value=core):
            await _collect_events(agent, _make_run_input(resume=resume))

        [wrapped] = core.stream_prompts
        assert wrapped == [
            {"interruptResponse": {"interruptId": "int-1", "response": {"response": falsy_payload}}}
        ]
        # The envelope itself must be truthy — that is the whole point.
        assert bool(wrapped[0]["interruptResponse"]["response"])

    @pytest.mark.asyncio
    async def test_cancelled_resume_uses_sentinel(self):
        """A cancelled ResumeEntry resumes with the denial sentinel as response."""
        core = _MockStrandsCore(
            terminal_events=[],
            interrupts=[StrandsInterrupt(id="int-1", name="confirm")],
        )
        agent = _make_base_agent()
        resume = [ResumeEntry(interrupt_id="int-1", status="cancelled", payload=None)]

        with patch("ag_ui_strands.agent.StrandsAgentCore", return_value=core):
            await _collect_events(agent, _make_run_input(resume=resume))

        assert core.stream_prompts == [
            [{"interruptResponse": {"interruptId": "int-1", "response": INTERRUPT_CANCELLED}}]
        ]

    @pytest.mark.asyncio
    async def test_multiple_resume_entries(self):
        """Every ResumeEntry becomes one interruptResponse content block."""
        core = _MockStrandsCore(
            terminal_events=[],
            interrupts=[
                StrandsInterrupt(id="a", name="confirm-a"),
                StrandsInterrupt(id="b", name="confirm-b"),
            ],
        )
        agent = _make_base_agent()
        resume = [
            ResumeEntry(interrupt_id="a", status="resolved", payload={"k": 1}),
            ResumeEntry(interrupt_id="b", status="cancelled", payload=None),
        ]

        with patch("ag_ui_strands.agent.StrandsAgentCore", return_value=core):
            await _collect_events(agent, _make_run_input(resume=resume))

        assert core.stream_prompts == [
            [
                {"interruptResponse": {"interruptId": "a", "response": {"response": {"k": 1}}}},
                {"interruptResponse": {"interruptId": "b", "response": INTERRUPT_CANCELLED}},
            ]
        ]

def _invalid_resume_case(case: str) -> tuple[list[StrandsInterrupt], list[ResumeEntry]]:
    open_interrupt = StrandsInterrupt(id="open", name="confirm")
    if case == "inactive":
        return [], [ResumeEntry(interrupt_id="open", status="resolved", payload=True)]
    if case == "empty":
        return [open_interrupt], []
    if case == "blank":
        return [open_interrupt], [
            ResumeEntry(interrupt_id="   ", status="resolved", payload=True)
        ]
    if case == "non-string":
        return [open_interrupt], [
            ResumeEntry.model_construct(
                interrupt_id=123, status="resolved", payload=True
            )
        ]
    if case == "duplicate":
        return [open_interrupt], [
            ResumeEntry(interrupt_id="open", status="resolved", payload=True),
            ResumeEntry(interrupt_id="open", status="cancelled", payload=None),
        ]
    if case == "known-then-unknown":
        return [open_interrupt], [
            ResumeEntry(interrupt_id="open", status="resolved", payload=True),
            ResumeEntry(interrupt_id="unknown", status="resolved", payload=True),
        ]
    if case == "answered":
        # An answered interrupt is not open, so addressing it is refused. The
        # submitted answer deliberately differs from the recorded one: an exact
        # replay of the recorded answers is the one batch an all-answered
        # checkpoint accepts, and this row is about the batches it does not.
        return [
            StrandsInterrupt(
                id="answered",
                name="confirm",
                response={"response": True},
            )
        ], [ResumeEntry(interrupt_id="answered", status="resolved", payload=False)]
    if case == "answered-partially-addressed":
        # Both are answered, so nothing is open, and a batch that covers only
        # one of them is not the replay the checkpoint would accept either.
        return [
            StrandsInterrupt(id="first", name="confirm", response={"response": True}),
            StrandsInterrupt(id="second", name="confirm", response={"response": True}),
        ], [ResumeEntry(interrupt_id="first", status="resolved", payload=True)]
    raise AssertionError(f"unknown resume case: {case}")


@pytest.mark.parametrize(
    "case",
    [
        "inactive",
        "empty",
        "blank",
        "non-string",
        "duplicate",
        "known-then-unknown",
        "answered",
        "answered-partially-addressed",
    ],
)
@pytest.mark.asyncio
async def test_resume_preflight_rejects_invalid_batch_before_any_mutation(case):
    interrupts, resume = _invalid_resume_case(case)
    core = _MockStrandsCore(interrupts=interrupts)
    agent = _make_base_agent()
    before = _snapshot_mutable_core_state(core)
    unexpected_tool = Tool(
        name="must_not_register",
        description="preflight must run before proxy synchronization",
        parameters={},
    )

    with patch("ag_ui_strands.agent.StrandsAgentCore", return_value=core):
        events = await _collect_events(
            agent,
            _make_run_input(resume=resume, tools=[unexpected_tool]),
        )

    expected_code = (
        "UNKNOWN_INTERRUPT_ID" if case == "inactive" else "INTERRUPT_RESUME_ERROR"
    )
    _assert_single_run_error(events, expected_code)
    assert core.stream_prompts == []
    assert _snapshot_mutable_core_state(core) == before


@pytest.mark.parametrize(
    ("case", "expected_code"),
    [
        pytest.param("partial", "PARTIAL_RESUME", id="partial"),
        pytest.param("expired", "INTERRUPT_EXPIRED", id="expired"),
        pytest.param("invalid-payload", "INVALID_PAYLOAD", id="invalid-payload"),
    ],
)
@pytest.mark.asyncio
async def test_protocol_resume_rejection_is_atomic(case, expected_code):
    interrupts = [StrandsInterrupt(id="open", name="confirm")]
    resume = [ResumeEntry(interrupt_id="open", status="resolved", payload=True)]
    pending: dict[str, Interrupt] = {}

    if case == "partial":
        interrupts.append(StrandsInterrupt(id="other-open", name="confirm-other"))
    elif case == "expired":
        pending["open"] = Interrupt(
            id="open",
            reason="confirm",
            expires_at="2000-01-01T00:00:00+00:00",
        )
    else:
        pending["open"] = Interrupt(
            id="open",
            reason="confirm",
            response_schema={
                "type": "object",
                "properties": {"approved": {"type": "boolean"}},
                "required": ["approved"],
            },
        )
        resume = [
            ResumeEntry(
                interrupt_id="open",
                status="resolved",
                payload={"approved": "true"},
            )
        ]

    core = _MockStrandsCore(interrupts=interrupts)
    agent = _make_base_agent()
    if pending:
        agent._pending_interrupts_by_thread["thread-1"] = pending
    before = _snapshot_mutable_core_state(core)

    with patch("ag_ui_strands.agent.StrandsAgentCore", return_value=core):
        events = await _collect_events(
            agent,
            _make_run_input(
                resume=resume,
                tools=[
                    Tool(
                        name="must_not_register",
                        description="resume validation must be atomic",
                        parameters={},
                    )
                ],
            ),
        )

    _assert_single_run_error(events, expected_code)
    assert core.stream_prompts == []
    assert _snapshot_mutable_core_state(core) == before


@pytest.mark.asyncio
async def test_pending_interrupt_blocks_new_input_before_any_mutation():
    core = _MockStrandsCore(
        interrupts=[StrandsInterrupt(id="open", name="confirm")]
    )
    agent = _make_base_agent()
    before = _snapshot_mutable_core_state(core)

    with patch("ag_ui_strands.agent.StrandsAgentCore", return_value=core):
        events = await _collect_events(
            agent,
            _make_run_input(
                tools=[
                    Tool(
                        name="must_not_register",
                        description="blocked input must not mutate the checkpoint",
                        parameters={},
                    )
                ]
            ),
        )

    _assert_single_run_error(events, "PENDING_INTERRUPTS")
    assert core.stream_prompts == []
    assert _snapshot_mutable_core_state(core) == before


@pytest.mark.asyncio
async def test_resume_only_requires_unanswered_interrupts():
    answered = StrandsInterrupt(
        id="answered",
        name="confirm-answered",
        response={"response": True},
    )
    open_interrupt = StrandsInterrupt(id="open", name="confirm-open")
    core = _MockStrandsCore(interrupts=[answered, open_interrupt])
    agent = _make_base_agent()

    with patch("ag_ui_strands.agent.StrandsAgentCore", return_value=core):
        events = await _collect_events(
            agent,
            _make_run_input(
                resume=[
                    ResumeEntry(
                        interrupt_id="open",
                        status="resolved",
                        payload=True,
                    )
                ]
            ),
        )

    assert not any(event.type == EventType.RUN_ERROR for event in events)
    assert core.stream_prompts == [
        [
            {
                "interruptResponse": {
                    "interruptId": "open",
                    "response": {"response": True},
                }
            }
        ]
    ]


@pytest.mark.asyncio
async def test_retry_requires_complete_batch_after_atomic_resume_rejection():
    core = _MockStrandsCore(
        interrupts=[
            StrandsInterrupt(id="open", name="confirm"),
            StrandsInterrupt(id="other-open", name="confirm-other"),
        ]
    )
    agent = _make_base_agent()
    invalid = [
        ResumeEntry(interrupt_id="open", status="resolved", payload=True),
        ResumeEntry(interrupt_id="unknown", status="resolved", payload=True),
    ]

    with patch("ag_ui_strands.agent.StrandsAgentCore", return_value=core):
        rejected = await _collect_events(agent, _make_run_input(resume=invalid))
        partial = await _collect_events(
            agent,
            _make_run_input(
                run_id="run-2",
                resume=[
                    ResumeEntry(
                        interrupt_id="open", status="resolved", payload=False
                    )
                ],
            ),
        )
        accepted = await _collect_events(
            agent,
            _make_run_input(
                run_id="run-3",
                resume=[
                    ResumeEntry(
                        interrupt_id="open", status="resolved", payload=False
                    ),
                    ResumeEntry(
                        interrupt_id="other-open", status="resolved", payload=True
                    ),
                ],
            ),
        )

    _assert_single_run_error(rejected, "INTERRUPT_RESUME_ERROR")
    _assert_single_run_error(partial, "PARTIAL_RESUME")
    assert not any(event.type == EventType.RUN_ERROR for event in accepted)
    assert core.stream_prompts == [
        [
            {
                "interruptResponse": {
                    "interruptId": "open",
                    "response": {"response": False},
                }
            },
            {
                "interruptResponse": {
                    "interruptId": "other-open",
                    "response": {"response": True},
                }
            },
        ]
    ]


@pytest.mark.parametrize(
    ("session_manager", "expected_code"),
    [
        pytest.param(None, "INTERRUPT_SESSION_REQUIRED", id="no-session"),
        pytest.param(
            SimpleNamespace(session_id="session-without-repository"),
            "INTERRUPT_SESSION_CAPABILITY_ERROR",
            id="missing-repository-capability",
        ),
    ],
)
@pytest.mark.asyncio
async def test_post_stream_new_mixed_checkpoint_fails_before_outcome_and_stays_retryable(
    session_manager, expected_code
):
    core = _PostStreamMixedCore(session_manager=session_manager)
    agent = _make_base_agent()

    with patch("ag_ui_strands.agent.StrandsAgentCore", return_value=core):
        initial_events = await _collect_events(agent, _make_run_input())
        resumed_events = await _collect_events(
            agent,
            _make_run_input(
                run_id="run-2",
                resume=[
                    ResumeEntry(
                        interrupt_id="native-interrupt",
                        status="resolved",
                        payload=True,
                    )
                ],
            ),
        )

    _assert_single_run_error(initial_events, expected_code)
    _assert_single_run_error(resumed_events, expected_code)
    assert core.stream_prompts == [""]
    assert core._interrupt_state.activated
    assert core._interrupt_state.context["tool_results"][0]["content"] == [
        {"text": PROXY_RESULT_PLACEHOLDER}
    ]


def _sdk_active_mixed_core(session_manager=None, answered=False) -> _MockStrandsCore:
    """A checkpoint the SDK still holds active, parking a proxy placeholder.

    ``answered`` records an answer on the interrupt, which is how a checkpoint
    ends up active with nothing open: the SDK settles the interrupt but the tool
    output it parked has not been appended to the conversation yet.
    """
    interrupt = StrandsInterrupt(id="native-interrupt", name="confirm")
    if answered:
        interrupt.response = {"approved": True}
    core = _MockStrandsCore(interrupts=[interrupt], session_manager=session_manager)
    core._interrupt_state.context["tool_use_message"] = {
        "role": "assistant",
        "content": [{"toolUse": {"toolUseId": "native-proxy", "name": "proxy"}}],
    }
    core._interrupt_state.context["tool_results"] = [
        {
            "toolUseId": "native-proxy",
            "status": "success",
            "content": [{"text": PROXY_RESULT_PLACEHOLDER}],
        }
    ]
    core.messages = [
        {
            "role": "user",
            "content": [
                {
                    "toolResult": {
                        "toolUseId": "native-proxy",
                        "status": "success",
                        "content": [{"text": PROXY_RESULT_PLACEHOLDER}],
                    }
                }
            ],
        }
    ]
    return core


def _repository_manager() -> SimpleNamespace:
    repository = SimpleNamespace(
        list_messages=MagicMock(return_value=[]),
        update_message=MagicMock(),
    )
    return SimpleNamespace(
        session_id="session-1",
        session_repository=repository,
    )


def _active_mixed_mock_core() -> _MockStrandsCore:
    core = _MockStrandsCore(
        interrupts=[StrandsInterrupt(id="native-interrupt", name="confirm")],
        session_manager=_repository_manager(),
    )
    core._interrupt_state.context["tool_results"] = [
        {
            "toolUseId": "native-proxy",
            "status": "success",
            "content": [{"text": PROXY_RESULT_PLACEHOLDER}],
        }
    ]
    core.messages = [
        {
            "role": "user",
            "content": [
                {
                    "toolResult": {
                        "toolUseId": "native-proxy",
                        "status": "success",
                        "content": [{"text": PROXY_RESULT_PLACEHOLDER}],
                    }
                }
            ],
        }
    ]
    core.state.set(AG_UI_WIRE_MAP_STATE_KEY, {"wire-proxy": "native-proxy"})
    return core


def _mixed_resume_input(*, include_proxy_result: bool) -> RunAgentInput:
    messages = (
        [
            ToolMessage(
                id="tool-result",
                role="tool",
                tool_call_id="wire-proxy",
                content='{"approved": true}',
            )
        ]
        if include_proxy_result
        else []
    )
    return _make_run_input(
        messages=messages,
        resume=[
            ResumeEntry(
                interrupt_id="native-interrupt",
                status="resolved",
                payload=True,
            )
        ],
        tools=[Tool(name="approveTool", description="approve", parameters={})],
    )


@pytest.mark.parametrize(
    ("session_manager", "expected_code"),
    [
        pytest.param(None, "INTERRUPT_SESSION_REQUIRED", id="no-session"),
        pytest.param(
            SimpleNamespace(session_id="session-without-repository"),
            "INTERRUPT_SESSION_CAPABILITY_ERROR",
            id="missing-repository-capability",
        ),
    ],
)
@pytest.mark.asyncio
async def test_resume_against_a_parked_proxy_placeholder_hits_the_mixed_guard(
    session_manager, expected_code
):
    """The guard reads the checkpoint's parked tool results, so they must be there."""
    core = _sdk_active_mixed_core(session_manager=session_manager)
    agent = _make_base_agent()
    before = _snapshot_mutable_core_state(core)

    with patch("ag_ui_strands.agent.StrandsAgentCore", return_value=core):
        events = await _collect_events(
            agent,
            _mixed_resume_input(include_proxy_result=True),
        )

    _assert_single_run_error(events, expected_code)
    assert core.stream_prompts == []
    assert _snapshot_mutable_core_state(core) == before


@pytest.mark.asyncio
async def test_fresh_turn_never_admits_a_checkpoint_parking_a_proxy_placeholder():
    """The parked placeholder must not reach the model as the tool's own output.

    An answered interrupt leaves the checkpoint active with nothing open. Clearing
    it for the fresh turn also clears the tool results the mixed frontend-proxy
    guard reads a few dozen lines later, so the guard passes on an empty
    checkpoint and the placeholder is replayed to the model under a success
    outcome.
    """
    core = _sdk_active_mixed_core(answered=True)
    agent = _make_base_agent()
    before = _snapshot_mutable_core_state(core)

    with patch("ag_ui_strands.agent.StrandsAgentCore", return_value=core):
        events = await _collect_events(
            agent,
            _make_run_input(messages=[UserMessage(id="u1", content="what now?")]),
        )

    _assert_single_run_error(events, "PENDING_INTERRUPTS")
    assert core.stream_prompts == []
    assert _snapshot_mutable_core_state(core) == before


@pytest.mark.asyncio
async def test_active_mixed_resume_requires_every_proxy_result_before_reconciliation():
    core = _active_mixed_mock_core()
    agent = _make_base_agent(StrandsAgentConfig())
    before = copy.deepcopy(core._interrupt_state.to_dict())

    with (
        patch("ag_ui_strands.agent.StrandsAgentCore", return_value=core),
        patch("ag_ui_strands.agent.reconcile_frontend_tool_results") as reconcile_spy,
    ):
        events = await _collect_events(
            agent, _mixed_resume_input(include_proxy_result=False)
        )

    _assert_single_run_error(events, "INTERRUPT_RECONCILIATION_ERROR")
    reconcile_spy.assert_not_called()
    assert core.stream_prompts == []
    assert core._interrupt_state.to_dict() == before


@pytest.mark.asyncio
async def test_active_mixed_capability_accessor_failure_is_atomic_and_retryable():
    class ThrowingRepository:
        @property
        def list_messages(self):
            raise RuntimeError("list_messages unavailable")

        update_message = MagicMock()

    core = _active_mixed_mock_core()
    core.state.set("agui_context", [])
    core.session_manager.session_repository = ThrowingRepository()
    agent = _make_base_agent(StrandsAgentConfig())
    input_data = _mixed_resume_input(include_proxy_result=True).model_copy(
        update={"tools": []}
    )
    before = _snapshot_mutable_core_state(core)

    with patch("ag_ui_strands.agent.StrandsAgentCore", return_value=core):
        rejected = await _collect_events(agent, input_data)

    _assert_single_run_error(rejected, "INTERRUPT_SESSION_CAPABILITY_ERROR")
    assert core.stream_prompts == []
    assert _snapshot_mutable_core_state(core) == before

    core.session_manager.session_repository = _repository_manager().session_repository
    with patch("ag_ui_strands.agent.StrandsAgentCore", return_value=core):
        retried = await _collect_events(
            agent,
            input_data.model_copy(update={"run_id": "run-2"}),
        )

    assert not any(event.type == EventType.RUN_ERROR for event in retried)
    assert len(core.stream_prompts) == 1
    assert core._interrupt_state.context["tool_results"][0]["content"] == [
        {"text": '{"approved": true}'}
    ]


@pytest.mark.parametrize(
    "failure_point", ["wire-map-read", "id-resolution", "repository"]
)
@pytest.mark.asyncio
async def test_active_reconciliation_failure_is_atomic_and_retryable(failure_point):
    core = _active_mixed_mock_core()
    core.state.set("agui_context", [])
    agent = _make_base_agent(StrandsAgentConfig())
    input_data = _mixed_resume_input(include_proxy_result=True).model_copy(
        update={"tools": []}
    )
    before = _snapshot_mutable_core_state(core)
    original_state_get = core.state.get

    def fail_wire_map_read(key=None):
        if key == AG_UI_WIRE_MAP_STATE_KEY:
            raise RuntimeError("wire map unavailable")
        return original_state_get(key)

    if failure_point == "wire-map-read":
        failure_patch = patch.object(core.state, "get", side_effect=fail_wire_map_read)
    elif failure_point == "id-resolution":
        failure_patch = patch(
            "ag_ui_strands.agent.resolve_native_ids",
            side_effect=RuntimeError("id resolution unavailable"),
        )
    else:
        failure_patch = patch(
            "ag_ui_strands.agent.reconcile_frontend_tool_results",
            side_effect=RuntimeError("repository unavailable"),
        )
    with (
        patch("ag_ui_strands.agent.StrandsAgentCore", return_value=core),
        failure_patch,
    ):
        rejected = await _collect_events(agent, input_data)

    _assert_single_run_error(rejected, "INTERRUPT_RECONCILIATION_ERROR")
    assert core.stream_prompts == []
    assert _snapshot_mutable_core_state(core) == before

    with patch("ag_ui_strands.agent.StrandsAgentCore", return_value=core):
        retried = await _collect_events(
            agent,
            input_data.model_copy(update={"run_id": "run-2"}),
        )

    assert not any(event.type == EventType.RUN_ERROR for event in retried)
    assert len(core.stream_prompts) == 1
    assert core._interrupt_state.context["tool_results"][0]["content"] == [
        {"text": '{"approved": true}'}
    ]


@pytest.mark.asyncio
async def test_active_native_resume_metadata_read_failure_is_atomic_and_retryable(
    caplog,
):
    core = _MockStrandsCore(
        interrupts=[StrandsInterrupt(id="native-interrupt", name="confirm")],
        session_manager=None,
    )
    core.state.set("agui_context", [])
    agent = _make_base_agent()
    input_data = _make_run_input(
        resume=[
            ResumeEntry(
                interrupt_id="native-interrupt",
                status="resolved",
                payload=True,
            )
        ]
    )
    before = _snapshot_mutable_core_state(core)
    original_state_get = core.state.get

    def fail_tool_call_map_read(key=None):
        if key == AG_UI_TOOL_CALL_MAP_STATE_KEY:
            raise RuntimeError("tool-call metadata unavailable")
        return original_state_get(key)

    with (
        patch("ag_ui_strands.agent.StrandsAgentCore", return_value=core),
        patch.object(core.state, "get", side_effect=fail_tool_call_map_read),
    ):
        rejected = await _collect_events(agent, input_data)

    _assert_single_run_error(rejected, "INTERRUPT_RECONCILIATION_ERROR")
    assert "Active interrupt tool result reconciliation failed" in caplog.text
    assert core.stream_prompts == []
    assert _snapshot_mutable_core_state(core) == before

    with patch("ag_ui_strands.agent.StrandsAgentCore", return_value=core):
        retried = await _collect_events(
            agent,
            input_data.model_copy(update={"run_id": "run-2"}),
        )

    assert not any(event.type == EventType.RUN_ERROR for event in retried)
    assert len(core.stream_prompts) == 1


@pytest.mark.asyncio
async def test_active_reconciliation_retry_counts_already_applied_results(tmp_path):
    native_results = {
        "native-proxy-1": '{"approved": true}',
        "native-proxy-2": '{"approved": false}',
    }
    wire_to_native = {
        "wire-proxy-1": "native-proxy-1",
        "wire-proxy-2": "native-proxy-2",
    }

    session_manager = FileSessionManager(
        session_id="session-1", storage_dir=str(tmp_path)
    )
    repository = session_manager.session_repository
    repository.create_agent(
        session_manager.session_id,
        SessionAgent(agent_id="default", state={}, conversation_manager_state={}),
    )

    def tool_result(tool_use_id, text):
        return {
            "toolUseId": tool_use_id,
            "status": "success",
            "content": [{"text": text}],
        }

    for index, native_id in enumerate(native_results):
        repository.create_message(
            session_manager.session_id,
            "default",
            SessionMessage(
                message={
                    "role": "user",
                    "content": [
                        {"toolResult": tool_result(native_id, PROXY_RESULT_PLACEHOLDER)}
                    ],
                },
                message_id=index,
            ),
        )

    core = _active_mixed_mock_core()
    core.session_manager = session_manager
    core.messages = [
        {
            "role": "user",
            "content": [
                {
                    "toolResult": tool_result(
                        native_id, PROXY_RESULT_PLACEHOLDER
                    )
                }
                for native_id in native_results
            ],
        }
    ]
    core._interrupt_state.context["tool_results"] = [
        tool_result(native_id, PROXY_RESULT_PLACEHOLDER)
        for native_id in native_results
    ]
    core.state.set(AG_UI_WIRE_MAP_STATE_KEY, wire_to_native)
    core.state.set("agui_context", [])

    async def consume_checkpoint(prompt):
        core._interrupt_state.deactivate()
        yield {"complete": True}

    core._stream_body = consume_checkpoint
    agent = _make_base_agent(StrandsAgentConfig())
    input_data = _make_run_input(
        messages=[
            ToolMessage(
                id=f"result-{wire_id}",
                role="tool",
                tool_call_id=wire_id,
                content=native_results[native_id],
            )
            for wire_id, native_id in wire_to_native.items()
        ],
        resume=[
            ResumeEntry(
                interrupt_id="native-interrupt", status="resolved", payload=True
            )
        ],
        tools=[],
    )

    original_update = repository.update_message
    update_count = 0

    def fail_second_update(session_id, agent_id, session_message):
        nonlocal update_count
        update_count += 1
        if update_count == 2:
            raise RuntimeError("second repository update unavailable")
        original_update(session_id, agent_id, session_message)
        # The first committed target may already be visible on the live and
        # checkpoint surfaces when a later repository target fails.
        expected = [{"text": native_results["native-proxy-1"]}]
        core.messages[0]["content"][0]["toolResult"]["content"] = expected
        core._interrupt_state.context["tool_results"][0]["content"] = expected

    with (
        patch("ag_ui_strands.agent.StrandsAgentCore", return_value=core),
        patch.object(repository, "update_message", side_effect=fail_second_update),
    ):
        rejected = await _collect_events(agent, input_data)

    _assert_single_run_error(rejected, "INTERRUPT_RECONCILIATION_ERROR")
    assert core.stream_prompts == []
    assert core._interrupt_state.activated
    assert set(core._interrupt_state.interrupts) == {"native-interrupt"}
    assert core.state.get(AG_UI_WIRE_MAP_STATE_KEY) == wire_to_native

    partially_updated = repository.list_messages("session-1", "default")
    assert partially_updated[0].message["content"][0]["toolResult"]["content"] == [
        {"text": native_results["native-proxy-1"]}
    ]
    assert partially_updated[1].message["content"][0]["toolResult"]["content"] == [
        {"text": PROXY_RESULT_PLACEHOLDER}
    ]

    with patch("ag_ui_strands.agent.StrandsAgentCore", return_value=core):
        retried = await _collect_events(
            agent, input_data.model_copy(update={"run_id": "run-2"})
        )

    assert not any(event.type == EventType.RUN_ERROR for event in retried)
    assert any(event.type == EventType.RUN_FINISHED for event in retried)
    assert len(core.stream_prompts) == 1
    assert not core._interrupt_state.activated
    assert core.state.get(AG_UI_WIRE_MAP_STATE_KEY) == {}
    persisted = repository.list_messages("session-1", "default")
    for index, expected_text in enumerate(native_results.values()):
        assert persisted[index].message["content"][0]["toolResult"]["content"] == [
            {"text": expected_text}
        ]


@pytest.mark.asyncio
async def test_non_active_reconciliation_exception_keeps_legacy_fallback(caplog):
    core = _MockStrandsCore(session_manager=_repository_manager())
    core.state.set(AG_UI_WIRE_MAP_STATE_KEY, {"wire-proxy": "native-proxy"})
    agent = _make_base_agent(StrandsAgentConfig())
    input_data = _make_run_input(
        messages=[
            ToolMessage(
                id="tool-result",
                role="tool",
                tool_call_id="wire-proxy",
                content='{"approved": true}',
            )
        ],
        tools=[Tool(name="approveTool", description="approve", parameters={})],
    )

    with (
        patch("ag_ui_strands.agent.StrandsAgentCore", return_value=core),
        patch(
            "ag_ui_strands.agent.reconcile_frontend_tool_results",
            side_effect=RuntimeError("repository unavailable"),
        ),
    ):
        events = await _collect_events(agent, input_data)

    assert not any(event.type == EventType.RUN_ERROR for event in events)
    assert any(event.type == EventType.RUN_FINISHED for event in events)
    assert len(core.stream_prompts) == 1
    assert "falling back to the legacy continuation path" in caplog.text


# ---------------------------------------------------------------------------
# Real-agent end-to-end regression
#
# The tests above replay canned events through ``_MockStrandsCore`` and never
# drive the real Strands event loop, tool executor, or interrupt machinery.
# This section runs a real ``strands.Agent`` with a scripted stub ``Model``
# and a real ``@tool(context=True)`` tool so the interrupt/resume round-trip
# is exercised for real.
# ---------------------------------------------------------------------------


@tool(context=True)
def confirm_action(key: str, tool_context: ToolContext) -> dict:
    # Resume envelope: {"cancelled": True} on cancel, {"response": <raw>} on
    # resolve. Destructure — do NOT truthiness-check the envelope, since it is
    # always truthy on resolve (that's the whole point of the wrap).
    envelope = tool_context.interrupt("confirm_action", reason={"key": key})
    if envelope.get("cancelled"):
        return {"status": "success", "content": [{"text": f"denied {key}"}]}
    if envelope.get("response"):
        return {"status": "success", "content": [{"text": f"confirmed {key}"}]}
    return {"status": "success", "content": [{"text": f"denied {key}"}]}


class _InterruptFlowModel(StrandsModel):
    """Turn 1: calls the frontend proxy tool and the interrupting native tool
    in the same batch. Turn 2+: narrates a final answer."""

    def __init__(self, *, include_frontend=True):
        self.turn = 0
        self.include_frontend = include_frontend
        self.stream_calls_messages = []

    def get_config(self):
        return {}

    def update_config(self, **kwargs):
        pass

    async def structured_output(self, output_model, prompt=None, system_prompt=None, **kwargs):
        raise NotImplementedError
        yield  # pragma: no cover — make this an async generator

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs):
        self.turn += 1
        self.stream_calls_messages.append(messages)
        if self.turn == 1:
            yield {"messageStart": {"role": "assistant"}}
            if self.include_frontend:
                yield {
                    "contentBlockStart": {
                        "start": {
                            "toolUse": {
                                "toolUseId": "native-approve",
                                "name": "approveTool",
                            }
                        }
                    }
                }
                yield {
                    "contentBlockDelta": {"delta": {"toolUse": {"input": "{}"}}}
                }
                yield {"contentBlockStop": {}}
            yield {
                "contentBlockStart": {
                    "start": {"toolUse": {"toolUseId": "native-confirm", "name": "confirm_action"}}
                }
            }
            yield {"contentBlockDelta": {"delta": {"toolUse": {"input": '{"key": "widget-1"}'}}}}
            yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "tool_use"}}
        else:
            yield {"messageStart": {"role": "assistant"}}
            yield {"contentBlockDelta": {"delta": {"text": "Done."}}}
            yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "end_turn"}}


def _make_e2e_agent(config: StrandsAgentConfig) -> tuple[StrandsAgent, _InterruptFlowModel]:
    model = _InterruptFlowModel()
    core = StrandsAgentCore(model=model, tools=[confirm_action], system_prompt="test")
    return StrandsAgent(core, name="e2e-interrupt", config=config), model


@pytest.mark.asyncio
async def test_interrupt_bookkeeping_is_durable_when_each_run_returns(tmp_path):
    managers: dict[str, FileSessionManager] = {}

    def session_manager_provider(input_data):
        manager = FileSessionManager(
            session_id=input_data.thread_id,
            storage_dir=str(tmp_path),
        )
        managers[input_data.thread_id] = manager
        return manager

    config = StrandsAgentConfig(session_manager_provider=session_manager_provider)
    model = _InterruptFlowModel(include_frontend=False)
    core = StrandsAgentCore(model=model, tools=[confirm_action], system_prompt="test")
    agent = StrandsAgent(core, name="e2e-interrupt", config=config)
    thread_id = "durable-interrupt-bookkeeping"

    paused_events = await _collect_events(
        agent,
        _make_run_input(
            thread_id=thread_id,
            messages=[UserMessage(id="u1", role="user", content="confirm")],
        ),
    )
    paused = next(event for event in paused_events if event.type == EventType.RUN_FINISHED)
    interrupt_id = paused.outcome.interrupts[0].id
    strands_agent = agent._agents_by_thread[thread_id]
    manager = managers[thread_id]

    persisted_pause = manager.session_repository.read_agent(
        thread_id, strands_agent.agent_id
    )
    pause_bookkeeping = persisted_pause.state[_INTERRUPT_BOOKKEEPING_STATE_KEY]
    assert set(pause_bookkeeping["pending_interrupts"]) == {interrupt_id}
    assert pause_bookkeeping["last_resume_fingerprint"] is None

    resumed_events = await _collect_events(
        agent,
        _make_run_input(
            thread_id=thread_id,
            run_id="run-2",
            resume=[
                ResumeEntry(
                    interrupt_id=interrupt_id,
                    status="resolved",
                    payload=True,
                )
            ],
        ),
    )
    assert not any(event.type == EventType.RUN_ERROR for event in resumed_events)

    persisted_resume = manager.session_repository.read_agent(
        thread_id, strands_agent.agent_id
    )
    resume_bookkeeping = persisted_resume.state[_INTERRUPT_BOOKKEEPING_STATE_KEY]
    assert resume_bookkeeping["pending_interrupts"] == {}
    assert isinstance(resume_bookkeeping["last_resume_fingerprint"], str)


@pytest.mark.asyncio
async def test_cancelled_approval_emits_one_tool_result_inside_run_envelope():
    config = StrandsAgentConfig(
        tool_behaviors={
            "confirm_action": ToolBehavior(interrupt_on_call=True),
        }
    )
    model = _InterruptFlowModel(include_frontend=False)
    core = StrandsAgentCore(model=model, tools=[confirm_action], system_prompt="test")
    agent = StrandsAgent(core, name="e2e-interrupt", config=config)
    thread_id = "cancelled-approval-result"

    paused_events = await _collect_events(
        agent,
        _make_run_input(
            thread_id=thread_id,
            messages=[UserMessage(id="u1", role="user", content="confirm")],
        ),
    )
    paused = next(event for event in paused_events if event.type == EventType.RUN_FINISHED)
    interrupt_id = paused.outcome.interrupts[0].id

    resumed_events = await _collect_events(
        agent,
        _make_run_input(
            thread_id=thread_id,
            run_id="run-2",
            resume=[
                ResumeEntry(
                    interrupt_id=interrupt_id,
                    status="cancelled",
                )
            ],
        ),
    )

    tool_results = [
        event
        for event in resumed_events
        if event.type == EventType.TOOL_CALL_RESULT
        and event.tool_call_id == "native-confirm"
    ]
    assert len(tool_results) == 1
    assert resumed_events[0].type == EventType.RUN_STARTED
    assert resumed_events.index(tool_results[0]) > 0


@pytest.mark.asyncio
async def test_native_interrupt_resumes_live_without_session_and_restores_callbacks_once():
    state_contexts = []
    custom_contexts = []

    def state_from_result(ctx):
        state_contexts.append(ctx)
        return {"confirmed_key": ctx.tool_input["key"]}

    async def custom_result_handler(ctx):
        custom_contexts.append(ctx)
        yield CustomEvent(
            type=EventType.CUSTOM,
            name="native-resume-result",
            value={"tool": ctx.tool_name},
        )

    model = _InterruptFlowModel(include_frontend=False)
    core = StrandsAgentCore(model=model, tools=[confirm_action], system_prompt="test")
    agent = StrandsAgent(
        core,
        name="live-native-interrupt",
        config=StrandsAgentConfig(
            tool_behaviors={
                "confirm_action": ToolBehavior(
                    state_from_result=state_from_result,
                    custom_result_handler=custom_result_handler,
                )
            }
        ),
    )

    initial_events = await _collect_events(
        agent,
        _make_run_input(
            messages=[
                UserMessage(id="user-1", role="user", content="confirm widget-1")
            ]
        ),
    )
    interrupt = next(
        event for event in initial_events if event.type == EventType.RUN_FINISHED
    ).outcome.interrupts[0]
    live_core = agent._agents_by_thread["thread-1"]
    saved_meta = live_core.state.get(AG_UI_TOOL_CALL_MAP_STATE_KEY)
    assert saved_meta["native-confirm"] == {
        "name": "confirm_action",
        "args": '{"key": "widget-1"}',
        "input": {"key": "widget-1"},
        "strands_tool_id": "native-confirm",
    }

    resumed_events = await _collect_events(
        agent,
        _make_run_input(
            run_id="run-2",
            resume=[
                ResumeEntry(
                    interrupt_id=interrupt.id,
                    status="resolved",
                    payload=True,
                )
            ],
        ),
    )

    assert not any(event.type == EventType.RUN_ERROR for event in resumed_events)
    assert len(state_contexts) == 1
    assert len(custom_contexts) == 1
    for ctx in (state_contexts[0], custom_contexts[0]):
        assert ctx.tool_name == "confirm_action"
        assert ctx.tool_use_id == "native-confirm"
        assert ctx.tool_input == {"key": "widget-1"}
        assert ctx.args_str == '{"key": "widget-1"}'
    assert [
        event.value
        for event in resumed_events
        if event.type == EventType.CUSTOM and event.name == "native-resume-result"
    ] == [{"tool": "confirm_action"}]
    assert live_core.state.get(AG_UI_TOOL_CALL_MAP_STATE_KEY) == {}


@pytest.mark.parametrize("recreate_agent", [False, True])
@pytest.mark.parametrize("fe_continues", [False, True])
@pytest.mark.asyncio
async def test_mixed_resume_batch_with_falsy_payload_and_tool_behaviors(
    tmp_path, recreate_agent, fe_continues
):
    """Regression for mixed FE tools & interrupts.

    Uses a real ``FileSessionManager`` — the no-session-manager path (in-memory
    ``replay_history_into_strands``) is out of scope for this regression.

    Parametrized on ``recreate_agent``: ``False`` exercises resume through the
    same in-memory ``StrandsAgent``/``StrandsAgentCore`` (the per-thread cache
    still holds the paused agent); ``True`` discards them after turn 1 and
    resumes through freshly constructed ones sharing the same
    ``FileSessionManager``-backed session — the cross-process resume scenario
    the README's "Persistence" caveat describes, where nothing survives in
    memory from turn 1.

    Parametrized on ``fe_continues`` (``continue_after_frontend_call`` for the
    frontend tool) because in THIS batch shape the flag is near-moot, and both
    settings must reach the same interrupt outcome:

    * The model commits both ``toolUse`` blocks in ONE assistant message, so
      the halt cannot pre-empt ``confirm_action`` — it is already dispatched
      concurrently by Strands' ``ConcurrentToolExecutor``.
    * ``confirm_action`` interrupts, so Strands returns early at
      ``event_loop.py:501`` WITHOUT appending the ``role=user`` tool-result
      message. That message is the only place ``pending_halt`` is promoted to
      ``halt_event_stream`` (``agent.py:1479-1480``), so the halt latches but
      never fires; the interrupt stops the loop instead. Measured consequence:
      the flag only changes where the frontend ``TOOL_CALL_END`` lands on the
      wire.

    ``False`` keeps coverage that a latched-but-unfired halt does not corrupt
    the interrupt path (moving the latch earlier would break this param and
    not the other); ``True`` models immediate hand-off.
    """
    tool_behaviors = {
        "confirm_action": ToolBehavior(
            state_from_result=lambda ctx: {"confirmed_key": ctx.result_data}
        )
    }
    if fe_continues:
        tool_behaviors["approveTool"] = ToolBehavior(continue_after_frontend_call=True)
    config = StrandsAgentConfig(
        tool_behaviors=tool_behaviors,
        session_manager_provider=lambda input_data: FileSessionManager(
            session_id=input_data.thread_id, storage_dir=str(tmp_path)
        ),
    )
    agent, model = _make_e2e_agent(config)

    approve_tool = Tool(name="approveTool", description="approve", parameters={})
    inp1 = _make_run_input(
        messages=[UserMessage(id="u1", role="user", content="please handle widget-1")],
        tools=[approve_tool],
    )
    events1 = await _collect_events(agent, inp1)

    finished1 = next(e for e in events1 if e.type == EventType.RUN_FINISHED)
    assert finished1.outcome is not None
    assert finished1.outcome.type == "interrupt"
    interrupt_id = finished1.outcome.interrupts[0].id
    fe_wire_id = next(
        e.tool_call_id
        for e in events1
        if e.type == EventType.TOOL_CALL_START and e.tool_call_name == "approveTool"
    )

    if recreate_agent:
        # Discard the wrapper and underlying core entirely — turn 2 must
        # restore interrupt state, the wire->native map, and history purely
        # from the FileSessionManager-backed session, not from memory. Carry
        # over the turn count so it reads the same as the non-recreated case.
        prior_turn = model.turn
        agent, model = _make_e2e_agent(config)
        model.turn = prior_turn

    inp2 = _make_run_input(
        run_id="run-2",
        messages=[
            ToolMessage(
                id="t-fe",
                role="tool",
                tool_call_id=fe_wire_id,
                content='{"approved": true}',
            )
        ],
        resume=[ResumeEntry(interrupt_id=interrupt_id, status="resolved", payload=False)],
        tools=[approve_tool],
    )
    events2 = await _collect_events(agent, inp2)

    # --- A falsy-but-explicit resume payload must resolve, not loop. ---
    finished2 = next(e for e in events2 if e.type == EventType.RUN_FINISHED)
    still_stuck = (
        finished2.outcome is not None
        and finished2.outcome.type == "interrupt"
        and finished2.outcome.interrupts[0].id == interrupt_id
    )
    assert not still_stuck, "falsy resume payload re-emitted the same interrupt"

    # --- The frontend tool's REAL result must reach the model. ---
    assert model.turn >= 2, "resume never advanced the event loop past the interrupt"
    last_messages_text = json.dumps(model.stream_calls_messages[-1])
    assert "approved" in last_messages_text
    assert "Forwarded to client" not in last_messages_text

    # --- state_from_result must fire for a tool resolved on resume. ---
    assert any(
        e.type == EventType.STATE_SNAPSHOT and e.snapshot.get("confirmed_key") for e in events2
    ), "state_from_result did not fire for confirm_action on the resume run"
