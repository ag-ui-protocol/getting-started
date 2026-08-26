"""The frontend-tool halt must stop the Strands loop, not just mute the wire.

A proxy (frontend) tool returns a SUCCESSFUL ``"Forwarded to client"``
placeholder server-side, so Strands has every reason to run another model cycle
on that placeholder — and another. Gating only event *emission* leaves those
cycles running: frontend tool calls the client never sees (and therefore can
never answer), real backend side effects, phantom assistant turns written to
the session store, and RUN_FINISHED queued behind work nobody is watching.
Single-agent Strands has no cycle cap, so a model that keeps retrying the read
never produces a terminal event at all.

These tests drive the REAL ``StrandsAgent`` adapter over a REAL
``strands.Agent`` event loop with a scripted stub model (no network, no
credentials, deterministic cycle count), so the model-invocation count is
direct evidence about the loop rather than about a mocked stream.
"""

from __future__ import annotations

import asyncio
import copy

import pytest
from ag_ui.core import Context, EventType, RunAgentInput, Tool, ToolMessage, UserMessage
from fastapi import FastAPI
from fastapi.testclient import TestClient
from strands import Agent
from strands.models.model import Model
from strands.session.file_session_manager import FileSessionManager
from strands.tools.tools import PythonAgentTool

from ag_ui_strands.agent import StrandsAgent
from ag_ui_strands.client_proxy_tool import PROXY_RESULT_PLACEHOLDER
from ag_ui_strands.config import StrandsAgentConfig, ToolBehavior
from ag_ui_strands.endpoint import add_strands_fastapi_endpoint
from ag_ui_strands.session_reconcile import AG_UI_WIRE_MAP_STATE_KEY
from tests.endpoint_helpers import sse_payloads

# Ceiling on model invocations. The halt should stop the loop after ONE, so any
# regression trips this and fails loudly instead of hanging the suite.
_RUNAWAY_GUARD = 12


class _ScriptedModel(Model):
    """Stub model that keeps calling the frontend tool until told to stop.

    * turn 1 — ONE assistant message carrying ``first_turn_tools`` as parallel
      ``toolUse`` blocks (the reported repro: a read and a write together).
    * turns 2..``follow_ups``+1 — another ``get_cell`` call, modelling a model
      that received only ``"Forwarded to client"`` and retries the read.
    * afterwards — plain text, ``end_turn``.

    ``follow_ups=None`` never stops calling the tool, which is how a run with a
    drained (rather than halted) loop is shown to have no terminal event.
    """

    def __init__(
        self,
        *,
        follow_ups: int | None = 2,
        raise_on_call: int | None = None,
        first_turn_tools: tuple[str, ...] = ("get_cell", "update_cell"),
    ):
        self.calls = 0
        self.follow_ups = follow_ups
        self.raise_on_call = raise_on_call
        self.first_turn_tools = first_turn_tools

    def get_config(self):
        return {}

    def update_config(self, **kwargs):
        pass

    async def structured_output(self, output_model, prompt, **kwargs):  # pragma: no cover
        if False:
            yield {}

    @staticmethod
    def _tool_use(tool_use_id: str, name: str):
        args = '{"cell":"B4"}' if name == "get_cell" else '{"cell":"B5","value":"?"}'
        return [
            {"contentBlockStart": {"start": {"toolUse": {"toolUseId": tool_use_id, "name": name}}}},
            {"contentBlockDelta": {"delta": {"toolUse": {"input": args}}}},
            {"contentBlockStop": {}},
        ]

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs):
        self.calls += 1
        turn = self.calls
        if turn > _RUNAWAY_GUARD:
            raise RuntimeError(
                f"model invoked {turn} times: the frontend-tool halt did not stop the loop"
            )
        if self.raise_on_call is not None and turn == self.raise_on_call:
            raise RuntimeError("simulated model failure on a post-halt cycle")

        yield {"messageStart": {"role": "assistant"}}
        if turn == 1:
            for index, name in enumerate(self.first_turn_tools):
                for event in self._tool_use(f"native-{name}-1", name):
                    yield event
            yield {"messageStop": {"stopReason": "tool_use"}}
        elif self.follow_ups is None or turn <= 1 + self.follow_ups:
            for event in self._tool_use(f"native-get_cell-{turn}", "get_cell"):
                yield event
            yield {"messageStop": {"stopReason": "tool_use"}}
        else:
            yield {"contentBlockDelta": {"delta": {"text": "Done."}}}
            yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "end_turn"}}


def _frontend_tools() -> list[Tool]:
    return [
        Tool(
            name="get_cell",
            description="Read a cell",
            parameters={
                "type": "object",
                "properties": {"cell": {"type": "string"}},
                "required": ["cell"],
            },
        ),
        Tool(
            name="update_cell",
            description="Write a cell",
            parameters={
                "type": "object",
                "properties": {"cell": {"type": "string"}, "value": {"type": "string"}},
                "required": ["cell", "value"],
            },
        ),
    ]


def _run_input(thread_id: str) -> RunAgentInput:
    return RunAgentInput(
        thread_id=thread_id,
        run_id="r-1",
        parent_run_id=None,
        state={},
        messages=[UserMessage(id="u1", role="user", content="Could you duplicate my B4 cell?")],
        tools=_frontend_tools(),
        context=[],
        forwarded_props={},
    )


async def _collect(adapter: StrandsAgent, thread_id: str) -> list:
    """Run to completion, failing fast rather than hanging on a regression."""

    async def drive():
        return [event async for event in adapter.run(_run_input(thread_id))]

    return await asyncio.wait_for(drive(), timeout=30)


def _build(model: Model, config: StrandsAgentConfig | None = None) -> StrandsAgent:
    return StrandsAgent(Agent(model=model, tools=[]), name="halt-test-agent", config=config)


@pytest.mark.asyncio
async def test_halt_stops_the_strands_loop_after_one_model_cycle():
    """No model cycle may run after the halt latches."""
    model = _ScriptedModel(follow_ups=2)
    events = await _collect(_build(model), "t-stops")

    assert model.calls == 1, (
        f"model invoked {model.calls}x; cycles after the halt run invisibly to the client"
    )
    assert any(e.type == EventType.RUN_FINISHED for e in events)


@pytest.mark.asyncio
async def test_halt_emits_run_finished_when_the_model_would_never_stop():
    """A model that keeps retrying the read must not strand the run.

    Draining instead of halting produces NO terminal event here at all, because
    single-agent Strands has no cycle cap.
    """
    model = _ScriptedModel(follow_ups=None)
    events = await _collect(_build(model), "t-unbounded")

    assert model.calls == 1
    assert any(e.type == EventType.RUN_FINISHED for e in events)
    assert not any(e.type == EventType.RUN_ERROR for e in events)


def test_endpoint_halt_keeps_request_context_scoped_to_each_stream_step():
    """The endpoint pulls each SSE event in a new task context."""
    model = _ScriptedModel(follow_ups=None)
    adapter = _build(model)
    app = FastAPI()
    add_strands_fastapi_endpoint(app, adapter, "/")
    input_data = _run_input("t-endpoint-context")
    input_data.context = [Context(description="account", value="premium")]

    response = TestClient(app).post(
        "/", json=input_data.model_dump(by_alias=True, mode="json")
    )
    payloads = sse_payloads(response.text)

    assert response.status_code == 200
    assert payloads[-1]["type"] == EventType.RUN_FINISHED
    assert not any(payload["type"] == EventType.RUN_ERROR for payload in payloads)


@pytest.mark.asyncio
async def test_post_halt_model_failure_cannot_replace_run_finished():
    """A fault on a cycle the client never sees must not become its RUN_ERROR.

    Draining reaches the failing cycle and surfaces EventLoopException as
    RUN_ERROR, leaving the client holding tool calls it can never answer.
    """
    model = _ScriptedModel(follow_ups=2, raise_on_call=2)
    events = await _collect(_build(model), "t-error")

    assert model.calls == 1
    assert any(e.type == EventType.RUN_FINISHED for e in events)
    assert not any(e.type == EventType.RUN_ERROR for e in events)


@pytest.mark.asyncio
async def test_both_parallel_frontend_calls_reach_the_wire():
    """The halt must not truncate a parallel batch.

    It latches at the tool-RESULT boundary, so every ``toolUse`` block in the
    assistant message is emitted first. Covered against a mocked stream in
    ``test_parallel_tool_call_handling.py``; this pins it against the real loop.
    """
    model = _ScriptedModel(follow_ups=2)
    events = await _collect(_build(model), "t-parallel")

    started = [
        e.tool_call_name for e in events if e.type == EventType.TOOL_CALL_START
    ]
    assert started == ["get_cell", "update_cell"]


@pytest.mark.asyncio
async def test_continue_after_frontend_call_still_runs_further_cycles():
    """Tools that opt out of halting keep the loop running."""
    model = _ScriptedModel(follow_ups=1, first_turn_tools=("get_cell",))
    config = StrandsAgentConfig(
        tool_behaviors={"get_cell": ToolBehavior(continue_after_frontend_call=True)}
    )
    events = await _collect(_build(model, config), "t-continue")

    assert model.calls > 1, "continue_after_frontend_call must not halt the loop"
    assert any(e.type == EventType.RUN_FINISHED for e in events)


class _MixedBatchModel(Model):
    """One assistant message calling a frontend tool AND a backend tool.

    This is the shape that loses data: the halt is triggered by the frontend
    tool, but the tool-result message it latches on also carries the backend
    tool's REAL result.
    """

    def __init__(self, backend_name: str = "run_script"):
        self.calls = 0
        self.backend_name = backend_name
        # Transcript handed to the provider on each call, for round-trip asserts.
        self.seen_messages: list[list[dict]] = []

    def get_config(self):
        return {}

    def update_config(self, **kwargs):
        pass

    async def structured_output(self, output_model, prompt, **kwargs):  # pragma: no cover
        if False:
            yield {}

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs):
        self.calls += 1
        self.seen_messages.append(copy.deepcopy(messages))
        if self.calls > _RUNAWAY_GUARD:
            raise RuntimeError("halt did not stop the loop")
        yield {"messageStart": {"role": "assistant"}}
        if self.calls == 1:
            yield {
                "contentBlockStart": {
                    "start": {"toolUse": {"toolUseId": "native-fe", "name": "get_cell"}}
                }
            }
            # A no-argument tool still streams one (empty) input delta. Without
            # any delta Strands never surfaces `current_tool_use` and the call
            # is invisible to the adapter entirely.
            yield {"contentBlockDelta": {"delta": {"toolUse": {"input": ""}}}}
            yield {"contentBlockStop": {}}
            yield {
                "contentBlockStart": {
                    "start": {"toolUse": {"toolUseId": "native-be", "name": self.backend_name}}
                }
            }
            yield {"contentBlockDelta": {"delta": {"toolUse": {"input": '{"q":"tables"}'}}}}
            yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "tool_use"}}
        else:
            yield {"contentBlockDelta": {"delta": {"text": "Done."}}}
            yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "end_turn"}}


def _backend_tool(name: str = "run_script") -> PythonAgentTool:
    def _func(tool_use, **_kwargs):
        return {
            "toolUseId": tool_use["toolUseId"],
            "status": "success",
            "content": [{"text": '{"tables": ["orders", "customers"]}'}],
        }

    _func.__name__ = name
    return PythonAgentTool(
        tool_name=name,
        tool_spec={"name": name, "description": name, "inputSchema": {"json": {}}},
        tool_func=_func,
    )


@pytest.mark.asyncio
async def test_backend_result_in_a_halting_batch_still_reaches_the_client():
    """A backend tool batched with a frontend tool must not lose its result.

    The halt latches on the tool-result message, which in a mixed batch also
    carries the backend tool's real result. Dropping that message wholesale
    strands the client: the tool card never resolves, and consumers that
    persist from the event stream end up with a toolUse that has no
    toolResult — a transcript the next run replays to the model provider.
    """
    model = _MixedBatchModel()
    adapter = StrandsAgent(
        Agent(model=model, tools=[_backend_tool()]), name="halt-test-agent"
    )
    events = await _collect(adapter, "t-mixed")

    started = [e.tool_call_name for e in events if e.type == EventType.TOOL_CALL_START]
    results = [e.tool_call_id for e in events if e.type == EventType.TOOL_CALL_RESULT]

    assert started == ["get_cell", "run_script"]
    # The backend result goes out; the frontend placeholder stays suppressed
    # (the client produces the real one) — so exactly one result, the backend's.
    assert results == ["native-be"]
    assert model.calls == 1
    assert any(e.type == EventType.RUN_FINISHED for e in events)


@pytest.mark.asyncio
async def test_halting_batch_backend_result_lands_in_the_messages_snapshot():
    """MESSAGES_SNAPSHOT is the only path into client-side history.

    TOOL_CALL_RESULT is emitted role-less by design so the frontend does not
    add it to the conversation, so if the snapshot splice is skipped the result
    exists nowhere the client can persist it.
    """
    model = _MixedBatchModel()
    adapter = StrandsAgent(
        Agent(model=model, tools=[_backend_tool()]), name="halt-test-agent"
    )
    events = await _collect(adapter, "t-mixed-snapshot")

    final_snapshot = [e for e in events if e.type == EventType.MESSAGES_SNAPSHOT][-1]
    tool_messages = [
        m for m in final_snapshot.messages if getattr(m, "role", None) == "tool"
    ]
    assert [m.tool_call_id for m in tool_messages] == ["native-be"]


@pytest.mark.asyncio
async def test_stop_streaming_after_result_survives_a_frontend_halt_in_the_batch():
    """Guards the interaction that emitting backend results makes reachable.

    ``stop_streaming_after_result`` halts from INSIDE the per-item loop. Before
    this change the loop never ran on a halting batch, so the two halts could
    not meet; now they can, and the run must still emit the backend result and
    terminate cleanly rather than double-halting or stalling.

    Scope: this does NOT test suppression of later items in the batch — with a
    single backend tool there is no later item, and adding one would be flaky
    because batch result ordering is nondeterministic (the same repro emits
    two backend results in either order across runs). Suppression is covered
    deterministically against a mocked stream by Scenario C in
    ``test_parallel_tool_call_handling.py``.
    """
    model = _MixedBatchModel()
    config = StrandsAgentConfig(
        tool_behaviors={"run_script": ToolBehavior(stop_streaming_after_result=True)}
    )
    adapter = StrandsAgent(
        Agent(model=model, tools=[_backend_tool()]), name="halt-test-agent", config=config
    )
    events = await _collect(adapter, "t-mixed-stop-streaming")

    results = [e.tool_call_id for e in events if e.type == EventType.TOOL_CALL_RESULT]
    assert results == ["native-be"]
    assert model.calls == 1
    assert any(e.type == EventType.RUN_FINISHED for e in events)


@pytest.mark.asyncio
async def test_state_from_result_fires_for_a_backend_tool_in_a_halting_batch():
    """Derived state must not be silently dropped by the halt.

    Skipping the tool-result message also skipped ``state_from_result``, so an
    app mapping backend results into shared state lost the update with no error
    anywhere.
    """
    model = _MixedBatchModel()
    config = StrandsAgentConfig(
        tool_behaviors={
            "run_script": ToolBehavior(
                state_from_result=lambda ctx: {"tables": ctx.result_data["tables"]}
            )
        }
    )
    adapter = StrandsAgent(
        Agent(model=model, tools=[_backend_tool()]), name="halt-test-agent", config=config
    )
    events = await _collect(adapter, "t-mixed-state")

    snapshots = [e.snapshot for e in events if e.type == EventType.STATE_SNAPSHOT]
    assert any(s.get("tables") == ["orders", "customers"] for s in snapshots)


def _orphan_tool_uses(transcript: list[dict]) -> list[str]:
    """Apply the provider rule: every ``toolUse`` needs a matching ``toolResult``.

    Bedrock and Anthropic both reject a transcript containing a ``toolUse`` with
    no corresponding ``toolResult``, so this is the check that decides whether
    the next run is servable at all.
    """
    tool_uses: dict[str, str] = {}
    resolved: set[str] = set()
    for message in transcript:
        for block in message.get("content") or []:
            if not isinstance(block, dict):
                continue
            if "toolUse" in block:
                tool_uses[block["toolUse"]["toolUseId"]] = block["toolUse"]["name"]
            elif "toolResult" in block:
                resolved.add(block["toolResult"]["toolUseId"])
    return [name for tid, name in tool_uses.items() if tid not in resolved]


@pytest.mark.asyncio
async def test_event_stream_alone_replays_into_a_servable_transcript():
    """Round-trip: a client that persists from the event stream must be able to
    replay a transcript the model provider will accept.

    This is the failure the other tests cannot see, because it surfaces one run
    LATER and at the provider rather than in our code. With no session manager
    the adapter does ``strands_agent.messages = _build_strands_history(
    input_data.messages)``, and that builder transcribes straight through with
    no orphan handling — so whatever the client persisted becomes the literal
    transcript. If the halting batch dropped the backend result, turn 2 carries
    a ``toolUse`` with no ``toolResult`` and the provider rejects it.

    History here is rebuilt from the emitted MESSAGES_SNAPSHOT rather than
    hand-written, so the test asserts the property that actually matters: the
    event stream carries enough information to reconstruct a valid transcript.
    """
    model = _MixedBatchModel()
    adapter = StrandsAgent(
        Agent(model=model, tools=[_backend_tool()]), name="halt-test-agent"
    )
    tools = [
        Tool(
            name="get_cell",
            description="Read the selected cell",
            parameters={"type": "object", "properties": {}},
        )
    ]

    async def run(thread_id: str, run_id: str, messages: list) -> list:
        run_input = RunAgentInput(
            thread_id=thread_id,
            run_id=run_id,
            parent_run_id=None,
            state={},
            messages=messages,
            tools=tools,
            context=[],
            forwarded_props={},
        )

        async def drive():
            return [event async for event in adapter.run(run_input)]

        return await asyncio.wait_for(drive(), timeout=30)

    # --- Turn 1: the halting mixed batch -------------------------------------
    turn_1 = await run(
        "t-roundtrip", "r-1", [UserMessage(id="u1", role="user", content="What tables?")]
    )

    # --- Rebuild client-side history from the wire, as an event-sourced client
    #     would, then append the result it produced for the frontend tool.
    client_history = list(
        [e for e in turn_1 if e.type == EventType.MESSAGES_SNAPSHOT][-1].messages
    )
    fe_wire_id = next(
        e.tool_call_id
        for e in turn_1
        if e.type == EventType.TOOL_CALL_START and e.tool_call_name == "get_cell"
    )
    client_history.append(
        ToolMessage(
            id="tm-fe",
            role="tool",
            tool_call_id=fe_wire_id,
            content='{"cell": "B4", "value": 42}',
        )
    )

    # --- Turn 2: replay it -----------------------------------------------------
    await run("t-roundtrip", "r-2", client_history)

    transcript = model.seen_messages[-1]
    orphans = _orphan_tool_uses(transcript)
    assert not orphans, (
        f"replayed transcript has toolUse with no toolResult: {orphans} — "
        "the provider rejects this, so turn 2 cannot be served"
    )

    # And the backend result must actually be IN the replayed transcript, so the
    # model can answer from it instead of re-running the expensive tool.
    assert any(
        "orders" in str(block.get("toolResult", ""))
        for message in transcript
        for block in message.get("content") or []
        if isinstance(block, dict)
    ), "backend result absent from the replayed transcript; the model would re-run it"


def _persisted_messages(sm: FileSessionManager, session_id: str) -> list[dict]:
    return [m.message for m in sm.list_messages(session_id, "default")]


@pytest.mark.asyncio
async def test_halted_turn_persists_tool_use_placeholder_and_wire_map(tmp_path):
    """Stopping the loop must not cost the next run's reconcile inputs.

    The reconcile overwrites a persisted placeholder ``toolResult``, keyed via
    the wire->native map on agent state. Both are written before the halt
    latches (``MessageAddedEvent`` drives ``append_message`` AND ``sync_agent``
    — see ``SessionManager.register_hooks``), so halting keeps them. If Strands
    ever stops syncing state on message-added, this test is the tripwire.

    Asserting EXACTLY one persisted ``toolUse`` also pins the other half: a
    drained loop persists the invisible retry calls too, leaving the store with
    several unresolved placeholders the client was never asked about.
    """
    session_id = "s-halt"
    sm = FileSessionManager(session_id=session_id, storage_dir=str(tmp_path))
    model = _ScriptedModel(follow_ups=2, first_turn_tools=("get_cell",))
    adapter = _build(model, StrandsAgentConfig(session_manager_provider=lambda _tid: sm))

    await _collect(adapter, "t-persist")

    messages = _persisted_messages(sm, session_id)
    tool_uses = [
        block["toolUse"]
        for message in messages
        for block in message.get("content") or []
        if isinstance(block, dict) and "toolUse" in block
    ]
    placeholders = [
        block["toolResult"]
        for message in messages
        for block in message.get("content") or []
        if isinstance(block, dict)
        and "toolResult" in block
        and any(
            PROXY_RESULT_PLACEHOLDER in (part.get("text") or "")
            for part in block["toolResult"].get("content") or []
            if isinstance(part, dict)
        )
    ]

    assert [t["name"] for t in tool_uses] == ["get_cell"]
    assert len(placeholders) == 1
    assert placeholders[0]["toolUseId"] == tool_uses[0]["toolUseId"]

    persisted_agent = sm.read_agent(session_id, "default")
    wire_map = persisted_agent.state.get(AG_UI_WIRE_MAP_STATE_KEY) or {}
    assert tool_uses[0]["toolUseId"] in wire_map.values(), (
        "reconcile cannot locate the placeholder without the wire->native map"
    )


@pytest.mark.asyncio
async def test_halted_turn_persists_no_assistant_turn_the_client_never_saw(tmp_path):
    """Draining writes phantom history: the model's post-halt answer lands in
    the session store even though it never reached the wire, so the next turn
    starts from a transcript claiming the question was already answered."""
    session_id = "s-phantom"
    sm = FileSessionManager(session_id=session_id, storage_dir=str(tmp_path))
    model = _ScriptedModel(follow_ups=0, first_turn_tools=("get_cell",))
    adapter = _build(model, StrandsAgentConfig(session_manager_provider=lambda _tid: sm))

    events = await _collect(adapter, "t-phantom")

    emitted_text = [e for e in events if e.type == EventType.TEXT_MESSAGE_CONTENT]
    persisted_text = [
        block["text"]
        for message in _persisted_messages(sm, session_id)
        if message.get("role") == "assistant"
        for block in message.get("content") or []
        if isinstance(block, dict) and "text" in block
    ]

    assert emitted_text == []
    assert persisted_text == [], f"assistant text persisted but never emitted: {persisted_text}"
