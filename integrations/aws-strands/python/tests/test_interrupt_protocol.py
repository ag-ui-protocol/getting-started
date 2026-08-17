"""Tests for the AG-UI interrupt-and-resume protocol in StrandsAgent.

The interrupt protocol is built on top of the Strands native interrupt system:

- StrandsInterruptHook fires on BeforeToolCallEvent for interrupt_on_call tools
  and calls event.interrupt(), which suspends the Strands agent loop natively.
- agent.py detects result.stop_reason == "interrupt" in the AgentResult event
  and emits RunFinishedInterruptOutcome using the Strands interrupt IDs directly.
- On resume, input_data.resume entries are converted to interruptResponse dicts
  and passed to stream_async() — Strands resumes from its checkpoint.

Covers:
- interrupt_on_call=True emits RunFinishedInterruptOutcome with correct fields
- interrupt_on_call=False (default) keeps legacy pending_halt behaviour (no interrupt outcome)
- Normal runs (no frontend tool) emit RunFinishedSuccessOutcome
- Resume: resolved+approved passes `{"approved": True}` to Strands and continues
- Resume: resolved+denied passes `{"approved": False}` to Strands and continues
- Resume: cancelled forwards a native denial through stream_async() and ends cleanly
- Resume: unknown interrupt_id yields RunErrorEvent
- Resume: no pending interrupt on thread yields RunErrorEvent
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Sequence
from unittest.mock import MagicMock

import pytest
from ag_ui.core import (
    EventType,
    Interrupt,
    RunAgentInput,
    Tool,
    UserMessage,
)
from strands.interrupt import Interrupt as StrandsInterrupt
from strands.tools.registry import ToolRegistry

from ag_ui_strands.agent import StrandsAgent
from ag_ui_strands.config import StrandsAgentConfig, ToolBehavior
from ag_ui_strands import (
    ResumeEntry,
    RunFinishedInterruptOutcome,
    RunFinishedSuccessOutcome,
)


# ---------------------------------------------------------------------------
# Minimal AgentResult stub
# ---------------------------------------------------------------------------

@dataclass
class _FakeMetrics:
    pass


@dataclass
class _FakeAgentResult:
    """Minimal stand-in for strands.agent.agent_result.AgentResult."""
    stop_reason: str
    message: dict = field(default_factory=lambda: {"role": "assistant", "content": []})
    metrics: Any = field(default_factory=_FakeMetrics)
    state: Any = field(default_factory=dict)
    interrupts: Sequence[StrandsInterrupt] | None = None
    structured_output: Any = None


def _make_strands_interrupt(
    tool_name: str = "my_tool",
    tool_input: dict | None = None,
    tool_use_id: str = "st-1",
) -> StrandsInterrupt:
    """Build a Strands Interrupt as the hook would produce it."""
    import uuid
    interrupt_id = f"v1:before_tool_call:{tool_use_id}:{uuid.uuid5(uuid.NAMESPACE_OID, f'ag_ui:tool_call:{tool_name}')}"
    return StrandsInterrupt(
        id=interrupt_id,
        name=f"ag_ui:tool_call:{tool_name}",
        reason={"tool_name": tool_name, "tool_input": tool_input or {}},
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _template_agent() -> MagicMock:
    mock = MagicMock()
    mock.model = MagicMock()
    mock.system_prompt = "You are helpful"
    mock.tool_registry.registry = {}
    mock.record_direct_tool_call = True
    return mock


def _make_interrupt_state(activated: bool = False, interrupts: dict | None = None) -> MagicMock:
    """Build a mock _interrupt_state matching Strands' interface."""
    state = MagicMock()
    state.activated = activated
    state.interrupts = interrupts or {}
    state.deactivate = MagicMock(side_effect=lambda: setattr(state, "activated", False))
    return state


def _build_agent(
    thread_id: str,
    stream_events: list,
    config: StrandsAgentConfig | None = None,
    interrupt_state: MagicMock | None = None,
) -> StrandsAgent:
    agent = StrandsAgent(
        _template_agent(), name="test-agent", config=config or StrandsAgentConfig()
    )
    mock_inner = MagicMock()
    mock_inner.tool_registry = ToolRegistry()

    # Wire interrupt state
    mock_inner._interrupt_state = interrupt_state or _make_interrupt_state()

    async def _stream(_msg: Any):
        if isinstance(_msg, list) and any(
            isinstance(item, dict) and "interruptResponse" in item
            for item in _msg
        ):
            mock_inner._interrupt_state.deactivate()
        for event in stream_events:
            yield event

    mock_inner.stream_async = _stream
    agent._agents_by_thread[thread_id] = mock_inner
    return agent


def _run_input(
    thread_id: str = "t1",
    messages: list | None = None,
    tools: list | None = None,
    resume: list | None = None,
) -> RunAgentInput:
    return RunAgentInput(
        thread_id=thread_id,
        run_id="r1",
        state={},
        messages=messages or [UserMessage(id="u1", content="hello")],
        tools=tools or [],
        context=[],
        forwarded_props={},
        resume=resume,
    )


async def _collect(agent: StrandsAgent, inp: RunAgentInput) -> list:
    return [e async for e in agent.run(inp)]


def _frontend_tool_stream_with_interrupt(
    tool_name: str = "my_tool",
    tool_use_id: str = "st-1",
) -> list:
    """Stream that ends with an AgentResult carrying stop_reason='interrupt'."""
    strands_interrupt = _make_strands_interrupt(tool_name, {}, tool_use_id)
    return [
        {"current_tool_use": {"name": tool_name, "toolUseId": tool_use_id, "input": {}}},
        {"event": {"contentBlockStop": {}}},
        {"result": _FakeAgentResult(
            stop_reason="interrupt",
            interrupts=[strands_interrupt],
        )},
    ]


def _empty_stream() -> list:
    return [
        {"result": _FakeAgentResult(stop_reason="end_turn")},
    ]


# ---------------------------------------------------------------------------
# interrupt_on_call=True — interrupt outcome emitted
# ---------------------------------------------------------------------------

class TestInterruptOutcomeEmitted:
    THREAD = "interrupt-thread"
    TOOL = Tool(name="my_tool", description="d", parameters={})

    def _config(self) -> StrandsAgentConfig:
        return StrandsAgentConfig(
            tool_behaviors={"my_tool": ToolBehavior(interrupt_on_call=True)}
        )

    async def test_run_finished_has_interrupt_outcome(self):
        agent = _build_agent(self.THREAD, _frontend_tool_stream_with_interrupt(), self._config())
        events = await _collect(agent, _run_input(self.THREAD, tools=[self.TOOL]))

        finished = [e for e in events if e.type == EventType.RUN_FINISHED]
        assert len(finished) == 1
        outcome = finished[0].outcome
        assert isinstance(outcome, RunFinishedInterruptOutcome)
        assert outcome.type == "interrupt"

    async def test_interrupt_has_correct_reason(self):
        agent = _build_agent(self.THREAD + "-reason", _frontend_tool_stream_with_interrupt(), self._config())
        events = await _collect(agent, _run_input(self.THREAD + "-reason", tools=[self.TOOL]))

        finished = [e for e in events if e.type == EventType.RUN_FINISHED]
        interrupt = finished[0].outcome.interrupts[0]
        assert interrupt.reason == "tool_call"

    async def test_interrupt_id_matches_strands_id(self):
        """The AG-UI interrupt.id must be the Strands deterministic interrupt ID."""
        strands_interrupt = _make_strands_interrupt("my_tool", {}, "st-1")
        stream = [
            {"current_tool_use": {"name": "my_tool", "toolUseId": "st-1", "input": {}}},
            {"event": {"contentBlockStop": {}}},
            {"result": _FakeAgentResult(stop_reason="interrupt", interrupts=[strands_interrupt])},
        ]
        agent = _build_agent(self.THREAD + "-id", stream, self._config())
        events = await _collect(agent, _run_input(self.THREAD + "-id", tools=[self.TOOL]))

        finished = [e for e in events if e.type == EventType.RUN_FINISHED]
        ag_ui_interrupt = finished[0].outcome.interrupts[0]
        assert ag_ui_interrupt.id == strands_interrupt.id

    async def test_interrupt_has_response_schema(self):
        agent = _build_agent(self.THREAD + "-schema", _frontend_tool_stream_with_interrupt(), self._config())
        events = await _collect(agent, _run_input(self.THREAD + "-schema", tools=[self.TOOL]))

        finished = [e for e in events if e.type == EventType.RUN_FINISHED]
        interrupt = finished[0].outcome.interrupts[0]
        assert interrupt.response_schema is not None
        assert "approved" in interrupt.response_schema.get("properties", {})

    async def test_interrupt_id_is_deterministic(self):
        """Same tool call + same name always produces the same interrupt ID."""
        si1 = _make_strands_interrupt("my_tool", {}, "st-1")
        si2 = _make_strands_interrupt("my_tool", {}, "st-1")
        assert si1.id == si2.id


# ---------------------------------------------------------------------------
# interrupt_on_call=False (default) — legacy pending_halt, no interrupt outcome
# ---------------------------------------------------------------------------

class TestLegacyPendingHaltUnchanged:
    THREAD = "legacy-halt-thread"
    TOOL = Tool(name="my_tool", description="d", parameters={})

    async def test_run_finished_outcome_is_success_by_default(self):
        """Without interrupt_on_call, RunFinished.outcome is RunFinishedSuccessOutcome."""
        # Default ToolBehavior — no interrupt_on_call; stream ends with end_turn
        stream = [
            {"current_tool_use": {"name": "my_tool", "toolUseId": "st-1", "input": {}}},
            {"event": {"contentBlockStop": {}}},
            {"result": _FakeAgentResult(stop_reason="end_turn")},
        ]
        agent = _build_agent(self.THREAD, stream)
        events = await _collect(agent, _run_input(self.THREAD, tools=[self.TOOL]))

        finished = [e for e in events if e.type == EventType.RUN_FINISHED]
        assert len(finished) == 1
        assert not isinstance(finished[0].outcome, RunFinishedInterruptOutcome)


# ---------------------------------------------------------------------------
# Normal run (no frontend tool) — success outcome
# ---------------------------------------------------------------------------

class TestSuccessOutcomeOnNormalRun:
    THREAD = "success-thread"

    async def test_run_finished_has_success_outcome(self):
        agent = _build_agent(self.THREAD, _empty_stream())
        events = await _collect(agent, _run_input(self.THREAD))

        finished = [e for e in events if e.type == EventType.RUN_FINISHED]
        assert len(finished) == 1
        assert isinstance(finished[0].outcome, RunFinishedSuccessOutcome)


# ---------------------------------------------------------------------------
# Resume: resolved + approved
# ---------------------------------------------------------------------------

class TestResumeResolvedApproved:
    THREAD = "resume-approved-thread"
    TOOL = Tool(name="my_tool", description="d", parameters={})

    def _config(self) -> StrandsAgentConfig:
        return StrandsAgentConfig(
            tool_behaviors={"my_tool": ToolBehavior(interrupt_on_call=True)}
        )

    async def test_resume_approved_ends_with_success(self):
        strands_interrupt = _make_strands_interrupt("my_tool", {}, "st-1")
        interrupt_state = _make_interrupt_state(
            activated=True,
            interrupts={strands_interrupt.id: strands_interrupt},
        )

        # Second turn stream: normal completion
        resume_stream = [
            {"result": _FakeAgentResult(stop_reason="end_turn")},
        ]

        agent = _build_agent(self.THREAD, resume_stream, self._config(), interrupt_state)

        resume_input = _run_input(
            self.THREAD,
            tools=[self.TOOL],
            resume=[ResumeEntry(
                interrupt_id=strands_interrupt.id,
                status="resolved",
                payload={"approved": True},
            )],
        )
        events = await _collect(agent, resume_input)

        finished = [e for e in events if e.type == EventType.RUN_FINISHED]
        assert len(finished) == 1
        assert isinstance(finished[0].outcome, RunFinishedSuccessOutcome)

    async def test_resume_approved_passes_payload_to_strands(self):
        """Verify stream_async receives the resolved approval payload directly."""
        strands_interrupt = _make_strands_interrupt("my_tool", {}, "st-1")
        interrupt_state = _make_interrupt_state(
            activated=True,
            interrupts={strands_interrupt.id: strands_interrupt},
        )

        received_prompts: list = []

        async def _capture_stream(prompt: Any):
            received_prompts.append(prompt)
            yield {"result": _FakeAgentResult(stop_reason="end_turn")}

        agent = _build_agent(self.THREAD + "-y", [], self._config(), interrupt_state)
        agent._agents_by_thread[self.THREAD + "-y"].stream_async = _capture_stream

        resume_input = _run_input(
            self.THREAD + "-y",
            resume=[ResumeEntry(
                interrupt_id=strands_interrupt.id,
                status="resolved",
                payload={"approved": True},
            )],
        )
        await _collect(agent, resume_input)

        assert len(received_prompts) == 1
        prompt = received_prompts[0]
        assert isinstance(prompt, list)
        assert prompt[0]["interruptResponse"]["response"] == {"approved": True}
        assert prompt[0]["interruptResponse"]["interruptId"] == strands_interrupt.id

    async def test_resume_denied_passes_payload_to_strands(self):
        """Verify stream_async receives the resolved denial payload directly."""
        strands_interrupt = _make_strands_interrupt("my_tool", {}, "st-1")
        interrupt_state = _make_interrupt_state(
            activated=True,
            interrupts={strands_interrupt.id: strands_interrupt},
        )

        received_prompts: list = []

        async def _capture_stream(prompt: Any):
            received_prompts.append(prompt)
            yield {"result": _FakeAgentResult(stop_reason="end_turn")}

        agent = _build_agent(self.THREAD + "-n", [], self._config(), interrupt_state)
        agent._agents_by_thread[self.THREAD + "-n"].stream_async = _capture_stream

        resume_input = _run_input(
            self.THREAD + "-n",
            resume=[ResumeEntry(
                interrupt_id=strands_interrupt.id,
                status="resolved",
                payload={"approved": False},
            )],
        )
        await _collect(agent, resume_input)

        assert received_prompts[0][0]["interruptResponse"]["response"] == {"approved": False}

    async def test_resume_passes_prompt_when_replay_history_enabled(self):
        """When replay_history=True (no session_manager), resume still passes interruptResponse."""
        strands_interrupt = _make_strands_interrupt("my_tool", {}, "st-1")
        interrupt_state = _make_interrupt_state(
            activated=True,
            interrupts={strands_interrupt.id: strands_interrupt},
        )

        received_prompts: list = []

        async def _capture_stream(prompt: Any):
            received_prompts.append(prompt)
            yield {"result": _FakeAgentResult(stop_reason="end_turn")}

        agent = _build_agent(self.THREAD + "-replay", [], self._config(), interrupt_state)
        inner = agent._agents_by_thread[self.THREAD + "-replay"]
        inner.session_manager = None  # Force replay_history=True
        inner.stream_async = _capture_stream

        resume_input = _run_input(
            self.THREAD + "-replay",
            resume=[ResumeEntry(
                interrupt_id=strands_interrupt.id,
                status="resolved",
                payload={"approved": True},
            )],
        )
        await _collect(agent, resume_input)

        assert len(received_prompts) == 1
        assert received_prompts[0] is not None
        assert received_prompts[0][0]["interruptResponse"]["interruptId"] == strands_interrupt.id
        assert received_prompts[0][0]["interruptResponse"]["response"] == {"approved": True}


# ---------------------------------------------------------------------------
# Resume: cancelled
# ---------------------------------------------------------------------------

class TestResumeCancelled:
    THREAD = "resume-cancelled-thread"
    TOOL = Tool(name="my_tool", description="d", parameters={})

    def _config(self) -> StrandsAgentConfig:
        return StrandsAgentConfig(
            tool_behaviors={"my_tool": ToolBehavior(interrupt_on_call=True)}
        )

    async def test_cancelled_resume_ends_cleanly(self):
        strands_interrupt = _make_strands_interrupt("my_tool", {}, "st-1")
        interrupt_state = _make_interrupt_state(
            activated=True,
            interrupts={strands_interrupt.id: strands_interrupt},
        )

        agent = _build_agent(self.THREAD, [], self._config(), interrupt_state)

        resume_input = _run_input(
            self.THREAD,
            resume=[ResumeEntry(interrupt_id=strands_interrupt.id, status="cancelled")],
        )
        events = await _collect(agent, resume_input)

        errors = [e for e in events if e.type == EventType.RUN_ERROR]
        assert len(errors) == 0

        finished = [e for e in events if e.type == EventType.RUN_FINISHED]
        assert len(finished) == 1
        assert isinstance(finished[0].outcome, RunFinishedSuccessOutcome)

    async def test_cancelled_forwards_denial_through_strands(self):
        """All-cancelled resumes must flow through stream_async() — not a
        synthetic short-circuit — so Strands' own interrupt-state cleanup,
        hooks, and session persistence still run (see issue: all-cancel
        previously bypassed Strands and the run lifecycle entirely).
        """
        strands_interrupt = _make_strands_interrupt("my_tool", {}, "st-1")
        interrupt_state = _make_interrupt_state(
            activated=True,
            interrupts={strands_interrupt.id: strands_interrupt},
        )

        agent = _build_agent(self.THREAD + "-deact", [], self._config(), interrupt_state)
        mock_inner = agent._agents_by_thread[self.THREAD + "-deact"]

        captured_prompts: list = []
        original_stream_async = mock_inner.stream_async

        async def _spy_stream(msg: Any):
            captured_prompts.append(msg)
            async for event in original_stream_async(msg):
                yield event

        mock_inner.stream_async = _spy_stream

        resume_input = _run_input(
            self.THREAD + "-deact",
            resume=[ResumeEntry(interrupt_id=strands_interrupt.id, status="cancelled")],
        )
        await _collect(agent, resume_input)

        # The cancellation must be forwarded to Strands as a native
        # interruptResponse denial — not handled by a synthetic return that
        # skips stream_async() entirely.
        assert len(captured_prompts) == 1
        assert captured_prompts[0] == [
            {
                "interruptResponse": {
                    "interruptId": strands_interrupt.id,
                    "response": {"approved": False},
                }
            }
        ]

# ---------------------------------------------------------------------------
# Resume: unknown interrupt_id
# ---------------------------------------------------------------------------

class TestResumeUnknownInterruptId:
    THREAD = "unknown-id-thread"
    TOOL = Tool(name="my_tool", description="d", parameters={})

    def _config(self) -> StrandsAgentConfig:
        return StrandsAgentConfig(
            tool_behaviors={"my_tool": ToolBehavior(interrupt_on_call=True)}
        )

    async def test_unknown_id_yields_run_error(self):
        strands_interrupt = _make_strands_interrupt("my_tool", {}, "st-1")
        interrupt_state = _make_interrupt_state(
            activated=True,
            interrupts={strands_interrupt.id: strands_interrupt},
        )

        agent = _build_agent(self.THREAD, [], self._config(), interrupt_state)

        resume_input = _run_input(
            self.THREAD,
            resume=[ResumeEntry(interrupt_id="wrong-id", status="resolved", payload={"approved": True})],
        )
        events = await _collect(agent, resume_input)

        errors = [e for e in events if e.type == EventType.RUN_ERROR]
        assert len(errors) == 1
        assert errors[0].code == "INTERRUPT_RESUME_ERROR"

    async def test_no_pending_interrupt_yields_run_error(self):
        """Resume on a thread with no active interrupt must yield RunError."""
        # interrupt_state.activated = False → no pending interrupt
        interrupt_state = _make_interrupt_state(activated=False)

        agent = _build_agent(self.THREAD + "-none", [], self._config(), interrupt_state)

        resume_input = _run_input(
            self.THREAD + "-none",
            resume=[ResumeEntry(interrupt_id="any-id", status="resolved", payload={"approved": True})],
        )
        events = await _collect(agent, resume_input)

        errors = [e for e in events if e.type == EventType.RUN_ERROR]
        assert len(errors) == 1
        assert errors[0].code == "UNKNOWN_INTERRUPT_ID"


# ---------------------------------------------------------------------------
# Resume: idempotency and payload type validation
# ---------------------------------------------------------------------------


class TestResumeValidation:
    THREAD = "resume-validation-thread"

    def _agent_with_pending_schema(self, schema: dict) -> tuple[StrandsAgent, Any]:
        strands_interrupt = _make_strands_interrupt("my_tool", {}, "st-1")
        interrupt_state = _make_interrupt_state(
            activated=True,
            interrupts={strands_interrupt.id: strands_interrupt},
        )
        agent = _build_agent(
            self.THREAD,
            _empty_stream(),
            StrandsAgentConfig(),
            interrupt_state,
        )
        agent._pending_interrupts_by_thread[self.THREAD] = {
            strands_interrupt.id: Interrupt(
                id=strands_interrupt.id,
                reason="tool_call",
                response_schema=schema,
            )
        }
        return agent, interrupt_state

    async def test_reordered_resume_replay_does_not_reinvoke_strands(self):
        first = _make_strands_interrupt("my_tool", {}, "st-1")
        second = _make_strands_interrupt("my_tool", {}, "st-2")
        interrupt_state = _make_interrupt_state(
            activated=True,
            interrupts={first.id: first, second.id: second},
        )
        agent = _build_agent(
            self.THREAD + "-reordered",
            _empty_stream(),
            StrandsAgentConfig(),
            interrupt_state,
        )
        stream_calls = 0
        inner = agent._agents_by_thread[self.THREAD + "-reordered"]
        original_stream = inner.stream_async

        async def _spy_stream(message: Any):
            nonlocal stream_calls
            stream_calls += 1
            async for event in original_stream(message):
                yield event

        inner.stream_async = _spy_stream
        first_resume = [
            ResumeEntry(interrupt_id=first.id, status="resolved", payload={"approved": True}),
            ResumeEntry(interrupt_id=second.id, status="cancelled"),
        ]
        await _collect(
            agent,
            _run_input(self.THREAD + "-reordered", resume=first_resume),
        )
        assert stream_calls == 1

        # A completed native resume has no active interrupts. Simulate that
        # state before replaying the equivalent entries in reverse order.
        interrupt_state.activated = False
        replay_events = await _collect(
            agent,
            _run_input(
                self.THREAD + "-reordered",
                resume=list(reversed(first_resume)),
            ),
        )
        assert stream_calls == 1
        assert any(event.type == EventType.RUN_FINISHED for event in replay_events)
        assert not any(event.type == EventType.RUN_ERROR for event in replay_events)

    async def test_non_boolean_approval_payload_is_rejected(self):
        schema = {
            "type": "object",
            "properties": {"approved": {"type": "boolean"}},
            "required": ["approved"],
        }
        for invalid_approval in ("true", 1, None):
            agent, _ = self._agent_with_pending_schema(schema)
            interrupt_id = next(iter(agent._pending_interrupts_by_thread[self.THREAD]))

            events = await _collect(
                agent,
                _run_input(
                    self.THREAD,
                    resume=[
                        ResumeEntry(
                            interrupt_id=interrupt_id,
                            status="resolved",
                            payload={"approved": invalid_approval},
                        )
                    ],
                ),
            )

            error = next(event for event in events if event.type == EventType.RUN_ERROR)
            assert error.code == "INVALID_PAYLOAD"
            assert "approved" in error.message

    async def test_explicit_denial_and_optional_edited_args_are_valid(self):
        schema = {
            "type": "object",
            "properties": {
                "approved": {"type": "boolean"},
                "editedArgs": {"type": "object"},
            },
            "required": ["approved"],
        }
        denied, _ = self._agent_with_pending_schema(schema)
        denied_id = next(iter(denied._pending_interrupts_by_thread[self.THREAD]))
        denied_events = await _collect(
            denied,
            _run_input(
                self.THREAD,
                resume=[
                    ResumeEntry(
                        interrupt_id=denied_id,
                        status="resolved",
                        payload={"approved": False},
                    )
                ],
            ),
        )
        assert not any(event.type == EventType.RUN_ERROR for event in denied_events)

        edited, _ = self._agent_with_pending_schema(schema)
        edited_id = next(iter(edited._pending_interrupts_by_thread[self.THREAD]))
        edited_events = await _collect(
            edited,
            _run_input(
                self.THREAD,
                resume=[
                    ResumeEntry(
                        interrupt_id=edited_id,
                        status="resolved",
                        payload={
                            "approved": True,
                            "editedArgs": {"environment": "staging"},
                        },
                    )
                ],
            ),
        )
        assert not any(event.type == EventType.RUN_ERROR for event in edited_events)


# ---------------------------------------------------------------------------
# StrandsInterruptHook auto-registration
# ---------------------------------------------------------------------------

class TestStrandsInterruptHookAutoRegistration:
    async def test_hook_prepended_when_interrupt_on_call_tools_present(self):
        from ag_ui_strands.agent import StrandsInterruptHook
        config = StrandsAgentConfig(
            tool_behaviors={"my_tool": ToolBehavior(interrupt_on_call=True)}
        )
        agent = StrandsAgent(_template_agent(), name="test", config=config)
        assert len(agent._hooks) >= 1
        assert isinstance(agent._hooks[0], StrandsInterruptHook)

    async def test_no_hook_when_no_interrupt_on_call_tools(self):
        from ag_ui_strands.agent import StrandsInterruptHook
        config = StrandsAgentConfig(
            tool_behaviors={"my_tool": ToolBehavior(stop_streaming_after_result=True)}
        )
        agent = StrandsAgent(_template_agent(), name="test", config=config)
        assert not any(isinstance(h, StrandsInterruptHook) for h in agent._hooks)

    async def test_hook_prepended_before_caller_hooks(self):
        from ag_ui_strands.agent import StrandsInterruptHook
        caller_hook = MagicMock()
        config = StrandsAgentConfig(
            tool_behaviors={"my_tool": ToolBehavior(interrupt_on_call=True)}
        )
        agent = StrandsAgent(_template_agent(), name="test", config=config, hooks=[caller_hook])
        assert isinstance(agent._hooks[0], StrandsInterruptHook)
        assert agent._hooks[1] is caller_hook


# ---------------------------------------------------------------------------
# StrandsInterruptHook — strict approval payload contract
# ---------------------------------------------------------------------------


def _hook_event(response: Any, tool_name: str = "my_tool") -> MagicMock:
    """Build a mock BeforeToolCallEvent whose event.interrupt() returns the
    given resume response, as Strands does on the resume call."""
    event = MagicMock()
    event.tool_use = {"name": tool_name, "input": {}, "toolUseId": "st-1"}
    event.interrupt = MagicMock(return_value=response)
    event.cancel_tool = False
    return event


class TestStrandsInterruptHookStrictApproval:
    """The approval hook must only grant approval for a strict
    {"approved": true} payload — any other shape (missing key, non-bool
    value, non-dict response) is an explicit denial, not a truthy coercion.
    """

    def _hook(self):
        from ag_ui_strands.agent import StrandsInterruptHook
        return StrandsInterruptHook(
            {"my_tool": ToolBehavior(interrupt_on_call=True)}
        )

    def test_approved_true_grants_approval(self):
        event = _hook_event({"approved": True})
        self._hook()._on_before_tool_call(event)
        assert event.cancel_tool is False

    def test_approved_false_denies(self):
        event = _hook_event({"approved": False})
        self._hook()._on_before_tool_call(event)
        assert event.cancel_tool

    def test_missing_approved_key_denies(self):
        event = _hook_event({})
        self._hook()._on_before_tool_call(event)
        assert event.cancel_tool

    def test_truthy_string_does_not_grant_approval(self):
        """A stringified 'false' (or any non-empty string) must NOT be
        treated as approval merely because it's truthy."""
        event = _hook_event({"approved": "false"})
        self._hook()._on_before_tool_call(event)
        assert event.cancel_tool

    def test_truthy_string_true_does_not_grant_approval(self):
        event = _hook_event({"approved": "true"})
        self._hook()._on_before_tool_call(event)
        assert event.cancel_tool

    def test_numeric_one_does_not_grant_approval(self):
        event = _hook_event({"approved": 1})
        self._hook()._on_before_tool_call(event)
        assert event.cancel_tool

    def test_extra_keys_with_valid_approval_still_grants(self):
        """Extra keys beyond the declared schema aren't themselves
        disqualifying — only the "approved" value's type/value matters."""
        event = _hook_event({"approved": True, "note": "looks fine"})
        self._hook()._on_before_tool_call(event)
        assert event.cancel_tool is False

    def test_non_dict_response_denies(self):
        event = _hook_event("y")
        self._hook()._on_before_tool_call(event)
        assert event.cancel_tool

    def test_none_response_denies(self):
        event = _hook_event(None)
        self._hook()._on_before_tool_call(event)
        assert event.cancel_tool


# ---------------------------------------------------------------------------
# Generic (non-tool-approval) native interrupts must stay generic
# ---------------------------------------------------------------------------


class TestGenericNativeInterrupt:
    """Interrupts NOT raised by StrandsInterruptHook's own
    "ag_ui:tool_call:" naming convention — e.g. a user's own tool calling
    event.interrupt() directly for a generic human-in-the-loop request —
    must be preserved as generic interrupts, not misclassified as tool-call
    approvals with fabricated schema/metadata.
    """

    THREAD = "generic-interrupt-thread"

    async def test_generic_interrupt_reason_is_preserved(self):
        generic = StrandsInterrupt(
            id="v1:custom:abc",
            name="need_clarification",
            reason={"question": "Which environment?"},
        )
        stream = [
            {"result": _FakeAgentResult(stop_reason="interrupt", interrupts=[generic])},
        ]
        agent = _build_agent(self.THREAD, stream, StrandsAgentConfig())
        events = await _collect(agent, _run_input(self.THREAD))

        finished = [e for e in events if e.type == EventType.RUN_FINISHED]
        assert len(finished) == 1
        interrupt = finished[0].outcome.interrupts[0]
        assert interrupt.id == "v1:custom:abc"
        assert interrupt.reason == "need_clarification"

    async def test_generic_interrupt_has_no_fabricated_tool_schema(self):
        generic = StrandsInterrupt(
            id="v1:custom:abc",
            name="need_clarification",
            reason={"question": "Which environment?"},
        )
        stream = [
            {"result": _FakeAgentResult(stop_reason="interrupt", interrupts=[generic])},
        ]
        agent = _build_agent(self.THREAD + "-schema", stream, StrandsAgentConfig())
        events = await _collect(agent, _run_input(self.THREAD + "-schema"))

        finished = [e for e in events if e.type == EventType.RUN_FINISHED]
        interrupt = finished[0].outcome.interrupts[0]
        assert interrupt.response_schema is None
        assert interrupt.tool_call_id is None

    async def test_generic_interrupt_preserves_native_reason_in_metadata(self):
        generic = StrandsInterrupt(
            id="v1:custom:abc",
            name="need_clarification",
            reason={"question": "Which environment?"},
        )
        stream = [
            {"result": _FakeAgentResult(stop_reason="interrupt", interrupts=[generic])},
        ]
        agent = _build_agent(self.THREAD + "-meta", stream, StrandsAgentConfig())
        events = await _collect(agent, _run_input(self.THREAD + "-meta"))

        finished = [e for e in events if e.type == EventType.RUN_FINISHED]
        interrupt = finished[0].outcome.interrupts[0]
        assert interrupt.metadata == {"reason": {"question": "Which environment?"}}

    async def test_tool_call_interrupt_still_classified_as_tool_call(self):
        """Sanity check: the ag_ui:tool_call: naming convention still
        produces the tool-approval shape, unaffected by the generic path."""
        strands_interrupt = _make_strands_interrupt("my_tool", {"x": 1}, "st-1")
        stream = [
            {"result": _FakeAgentResult(stop_reason="interrupt", interrupts=[strands_interrupt])},
        ]
        config = StrandsAgentConfig(
            tool_behaviors={"my_tool": ToolBehavior(interrupt_on_call=True)}
        )
        agent = _build_agent(self.THREAD + "-tool", stream, config)
        events = await _collect(agent, _run_input(self.THREAD + "-tool", tools=[Tool(name="my_tool", description="d", parameters={})]))

        finished = [e for e in events if e.type == EventType.RUN_FINISHED]
        interrupt = finished[0].outcome.interrupts[0]
        assert interrupt.reason == "tool_call"
        assert interrupt.response_schema is not None
