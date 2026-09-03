"""One direct test per terminal RUN_ERROR this bridge can emit.

Each test drives the real ``StrandsAgent`` (or the real FastAPI endpoint) to
the failure and asserts the frame a client actually receives, code and message
both, against ``error-codes.json``. That is the same shape the CrewAI bridge's
terminal paths take in ``ag_ui_crewai/endpoint.py``: one arm per failure mode,
each with its own code and its own sentence.

The message assertion goes through ``assert_contract_error``, so the text is
compared to the shared table rather than to a copy of it. A code the table
marks shared is therefore matched against the same string on both sides, which
is what makes the two bridges agree without either suite reading the other's
source.

Codes whose only realistic driver is a full real-SDK frontend-tool run are
covered where that driver already lives, with the same assertion:
``test_frontend_tool_native_wait.py`` (``FRONTEND_TOOL_IDENTITY_ERROR``,
``FRONTEND_TOOL_NOT_REGISTERED``, ``FRONTEND_TOOL_RESULT_CONFLICT``,
``FRONTEND_TOOL_RESULT_DUPLICATE``), ``test_interrupt.py``
(``INTERRUPT_RECONCILIATION_ERROR``) and ``test_multiagent_orchestrator.py``
(the orchestrator's own ``THREAD_BUSY`` wording).
"""

from __future__ import annotations

import asyncio
import base64
import json
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from ag_ui.core import (
    EventType,
    ImageInputContent,
    InputContentDataSource,
    Interrupt,
    ResumeEntry,
    RunAgentInput,
    Tool,
    ToolMessage,
    UserMessage,
)
from fastapi import FastAPI
from fastapi.testclient import TestClient
from strands import Agent
from strands.agent.state import AgentState
from strands.hooks.registry import HookRegistry
from strands.interrupt import Interrupt as StrandsInterrupt
from strands.models.model import Model

import ag_ui_strands.agent as agent_module
from ag_ui_strands.agent import StrandsAgent
from ag_ui_strands.client_proxy_tool import PROXY_RESULT_PLACEHOLDER
from ag_ui_strands.config import StrandsAgentConfig
from ag_ui_strands.endpoint import add_strands_fastapi_endpoint

from tests.error_code_table import FORCE_STOP_FALLBACK, assert_contract_error
from tests.interrupt_state_stub import InterruptStateStub

THREAD = "terminal-path-thread"


# ---------------------------------------------------------------------------
# Harness
# ---------------------------------------------------------------------------


class _UnusedModel(Model):
    """A complete Model for agents whose stream never reaches a provider."""

    def get_config(self):
        return {"model_id": "unused-test-model"}

    def update_config(self, **kwargs):
        pass

    async def structured_output(self, output_model, prompt, **kwargs):
        if False:  # pragma: no cover
            yield {}

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs):
        raise AssertionError("the scripted stream should bypass the model")
        yield  # pragma: no cover


class _MockCore:
    """The ``StrandsAgentCore`` surface the adapter reads, with a scripted stream."""

    def __init__(self, *, interrupts=None, session_manager=None, events=None):
        self.agent_id = "default"
        self.tool_registry = MagicMock()
        self.tool_registry.registry = {}
        self.state = AgentState()
        self.model = MagicMock()
        self.messages: list = []
        self.hooks = HookRegistry()
        self.session_manager = session_manager
        self.stream_prompts: list = []
        self._events = events or []
        self._interrupt_state = InterruptStateStub()
        for interrupt in interrupts or []:
            self._interrupt_state.interrupts[interrupt.id] = interrupt
        if interrupts:
            self._interrupt_state.activate()

    async def stream_async(self, prompt):
        self.stream_prompts.append(prompt)
        for event in self._events:
            yield event


def _run_input(**overrides) -> RunAgentInput:
    fields = {
        "thread_id": THREAD,
        "run_id": "run-1",
        "state": {},
        "messages": [],
        "tools": [],
        "context": [],
        "forwarded_props": {},
    }
    fields.update(overrides)
    return RunAgentInput(**fields)


def _adapter(config: StrandsAgentConfig | None = None) -> StrandsAgent:
    template = MagicMock()
    template.model = MagicMock()
    template.system_prompt = "You are a test assistant."
    template.tool_registry = MagicMock()
    template.tool_registry.registry = {}
    return StrandsAgent(
        agent=template,
        name="terminal-path-agent",
        config=config or StrandsAgentConfig(replay_history_into_strands=False),
    )


async def _collect(adapter: StrandsAgent, input_data: RunAgentInput) -> list:
    return [event async for event in adapter.run(input_data)]


async def _drive(core: _MockCore, input_data: RunAgentInput, **kwargs) -> list:
    """Run the adapter with ``core`` standing in for the per-thread agent."""
    adapter = _adapter(**kwargs)
    with patch("ag_ui_strands.agent.StrandsAgentCore", return_value=core):
        return await _collect(adapter, input_data)


def _terminal_error(events: list):
    """The run's single RUN_ERROR, which must also be how the run ended."""
    errors = [event for event in events if event.type == EventType.RUN_ERROR]
    assert len(errors) == 1, [event.type for event in events]
    assert not any(event.type == EventType.RUN_FINISHED for event in events)
    return errors[0]


# ---------------------------------------------------------------------------
# Lifecycle refusals
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_thread_busy_refuses_an_overlapping_run():
    """A second run on a streaming thread is refused, not multiplexed."""
    released = asyncio.Event()
    first_started = asyncio.Event()

    class _BlockingCore(_MockCore):
        async def stream_async(self, prompt):
            first_started.set()
            await released.wait()
            return
            yield  # pragma: no cover

    core = _BlockingCore()
    adapter = _adapter()

    with patch("ag_ui_strands.agent.StrandsAgentCore", return_value=core):

        async def _first():
            return await _collect(adapter, _run_input())

        task = asyncio.create_task(_first())
        await asyncio.wait_for(first_started.wait(), timeout=5)
        second = await _collect(adapter, _run_input(run_id="run-2"))
        released.set()
        await task

    error = _terminal_error(second)
    assert_contract_error(error, "THREAD_BUSY")
    assert f'thread "{THREAD}"' in error.message


@pytest.mark.asyncio
async def test_session_manager_error_reports_a_provider_that_raised():
    def _provider(_input):
        raise RuntimeError("no credentials")

    events = await _drive(
        _MockCore(),
        _run_input(),
        config=StrandsAgentConfig(
            replay_history_into_strands=False, session_manager_provider=_provider
        ),
    )

    assert_contract_error(_terminal_error(events), "SESSION_MANAGER_ERROR")


@pytest.mark.asyncio
async def test_session_manager_invalid_type_names_the_option_that_returned_it():
    events = await _drive(
        _MockCore(),
        _run_input(),
        config=StrandsAgentConfig(
            replay_history_into_strands=False,
            session_manager_provider=lambda _input: object(),
        ),
    )

    error = _terminal_error(events)
    assert_contract_error(error, "SESSION_MANAGER_INVALID_TYPE")
    assert "session_manager_provider" in error.message


@pytest.mark.asyncio
async def test_thread_agent_kwargs_error_reports_a_hook_that_raised():
    def _kwargs(_input):
        raise ValueError("bad config")

    events = await _drive(
        _MockCore(),
        _run_input(),
        config=StrandsAgentConfig(
            replay_history_into_strands=False, thread_agent_kwargs=_kwargs
        ),
    )

    assert_contract_error(_terminal_error(events), "THREAD_AGENT_KWARGS_ERROR")


# ---------------------------------------------------------------------------
# Interrupt preflight
# ---------------------------------------------------------------------------


def _open(interrupt_id: str = "open") -> StrandsInterrupt:
    return StrandsInterrupt(id=interrupt_id, name="confirm")


def _resolved(interrupt_id: str = "open", payload=True) -> ResumeEntry:
    return ResumeEntry(interrupt_id=interrupt_id, status="resolved", payload=payload)


@pytest.mark.asyncio
async def test_pending_interrupts_refuses_a_turn_against_a_parked_checkpoint():
    events = await _drive(
        _MockCore(interrupts=[_open()], session_manager=MagicMock()),
        _run_input(messages=[UserMessage(id="u1", content="what now?")]),
    )

    assert_contract_error(_terminal_error(events), "PENDING_INTERRUPTS")


@pytest.mark.asyncio
async def test_unknown_interrupt_id_refuses_a_resume_with_nothing_to_resume():
    events = await _drive(
        _MockCore(session_manager=MagicMock()),
        _run_input(resume=[_resolved()]),
    )

    assert_contract_error(_terminal_error(events), "UNKNOWN_INTERRUPT_ID")


@pytest.mark.parametrize(
    ("interrupts", "resume"),
    [
        pytest.param([_open()], [], id="empty-batch"),
        pytest.param(
            [_open()],
            [ResumeEntry(interrupt_id="   ", status="resolved", payload=True)],
            id="blank-id",
        ),
        pytest.param([_open()], [_resolved(), _resolved()], id="duplicate-id"),
        pytest.param([_open()], [_resolved("never-issued")], id="not-open"),
    ],
)
@pytest.mark.asyncio
async def test_interrupt_resume_error_refuses_a_batch_the_checkpoint_cannot_take(
    interrupts, resume
):
    events = await _drive(
        _MockCore(interrupts=interrupts, session_manager=MagicMock()),
        _run_input(resume=resume),
    )

    assert_contract_error(_terminal_error(events), "INTERRUPT_RESUME_ERROR")


@pytest.mark.asyncio
async def test_interrupt_resume_error_refuses_an_expiry_that_is_not_a_timestamp():
    adapter = _adapter()
    adapter._pending_interrupts_by_thread[THREAD] = {
        "open": Interrupt(id="open", reason="confirm", expires_at="tomorrow")
    }
    core = _MockCore(interrupts=[_open()], session_manager=MagicMock())

    with patch("ag_ui_strands.agent.StrandsAgentCore", return_value=core):
        events = await _collect(adapter, _run_input(resume=[_resolved()]))

    assert_contract_error(_terminal_error(events), "INTERRUPT_RESUME_ERROR")


@pytest.mark.asyncio
async def test_partial_resume_refuses_a_batch_that_leaves_an_interrupt_open():
    events = await _drive(
        _MockCore(
            interrupts=[_open(), _open("other-open")], session_manager=MagicMock()
        ),
        _run_input(resume=[_resolved()]),
    )

    error = _terminal_error(events)
    assert_contract_error(error, "PARTIAL_RESUME")
    assert "other-open" in error.message


@pytest.mark.asyncio
async def test_interrupt_expired_refuses_a_resume_past_its_deadline():
    adapter = _adapter()
    adapter._pending_interrupts_by_thread[THREAD] = {
        "open": Interrupt(
            id="open", reason="confirm", expires_at="2000-01-01T00:00:00+00:00"
        )
    }
    core = _MockCore(interrupts=[_open()], session_manager=MagicMock())

    with patch("ag_ui_strands.agent.StrandsAgentCore", return_value=core):
        events = await _collect(adapter, _run_input(resume=[_resolved()]))

    assert_contract_error(_terminal_error(events), "INTERRUPT_EXPIRED")


_APPROVAL_SCHEMA = {
    "type": "object",
    "properties": {"approved": {"type": "boolean"}},
    "required": ["approved"],
}


@pytest.mark.parametrize(
    "payload",
    [
        pytest.param("yes", id="not-an-object"),
        pytest.param({}, id="missing-required-key"),
        pytest.param({"approved": "true"}, id="wrong-property-type"),
    ],
)
@pytest.mark.asyncio
async def test_invalid_payload_refuses_a_resume_the_schema_rejects(payload):
    adapter = _adapter()
    adapter._pending_interrupts_by_thread[THREAD] = {
        "open": Interrupt(
            id="open", reason="confirm", response_schema=_APPROVAL_SCHEMA
        )
    }
    core = _MockCore(interrupts=[_open()], session_manager=MagicMock())

    with patch("ag_ui_strands.agent.StrandsAgentCore", return_value=core):
        events = await _collect(
            adapter, _run_input(resume=[_resolved(payload=payload)])
        )

    error = _terminal_error(events)
    assert_contract_error(error, "INVALID_PAYLOAD")
    assert "'open'" in error.message


@pytest.mark.asyncio
async def test_frontend_tool_wait_state_error_refuses_a_malformed_checkpoint():
    """The wait index is read before anything else touches the checkpoint."""
    core = _MockCore(session_manager=MagicMock())
    core._interrupt_state.interrupts["not-the-interrupt-id"] = _open()
    core._interrupt_state.activate()

    events = await _drive(core, _run_input())

    assert_contract_error(_terminal_error(events), "FRONTEND_TOOL_WAIT_STATE_ERROR")


# ---------------------------------------------------------------------------
# Mixed frontend-proxy / native checkpoints
# ---------------------------------------------------------------------------


class _MixedCheckpointCore(_MockCore):
    """Builds a mixed proxy/native checkpoint once streaming has started."""

    async def stream_async(self, prompt):
        self.stream_prompts.append(prompt)
        interrupt = _open("native-interrupt")
        self._interrupt_state.interrupts[interrupt.id] = interrupt
        self._interrupt_state.context["tool_results"] = [
            {
                "toolUseId": "native-proxy",
                "status": "success",
                "content": [{"text": PROXY_RESULT_PLACEHOLDER}],
            }
        ]
        self._interrupt_state.activate()
        result = MagicMock()
        result.stop_reason = "interrupt"
        result.interrupts = [interrupt]
        yield {"result": result}


@pytest.mark.parametrize(
    ("session_manager", "code"),
    [
        pytest.param(None, "INTERRUPT_SESSION_REQUIRED", id="no-session-manager"),
        pytest.param(
            SimpleNamespace(session_id="session-without-repository"),
            "INTERRUPT_SESSION_CAPABILITY_ERROR",
            id="session-manager-without-the-repository",
        ),
    ],
)
@pytest.mark.asyncio
async def test_a_mixed_checkpoint_without_a_reconcilable_store_is_refused(
    session_manager, code
):
    events = await _drive(
        _MixedCheckpointCore(session_manager=session_manager), _run_input()
    )

    assert_contract_error(_terminal_error(events), code)


# ---------------------------------------------------------------------------
# Failures out of the run loop
# ---------------------------------------------------------------------------


def _scripted_agent(events: list[dict], *, stream_error: Exception | None = None):
    """A real ``Agent`` container whose stream is deterministic."""
    core = Agent(model=_UnusedModel(), tools=[])

    async def stream_async(_prompt):
        for event in events:
            yield event
        if stream_error is not None:
            raise stream_error

    core.stream_async = stream_async
    return StrandsAgent(
        core, name="terminal-path-agent", agents_by_thread={THREAD: core}
    )


@pytest.mark.asyncio
async def test_strands_force_stop_carries_the_reason_the_sdk_gave():
    adapter = _scripted_agent(
        [{"force_stop": True, "force_stop_reason": "provider refused"}]
    )

    events = await _collect(adapter, _run_input())

    error = _terminal_error(events)
    assert_contract_error(error, "STRANDS_FORCE_STOP")
    assert error.message == "provider refused"


@pytest.mark.asyncio
async def test_strands_force_stop_falls_back_to_the_shared_sentence():
    """A reasonless stop still says something, and says the same thing on both sides."""
    adapter = _scripted_agent([{"force_stop": True, "force_stop_reason": None}])

    events = await _collect(adapter, _run_input())

    error = _terminal_error(events)
    assert_contract_error(error, "STRANDS_FORCE_STOP")
    assert error.message == FORCE_STOP_FALLBACK


@pytest.mark.asyncio
async def test_strands_error_reports_a_failure_from_outside_this_adapter():
    adapter = _scripted_agent([], stream_error=ValueError("provider exploded"))

    events = await _collect(adapter, _run_input())

    error = _terminal_error(events)
    assert_contract_error(error, "STRANDS_ERROR")
    assert error.message == "provider exploded"


@pytest.mark.asyncio
async def test_adapter_bug_reports_a_defect_in_this_adapter(
    monkeypatch: pytest.MonkeyPatch,
):
    def _broken(*_args, **_kwargs):
        raise TypeError("not subscriptable")

    monkeypatch.setattr(agent_module, "_build_snapshot_messages", _broken)
    adapter = _scripted_agent([])

    events = await _collect(adapter, _run_input())

    error = _terminal_error(events)
    assert_contract_error(error, "ADAPTER_BUG")
    assert error.message == "not subscriptable"


# ---------------------------------------------------------------------------
# Prompt and continuation failures
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_media_resolution_failed_when_nothing_of_the_prompt_survives():
    core = _MockCore(session_manager=object())
    message = UserMessage(
        id="unconvertible-1",
        content=[
            ImageInputContent(
                source=InputContentDataSource(
                    value=base64.b64encode(b"fake-tiff").decode(),
                    mime_type="image/tiff",
                )
            )
        ],
    )

    events = await _drive(core, _run_input(messages=[message]))

    assert core.stream_prompts == []
    assert_contract_error(_terminal_error(events), "MEDIA_RESOLUTION_FAILED")


@pytest.mark.asyncio
async def test_continuation_tool_name_unresolved_names_the_offending_results():
    """A trailing tool result nothing can name ends the run rather than guessing."""
    core = _MockCore(session_manager=MagicMock())
    events = await _drive(
        core,
        _run_input(
            thread_id=THREAD,
            messages=[
                ToolMessage(id="t1", role="tool", content="", tool_call_id="call-xyz")
            ],
            tools=[Tool(name="a_frontend_tool", description="x", parameters={})],
        ),
    )

    error = _terminal_error(events)
    assert_contract_error(error, "CONTINUATION_TOOL_NAME_UNRESOLVED")
    assert "call-xyz" in error.message


# ---------------------------------------------------------------------------
# Transport
# ---------------------------------------------------------------------------


class _UnencodableEvent:
    """Not a pydantic model, so the encoder fails when it reaches this."""

    type = "NOT_A_REAL_EVENT"


class _BadEventAgent:
    name = "bad-event"

    async def run(self, input_data):
        yield _UnencodableEvent()


def test_encoding_error_is_reported_inside_a_stream_already_open():
    app = FastAPI()
    add_strands_fastapi_endpoint(app, _BadEventAgent(), path="/agent")
    payload = _run_input(messages=[UserMessage(id="u1", content="hi")]).model_dump(
        by_alias=True
    )

    with TestClient(app) as client:
        response = client.post("/agent", json=payload)

    assert response.status_code == 200
    frames = [
        line[len("data: ") :]
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    assert frames, response.text
    error = json.loads(frames[-1])
    assert_contract_error(
        SimpleNamespace(code=error["code"], message=error["message"]), "ENCODING_ERROR"
    )
