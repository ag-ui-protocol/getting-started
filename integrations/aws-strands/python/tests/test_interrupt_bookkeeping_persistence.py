"""Regression coverage for interrupt bookkeeping surviving a process restart.

``_pending_interrupts_by_thread`` and ``_last_resume_fingerprint`` are the
adapter's own bookkeeping, layered on top of Strands' native
``_interrupt_state`` (which SessionManager already persists/restores on its
own). Prior to this, the adapter's bookkeeping lived purely in a Python dict
on the ``StrandsAgent`` instance, so a real process restart lost it:

- Rule 6 (responseSchema payload validation) and Rule 7 (expiresAt
  enforcement) silently degrade, since they read AG-UI-specific interrupt
  metadata that only exists in this bookkeeping.
- Rule 5 (idempotency) breaks: a replayed resume request is no longer
  recognized as a duplicate and can re-invoke the model/tool.

These tests use a REAL ``strands.agent.state.AgentState`` instance (not a
mock) to prove the adapter actually round-trips through
``strands_agent.state``, matching what a real SessionManager restores after
a restart.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock

from ag_ui.core import EventType, Interrupt, ResumeEntry, RunAgentInput, Tool, UserMessage
from strands.agent.state import AgentState
from strands.interrupt import Interrupt as StrandsInterrupt
from strands.tools.registry import ToolRegistry

from ag_ui_strands.agent import StrandsAgent, _resume_fingerprint
from ag_ui_strands.config import StrandsAgentConfig, ToolBehavior


def _template_agent() -> MagicMock:
    mock = MagicMock()
    mock.model = MagicMock()
    mock.system_prompt = "You are helpful"
    mock.tool_registry.registry = {}
    mock.record_direct_tool_call = True
    return mock


def _build_agent_with_real_state(
    thread_id: str,
    stream_events: list,
    state: AgentState,
    config: StrandsAgentConfig | None = None,
) -> StrandsAgent:
    """Build a StrandsAgent whose per-thread Strands agent has a REAL
    AgentState (not a MagicMock) — as if it had just been reconstructed by
    _ensure_agent() on a fresh process, with SessionManager having restored
    ``state`` from persisted storage."""
    agent = StrandsAgent(
        _template_agent(), name="test-agent", config=config or StrandsAgentConfig()
    )
    mock_inner = MagicMock()
    mock_inner.tool_registry = ToolRegistry()
    mock_inner.state = state
    # No native interrupt activated on this "fresh" agent — the point of
    # these tests is that our OWN bookkeeping (not Strands' native
    # _interrupt_state) is what gets restored from persisted state.
    mock_inner._interrupt_state = None

    async def _stream(_msg: Any):
        for event in stream_events:
            yield event

    mock_inner.stream_async = _stream
    agent._agents_by_thread[thread_id] = mock_inner
    return agent


def _run_input(thread_id: str, resume: list | None = None) -> RunAgentInput:
    return RunAgentInput(
        thread_id=thread_id,
        run_id="r1",
        state={},
        messages=[UserMessage(id="u1", content="hello")],
        tools=[Tool(name="my_tool", description="d", parameters={})],
        context=[],
        forwarded_props={},
        resume=resume,
    )


async def _collect(agent: StrandsAgent, inp: RunAgentInput) -> list:
    return [e async for e in agent.run(inp)]


class TestIdempotencyFingerprintSurvivesRestart:
    THREAD = "restart-fingerprint-thread"

    async def test_replayed_resume_is_recognized_from_persisted_state(self):
        """A resume request whose fingerprint was persisted (by a prior
        process, before this process's in-memory map was ever populated)
        must be recognized as a replay and short-circuit to success —
        without touching Strands again."""
        state = AgentState()
        state.set(
            "ag_ui_interrupt_bookkeeping",
            {
                "last_resume_fingerprint": None,  # will be overwritten below
                "pending_interrupts": {},
            },
        )
        resume = [ResumeEntry(interrupt_id="int-1", status="resolved", payload={"approved": True})]

        # Compute the fingerprint exactly as the adapter does, and persist
        # it directly into state — simulating what a prior process wrote
        # before restarting.
        fingerprint = _resume_fingerprint(resume)
        state.set(
            "ag_ui_interrupt_bookkeeping",
            {"last_resume_fingerprint": fingerprint, "pending_interrupts": {}},
        )

        agent = _build_agent_with_real_state(self.THREAD, [], state)
        # In-memory maps are empty for this thread — this process has never
        # run anything for it. Only persisted state has the fingerprint.
        assert self.THREAD not in agent._last_resume_fingerprint

        events = await _collect(agent, _run_input(self.THREAD, resume=resume))

        finished = [e for e in events if e.type == EventType.RUN_FINISHED]
        assert len(finished) == 1
        assert finished[0].outcome.type == "success"
        # No RUN_ERROR — the replay was recognized, not treated as an
        # unknown/stale resume.
        assert not any(e.type == EventType.RUN_ERROR for e in events)


class TestPendingInterruptMetadataSurvivesRestart:
    THREAD = "restart-pending-thread"

    def _config(self) -> StrandsAgentConfig:
        return StrandsAgentConfig(
            tool_behaviors={"my_tool": ToolBehavior(interrupt_on_call=True)}
        )

    async def test_expired_interrupt_still_enforced_after_restart(self):
        """Rule 7 (expiresAt) depends on AG-UI-specific interrupt metadata
        that only lives in our adapter bookkeeping, not Strands' native
        _interrupt_state. It must still be enforced when that bookkeeping
        is restored from persisted state rather than the in-memory map."""
        expired_interrupt = Interrupt(
            id="int-1",
            reason="tool_call",
            tool_call_id="tc-1",
            expires_at="2000-01-01T00:00:00+00:00",  # long expired
        )
        state = AgentState()
        state.set(
            "ag_ui_interrupt_bookkeeping",
            {
                "last_resume_fingerprint": None,
                "pending_interrupts": {"int-1": expired_interrupt.model_dump(mode="json")},
            },
        )

        # Strands' native _interrupt_state still needs to report "int-1" as
        # pending for Rule 2/3 to pass before Rule 7 is even reached.
        strands_interrupt_state = MagicMock()
        strands_interrupt_state.activated = True
        strands_interrupt_state.interrupts = {
            "int-1": StrandsInterrupt(id="int-1", name="confirm")
        }

        agent = _build_agent_with_real_state(self.THREAD, [], state, self._config())
        mock_inner = agent._agents_by_thread[self.THREAD]
        mock_inner._interrupt_state = strands_interrupt_state

        assert self.THREAD not in agent._pending_interrupts_by_thread

        resume = [ResumeEntry(interrupt_id="int-1", status="resolved", payload={"approved": True})]
        events = await _collect(agent, _run_input(self.THREAD, resume=resume))

        error = next((e for e in events if e.type == EventType.RUN_ERROR), None)
        assert error is not None, f"expected RUN_ERROR(INTERRUPT_EXPIRED), got: {[e.type for e in events]}"
        assert error.code == "INTERRUPT_EXPIRED"

    async def test_invalid_payload_still_rejected_after_restart(self):
        """Rule 6 (responseSchema validation) likewise depends on restored
        bookkeeping."""
        pending_interrupt = Interrupt(
            id="int-2",
            reason="tool_call",
            tool_call_id="tc-2",
            response_schema={
                "type": "object",
                "properties": {"approved": {"type": "boolean"}},
                "required": ["approved"],
            },
        )
        state = AgentState()
        state.set(
            "ag_ui_interrupt_bookkeeping",
            {
                "last_resume_fingerprint": None,
                "pending_interrupts": {"int-2": pending_interrupt.model_dump(mode="json")},
            },
        )

        strands_interrupt_state = MagicMock()
        strands_interrupt_state.activated = True
        strands_interrupt_state.interrupts = {
            "int-2": StrandsInterrupt(id="int-2", name="confirm")
        }

        agent = _build_agent_with_real_state(self.THREAD + "-2", [], state, self._config())
        mock_inner = agent._agents_by_thread[self.THREAD + "-2"]
        mock_inner._interrupt_state = strands_interrupt_state

        # Missing the required "approved" key.
        resume = [ResumeEntry(interrupt_id="int-2", status="resolved", payload={})]
        events = await _collect(agent, _run_input(self.THREAD + "-2", resume=resume))

        error = next((e for e in events if e.type == EventType.RUN_ERROR), None)
        assert error is not None, f"expected RUN_ERROR(INVALID_PAYLOAD), got: {[e.type for e in events]}"
        assert error.code == "INVALID_PAYLOAD"


class TestPersistenceHelpersAreDefensiveAgainstMocks:
    """Guards against reintroducing the MagicMock-truthiness class of bug:
    a bare MagicMock() standing in for the Strands agent must be treated as
    having no persisted bookkeeping, not crash or silently misbehave."""

    async def test_bare_magicmock_state_is_treated_as_no_persisted_data(self):
        from ag_ui_strands.agent import _load_persisted_interrupt_bookkeeping

        mock_agent = MagicMock()  # mock_agent.state.get(...) auto-vivifies a MagicMock
        pending, fingerprint = _load_persisted_interrupt_bookkeeping(mock_agent)
        assert pending is None
        assert fingerprint is None

    async def test_persist_helper_never_raises_on_a_broken_state_object(self):
        from ag_ui_strands.agent import _persist_interrupt_bookkeeping

        class _BrokenState:
            def set(self, key, value):
                raise RuntimeError("boom")

        broken_agent = MagicMock()
        broken_agent.state = _BrokenState()
        # Must not raise.
        _persist_interrupt_bookkeeping(broken_agent, None, "fp")

    async def test_missing_state_attribute_is_handled(self):
        from ag_ui_strands.agent import _load_persisted_interrupt_bookkeeping

        class _NoState:
            pass

        pending, fingerprint = _load_persisted_interrupt_bookkeeping(_NoState())
        assert pending is None
        assert fingerprint is None
