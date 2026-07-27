"""Unit tests for the AWS Strands A2UI subagent tool — Python.

Mirrors the TypeScript suite
(integrations/aws-strands/typescript/src/__tests__/a2ui-tool.test.ts), covering
both wiring modes (explicit + auto-injected), message-shape helpers, error
classification, and
the sub-agent streaming translation:

  Explicit wiring: ``get_a2ui_tools(params)`` returns a Strands
  ``AgentTool`` subclass named ``generate_a2ui`` that runs the toolkit recovery
  loop.

  Auto-injection: ``plan_a2ui_injection(...)`` is the pure per-run
  decision — read the runtime ``injectA2UITool`` flag off ``forwarded_props``,
  infer the model from the wrapped agent, resolve the catalog from
  ``input.context``, and decide whether to inject ``generate_a2ui`` (and which
  injected render tool to drop). Returns ``None`` when it must NOT inject.

String literals mirror the shared constants (``GENERATE_A2UI_TOOL_NAME`` from
ag-ui-a2ui-toolkit, ``RENDER_A2UI_TOOL_NAME`` + ``A2UI_SCHEMA_CONTEXT_DESCRIPTION``
from @ag-ui/a2ui-middleware), hardcoded ON PURPOSE: these are cross-package
wire contracts, and a hardcoded copy makes the suite fail if an upstream
constant drifts (importing the constant would hide the drift).
"""

from __future__ import annotations

import asyncio
import json
from unittest.mock import MagicMock

import pytest
from ag_ui.core import Context, EventType, RunAgentInput, Tool, UserMessage
from strands.tools.registry import ToolRegistry

from ag_ui_strands.a2ui_tool import (
    A2UI_STREAM_KEY,
    classify_a2ui_subagent_error,
    get_a2ui_tools,
    is_auto_injected_a2ui_tool,
    plan_a2ui_injection,
    strands_tool_results_to_agui,
    strip_in_flight_tool_call,
)
from ag_ui_strands.agent import StrandsAgent
from ag_ui_strands.config import StrandsAgentConfig

GENERATE_A2UI_TOOL_NAME = "generate_a2ui"
RENDER_A2UI_TOOL_NAME = "render_a2ui"
A2UI_SCHEMA_CONTEXT_DESCRIPTION = (
    "A2UI Component Schema — available components for generating UI surfaces. "
    "Use these component names and properties when creating A2UI operations."
)
A2UI_OPS_KEY = "a2ui_operations"

STUB_MODEL = MagicMock(name="stub-model")
CATALOG = {
    "components": {
        "Row": {"required": ["children"]},
        "HotelCard": {"required": ["name", "rating"]},
    }
}


def _input(forwarded_props=None, context=None, tools=None) -> RunAgentInput:
    return RunAgentInput(
        thread_id="thread-1",
        run_id="run-1",
        state={},
        messages=[],
        tools=tools or [],
        context=context or [],
        forwarded_props=forwarded_props or {},
    )


# ---------------------------------------------------------------------------
# Explicit factory
# ---------------------------------------------------------------------------


def test_get_a2ui_tools_default_name():
    tool = get_a2ui_tools({"model": STUB_MODEL})
    assert tool.tool_name == GENERATE_A2UI_TOOL_NAME


def test_get_a2ui_tools_custom_name():
    tool = get_a2ui_tools({"model": STUB_MODEL, "tool_name": "make_ui"})
    assert tool.tool_name == "make_ui"


# ---------------------------------------------------------------------------
# Auto-inject decision
# ---------------------------------------------------------------------------


def test_injects_when_flag_true_and_model_present():
    plan = plan_a2ui_injection(
        model=STUB_MODEL,
        input=_input(forwarded_props={"injectA2UITool": True}),
        existing_tool_names=[],
    )
    assert plan is not None
    assert plan["tool_name"] == GENERATE_A2UI_TOOL_NAME
    assert RENDER_A2UI_TOOL_NAME in plan["drop_tool_names"]


def test_drops_custom_named_render_tool_when_flag_is_string():
    plan = plan_a2ui_injection(
        model=STUB_MODEL,
        input=_input(forwarded_props={"injectA2UITool": "render_ui_custom"}),
        existing_tool_names=[],
    )
    assert plan is not None
    assert plan["tool_name"] == GENERATE_A2UI_TOOL_NAME
    assert "render_ui_custom" in plan["drop_tool_names"]


def test_skips_and_warns_when_no_model_inferable_orchestrator():
    log = MagicMock()
    plan = plan_a2ui_injection(
        model=None,
        input=_input(forwarded_props={"injectA2UITool": True}),
        existing_tool_names=[],
        log=log,
    )
    assert plan is None
    log.warning.assert_called_once()


def test_no_inject_without_flag_or_override():
    plan = plan_a2ui_injection(
        model=STUB_MODEL,
        input=_input(),
        existing_tool_names=[],
    )
    assert plan is None


def test_backend_override_injects_without_runtime_flag():
    plan = plan_a2ui_injection(
        model=STUB_MODEL,
        input=_input(),
        existing_tool_names=[],
        config={"inject_a2ui_tool": True},
    )
    assert plan is not None
    assert plan["tool_name"] == GENERATE_A2UI_TOOL_NAME


def test_user_prevails_no_double_inject():
    # THE "USER PREVAILS" REQUIREMENT: explicit dev wiring wins.
    plan = plan_a2ui_injection(
        model=STUB_MODEL,
        input=_input(forwarded_props={"injectA2UITool": True}),
        existing_tool_names=[GENERATE_A2UI_TOOL_NAME],
    )
    assert plan is None


def test_ignores_catalog_in_schema_context_entry():
    """Mirrors the LangGraph adapter: a catalog carried in RunAgentInput.context
    is NOT auto-resolved. Only an explicit ``config["catalog"]`` enables
    catalog-aware recovery; otherwise recovery stays structural-only."""
    plan = plan_a2ui_injection(
        model=STUB_MODEL,
        input=_input(
            forwarded_props={"injectA2UITool": True},
            context=[
                Context(
                    description=A2UI_SCHEMA_CONTEXT_DESCRIPTION,
                    value=json.dumps(CATALOG),
                )
            ],
        ),
        existing_tool_names=[],
    )
    assert plan is not None
    assert plan["catalog"] is None


def test_uses_explicit_config_catalog():
    """Explicit backend config catalog is threaded through unchanged."""
    plan = plan_a2ui_injection(
        model=STUB_MODEL,
        input=_input(forwarded_props={"injectA2UITool": True}),
        existing_tool_names=[],
        config={"catalog": CATALOG},
    )
    assert plan is not None
    assert plan["catalog"] == CATALOG


def test_resolves_catalog_id_from_runtime_state():
    """When the host does NOT configure default_catalog_id, the catalog id is
    auto-resolved from run state (native ag-ui.a2ui_schema) and bound — parity
    with the LangGraph adapter, so the host wires nothing."""
    agui_state = {
        "ag-ui": {
            "a2ui_schema": json.dumps({"catalogId": "runtime-cat", "components": []})
        }
    }
    plan = plan_a2ui_injection(
        model=STUB_MODEL,
        input=_input(forwarded_props={"injectA2UITool": True}),
        existing_tool_names=[],
        agui_state=agui_state,
    )
    assert plan is not None
    assert plan["tool"]._cfg["default_catalog_id"] == "runtime-cat"


def test_config_default_catalog_id_overrides_runtime():
    """Explicit backend config wins over the runtime-resolved catalog id."""
    agui_state = {
        "ag-ui": {"a2ui_schema": json.dumps({"catalogId": "runtime-cat"})}
    }
    plan = plan_a2ui_injection(
        model=STUB_MODEL,
        input=_input(forwarded_props={"injectA2UITool": True}),
        existing_tool_names=[],
        config={"default_catalog_id": "config-cat"},
        agui_state=agui_state,
    )
    assert plan is not None
    assert plan["tool"]._cfg["default_catalog_id"] == "config-cat"


def test_runtime_schema_becomes_composition_guide():
    """The proxy-path component schema is bound as the sub-agent
    composition_guide when the host did not supply guidelines."""
    agui_state = {
        "ag-ui": {
            "context": [
                {"description": "A2UI catalog", "value": "- custom-cat\nSchema text"}
            ]
        }
    }
    plan = plan_a2ui_injection(
        model=STUB_MODEL,
        input=_input(forwarded_props={"injectA2UITool": True}),
        existing_tool_names=[],
        agui_state=agui_state,
    )
    assert plan is not None
    assert plan["tool"]._cfg["default_catalog_id"] == "custom-cat"
    assert "custom-cat" in plan["tool"]._cfg["guidelines"]["composition_guide"]


def test_auto_inject_threads_all_config_knobs():
    """plan_a2ui_injection must forward every backend ``config.a2ui`` knob the
    toolkit honors (tool_description / default_surface_id / on_a2ui_attempt),
    not just the model/catalog subset — parity with the dev-wired path."""
    def sentinel(*_a, **_k):
        return None

    plan = plan_a2ui_injection(
        model=STUB_MODEL,
        input=_input(forwarded_props={"injectA2UITool": True}),
        existing_tool_names=[],
        config={
            "tool_description": "custom desc",
            "default_surface_id": "surf-9",
            "default_catalog_id": "cat-9",
            "on_a2ui_attempt": sentinel,
        },
    )
    assert plan is not None
    cfg = plan["tool"]._cfg
    assert cfg["tool_description"] == "custom desc"
    assert cfg["default_surface_id"] == "surf-9"
    assert cfg["default_catalog_id"] == "cat-9"
    assert cfg["on_a2ui_attempt"] is sentinel


def test_plan_threads_agui_state_into_glue():
    """The caller-assembled ``agui_state`` (schema + context under
    state["ag-ui"]) is threaded into the built tool's glue, so the sub-agent
    prompt can carry it — parity with the LangGraph adapter."""
    state = {"ag-ui": {"context": [], "a2ui_schema": "SCHEMA"}}
    plan = plan_a2ui_injection(
        model=STUB_MODEL,
        input=_input(forwarded_props={"injectA2UITool": True}),
        existing_tool_names=[],
        agui_state=state,
    )
    assert plan is not None
    assert plan["tool"]._glue["state"] is state


@pytest.mark.asyncio
async def test_subagent_prompt_carries_ag_ui_schema_and_context(monkeypatch):
    """state["ag-ui"] schema + context reach the sub-agent prompt as the
    '## Available Components' block and context lines — the LangGraph-parity
    fix: without it the sub-agent gets no component list and guesses."""
    import ag_ui_strands.a2ui_tool as mod

    seen = {}

    async def fake_subagent(model, prompt, messages, push, **kwargs):
        seen["prompt"] = prompt
        return {"surfaceId": "s1", "components": [{"id": "root", "component": "Row"}]}

    monkeypatch.setattr(mod, "_stream_render_subagent", fake_subagent)
    tool = get_a2ui_tools(
        {"model": STUB_MODEL},
        glue={
            "state": {
                "ag-ui": {
                    "context": [
                        {"description": "App context", "value": "user on dashboard"}
                    ],
                    "a2ui_schema": json.dumps(CATALOG),
                }
            }
        },
    )
    await _drive_stream(tool)

    prompt = seen["prompt"]
    assert "## Available Components" in prompt
    assert "HotelCard" in prompt  # from CATALOG schema
    assert "## App context" in prompt
    assert "user on dashboard" in prompt


def test_marker_distinguishes_auto_injected_from_dev_wired():
    plan = plan_a2ui_injection(
        model=STUB_MODEL,
        input=_input(forwarded_props={"injectA2UITool": True}),
        existing_tool_names=[],
    )
    assert plan is not None
    assert is_auto_injected_a2ui_tool(plan["tool"]) is True
    # A dev-wired tool carries no marker.
    assert is_auto_injected_a2ui_tool(get_a2ui_tools({"model": STUB_MODEL})) is False


# ---------------------------------------------------------------------------
# Message-shape helpers (Strands python message dicts)
# ---------------------------------------------------------------------------


def test_strip_in_flight_tool_call_drops_trailing_call():
    messages = [
        {"role": "user", "content": [{"text": "compare hotels"}]},
        {
            "role": "assistant",
            "content": [
                {"toolUse": {"name": GENERATE_A2UI_TOOL_NAME, "toolUseId": "t1", "input": {}}}
            ],
        },
    ]
    stripped = strip_in_flight_tool_call(messages, GENERATE_A2UI_TOOL_NAME)
    assert len(stripped) == 1
    assert stripped[0]["role"] == "user"


def test_strip_in_flight_tool_call_keeps_trailing_user_turn():
    messages = [{"role": "user", "content": [{"text": "compare hotels"}]}]
    assert len(strip_in_flight_tool_call(messages, GENERATE_A2UI_TOOL_NAME)) == 1


def test_strands_tool_results_to_agui_reconstructs_a2ui_results():
    envelope = json.dumps({A2UI_OPS_KEY: [{"version": "v0.9"}]})
    messages = [
        {
            "role": "user",
            "content": [
                {
                    "toolResult": {
                        "toolUseId": "tc1",
                        "status": "success",
                        "content": [{"text": envelope}],
                    }
                }
            ],
        }
    ]
    agui = strands_tool_results_to_agui(messages)
    assert len(agui) == 1
    assert agui[0]["role"] == "tool"
    assert agui[0]["tool_call_id"] == "tc1"
    assert A2UI_OPS_KEY in agui[0]["content"]


def test_strands_tool_results_to_agui_handles_json_blocks_and_ignores_non_a2ui():
    # {json} content block form.
    from_json = strands_tool_results_to_agui(
        [
            {
                "role": "user",
                "content": [
                    {
                        "toolResult": {
                            "toolUseId": "tc2",
                            "status": "success",
                            "content": [{"json": {A2UI_OPS_KEY: [{"version": "v0.9"}]}}],
                        }
                    }
                ],
            }
        ]
    )
    assert len(from_json) == 1
    assert A2UI_OPS_KEY in from_json[0]["content"]
    # Non-A2UI tool results are ignored.
    ignored = strands_tool_results_to_agui(
        [
            {
                "role": "user",
                "content": [
                    {
                        "toolResult": {
                            "toolUseId": "tc3",
                            "status": "success",
                            "content": [{"text": "just a weather result"}],
                        }
                    }
                ],
            }
        ]
    )
    assert ignored == []


# ---------------------------------------------------------------------------
# Sub-agent error classification
# ---------------------------------------------------------------------------


def test_classify_rethrows_cancellation_and_programmer_errors():
    assert classify_a2ui_subagent_error(asyncio.CancelledError(), False) == "rethrow"
    assert classify_a2ui_subagent_error(Exception("x"), True) == "rethrow"
    assert classify_a2ui_subagent_error(TypeError("x"), False) == "rethrow"
    assert classify_a2ui_subagent_error(NameError("x"), False) == "rethrow"


def test_classify_treats_model_errors_as_recoverable():
    assert classify_a2ui_subagent_error(Exception("Bedrock 429"), False) == "recoverable"


# ---------------------------------------------------------------------------
# Adapter integration — scripted runs (conventions from
# tests/test_streaming_predict_state.py)
# ---------------------------------------------------------------------------


def _template_agent() -> MagicMock:
    mock = MagicMock()
    mock.model = MagicMock()
    mock.system_prompt = "You are helpful"
    mock.tool_registry.registry = {}
    mock.record_direct_tool_call = True
    # A bare MagicMock auto-creates a truthy `_session_manager`, which would
    # fire the "session_manager will be ignored" warning in every test.
    mock._session_manager = None
    return mock


def _build_agent(thread_id: str, stream_events: list, config=None) -> StrandsAgent:
    agent = StrandsAgent(
        _template_agent(), name="test-agent", config=config or StrandsAgentConfig()
    )
    mock_inner = MagicMock()
    mock_inner.model = MagicMock()
    mock_inner.tool_registry = ToolRegistry()
    mock_inner.session_manager = None
    # Without this a bare MagicMock auto-creates a truthy `_session_manager`,
    # making `_get_strands_session_manager` return it and silently routing every
    # test through the legacy (non-replay) path instead of the default
    # `replay_history_into_strands` one.
    mock_inner._session_manager = None
    mock_inner.messages = []

    async def _stream(_msg):
        for event in stream_events:
            yield event

    mock_inner.stream_async = _stream
    agent._agents_by_thread[thread_id] = mock_inner
    return agent


async def _collect(agent: StrandsAgent, inp: RunAgentInput) -> list:
    return [e async for e in agent.run(inp)]


RENDER_TOOL_INPUT = Tool(
    name=RENDER_A2UI_TOOL_NAME,
    description="render a2ui",
    parameters={"type": "object", "properties": {}},
)


def _msg_input(**overrides) -> RunAgentInput:
    base = dict(
        thread_id="thread-1",
        run_id="run-1",
        state={},
        messages=[UserMessage(id="u1", role="user", content="hi")],
        tools=[],
        context=[],
        forwarded_props={},
    )
    base.update(overrides)
    return RunAgentInput(**base)


@pytest.mark.asyncio
async def test_auto_inject_registers_generate_and_drops_render_across_turns():
    """F1 regression: turn 2 on a cached thread must re-drop the re-synced
    render_a2ui and keep exactly one generate_a2ui (our own marked tool is
    refreshed, never treated as dev-wired)."""
    agent = _build_agent("thread-1", [])
    registry = agent._agents_by_thread["thread-1"].tool_registry

    inp = _msg_input(
        forwarded_props={"injectA2UITool": True}, tools=[RENDER_TOOL_INPUT]
    )
    await _collect(agent, inp)
    names = set(registry.registry.keys())
    assert GENERATE_A2UI_TOOL_NAME in names
    assert RENDER_A2UI_TOOL_NAME not in names
    tool_turn1 = registry.registry[GENERATE_A2UI_TOOL_NAME]
    # The dropped render tool must also leave the proxy bookkeeping.
    assert RENDER_A2UI_TOOL_NAME not in agent._proxy_tool_names_by_thread["thread-1"]

    # Turn 2: syncProxyTools re-adds render_a2ui from input.tools; the hook
    # must drop it again and refresh (not duplicate) generate_a2ui.
    await _collect(agent, inp)
    names = set(registry.registry.keys())
    assert GENERATE_A2UI_TOOL_NAME in names
    assert RENDER_A2UI_TOOL_NAME not in names
    # "Refresh" means a REBUILT tool carrying turn-2 glue — reusing the turn-1
    # object would resolve `intent:"update"` priors against stale history.
    assert registry.registry[GENERATE_A2UI_TOOL_NAME] is not tool_turn1


@pytest.mark.asyncio
async def test_tool_stream_a2ui_payloads_become_inner_tool_call_events():
    """The generate_a2ui tool yields A2UI_STREAM_KEY payloads; the adapter must
    re-emit them as synthetic inner TOOL_CALL_START/ARGS/END so the middleware
    can drive the building skeleton + progressive paint."""
    events = [
        {
            "tool_stream_event": {
                "data": {
                    A2UI_STREAM_KEY: {
                        "kind": "start",
                        "tool_call_id": "r1",
                        "tool_call_name": RENDER_A2UI_TOOL_NAME,
                    }
                }
            }
        },
        {
            "tool_stream_event": {
                "data": {A2UI_STREAM_KEY: {"kind": "args", "tool_call_id": "r1", "delta": '{"surfaceId":'}}
            }
        },
        {
            "tool_stream_event": {
                "data": {A2UI_STREAM_KEY: {"kind": "args", "tool_call_id": "r1", "delta": '"s1"}'}}
            }
        },
        {
            "tool_stream_event": {
                "data": {A2UI_STREAM_KEY: {"kind": "end", "tool_call_id": "r1"}}
            }
        },
    ]
    agent = _build_agent("thread-1", events)
    out = await _collect(agent, _msg_input())

    starts = [
        e
        for e in out
        if e.type == EventType.TOOL_CALL_START
        and getattr(e, "tool_call_name", None) == RENDER_A2UI_TOOL_NAME
    ]
    assert len(starts) == 1
    assert starts[0].tool_call_id == "r1"

    deltas = [
        getattr(e, "delta", "")
        for e in out
        if e.type == EventType.TOOL_CALL_ARGS and getattr(e, "tool_call_id", None) == "r1"
    ]
    assert "".join(deltas) == '{"surfaceId":"s1"}'

    assert any(
        e.type == EventType.TOOL_CALL_END and getattr(e, "tool_call_id", None) == "r1"
        for e in out
    )


# ---------------------------------------------------------------------------
# _GenerateA2UITool.stream() — the REAL executor + queue drain path
# ---------------------------------------------------------------------------


def _tool_use(args=None):
    return {"name": GENERATE_A2UI_TOOL_NAME, "toolUseId": "tu-1", "input": args or {}}


async def _drive_stream(tool, invocation_state=None):
    events = []
    async for ev in tool.stream(_tool_use(), invocation_state or {}):
        events.append(ev)
    return events


@pytest.mark.asyncio
async def test_stream_drains_all_pushed_events_through_executor(monkeypatch):
    """Drives the real worker-thread + queue drain path (not the mocked
    adapter loop): every pushed payload — including the terminal `end` pushed
    just before the recovery future resolves — must reach the wire, and the
    final ToolResultEvent must carry the envelope."""
    import ag_ui_strands.a2ui_tool as mod

    async def fake_subagent(model, prompt, messages, push, **kwargs):
        push({"kind": "start", "tool_call_id": "r1", "tool_call_name": "render_a2ui"})
        for i in range(5):
            push({"kind": "args", "tool_call_id": "r1", "delta": f"chunk{i}"})
        push({"kind": "end", "tool_call_id": "r1"})
        return {"surfaceId": "s1", "components": [{"id": "root", "component": "Row"}]}

    monkeypatch.setattr(mod, "_stream_render_subagent", fake_subagent)
    tool = get_a2ui_tools({"model": STUB_MODEL})
    events = await _drive_stream(tool)

    payloads = [
        ev["tool_stream_event"]["data"][A2UI_STREAM_KEY]
        for ev in events
        if isinstance(ev, dict) and "tool_stream_event" in ev
    ]
    kinds = [p["kind"] for p in payloads]
    assert kinds[0] == "start"
    assert kinds.count("args") == 5
    assert kinds[-1] == "end", "terminal end push must not be dropped"

    # Final event is the ToolResultEvent wrapper; its text carries the envelope.
    text = str(events[-1])
    assert A2UI_OPS_KEY in text


@pytest.mark.asyncio
async def test_generate_tool_single_forced_render_call_and_returns_envelope():
    """Regression for the dynamic-A2UI hang: driving the tool's real stream()
    against a fake model, the sub-agent must fire EXACTLY ONE forced render_a2ui
    model call (no agentic continuation that would never settle), and the tool
    must yield the committed envelope so the outer Strands loop can emit
    RUN_FINISHED instead of hanging on a still-Running generate_a2ui."""
    calls: list = []

    class FakeModel:
        async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs):
            calls.append(kwargs.get("tool_choice"))
            yield _block_start()
            yield _block_delta(
                '{"surfaceId": "s1", "components": [{"id": "root", "component": "Row"}]}'
            )
            yield _BLOCK_STOP

    tool = get_a2ui_tools({"model": FakeModel()})
    events = await _drive_stream(tool)

    # Single forced turn — the model is called once, forced to render_a2ui.
    assert calls == [{"tool": {"name": RENDER_A2UI_TOOL_NAME}}]
    # The committed envelope reaches the outer loop (the run can finish).
    assert A2UI_OPS_KEY in str(events[-1])


@pytest.mark.asyncio
async def test_stream_update_intent_without_prior_returns_error_envelope(monkeypatch):
    """intent='update' with an unknown surface short-circuits to an error
    envelope (no recovery loop, no sub-agent call)."""
    import ag_ui_strands.a2ui_tool as mod

    async def fail_subagent(*a, **k):  # pragma: no cover — must not be called
        raise AssertionError("sub-agent must not run on prep error")

    monkeypatch.setattr(mod, "_stream_render_subagent", fail_subagent)
    tool = get_a2ui_tools({"model": STUB_MODEL})
    events = []
    async for ev in tool.stream(
        {
            "name": GENERATE_A2UI_TOOL_NAME,
            "toolUseId": "tu-2",
            "input": {"intent": "update", "target_surface_id": "nope"},
        },
        {},
    ):
        events.append(ev)
    text = str(events[-1])
    assert "error" in text
    assert A2UI_OPS_KEY not in text


@pytest.mark.asyncio
async def test_stream_recoverable_subagent_error_yields_hard_failure(monkeypatch):
    """A recoverable sub-agent error per attempt exhausts the recovery loop and
    yields the structured hard-failure envelope — never a crash."""
    import ag_ui_strands.a2ui_tool as mod

    async def boom(model, prompt, messages, push, **kwargs):
        raise RuntimeError("model 429")

    monkeypatch.setattr(mod, "_stream_render_subagent", boom)
    tool = get_a2ui_tools({"model": STUB_MODEL})
    events = await _drive_stream(tool)
    text = str(events[-1])
    assert "a2ui_recovery_exhausted" in text


@pytest.mark.asyncio
async def test_stream_programmer_error_propagates(monkeypatch):
    """TypeError from the sub-agent path is an adapter bug — it must unwind,
    not masquerade as a failed attempt."""
    import ag_ui_strands.a2ui_tool as mod

    async def bug(model, prompt, messages, push, **kwargs):
        raise TypeError("adapter bug")

    monkeypatch.setattr(mod, "_stream_render_subagent", bug)
    tool = get_a2ui_tools({"model": STUB_MODEL})
    with pytest.raises(TypeError):
        await _drive_stream(tool)


# ---------------------------------------------------------------------------
# _stream_render_subagent — the REAL streaming translation (faked model.stream)
# ---------------------------------------------------------------------------


def _block_start(tool_use_id="r1", name=RENDER_A2UI_TOOL_NAME):
    return {"contentBlockStart": {"start": {"toolUse": {"name": name, "toolUseId": tool_use_id}}}}


def _block_delta(fragment):
    return {"contentBlockDelta": {"delta": {"toolUse": {"input": fragment}}}}


_BLOCK_STOP = {"contentBlockStop": {}}


def _fake_stream_model(events):
    """A minimal Strands ``Model`` stand-in whose ``stream`` replays raw
    ``StreamEvent`` dicts. ``_stream_render_subagent`` now drives the model
    DIRECTLY (single forced render_a2ui turn), so the fakes mirror the model
    streaming protocol rather than the old ``Agent`` loop."""

    class FakeModel:
        async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs):
            # The forced single turn must request exactly the render tool.
            assert kwargs.get("tool_choice") == {"tool": {"name": RENDER_A2UI_TOOL_NAME}}
            for ev in events:
                yield ev

    return FakeModel()


@pytest.mark.asyncio
async def test_render_subagent_streams_arg_fragments_as_deltas():
    """Direct coverage of ``_stream_render_subagent``: a forced render_a2ui model
    call's streamed toolUse input fragments become start + incremental args
    deltas + end (all under the live toolUseId), and the accumulated JSON is
    captured for the recovery loop."""
    import ag_ui_strands.a2ui_tool as mod

    events = [
        _block_start(),
        _block_delta('{"surf'),
        {"unrelated_event": True},
        _block_delta('aceId": "s1"}'),
        _BLOCK_STOP,
    ]
    pushed = []
    captured = await mod._stream_render_subagent(
        _fake_stream_model(events), "prompt", [], pushed.append
    )

    kinds = [p["kind"] for p in pushed]
    assert kinds == ["start", "args", "args", "end"]
    assert (
        "".join(p["delta"] for p in pushed if p["kind"] == "args")
        == '{"surfaceId": "s1"}'
    )
    assert all(p["tool_call_id"] == "r1" for p in pushed)
    assert captured == {"surfaceId": "s1"}


@pytest.mark.asyncio
async def test_render_subagent_single_chunk_input_is_captured():
    """A provider that delivers the whole render_a2ui args in ONE toolUse delta
    still emits start + one args delta + end, and parses the captured object."""
    import ag_ui_strands.a2ui_tool as mod

    full = '{"surfaceId": "s1", "components": [{"id": "root", "component": "Row"}]}'
    events = [_block_start(), _block_delta(full), _BLOCK_STOP]
    pushed = []
    captured = await mod._stream_render_subagent(
        _fake_stream_model(events), "prompt", [], pushed.append
    )

    assert [p["kind"] for p in pushed] == ["start", "args", "end"]
    assert captured == {
        "surfaceId": "s1",
        "components": [{"id": "root", "component": "Row"}],
    }


@pytest.mark.asyncio
async def test_render_subagent_no_render_call_returns_none():
    """A turn that emits no render_a2ui block (e.g. text only) captures nothing
    and pushes nothing — the recovery loop records a no-call attempt."""
    import ag_ui_strands.a2ui_tool as mod

    events = [
        {"contentBlockStart": {"start": {"text": {}}}},
        {"contentBlockDelta": {"delta": {"text": "hi"}}},
        _BLOCK_STOP,
    ]
    pushed = []
    captured = await mod._stream_render_subagent(
        _fake_stream_model(events), "prompt", [], pushed.append
    )
    assert pushed == []
    assert captured is None


@pytest.mark.asyncio
async def test_render_subagent_stamps_catalog_id_into_streamed_args():
    """The host catalog id is spliced into the FIRST streamed chunk (after the
    opening brace) so the middleware's progressive paint binds to the real
    catalog instead of falling back to basic. The model never emits catalogId,
    and the splice must NOT contaminate the captured args."""
    import ag_ui_strands.a2ui_tool as mod

    events = [_block_start(), _block_delta('{"surf'), _block_delta('aceId": "s1"}'), _BLOCK_STOP]
    pushed = []
    captured = await mod._stream_render_subagent(
        _fake_stream_model(events), "prompt", [], pushed.append, catalog_id="my-cat"
    )
    args_str = "".join(p["delta"] for p in pushed if p["kind"] == "args")
    # Streamed args are valid JSON carrying the stamped id.
    assert json.loads(args_str) == {"catalogId": "my-cat", "surfaceId": "s1"}
    # The committed args stay the model's own (envelope builder stamps the id).
    assert captured == {"surfaceId": "s1"}


@pytest.mark.asyncio
async def test_render_subagent_stamps_catalog_id_in_single_chunk():
    """The single-chunk shape also gets the catalog id spliced into the one
    emitted delta, while the captured object stays catalogId-free."""
    import ag_ui_strands.a2ui_tool as mod

    full = '{"surfaceId": "s1", "components": [{"id": "root", "component": "Row"}]}'
    events = [_block_start(), _block_delta(full), _BLOCK_STOP]
    pushed = []
    captured = await mod._stream_render_subagent(
        _fake_stream_model(events), "prompt", [], pushed.append, catalog_id="my-cat"
    )
    delta = json.loads("".join(p["delta"] for p in pushed if p["kind"] == "args"))
    assert delta["catalogId"] == "my-cat"
    assert delta["surfaceId"] == "s1"
    assert "catalogId" not in captured


@pytest.mark.asyncio
async def test_auto_inject_failure_never_crashes_run(monkeypatch):
    """The auto-inject hook is best-effort by contract: a planner bug must log and
    leave the turn running without A2UI — never escape after RUN_STARTED."""
    import ag_ui_strands.agent as agent_mod

    def boom(**_kwargs):
        raise RuntimeError("planner exploded")

    monkeypatch.setattr(agent_mod, "plan_a2ui_injection", boom)
    agent = _build_agent("thread-1", [])
    out = await _collect(
        agent,
        _msg_input(forwarded_props={"injectA2UITool": True}, tools=[RENDER_TOOL_INPUT]),
    )
    types = [e.type for e in out]
    assert EventType.RUN_STARTED in types
    assert EventType.RUN_FINISHED in types
    assert EventType.RUN_ERROR not in types


def test_classify_rethrows_non_exception_base_exceptions():
    """SystemExit/KeyboardInterrupt signal shutdown — the recovery loop must
    not retry through them."""
    assert classify_a2ui_subagent_error(SystemExit(), False) == "rethrow"
    assert classify_a2ui_subagent_error(KeyboardInterrupt(), False) == "rethrow"
    # Genuine model/network errors remain recoverable.
    assert classify_a2ui_subagent_error(RuntimeError("429"), False) == "recoverable"


def test_explicit_runtime_false_disables_backend_override():
    """Nullish (not falsy) fallback, mirroring the TS adapter's `??`: a runtime
    that explicitly forwards injectA2UITool=False wins over a backend opt-in."""
    plan = plan_a2ui_injection(
        model=STUB_MODEL,
        input=_input(forwarded_props={"injectA2UITool": False}),
        existing_tool_names=[],
        config={"inject_a2ui_tool": True},
    )
    assert plan is None


@pytest.mark.asyncio
async def test_stream_update_intent_reuses_prior_surface(monkeypatch):
    """The auto-inject glue's purpose: `intent:"update"` resolves the prior surface
    from glue agui_messages and the envelope reconciles in place — no
    createSurface op (v0.9 forbids re-creating an existing surface id)."""
    import ag_ui_strands.a2ui_tool as mod

    prior_envelope = json.dumps(
        {
            A2UI_OPS_KEY: [
                {
                    "createSurface": {
                        "surfaceId": "s1",
                        "catalogId": "https://example.com/cat.json",
                    }
                },
                {
                    "updateComponents": {
                        "surfaceId": "s1",
                        "components": [{"id": "root", "component": "Row"}],
                    }
                },
            ]
        }
    )

    async def fake_subagent(model, prompt, messages, push, **kwargs):
        return {"components": [{"id": "root", "component": "Column"}], "data": {}}

    monkeypatch.setattr(mod, "_stream_render_subagent", fake_subagent)
    tool = get_a2ui_tools(
        {"model": STUB_MODEL},
        glue={"agui_messages": [{"role": "tool", "content": prior_envelope}]},
    )
    events = []
    async for ev in tool.stream(
        {
            "name": GENERATE_A2UI_TOOL_NAME,
            "toolUseId": "tu-up",
            "input": {"intent": "update", "target_surface_id": "s1"},
        },
        {},
    ):
        events.append(ev)

    text = str(events[-1])
    assert A2UI_OPS_KEY in text
    assert "updateComponents" in text
    assert "createSurface" not in text
    assert '\\"surfaceId\\": \\"s1\\"' in text or '"surfaceId": "s1"' in text


@pytest.mark.asyncio
async def test_stream_abandonment_stops_further_recovery_attempts(
    monkeypatch, caplog
):
    """Closing the stream mid-run (client disconnect) sets the disconnect
    flag: the recovery loop must not fire further sub-agent attempts for a
    consumer that's gone — and the intentional abort must not be logged as a
    recovery failure."""
    import threading as _threading

    import ag_ui_strands.a2ui_tool as mod

    attempts: list[int] = []
    gate = _threading.Event()

    async def fake_subagent(model, prompt, messages, push, **kwargs):
        attempts.append(1)
        push(
            {
                "kind": "start",
                "tool_call_id": f"r{len(attempts)}",
                "tool_call_name": RENDER_A2UI_TOOL_NAME,
            }
        )
        gate.wait(timeout=5)  # hold the attempt open until the test closes
        return None  # "no tool call" -> the loop would normally retry

    monkeypatch.setattr(mod, "_stream_render_subagent", fake_subagent)
    tool = get_a2ui_tools({"model": STUB_MODEL})

    agen = tool.stream(_tool_use(), {})
    await agen.__anext__()  # first pushed event reached the wire
    await agen.aclose()  # consumer disconnects mid-drain
    gate.set()  # let attempt 1 finish in the worker

    # Give the executor time to (wrongly) start attempt 2 if the disconnect
    # flag were broken.
    await asyncio.sleep(0.4)
    assert len(attempts) == 1, "no further attempts after consumer disconnect"
    # The deliberate between-attempt CancelledError lands on the future as a
    # stored exception (FINISHED, not CANCELLED) — the abandoned-result
    # consumer must recognize it as intentional, not warn about it.
    # (caplog captures at level 0 by default; the explicit filter below keys
    # off the message, so no at_level scoping is needed.)
    assert not [
        r for r in caplog.records if "A2UI recovery loop failed" in r.getMessage()
    ], "intentional disconnect abort must not be logged as a failure"


@pytest.mark.asyncio
async def test_no_flag_turn_removes_stale_auto_injected_tool():
    """Turn N+1 WITHOUT the runtime flag must remove turn N's auto-injected
    generate_a2ui (the sweep runs regardless of whether a new plan injects)."""
    agent = _build_agent("thread-1", [])
    registry = agent._agents_by_thread["thread-1"].tool_registry

    await _collect(
        agent,
        _msg_input(forwarded_props={"injectA2UITool": True}, tools=[RENDER_TOOL_INPUT]),
    )
    assert GENERATE_A2UI_TOOL_NAME in registry.registry

    # Flag gone on the next turn: our marked tool must not linger.
    await _collect(agent, _msg_input(forwarded_props={}, tools=[]))
    assert GENERATE_A2UI_TOOL_NAME not in registry.registry


@pytest.mark.asyncio
async def test_stream_update_intent_with_pydantic_glue_messages(monkeypatch):
    """Auto-injection passes pydantic message objects (not dicts) as glue — the prior
    surface must still resolve. Locks the object-shape contract against a
    dict-only toolkit refactor."""
    from ag_ui.core import ToolMessage

    import ag_ui_strands.a2ui_tool as mod

    prior_envelope = json.dumps(
        {
            A2UI_OPS_KEY: [
                {"createSurface": {"surfaceId": "s1", "catalogId": "cat-1"}},
                {
                    "updateComponents": {
                        "surfaceId": "s1",
                        "components": [{"id": "root", "component": "Row"}],
                    }
                },
            ]
        }
    )

    async def fake_subagent(model, prompt, messages, push, **kwargs):
        return {"components": [{"id": "root", "component": "Column"}], "data": {}}

    monkeypatch.setattr(mod, "_stream_render_subagent", fake_subagent)
    tool = get_a2ui_tools(
        {"model": STUB_MODEL},
        glue={
            "agui_messages": [
                ToolMessage(
                    id="t1", role="tool", content=prior_envelope, tool_call_id="tc1"
                )
            ]
        },
    )
    events = []
    async for ev in tool.stream(
        {
            "name": GENERATE_A2UI_TOOL_NAME,
            "toolUseId": "tu-up2",
            "input": {"intent": "update", "target_surface_id": "s1"},
        },
        {},
    ):
        events.append(ev)

    text = str(events[-1])
    assert "updateComponents" in text
    assert "createSurface" not in text


def test_get_a2ui_tools_requires_model():
    """Explicit wiring without a model would silently bind Strands' default Bedrock
    model — fail loud instead (the TS factory enforces this in the types)."""
    with pytest.raises(ValueError, match="model"):
        get_a2ui_tools({})


@pytest.mark.asyncio
async def test_render_subagent_no_block_stop_still_closes_and_captures():
    """A provider that ends the message without a per-block contentBlockStop
    must still close the live synthetic call and capture the accumulated args,
    so the middleware sees the end and the recovery loop gets the surface."""
    import ag_ui_strands.a2ui_tool as mod

    events = [_block_start(), _block_delta('{"surfaceId": "s1"}')]  # no stop
    pushed = []
    captured = await mod._stream_render_subagent(
        _fake_stream_model(events), "prompt", [], pushed.append
    )
    assert [p["kind"] for p in pushed] == ["start", "args", "end"]
    assert pushed[-1]["tool_call_id"] == "r1"
    assert captured == {"surfaceId": "s1"}


@pytest.mark.asyncio
async def test_render_subagent_midstream_error_closes_live_call():
    """A model stream dying mid-call (429, network drop) must close the live
    synthetic call before re-raising — an unclosed inner TOOL_CALL_START is a
    wire-protocol violation and the next recovery attempt would open a fresh
    call on top."""
    import ag_ui_strands.a2ui_tool as mod

    class FakeModel:
        async def stream(self, messages, **kwargs):
            yield _block_start()
            yield _block_delta('{"surf')
            raise RuntimeError("model 429")

    pushed = []
    with pytest.raises(RuntimeError):
        await mod._stream_render_subagent(FakeModel(), "prompt", [], pushed.append)

    assert [p["kind"] for p in pushed] == ["start", "args", "end"]
    assert pushed[-1]["tool_call_id"] == "r1"


@pytest.mark.asyncio
async def test_render_subagent_second_block_closes_first():
    """A second render block with a distinct toolUseId must close the first and
    reset the delta accumulator (no cross-call mis-attribution). The forced
    single tool emits one block in practice; this guards the close-on-restart
    invariant regardless of provider quirks."""
    import ag_ui_strands.a2ui_tool as mod

    events = [
        _block_start("r1"),
        _block_delta('{"a": 1}'),
        _block_start("r2"),
        _block_delta('{"b'),
    ]
    pushed = []
    await mod._stream_render_subagent(
        _fake_stream_model(events), "prompt", [], pushed.append
    )

    assert [(p["kind"], p["tool_call_id"]) for p in pushed] == [
        ("start", "r1"),
        ("args", "r1"),
        ("end", "r1"),
        ("start", "r2"),
        ("args", "r2"),
        ("end", "r2"),
    ]
    # Delta accumulator reset: r2's delta is its full prefix, not a slice
    # against r1's length.
    assert pushed[4]["delta"] == '{"b'


@pytest.mark.asyncio
async def test_stream_non_dict_glue_state_degrades(monkeypatch):
    """A truthy non-dict glue state must degrade to empty state — generation
    proceeds rather than crashing before the recovery loop engages."""
    import ag_ui_strands.a2ui_tool as mod

    async def fake_subagent(model, prompt, messages, push, **kwargs):
        return {"components": [{"id": "root", "component": "Row"}], "data": {}}

    monkeypatch.setattr(mod, "_stream_render_subagent", fake_subagent)
    tool = get_a2ui_tools(
        {"model": STUB_MODEL}, glue={"state": "not-a-dict", "agui_messages": []}
    )
    events = await _drive_stream(tool)
    assert A2UI_OPS_KEY in str(events[-1])


def test_snake_case_recovery_key_warns(caplog):
    """snake_case recovery keys are silently ignored by the camelCase toolkit
    contract — the factory must leave a breadcrumb."""
    import logging

    with caplog.at_level(logging.WARNING, logger="ag_ui_strands"):
        get_a2ui_tools({"model": STUB_MODEL, "recovery": {"max_attempts": 5}})
    assert any("max_attempts" in r.getMessage() for r in caplog.records)


@pytest.mark.asyncio
async def test_stream_update_intent_finds_same_run_surface(monkeypatch):
    """The auto-inject glue snapshots run-start history — a surface created EARLIER
    IN THIS SAME RUN exists only in live Strands history. The glue+derived
    merge must resolve it (a create-then-update turn must not error for a
    surface visibly on screen)."""
    import ag_ui_strands.a2ui_tool as mod

    prior_envelope = json.dumps(
        {
            A2UI_OPS_KEY: [
                {"createSurface": {"surfaceId": "s1", "catalogId": "c"}},
                {
                    "updateComponents": {
                        "surfaceId": "s1",
                        "components": [{"id": "root", "component": "Row"}],
                    }
                },
            ]
        }
    )

    async def fake_subagent(model, prompt, messages, push, **kwargs):
        return {"components": [{"id": "root", "component": "Column"}], "data": {}}

    monkeypatch.setattr(mod, "_stream_render_subagent", fake_subagent)
    # Glue present but EMPTY (run-start snapshot has no envelope); the
    # prior surface lives only in the calling agent's live message history.
    tool = get_a2ui_tools({"model": STUB_MODEL}, glue={"agui_messages": []})
    live_agent = MagicMock()
    live_agent.messages = [
        {
            "role": "user",
            "content": [
                {
                    "toolResult": {
                        "toolUseId": "t1",
                        "status": "success",
                        "content": [{"text": prior_envelope}],
                    }
                }
            ],
        }
    ]
    events = []
    async for ev in tool.stream(
        {
            "name": GENERATE_A2UI_TOOL_NAME,
            "toolUseId": "tu-sr",
            "input": {"intent": "update", "target_surface_id": "s1"},
        },
        {"agent": live_agent},
    ):
        events.append(ev)

    text = str(events[-1])
    assert "updateComponents" in text
    assert "createSurface" not in text


# ---------------------------------------------------------------------------
# End-to-end: the REAL Strands agent loop completes the dynamic-A2UI flow
# (run-level regression for the hang — generate_a2ui returns + RUN_FINISHED).
# ---------------------------------------------------------------------------

from strands import Agent as StrandsAgentCore
from strands.models.model import Model as StrandsModel


def _tool_use_chunks(name, tool_use_id, args_json):
    return [
        {"messageStart": {"role": "assistant"}},
        {"contentBlockStart": {"start": {"toolUse": {"name": name, "toolUseId": tool_use_id}}}},
        {"contentBlockDelta": {"delta": {"toolUse": {"input": args_json}}}},
        {"contentBlockStop": {}},
        {"messageStop": {"stopReason": "tool_use"}},
    ]


def _text_chunks(text):
    return [
        {"messageStart": {"role": "assistant"}},
        {"contentBlockDelta": {"delta": {"text": text}}},
        {"contentBlockStop": {}},
        {"messageStop": {"stopReason": "end_turn"}},
    ]


class _DynamicA2UIFakeModel(StrandsModel):
    """Scripts the full dynamic-A2UI conversation across the OUTER Strands agent
    loop AND the inner forced render turn, so an end-to-end run exercises the
    real event loop (not a stubbed stream_async). The forced render turn (the
    sub-agent) is identified by its tool_choice; the outer turn calls
    generate_a2ui first, then narrates once its result is in history."""

    def __init__(self):
        self.render_calls = 0
        self.outer_calls = 0

    def get_config(self):
        return {}

    def update_config(self, **kwargs):
        pass

    async def structured_output(self, output_model, prompt=None, system_prompt=None, **kwargs):
        raise NotImplementedError
        yield  # pragma: no cover — make this an async generator

    async def stream(
        self, messages, tool_specs=None, system_prompt=None, *, tool_choice=None, **kwargs
    ):
        # Inner forced render turn (the generate_a2ui sub-agent).
        if tool_choice == {"tool": {"name": RENDER_A2UI_TOOL_NAME}}:
            self.render_calls += 1
            for ch in _tool_use_chunks(
                RENDER_A2UI_TOOL_NAME,
                "render-1",
                '{"surfaceId": "s1", "components": [{"id": "root", "component": "Row"}], "data": {}}',
            ):
                yield ch
            return

        # Outer agent turn. Narrate once generate_a2ui already ran (its toolUse
        # is in history); else call generate_a2ui. The outer_calls guard keeps
        # the loop terminating even if detection drifts.
        self.outer_calls += 1
        already_generated = any(
            isinstance(m, dict)
            and m.get("role") == "assistant"
            and any(
                isinstance(b, dict)
                and (b.get("toolUse") or {}).get("name") == GENERATE_A2UI_TOOL_NAME
                for b in (m.get("content") or [])
            )
            for m in messages
        )
        if already_generated or self.outer_calls >= 2:
            for ch in _text_chunks("Here is your sales dashboard."):
                yield ch
        else:
            for ch in _tool_use_chunks(GENERATE_A2UI_TOOL_NAME, "gen-1", '{"intent": "create"}'):
                yield ch


@pytest.mark.asyncio
async def test_end_to_end_dynamic_a2ui_run_emits_run_finished():
    """End-to-end through the REAL Strands agent loop: an auto-injected
    generate_a2ui call paints an A2UI surface (render_a2ui streams), its
    envelope returns to the outer loop as a TOOL_CALL_RESULT, the agent
    narrates, and the run emits RUN_FINISHED — instead of hanging on a
    still-Running generate_a2ui. Run-level regression for the dynamic-A2UI hang."""
    model = _DynamicA2UIFakeModel()
    core = StrandsAgentCore(model=model, system_prompt="You render UIs.", tools=[])
    agent = StrandsAgent(core, name="strands-e2e", config=StrandsAgentConfig())

    inp = _msg_input(
        forwarded_props={"injectA2UITool": True},
        tools=[RENDER_TOOL_INPUT],
        messages=[UserMessage(id="u1", role="user", content="Show my sales dashboard")],
    )
    events = await _collect(agent, inp)
    types = [e.type for e in events]

    # generate_a2ui was auto-injected, called, and its result returned to the loop.
    assert any(
        e.type == EventType.TOOL_CALL_START
        and getattr(e, "tool_call_name", None) == GENERATE_A2UI_TOOL_NAME
        for e in events
    )
    assert EventType.TOOL_CALL_RESULT in types
    # The A2UI surface painted (inner render_a2ui streamed as synthetic events).
    assert any(
        e.type == EventType.TOOL_CALL_START
        and getattr(e, "tool_call_name", None) == RENDER_A2UI_TOOL_NAME
        for e in events
    )
    # The agent narrated and the run COMPLETED (no hang, no error).
    assert EventType.TEXT_MESSAGE_CONTENT in types
    assert EventType.RUN_FINISHED in types
    assert EventType.RUN_ERROR not in types
    # Exactly one forced render turn — no agentic continuation in the sub-agent.
    assert model.render_calls == 1
    # Outer loop: one generate call + one narration.
    assert model.outer_calls == 2
