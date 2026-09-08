"""What a paused tool actually receives when a resume reaches it.

This is the cross-language contract: a tool body written against one bridge has
to behave the same on the other, so the shape asserted here is the shape the
TypeScript adapter hands its own tools. Nearly every case drives a real Strands
interrupt raised by a real ``@tool(context=True)`` inside the real agent loop
and then resumes it, rather than replaying canned events past a stub core,
because the SDK's own "is this answered?" gate is half of what is under test.
The exceptions are the cases that need a checkpoint the real SDK will not
produce: pauses that hand back no interrupts, and one checkpoint parked by the
previous release. Those script the core deliberately and say so. There is only
the one earlier-release case, because this adapter's answer shape is unchanged
and only a single interrupt changes which shape it is answered in.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

import pytest
from ag_ui.core import EventType, Interrupt, ResumeEntry, RunAgentInput
from strands import Agent as StrandsAgentCore
from strands import ToolContext, tool
from strands.models.model import Model as StrandsModel

from ag_ui_strands import INTERRUPT_CANCELLED, StrandsAgent
from ag_ui_strands.agent import _load_persisted_interrupt_bookkeeping
from ag_ui_strands.config import StrandsAgentConfig, ToolBehavior

TOOL_NAME = "ask_operator"
GATED_TOOL_NAME = "confirm_delete"

# What ``interrupt()`` handed back, and how many times a body ran past it.
# Module level because the tool is defined at import time, like the SDK
# decorator requires; every test resets them through ``_reset``.
received: list[Any] = []
completions: list[str] = []
# The reason a `malformed` run should raise, set per test before the run starts.
# The tool is defined at import time, so the case cannot be a parameter of it.
malformed_reason: dict = {}


@pytest.fixture(autouse=True)
def _reset():
    global malformed_reason
    received.clear()
    completions.clear()
    malformed_reason = {}


@tool(context=True)
def ask_operator(tool_context: ToolContext) -> dict:
    """Pause for an operator answer, recording whatever comes back."""
    # ``interrupt()`` raises to suspend, so nothing below runs until a resume
    # supplies an answer the SDK counts as present.
    received.append(tool_context.interrupt("need_input", reason={}))
    completions.append(TOOL_NAME)
    return {"status": "success", "content": [{"text": "ok"}]}


@tool
def confirm_delete() -> dict:
    """A plain server tool, gated by the adapter's approval hook."""
    completions.append(GATED_TOOL_NAME)
    return {"status": "success", "content": [{"text": "deleted"}]}


class _TwoTurnModel(StrandsModel):
    """Turn 1 calls ``tool_name``; every later turn narrates a final answer."""

    def __init__(self, tool_name: str) -> None:
        self.tool_name = tool_name
        self.turn = 0

    def get_config(self):
        return {}

    def update_config(self, **kwargs):
        pass

    async def structured_output(
        self, output_model, prompt=None, system_prompt=None, **kwargs
    ):  # pragma: no cover - never reached
        raise NotImplementedError
        yield

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs):
        self.turn += 1
        yield {"messageStart": {"role": "assistant"}}
        if self.turn == 1:
            yield {
                "contentBlockStart": {
                    "start": {
                        "toolUse": {"toolUseId": "tu-1", "name": self.tool_name}
                    }
                }
            }
            yield {"contentBlockDelta": {"delta": {"toolUse": {"input": "{}"}}}}
            yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "tool_use"}}
            return
        yield {"contentBlockDelta": {"delta": {"text": "Done."}}}
        yield {"contentBlockStop": {}}
        yield {"messageStop": {"stopReason": "end_turn"}}


def _run_input(run_id: str, resume: list[ResumeEntry] | None = None) -> RunAgentInput:
    return RunAgentInput(
        thread_id="thread-1",
        run_id=run_id,
        state={},
        messages=[{"id": "u1", "role": "user", "content": "go"}],
        tools=[],
        context=[],
        forwarded_props={},
        resume=resume,
    )


async def _collect(agent: StrandsAgent, input_data: RunAgentInput) -> list:
    return [event async for event in agent.run(input_data)]


def _finished(events: list):
    finished = [e for e in events if e.type == EventType.RUN_FINISHED]
    assert finished, f"no RUN_FINISHED in {[e.type for e in events]}"
    return finished[0]


def _re_paused(events: list) -> bool:
    """True when ``events`` reported a pause rather than finishing the turn."""
    outcome = _finished(events).outcome
    return outcome is not None and outcome.type == "interrupt"


def _assert_no_run_error(events: list, label: str) -> None:
    errors = [event for event in events if event.type == EventType.RUN_ERROR]
    assert not errors, f"{label} emitted RUN_ERROR: {errors}"


def _capture_submitted(agent: StrandsAgent, thread_id: str = "thread-1") -> list:
    """Record the interrupt answers the adapter hands the SDK from now on.

    The TypeScript suite asserts the forwarded wire shape directly; without this
    a Python test can only assert the consequence, which holds for any wrong
    answer and so cannot tell a denial from a mistake.
    """
    core = agent._agents_by_thread[thread_id]
    submitted: list = []
    original = core.stream_async

    def wrapper(prompt=None, *args, **kwargs):
        for block in prompt if isinstance(prompt, list) else []:
            if isinstance(block, dict) and "interruptResponse" in block:
                submitted.append(block["interruptResponse"].get("response"))
        return original(prompt, *args, **kwargs)

    core.stream_async = wrapper
    return submitted


async def _paused_run(
    tool_name: str = TOOL_NAME,
    tools: list | None = None,
    config: StrandsAgentConfig | None = None,
) -> tuple[StrandsAgent, str]:
    """Drive one run to a pause, returning the agent and the interrupt id."""
    core = StrandsAgentCore(
        model=_TwoTurnModel(tool_name),
        tools=tools if tools is not None else [ask_operator],
        system_prompt="test",
    )
    agent = StrandsAgent(core, name="resume-contract", config=config)
    events = await _collect(agent, _run_input("run-1"))
    _assert_no_run_error(events, "initial run")
    outcome = _finished(events).outcome
    assert outcome is not None and outcome.type == "interrupt"
    return agent, outcome.interrupts[0].id


# Each falsy answer, plus the absent one. A raw pass-through is read as
# unanswered on the oldest SDK release this package supports, whose resume gate
# reads a recorded answer by truthiness. Newer releases read it by presence and
# accept a raw falsy answer, so the envelope is what keeps one tool body working
# across the whole supported range and identical to the TypeScript bridge.
FALSY_ANSWERS = [
    pytest.param(False, {"response": False}, id="false"),
    pytest.param(0, {"response": 0}, id="zero"),
    pytest.param("", {"response": ""}, id="empty-string"),
    pytest.param(None, {"response": None}, id="null"),
    pytest.param([], {"response": []}, id="empty-array"),
    pytest.param({}, {"response": {}}, id="empty-object"),
]


@pytest.mark.parametrize("payload,expected", FALSY_ANSWERS)
@pytest.mark.asyncio
async def test_falsy_answer_reaches_the_tool_in_an_envelope(payload, expected):
    agent, interrupt_id = await _paused_run()

    events = await _collect(
        agent,
        _run_input(
            "run-2",
            resume=[
                ResumeEntry(
                    interrupt_id=interrupt_id, status="resolved", payload=payload
                )
            ],
        ),
    )

    _assert_no_run_error(events, "resume")
    assert not _re_paused(events), "the answer was read as unanswered and re-raised"
    assert received == [expected]
    assert completions == [TOOL_NAME], "the tool body never completed"


@pytest.mark.asyncio
async def test_answer_without_a_payload_reaches_the_tool_in_an_envelope():
    """An acknowledge-style prompt whose button carries no data.

    ``ResumeEntry.payload`` is optional, so an answer can arrive with nothing in
    it. Forwarded as-is that reads as unanswered, and the retry below would then
    be answered from the idempotency fingerprint instead of by the tool.
    """
    agent, interrupt_id = await _paused_run()

    events = await _collect(
        agent,
        _run_input(
            "run-2",
            resume=[ResumeEntry(interrupt_id=interrupt_id, status="resolved")],
        ),
    )

    _assert_no_run_error(events, "payload-less resume")
    assert not _re_paused(events), "a payload-less answer was read as unanswered"
    assert received == [{"response": None}]
    assert completions == [TOOL_NAME], "the tool body never completed"


@pytest.mark.asyncio
async def test_a_replayed_payload_less_resume_does_not_re_run_the_tool():
    """A replayed resume is answered from the idempotency fingerprint.

    That is correct only because the resume it replays actually completed. A
    resume that paused again is no longer remembered as completed, so this pins
    the other half: the replay reports success AND the tool body ran exactly
    once, rather than being re-executed.
    """
    agent, interrupt_id = await _paused_run()
    entry = [ResumeEntry(interrupt_id=interrupt_id, status="resolved")]

    await _collect(agent, _run_input("run-2", resume=entry))
    retry = await _collect(agent, _run_input("run-3", resume=entry))

    assert _finished(retry).outcome.type == "success"
    assert completions == [TOOL_NAME], "reported success while the tool was parked"


@pytest.mark.asyncio
async def test_cancellation_reaches_the_tool_as_the_exported_sentinel():
    agent, interrupt_id = await _paused_run()

    events = await _collect(
        agent,
        _run_input(
            "run-2",
            resume=[ResumeEntry(interrupt_id=interrupt_id, status="cancelled")],
        ),
    )

    _assert_no_run_error(events, "cancelled resume")
    assert received == [INTERRUPT_CANCELLED]
    assert received[0] is not INTERRUPT_CANCELLED, "handed out the module constant"


@pytest.mark.asyncio
async def test_a_tool_approval_is_answered_raw_without_the_envelope():
    """The approval hook reads ``approved`` off the answer directly, so this
    path deliberately stays raw in both languages. The gated tool running is
    what the hook accepting that shape looks like from outside."""
    agent, interrupt_id = await _paused_run(
        tool_name=GATED_TOOL_NAME,
        tools=[confirm_delete],
        config=StrandsAgentConfig(
            tool_behaviors={GATED_TOOL_NAME: ToolBehavior(interrupt_on_call=True)}
        ),
    )

    events = await _collect(
        agent,
        _run_input(
            "run-2",
            resume=[
                ResumeEntry(
                    interrupt_id=interrupt_id,
                    status="resolved",
                    payload={"approved": True},
                )
            ],
        ),
    )

    _assert_no_run_error(events, "approval resume")
    assert completions == [GATED_TOOL_NAME], "the approved tool never ran"


@pytest.mark.asyncio
async def test_a_cancelled_tool_approval_is_denied_in_the_shape_its_hook_reads():
    agent, interrupt_id = await _paused_run(
        tool_name=GATED_TOOL_NAME,
        tools=[confirm_delete],
        config=StrandsAgentConfig(
            tool_behaviors={GATED_TOOL_NAME: ToolBehavior(interrupt_on_call=True)}
        ),
    )
    submitted = _capture_submitted(agent)

    events = await _collect(
        agent,
        _run_input(
            "run-2",
            resume=[ResumeEntry(interrupt_id=interrupt_id, status="cancelled")],
        ),
    )

    _assert_no_run_error(events, "cancelled approval resume")
    # The shape itself, not only the consequence: asserting the tool did not run
    # holds for any wrong answer, so it cannot tell a denial from a mistake.
    assert submitted == [{"approved": False}], (
        "a cancelled approval was not denied in the shape its own hook reads"
    )
    assert completions == [], "a cancelled approval executed the tool"


# ---------------------------------------------------------------------------
# What an approval interrupt publishes
#
# Both bridges advertise the same keys, so a client renders an approval the same
# way whichever language served it.
# ---------------------------------------------------------------------------


@tool(context=True)
def ghost(tool_context: ToolContext) -> dict:
    """Raise an approval-named interrupt carrying no reason.

    Stands in for an approval whose reason did not survive a restart. Raised for
    real rather than fabricated, so the SDK's own recording of the answer is
    exercised too.
    """
    received.append(tool_context.interrupt("ag_ui:tool_call:ghost"))
    completions.append("ghost")
    return {"status": "success", "content": [{"text": "ok"}]}


def _gated_config() -> StrandsAgentConfig:
    return StrandsAgentConfig(
        tool_behaviors={GATED_TOOL_NAME: ToolBehavior(interrupt_on_call=True)}
    )


@pytest.mark.asyncio
async def test_an_approval_always_carries_a_message_a_schema_and_three_keys():
    core = StrandsAgentCore(
        model=_TwoTurnModel(GATED_TOOL_NAME),
        tools=[confirm_delete],
        system_prompt="test",
    )
    agent = StrandsAgent(core, name="resume-contract", config=_gated_config())
    events = await _collect(agent, _run_input("run-1"))
    _assert_no_run_error(events, "approval run")

    interrupt = _finished(events).outcome.interrupts[0]
    assert interrupt.reason == "tool_call"
    assert interrupt.message == f"Approve call to {GATED_TOOL_NAME}?"
    assert interrupt.tool_call_id == "tu-1"
    assert interrupt.response_schema == {
        "type": "object",
        "properties": {"approved": {"type": "boolean"}},
        "required": ["approved"],
    }
    assert sorted(interrupt.metadata) == ["strandsName", "tool_input", "tool_name"]
    assert interrupt.metadata == {
        "tool_name": GATED_TOOL_NAME,
        "tool_input": {},
        "strandsName": f"ag_ui:tool_call:{GATED_TOOL_NAME}",
    }


class _GatedInputModel(StrandsModel):
    """Turn 1 calls the gated tool with a non-empty input."""

    def __init__(self) -> None:
        self.turn = 0

    def get_config(self):
        return {}

    def update_config(self, **kwargs):
        pass

    async def structured_output(
        self, output_model, prompt=None, system_prompt=None, **kwargs
    ):  # pragma: no cover - never reached
        raise NotImplementedError
        yield

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs):
        self.turn += 1
        yield {"messageStart": {"role": "assistant"}}
        if self.turn == 1:
            yield {
                "contentBlockStart": {
                    "start": {
                        "toolUse": {"toolUseId": "tu-1", "name": GATED_TOOL_NAME}
                    }
                }
            }
            yield {
                "contentBlockDelta": {
                    "delta": {
                        "toolUse": {
                            "input": '{"path": "/tmp/original", "nested": {"deep": "/tmp/original"}}'
                        }
                    }
                }
            }
            yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "tool_use"}}
            return
        yield {"contentBlockDelta": {"delta": {"text": "Done."}}}
        yield {"contentBlockStop": {}}
        yield {"messageStop": {"stopReason": "end_turn"}}


@pytest.mark.asyncio
async def test_an_approval_publishes_a_copy_of_tool_input():
    """The published metadata must not alias the native interrupt's reason.

    Otherwise a client inspecting an approval could reach into the SDK's own
    checkpoint.
    """
    core = StrandsAgentCore(
        model=_GatedInputModel(), tools=[confirm_delete], system_prompt="test"
    )
    agent = StrandsAgent(core, name="resume-contract", config=_gated_config())
    events = await _collect(agent, _run_input("run-1"))
    _assert_no_run_error(events, "gated input run")

    interrupt = _finished(events).outcome.interrupts[0]
    assert interrupt.metadata["tool_input"] == {
        "path": "/tmp/original",
        "nested": {"deep": "/tmp/original"},
    }

    # A consumer mutates what it was handed, at the top level and below it.
    interrupt.metadata["tool_input"]["path"] = "/etc/passwd"
    interrupt.metadata["tool_input"]["nested"]["deep"] = "/etc/passwd"

    native = agent._agents_by_thread["thread-1"]._interrupt_state.interrupts[
        interrupt.id
    ]
    assert native.reason["tool_input"] == {
        "path": "/tmp/original",
        "nested": {"deep": "/tmp/original"},
    }, "the published metadata aliased the live native interrupt reason"
    assert completions == []


@pytest.mark.asyncio
async def test_an_approval_stands_in_the_same_defaults_without_a_reason():
    core = StrandsAgentCore(
        model=_TwoTurnModel("ghost"), tools=[ghost], system_prompt="test"
    )
    agent = StrandsAgent(core, name="resume-contract")
    events = await _collect(agent, _run_input("run-1"))
    _assert_no_run_error(events, "reason-less approval run")

    interrupt = _finished(events).outcome.interrupts[0]
    assert interrupt.reason == "tool_call"
    assert interrupt.message == "Approve call to unknown?"
    assert interrupt.tool_call_id is None
    # The schema is what makes the resume preflight check an approval at all, so
    # a reason-less one still has to carry it.
    assert interrupt.response_schema == {
        "type": "object",
        "properties": {"approved": {"type": "boolean"}},
        "required": ["approved"],
    }
    assert interrupt.metadata == {
        "tool_name": "unknown",
        "tool_input": {},
        "strandsName": "ag_ui:tool_call:ghost",
    }


@tool(context=True)
def malformed(tool_context: ToolContext) -> dict:
    """Raise an approval whose reason fields are unusable."""
    tool_context.interrupt("ag_ui:tool_call:malformed", reason=malformed_reason)
    completions.append("malformed")
    return {"status": "success", "content": [{"text": "ok"}]}


@pytest.mark.parametrize(
    "reason",
    [
        pytest.param(
            {"tool_name": 123, "tool_input": [], "tool_use_id": 7},
            id="wrong-types",
        ),
        pytest.param(
            {"tool_name": "", "tool_input": {}, "tool_use_id": ""},
            id="blank-strings",
        ),
    ],
)
@pytest.mark.asyncio
async def test_an_approval_stands_in_the_same_defaults_when_the_reason_is_unusable(
    reason,
):
    """A reason present but unusable, the other way the fields can go missing.

    Both languages apply the same "is it usable?" test, so neither publishes a
    ``tool_name`` that is not a name, a ``tool_input`` that is not an input
    mapping, or a blank tool-call binding.
    """
    global malformed_reason
    malformed_reason = reason

    core = StrandsAgentCore(
        model=_TwoTurnModel("malformed"), tools=[malformed], system_prompt="test"
    )
    agent = StrandsAgent(core, name="resume-contract")
    events = await _collect(agent, _run_input("run-1"))
    _assert_no_run_error(events, "unusable approval reason run")

    interrupt = _finished(events).outcome.interrupts[0]
    assert interrupt.message == "Approve call to unknown?"
    assert interrupt.tool_call_id is None
    # The reason carried nothing the three keys could hold, so it is published
    # rather than dropped: a client seeing only the defaults would have no way to
    # tell a missing reason from an unreadable one.
    assert interrupt.metadata == {
        "tool_name": "unknown",
        "tool_input": {},
        "strandsName": "ag_ui:tool_call:malformed",
        "reason": reason,
    }


@pytest.mark.asyncio
async def test_a_reason_less_approval_is_still_answered_raw():
    agent, interrupt_id = await _paused_run(tool_name="ghost", tools=[ghost])

    events = await _collect(
        agent,
        _run_input(
            "run-2",
            resume=[
                ResumeEntry(
                    interrupt_id=interrupt_id,
                    status="resolved",
                    payload={"approved": True},
                )
            ],
        ),
    )

    _assert_no_run_error(events, "reason-less approval resume")
    assert received == [{"approved": True}]


def test_the_cancellation_sentinel_is_exported_with_its_shape():
    """The sentinel is exported from both packages, with the same value.

    A tool checks ``.get("cancelled")`` on what it receives, so the value is
    part of the contract, not just the name.
    """
    import ag_ui_strands

    assert "INTERRUPT_CANCELLED" in ag_ui_strands.__all__
    assert ag_ui_strands.INTERRUPT_CANCELLED == {"cancelled": True}


# ---------------------------------------------------------------------------
# A batch holding both shapes at once
#
# The shape is chosen per entry, from that entry's own interrupt, so a batch can
# legitimately carry both. Classifying the batch as a whole instead would either
# envelope the approval (denying an approved tool) or hand the generic tool a raw
# answer, and every single-interrupt test above would still pass.
# ---------------------------------------------------------------------------


class _MixedBatchModel(StrandsModel):
    """Turn 1 calls the asking tool and the gated tool in one batch."""

    def __init__(self) -> None:
        self.turn = 0

    def get_config(self):
        return {}

    def update_config(self, **kwargs):
        pass

    async def structured_output(
        self, output_model, prompt=None, system_prompt=None, **kwargs
    ):  # pragma: no cover - never reached
        raise NotImplementedError
        yield

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs):
        self.turn += 1
        yield {"messageStart": {"role": "assistant"}}
        if self.turn == 1:
            for tool_use_id, name in (("tu-1", TOOL_NAME), ("tu-2", GATED_TOOL_NAME)):
                yield {
                    "contentBlockStart": {
                        "start": {"toolUse": {"toolUseId": tool_use_id, "name": name}}
                    }
                }
                yield {"contentBlockDelta": {"delta": {"toolUse": {"input": "{}"}}}}
                yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "tool_use"}}
            return
        yield {"contentBlockDelta": {"delta": {"text": "Done."}}}
        yield {"contentBlockStop": {}}
        yield {"messageStop": {"stopReason": "end_turn"}}


@pytest.mark.asyncio
async def test_a_mixed_batch_envelopes_the_generic_and_passes_the_approval_raw():
    core = StrandsAgentCore(
        model=_MixedBatchModel(),
        tools=[ask_operator, confirm_delete],
        system_prompt="test",
    )
    agent = StrandsAgent(core, name="resume-contract", config=_gated_config())

    first = await _collect(agent, _run_input("run-1"))
    _assert_no_run_error(first, "mixed initial run")
    interrupts = _finished(first).outcome.interrupts
    assert len(interrupts) == 2, (
        "the run did not pause on both a generic interrupt and an approval: "
        f"{[i.reason for i in interrupts]}"
    )
    generic = next(i for i in interrupts if i.reason == "need_input")
    approval = next(i for i in interrupts if i.reason == "tool_call")

    resumed = await _collect(
        agent,
        _run_input(
            "run-2",
            resume=[
                ResumeEntry(
                    interrupt_id=generic.id,
                    status="resolved",
                    payload={"environment": "staging"},
                ),
                ResumeEntry(
                    interrupt_id=approval.id,
                    status="resolved",
                    payload={"approved": True},
                ),
            ],
        ),
    )
    _assert_no_run_error(resumed, "mixed resume")

    # The generic tool reads its answer off "response".
    assert received == [{"response": {"environment": "staging"}}]
    # And the approval's hook read `approved` off a raw payload, so the gated
    # tool ran. Enveloping it would have denied it silently.
    assert GATED_TOOL_NAME in completions, (
        "the approved tool was denied in a mixed batch"
    )


# ---------------------------------------------------------------------------
# Publication edge cases, mirrored from the TypeScript suite
# ---------------------------------------------------------------------------


@tool(context=True)
def odd(tool_context: ToolContext) -> dict:
    """Raise an approval-named interrupt whose reason is not a mapping."""
    tool_context.interrupt("ag_ui:tool_call:odd", reason="not a mapping")
    completions.append("odd")
    return {"status": "success", "content": [{"text": "ok"}]}


class _ParkedApproval:
    """A reserved-prefix interrupt whose reason is not a mapping.

    Scripted, because the real SDK does not retain a checkpoint in this state:
    it is the one a hook failure or a crash after persistence restores, which is
    what the replay path exists for.
    """

    def __init__(self, interrupt_id: str, answer: Any) -> None:
        self.id = interrupt_id
        self.name = "ag_ui:tool_call:ghost"
        self.reason = "not a mapping"
        self.response = answer


@pytest.mark.parametrize(
    "status,payload,legacy_answer",
    [
        pytest.param(
            "resolved",
            {"approved": True},
            {"response": {"approved": True}},
            id="resolved-object",
        ),
        # A generic interrupt had no response schema, so any payload was valid.
        # An object payload happens to satisfy the schema this release attaches
        # to the same interrupt, which is why it alone proves nothing about the
        # gate. These do.
        pytest.param("resolved", "yes", {"response": "yes"}, id="resolved-string"),
        pytest.param("resolved", 0, {"response": 0}, id="resolved-falsy"),
        pytest.param("resolved", None, {"response": None}, id="resolved-null"),
        pytest.param("cancelled", None, {"cancelled": True}, id="cancelled"),
    ],
)
@pytest.mark.asyncio
async def test_a_checkpoint_the_old_classifier_called_generic_still_replays(
    status, payload, legacy_answer
):
    """The one interrupt whose classification this release moves.

    A reserved-prefix interrupt with a reason that is not a mapping was generic
    before and is an approval now, so a checkpoint parked on it holds the generic
    envelope while the replay comparison computes the raw approval answer.
    Without a legacy path that thread never resumes: fresh input is refused
    because the checkpoint is active, and the replay is refused because the
    shapes differ.

    Recognising the replay is only half of it. A generic interrupt had no
    response schema, so its answer need not be an object, and judging that
    answer against the schema this release attaches would reject it at the
    payload gate instead. Both answered statuses, and payloads that the new
    schema would refuse.
    """
    from ag_ui_strands.agent import _strands_interrupt_to_agui

    core = StrandsAgentCore(
        model=_TwoTurnModel("odd"), tools=[odd], system_prompt="test"
    )
    agent = StrandsAgent(core, name="resume-contract")
    interrupt_id = "v1:tool_call:tu-1:legacy"
    parked = _ParkedApproval(interrupt_id, legacy_answer)

    # The bookkeeping a restart restores, published by the adapter's own mapper
    # so the pending metadata is exactly what it would have advertised.
    agent._agents_by_thread["thread-1"] = core
    agent._pending_interrupts_by_thread["thread-1"] = {
        interrupt_id: _strands_interrupt_to_agui(parked)
    }
    core._interrupt_state.activated = True
    core._interrupt_state.interrupts = {interrupt_id: parked}

    submitted = _capture_submitted(agent)
    entry = ResumeEntry(interrupt_id=interrupt_id, status=status, payload=payload)
    resumed = await _collect(agent, _run_input("run-1", resume=[entry]))

    # What is under test is the adapter's decision, not the SDK finishing: a
    # scripted checkpoint has none of the parked tool context the SDK needs to
    # complete, so it raises once the answers reach it. Refusing the replay is
    # the failure this covers, and it is refused before anything is forwarded.
    refusals = [
        event.code
        for event in resumed
        if event.type == EventType.RUN_ERROR
        and event.code in ("INTERRUPT_RESUME_ERROR", "UNKNOWN_INTERRUPT_ID")
    ]
    assert refusals == [], (
        f"the checkpoint parked by the previous release was refused: {refusals}"
    )
    assert submitted, "the legacy replay never reached the SDK"


def test_an_expired_legacy_replay_is_still_refused():
    """The compatibility exemption covers the schema and nothing else.

    An answer recorded before this release was accepted under rules that had no
    schema, so replaying it is not re-judged against the one this release
    attaches. Expiry is a different question: an answer nobody may act on any
    more does not become actionable by having been recorded early, and the
    exemption sits below that check so it cannot waive it.
    """
    from ag_ui_strands.agent import _preflight_resume_entries

    class _Parked:
        id = "v1:tool_call:tu-1:legacy"
        name = "ag_ui:tool_call:ghost"
        reason = "not a mapping"
        # A non-object answer, which is what the schema alone would refuse.
        response = {"response": "yes"}

    class _Agent:
        class _interrupt_state:
            activated = True
            interrupts = {_Parked.id: _Parked()}

    expired = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    entry = ResumeEntry(interrupt_id=_Parked.id, status="resolved", payload="yes")
    error = _preflight_resume_entries(
        _Agent(),
        [entry],
        {_Parked.id: Interrupt(id=_Parked.id, reason="tool_call", expires_at=expired)},
    )
    assert getattr(error, "code", None) == "INTERRUPT_EXPIRED", (
        "the compatibility exemption waived expiry as well as the schema"
    )

    # And the same replay inside its window is still let through, so this pins
    # the expiry check rather than the exemption being gone.
    future = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
    assert (
        _preflight_resume_entries(
            _Agent(),
            [entry],
            {
                _Parked.id: Interrupt(
                    id=_Parked.id, reason="tool_call", expires_at=future
                )
            },
        )
        is None
    )


def test_replaying_an_approval_does_not_waive_its_payload_schema():
    """The gate is relaxed for one interrupt, not for every replay.

    An approval whose reason is a mapping was an approval before this release
    too, so its schema always applied and a non-object answer was never valid
    for it. Recording one means something already went wrong upstream, and
    waving it through on replay would forward an answer its own hook cannot
    read. Only the interrupt whose rules changed gets the exemption.
    """
    from ag_ui_strands.agent import _preflight_resume_entries

    class _Approval:
        id = "v1:tool_call:tu-1:formed"
        name = "ag_ui:tool_call:charge"
        reason = {"tool_name": "charge", "tool_input": {}, "tool_use_id": "tu-1"}
        # The current shape for an approval is the raw payload, so this is a
        # genuine replay of what the checkpoint holds.
        response = "yes"

    class _Agent:
        class _interrupt_state:
            activated = True
            interrupts = {_Approval.id: _Approval()}

    entry = ResumeEntry(
        interrupt_id=_Approval.id, status="resolved", payload="yes"
    )
    error = _preflight_resume_entries(_Agent(), [entry], None)
    assert getattr(error, "code", None) == "INVALID_PAYLOAD", (
        "the schema exemption was widened past the one interrupt whose rules changed"
    )


@pytest.mark.asyncio
async def test_a_well_formed_approval_gets_no_legacy_path():
    """The legacy path covers one interrupt, and must not cover its neighbour.

    An approval whose reason is a mapping was an approval before this release
    too, so no shape moved for it and a checkpoint holding the generic envelope
    was never something either release recorded. Accepting that would let a
    batch that does not match the checkpoint through, which is what the replay
    comparison exists to refuse.
    """
    from ag_ui_strands.agent import _replays_recorded_answers

    class _WellFormed:
        id = "v1:tool_call:tu-1:formed"
        name = "ag_ui:tool_call:charge"
        reason = {"tool_name": "charge", "tool_input": {}, "tool_use_id": "tu-1"}
        response = {"response": {"approved": True}}

    class _State:
        activated = True
        interrupts = {_WellFormed.id: _WellFormed()}

    entry = ResumeEntry(
        interrupt_id=_WellFormed.id, status="resolved", payload={"approved": True}
    )
    assert _replays_recorded_answers(_State(), [entry]) is False, (
        "the legacy path was widened past the one interrupt whose shape moved"
    )


@pytest.mark.asyncio
async def test_an_approval_still_publishes_a_reason_it_could_not_use():
    """The relaxed classifier admits this case on purpose.

    Dropping the reason as well would leave the client nothing but the
    ``unknown`` defaults.
    """
    core = StrandsAgentCore(model=_TwoTurnModel("odd"), tools=[odd], system_prompt="test")
    agent = StrandsAgent(core, name="resume-contract")
    events = await _collect(agent, _run_input("run-1"))
    _assert_no_run_error(events, "unusable reason run")

    interrupt = _finished(events).outcome.interrupts[0]
    assert interrupt.reason == "tool_call"
    assert interrupt.metadata == {
        "tool_name": "unknown",
        "tool_input": {},
        "strandsName": "ag_ui:tool_call:odd",
        "reason": "not a mapping",
    }


# ---------------------------------------------------------------------------
# Guarantees that were reverting cleanly
#
# Each of these pins a behaviour this change introduced that a reviewer showed
# could be reverted with the whole suite still green.
# ---------------------------------------------------------------------------


# One usable key each, so each case fails exactly one of the three conditions
# that decide whether the raw reason is published alongside them. Named for the
# key that survived, since that is what the assertion turns on.
ONE_USABLE_KEY = [
    pytest.param({"tool_use_id": "tu-bound"}, "tu-bound", id="binding"),
    pytest.param({"tool_name": "charge_card"}, None, id="tool-name"),
    pytest.param({"tool_input": {"amount": 1}}, None, id="tool-input"),
]


@pytest.mark.parametrize("reason,expected_tool_call_id", ONE_USABLE_KEY)
@pytest.mark.asyncio
async def test_an_approval_publishes_no_reason_when_one_key_was_usable(
    reason, expected_tool_call_id
):
    """All three conditions, one case each.

    The raw reason is published only when nothing in it could be used, so a
    reason holding any one usable key must not carry it. Three cases rather than
    one because dropping any single condition leaves the other two satisfied,
    which is how two of the three went unpinned while this read as covering
    them.
    """
    global malformed_reason
    malformed_reason = reason
    core = StrandsAgentCore(
        model=_TwoTurnModel("malformed"), tools=[malformed], system_prompt="test"
    )
    agent = StrandsAgent(core, name="resume-contract")
    events = await _collect(agent, _run_input("run-1"))
    _assert_no_run_error(events, "one-usable-key reason run")

    interrupt = _finished(events).outcome.interrupts[0]
    assert interrupt.tool_call_id == expected_tool_call_id
    assert sorted(interrupt.metadata) == ["strandsName", "tool_input", "tool_name"]


@tool(context=True)
def aliased(tool_context: ToolContext) -> dict:
    """Raise an approval whose reason is an unusable mapping with nesting."""
    received.append(
        tool_context.interrupt(
            "ag_ui:tool_call:aliased", reason={"question": {"deep": "original"}}
        )
    )
    completions.append("aliased")
    return {"status": "success", "content": [{"text": "ok"}]}


@pytest.mark.asyncio
async def test_a_published_reason_is_a_copy_not_a_handle():
    """Mirrors the TypeScript assertion, which was the only one pinning this.

    A mapping, because the published reason is only reachable as a handle when it
    is mutable; a string reason could not prove anything either way.
    """
    core = StrandsAgentCore(
        model=_TwoTurnModel("aliased"), tools=[aliased], system_prompt="test"
    )
    agent = StrandsAgent(core, name="resume-contract")
    events = await _collect(agent, _run_input("run-1"))
    _assert_no_run_error(events, "aliasable reason run")

    interrupt = _finished(events).outcome.interrupts[0]
    assert interrupt.metadata["reason"] == {"question": {"deep": "original"}}

    # A consumer mutates what it was handed, below the top level.
    interrupt.metadata["reason"]["question"]["deep"] = "tampered"

    native = agent._agents_by_thread["thread-1"]._interrupt_state.interrupts[
        interrupt.id
    ]
    assert native.reason == {"question": {"deep": "original"}}, (
        "the published reason aliased the live native interrupt reason"
    )


# An unrecognised resume status has no test here on purpose: it cannot be
# constructed. ``ResumeEntry.status`` is validated at the wire boundary and
# admits only "resolved" or "cancelled", so the guard that denies on anything
# else is unreachable on this side. The TypeScript types are structural rather
# than validated, so its guard IS reachable and is pinned in that suite.


@pytest.mark.asyncio
async def test_poisoning_the_exported_sentinel_cannot_change_a_cancellation():
    """The emitted value is built by a factory rather than copied off the export.

    Deriving it from the export instead would let a consumer that mutated the
    constant change every later cancellation.
    """
    import ag_ui_strands

    original = dict(ag_ui_strands.INTERRUPT_CANCELLED)
    ag_ui_strands.INTERRUPT_CANCELLED["cancelled"] = "tampered"
    ag_ui_strands.INTERRUPT_CANCELLED["extra"] = True
    try:
        agent, interrupt_id = await _paused_run()
        events = await _collect(
            agent,
            _run_input(
                "run-2",
                resume=[ResumeEntry(interrupt_id=interrupt_id, status="cancelled")],
            ),
        )
        _assert_no_run_error(events, "cancelled resume with a poisoned sentinel")
        assert received == [{"cancelled": True}]
    finally:
        ag_ui_strands.INTERRUPT_CANCELLED.clear()
        ag_ui_strands.INTERRUPT_CANCELLED.update(original)


class _Uncopyable:
    """Deep-copying this raises, which is the only way into the fallback."""

    def __deepcopy__(self, memo):  # noqa: D105
        raise RuntimeError("cannot deepcopy")


def test_it_says_so_when_a_tool_input_cannot_be_fully_detached(caplog):
    """The same guarantee as below, for the helper that publishes tool input.

    This fallback returns a shallow copy, so the nested values stay handles on
    the live checkpoint. Saying so is the whole point: silently degrading the
    guarantee is what makes an aliasing bug invisible.
    """
    from ag_ui_strands.agent import _detached_copy

    held = _Uncopyable()

    with caplog.at_level("WARNING", logger="ag_ui_strands.agent"):
        result = _detached_copy({"nested": {"held": held}})

    assert result["nested"]["held"] is held, "the fallback did not alias"
    assert any(
        "Could not fully detach a tool input" in r.message for r in caplog.records
    ), "a tool input was published undetached with no warning"


def test_it_says_so_when_a_reason_cannot_be_detached(caplog):
    """The fallback publishes a value still shared with the live checkpoint.

    The one thing it must not do is go unmentioned, and until now this branch was
    never entered on this side at all.

    Driven directly rather than through a run, deliberately. Strands 1.19 and
    later deep-copies an interrupt reason itself, so an uncopyable one fails
    inside the SDK before this adapter ever sees it, and an end-to-end version of
    this test passes on the pinned floor and fails on the newer release. The
    branch is this module's own, so it is exercised as such.
    """
    from ag_ui_strands.agent import _detached_value

    held = _Uncopyable()

    with caplog.at_level("WARNING", logger="ag_ui_strands.agent"):
        result = _detached_value({"held": held})

    assert result["held"] is held, "the fallback did not return the original"
    assert any(
        "Could not detach an interrupt reason" in r.message for r in caplog.records
    ), "a value was published undetached with no warning"


# ---------------------------------------------------------------------------
# A pause that reports no interrupts
# ---------------------------------------------------------------------------


class _QuietPauseResult:
    """A terminal result that stopped for an interrupt and carries none."""

    stop_reason = "interrupt"
    # A tuple, not a list: a mutable default shared by every instance across
    # every test is the kind of state that fails once and never again.
    interrupts: tuple = ()


@pytest.mark.asyncio
async def test_a_pause_that_leaves_the_agent_parked_is_not_remembered_as_completed():
    """The framework can stop for an interrupt and hand back nothing.

    Where it leaves the checkpoint parked, that finish is indistinguishable from
    an ordinary success in the event stream, so recording the resume as
    completed would let the client's retry be answered from the idempotency
    fingerprint without ever reaching the agent waiting behind it. Mirrors the
    TypeScript guarantee of the same name.
    """
    agent, interrupt_id = await _paused_run()
    core = agent._agents_by_thread["thread-1"]

    calls = 0

    async def _quiet(prompt=None, *args, **kwargs):
        # Parked, and holding nothing open: the checkpoint stays active while
        # every interrupt on it reads as answered. Scripted inside the stream
        # rather than up front because the resume has to pass preflight against
        # an open interrupt first, exactly as a real one does.
        nonlocal calls
        calls += 1
        # The answer carries the envelope the adapter computes for this batch,
        # because that is the state Strands actually leaves behind: it records
        # the submitted answer before rerunning the parked execution, and clears
        # the checkpoint only once that work succeeds.
        core._interrupt_state.interrupts = {
            interrupt_id: _make_answered_interrupt(
                interrupt_id, {"response": {"a": 1}}
            )
        }
        yield {"result": _QuietPauseResult()}

    core.stream_async = _quiet

    batch = [
        ResumeEntry(interrupt_id=interrupt_id, status="resolved", payload={"a": 1})
    ]

    first = await _collect(agent, _run_input("run-2", resume=batch))
    _assert_no_run_error(first, "quiet pause")
    assert calls == 1
    assert agent._last_resume_fingerprint.get("thread-1") is None, (
        "the parked resume was remembered as completed"
    )

    # The client retries, having no way to know the run only looked finished,
    # and it reaches the framework rather than being answered from a fingerprint.
    retry = await _collect(agent, _run_input("run-3", resume=batch))
    _assert_no_run_error(retry, "retry after a parked quiet pause")
    assert calls == 2, (
        "the retry was answered from the fingerprint instead of reaching the framework"
    )


@pytest.mark.asyncio
async def test_a_reported_pause_that_left_no_checkpoint_is_still_idempotent():
    """The other half, and the reason the guard reads the checkpoint at all.

    A run whose terminal report says it stopped for an interrupt, with none to
    hand over and no checkpoint left behind, has finished its work. Treating
    that as a pause would cost the client its idempotent retry and leave an
    answered interrupt recorded as pending, in memory and in persisted state.
    """
    agent, interrupt_id = await _paused_run()
    core = agent._agents_by_thread["thread-1"]

    calls = 0

    async def _finished_but_reported_as_paused(prompt=None, *args, **kwargs):
        nonlocal calls
        calls += 1
        core._interrupt_state.deactivate()
        yield {"result": _QuietPauseResult()}

    core.stream_async = _finished_but_reported_as_paused

    batch = [
        ResumeEntry(interrupt_id=interrupt_id, status="resolved", payload={"a": 1})
    ]

    first = await _collect(agent, _run_input("run-2", resume=batch))
    _assert_no_run_error(first, "reported pause with no checkpoint")
    assert agent._pending_interrupts_by_thread.get("thread-1") in (None, {}), (
        "an answered interrupt was left recorded as pending"
    )
    # Checked where a restart would read it too, not just in memory, since that
    # is what carried the stale record across one.
    persisted_pending, persisted_fingerprint = _load_persisted_interrupt_bookkeeping(
        core
    )
    assert persisted_pending in (None, {}), (
        "an answered interrupt was left persisted as pending"
    )
    assert persisted_fingerprint is not None, (
        "the completed resume was not persisted as completed"
    )

    retry = await _collect(agent, _run_input("run-3", resume=batch))
    _assert_no_run_error(retry, "retry of a completed resume")
    assert _finished(retry).outcome.type == "success"
    assert calls == 1, "the completed resume was not remembered, so its replay re-ran"


class _Result:
    """A terminal result carrying just what the detector reads."""

    def __init__(self, stop_reason: str, interrupts: list | None = None) -> None:
        self.stop_reason = stop_reason
        self.interrupts = interrupts or []


class _State:
    def __init__(self, activated: bool, interrupts: dict | None = None) -> None:
        self.activated = activated
        self.interrupts = interrupts or {}


class _Core:
    def __init__(self, state: _State | None) -> None:
        self._interrupt_state = state


def _make_answered_interrupt(
    interrupt_id: str = "i-1", answer: Any | None = None
) -> Any:
    """An interrupt every supported release reads as already answered.

    The two halves of the supported range disagree on the predicate, one reading
    truthiness and the other presence, so this carries a value that satisfies
    both rather than picking a side. Carries its own id because the adapter
    checks that each entry is filed under the id it reports, and takes the
    recorded answer because an exact replay is compared against it.
    """

    class _Answered:
        id = interrupt_id
        response = {"response": 1} if answer is None else answer

    return _Answered()


def test_only_a_parked_checkpoint_counts_as_a_quiet_pause():
    """Pins the flag on every path, including those no SDK release reaches.

    Both conditions have to hold: a checkpoint still active with nothing open,
    and a terminal report of an interrupt stop. Either alone would claim a pause
    the framework did not leave behind, and withholding the fingerprint from a
    resume that really did complete costs the client its idempotent retry.
    """
    from ag_ui_strands.agent import _extract_interrupts

    answered = _make_answered_interrupt()

    paused = _State(activated=True, interrupts={"i-1": answered})
    assert _extract_interrupts(_Core(paused), _Result("interrupt")) == ([], True)

    finished = _State(activated=True, interrupts={"i-1": answered})
    assert _extract_interrupts(_Core(finished), _Result("end_turn")) == ([], False)

    # No terminal report at all, which is the case the rest of the suite walks
    # through and the one a wrong stop reason does not stand in for. Nothing
    # said this run paused, so nothing is withheld.
    unreported = _State(activated=True, interrupts={"i-1": answered})
    assert _extract_interrupts(_Core(unreported), None) == ([], False)

    # No checkpoint left behind is a finished run however the stop is reported,
    # so nothing is withheld and the client keeps its idempotent retry.
    assert _extract_interrupts(_Core(None), _Result("interrupt")) == ([], False)
    assert _extract_interrupts(_Core(None), _Result("end_turn")) == ([], False)
    assert _extract_interrupts(_Core(None), None) == ([], False)
    inactive = _State(activated=False, interrupts={})
    assert _extract_interrupts(_Core(inactive), _Result("interrupt")) == ([], False)
