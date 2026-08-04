"""Tests for the CrewAI A2UI subagent tool.

Covers the four pillars:
- auto-injection with opt-out (``plan_a2ui_injection`` / the endpoint state lift),
- subagent-based generation (``A2UITool.run`` driving a forced render_a2ui call),
- progressive streaming (inner ``render_a2ui`` chunks emitted on the wire),
- error recovery (validate -> retry through the shared toolkit loop).
"""

import json

import pytest

from ag_ui.core import Context, RunAgentInput
from ag_ui_a2ui_toolkit import (
    A2UI_OPERATIONS_KEY,
    A2UI_SCHEMA_CONTEXT_DESCRIPTION,
    BASIC_CATALOG_ID,
)

from ag_ui_crewai import a2ui_tool as a2
from ag_ui_crewai import endpoint as ep


# ---------------------------------------------------------------------------
# Fakes for a streamed litellm render_a2ui completion
# ---------------------------------------------------------------------------


class _FakeFn:
    def __init__(self, arguments):
        self._d = {"arguments": arguments}

    def __getitem__(self, key):
        return self._d[key]


class _FakeToolCall:
    def __init__(self, call_id, arguments):
        self.id = call_id
        self.function = _FakeFn(arguments)


def _make_fake_acompletion(arg_scripts, *, frag_size=12):
    """Return an ``acompletion`` stand-in that streams ``render_a2ui`` args.

    ``arg_scripts`` is one full JSON arg string per sub-agent call (the recovery
    loop invokes it once per attempt). ``calls`` records the invocation count.
    A ``None`` script means "emit no tool call" (models the no-render case).
    """
    calls = {"n": 0}

    async def fake_acompletion(**kwargs):  # noqa: ANN001 - test double
        idx = calls["n"]
        calls["n"] += 1
        full = arg_scripts[idx]

        async def gen():
            if full is not None:
                frags = [full[i : i + frag_size] for i in range(0, len(full), frag_size)] or [""]
                for j, frag in enumerate(frags):
                    tc = _FakeToolCall("call-%d" % idx if j == 0 else None, frag)
                    yield {"choices": [{"delta": {"tool_calls": [tc]}, "finish_reason": None}]}
            yield {"choices": [{"delta": {"tool_calls": None}, "finish_reason": "tool_calls"}]}

        return gen()

    return fake_acompletion, calls


class _RecordingBus:
    """Captures ``crewai_event_bus.emit(source, event)`` calls."""

    def __init__(self):
        self.events = []

    def emit(self, source, event):
        self.events.append(event)


VALID_ARGS = json.dumps(
    {"surfaceId": "prod", "components": [{"id": "root", "component": "Text", "text": "Hi"}]}
)
# No component has id "root" -> structural validation fails -> recovery retries.
INVALID_ARGS = json.dumps(
    {"surfaceId": "prod", "components": [{"id": "x", "component": "Text", "text": "Hi"}]}
)


# ---------------------------------------------------------------------------
# _normalize_model
# ---------------------------------------------------------------------------


def test_normalize_model_str_dict_object_and_invalid():
    assert a2._normalize_model("openai/gpt-4o") == {"model": "openai/gpt-4o"}
    assert a2._normalize_model({"model": "m", "api_key": "k"}) == {"model": "m", "api_key": "k"}
    assert a2._normalize_model(None) is None

    class _LLM:
        model = "openai/gpt-4o"
        api_key = "secret"
        base_url = "http://local"
        api_version = None

    kw = a2._normalize_model(_LLM())
    assert kw["model"] == "openai/gpt-4o"
    assert kw["api_key"] == "secret"
    assert kw["base_url"] == "http://local"
    assert "api_version" not in kw  # None dropped

    with pytest.raises(ValueError):
        a2._normalize_model(123)


# ---------------------------------------------------------------------------
# strip_in_flight_tool_call
# ---------------------------------------------------------------------------


def test_strip_in_flight_tool_call_drops_trailing_generate_call():
    msgs = [
        {"role": "user", "content": "make a card"},
        {
            "role": "assistant",
            "tool_calls": [{"function": {"name": "generate_a2ui"}}],
        },
    ]
    out = a2.strip_in_flight_tool_call(msgs, "generate_a2ui")
    assert out == msgs[:1]


def test_strip_in_flight_tool_call_preserves_user_tail():
    msgs = [{"role": "user", "content": "hi"}]
    assert a2.strip_in_flight_tool_call(msgs, "generate_a2ui") == msgs


# ---------------------------------------------------------------------------
# get_a2ui_tools + schema
# ---------------------------------------------------------------------------


def test_get_a2ui_tools_requires_model():
    with pytest.raises(ValueError):
        a2.get_a2ui_tools({})


def test_get_a2ui_tools_warns_on_snake_case_recovery_key(caplog):
    with caplog.at_level("WARNING", logger="ag_ui_crewai"):
        a2.get_a2ui_tools({"model": "m", "recovery": {"max_attempts": 2}})
    assert any("camelCase" in r.message for r in caplog.records)


def test_tool_schema_shape():
    tool = a2.get_a2ui_tools({"model": "m"})
    schema = tool.schema
    assert schema["type"] == "function"
    assert schema["function"]["name"] == "generate_a2ui"
    props = schema["function"]["parameters"]["properties"]
    assert set(props) == {"intent", "target_surface_id", "changes"}
    assert props["intent"]["enum"] == ["create", "update"]


# ---------------------------------------------------------------------------
# plan_a2ui_injection
# ---------------------------------------------------------------------------


def test_plan_off_without_flag():
    assert a2.plan_a2ui_injection(model="m", state={"messages": []}, existing_tool_names=[]) is None


def test_plan_on_with_state_flag():
    state = {"messages": [], "ag-ui": {"inject_a2ui_tool": True}}
    plan = a2.plan_a2ui_injection(model="m", state=state, existing_tool_names=[])
    assert plan is not None
    assert plan["tool_name"] == "generate_a2ui"
    assert plan["drop_tool_names"] == ["render_a2ui"]
    assert a2.is_auto_injected_a2ui_tool(plan["tool"]) is True


def test_plan_flag_as_string_drops_custom_render_name():
    state = {"messages": [], "ag-ui": {"inject_a2ui_tool": "customRender"}}
    plan = a2.plan_a2ui_injection(model="m", state=state, existing_tool_names=[])
    assert plan["drop_tool_names"] == ["customRender"]


def test_plan_config_override_and_explicit_false():
    # Backend opt-in via config when the runtime is silent.
    plan = a2.plan_a2ui_injection(
        model="m", state={"messages": []}, existing_tool_names=[],
        config={"inject_a2ui_tool": True},
    )
    assert plan is not None
    # Explicit runtime false wins over a config opt-in.
    off = a2.plan_a2ui_injection(
        model="m", state={"messages": [], "ag-ui": {"inject_a2ui_tool": False}},
        existing_tool_names=[], config={"inject_a2ui_tool": True},
    )
    assert off is None


def test_plan_user_prevails():
    state = {"messages": [], "ag-ui": {"inject_a2ui_tool": True}}
    assert (
        a2.plan_a2ui_injection(
            model="m", state=state, existing_tool_names=["generate_a2ui"]
        )
        is None
    )


def test_plan_no_model_skips(caplog):
    state = {"messages": [], "ag-ui": {"inject_a2ui_tool": True}}
    with caplog.at_level("WARNING", logger="ag_ui_crewai"):
        assert a2.plan_a2ui_injection(model=None, state=state, existing_tool_names=[]) is None
    assert any("no model" in r.message.lower() for r in caplog.records)


def test_plan_resolves_catalog_from_state():
    schema = json.dumps({"catalogId": "cat://custom", "components": [{"name": "Card"}]})
    state = {
        "messages": [],
        "ag-ui": {"inject_a2ui_tool": True, "a2ui_schema": schema},
    }
    plan = a2.plan_a2ui_injection(model="m", state=state, existing_tool_names=[])
    # Catalog id from the frontend schema becomes the tool's default.
    assert plan["tool"]._cfg["default_catalog_id"] == "cat://custom"


# ---------------------------------------------------------------------------
# apply_a2ui_plan_to_tools
# ---------------------------------------------------------------------------


def _fn_tool(name):
    return {"type": "function", "function": {"name": name, "parameters": {}}}


def test_apply_plan_none_is_copy():
    actions = [_fn_tool("foo")]
    out = a2.apply_a2ui_plan_to_tools(actions, None)
    assert out == actions and out is not actions


def test_apply_plan_swaps_render_for_generate():
    actions = [_fn_tool("render_a2ui"), _fn_tool("other")]
    state = {"messages": [], "ag-ui": {"inject_a2ui_tool": True}}
    plan = a2.plan_a2ui_injection(model="m", state=state, existing_tool_names=["other"])
    out = a2.apply_a2ui_plan_to_tools(actions, plan)
    names = [t["function"]["name"] for t in out]
    assert "render_a2ui" not in names
    assert names == ["other", "generate_a2ui"]


# ---------------------------------------------------------------------------
# A2UITool.run - subagent generation, progressive streaming, recovery
# ---------------------------------------------------------------------------


async def _run_tool(monkeypatch, arg_scripts, *, default_catalog_id=BASIC_CATALOG_ID, recovery=None):
    fake, calls = _make_fake_acompletion(arg_scripts)
    bus = _RecordingBus()
    monkeypatch.setattr(a2, "acompletion", fake)
    monkeypatch.setattr(a2, "crewai_event_bus", bus)
    tool = a2.get_a2ui_tools(
        {"model": "openai/gpt-4o", "default_catalog_id": default_catalog_id, "recovery": recovery}
    )
    envelope = await tool.run({"intent": "create"})
    return envelope, calls, bus


async def test_run_success_returns_envelope_and_streams(monkeypatch):
    envelope, calls, bus = await _run_tool(
        monkeypatch, [VALID_ARGS], default_catalog_id="cat://x"
    )
    doc = json.loads(envelope)
    ops = doc[A2UI_OPERATIONS_KEY]
    # createSurface + updateComponents for a fresh create.
    op_keys = {k for op in ops if isinstance(op, dict) for k in op if k != "version"}
    assert "createSurface" in op_keys and "updateComponents" in op_keys
    create = next(op for op in ops if "createSurface" in op)
    assert create["createSurface"]["catalogId"] == "cat://x"
    assert calls["n"] == 1

    # Progressive streaming: inner render_a2ui chunks were emitted on the wire.
    chunks = [e for e in bus.events if e.type == "TOOL_CALL_CHUNK"]
    assert chunks, "expected progressive render_a2ui chunks"
    assert chunks[0].tool_call_name == "render_a2ui"
    # Name rides only the opening chunk (OpenAI streaming convention).
    assert all(c.tool_call_name is None for c in chunks[1:])
    # The host catalog id is spliced into the streamed args for the paint.
    assert any('"catalogId": "cat://x"' in c.delta for c in chunks)


async def test_run_recovers_after_invalid_attempt(monkeypatch):
    envelope, calls, bus = await _run_tool(monkeypatch, [INVALID_ARGS, VALID_ARGS])
    doc = json.loads(envelope)
    assert A2UI_OPERATIONS_KEY in doc  # recovered to a valid surface
    assert calls["n"] == 2  # one retry
    # Each attempt re-streams render_a2ui -> two opening chunks.
    openings = [e for e in bus.events if e.type == "TOOL_CALL_CHUNK" and e.tool_call_name]
    assert len(openings) == 2


async def test_run_exhausts_recovery(monkeypatch):
    envelope, calls, bus = await _run_tool(
        monkeypatch, [INVALID_ARGS, INVALID_ARGS], recovery={"maxAttempts": 2}
    )
    doc = json.loads(envelope)
    assert doc.get("code") == "a2ui_recovery_exhausted"
    assert calls["n"] == 2


async def test_run_emits_tool_call_result_when_id_given(monkeypatch):
    # run() self-emits TOOL_CALL_RESULT so a flow can't leave the middleware
    # stuck at "building" by forgetting to emit it.
    fake, _ = _make_fake_acompletion([VALID_ARGS])
    bus = _RecordingBus()
    monkeypatch.setattr(a2, "acompletion", fake)
    monkeypatch.setattr(a2, "crewai_event_bus", bus)
    tool = a2.get_a2ui_tools({"model": "m"})
    envelope = await tool.run({"intent": "create"}, tool_call_id="outer-1")
    results = [e for e in bus.events if e.type == "TOOL_CALL_RESULT"]
    assert len(results) == 1
    assert (results[0].tool_call_id, results[0].content, results[0].role) == (
        "outer-1", envelope, "tool",
    )


async def test_run_without_id_emits_no_tool_call_result(monkeypatch):
    fake, _ = _make_fake_acompletion([VALID_ARGS])
    bus = _RecordingBus()
    monkeypatch.setattr(a2, "acompletion", fake)
    monkeypatch.setattr(a2, "crewai_event_bus", bus)
    tool = a2.get_a2ui_tools({"model": "m"})
    await tool.run({"intent": "create"})
    assert not [e for e in bus.events if e.type == "TOOL_CALL_RESULT"]


async def test_run_emits_tool_call_result_on_recovery_exhaustion(monkeypatch):
    # Even when recovery exhausts, the error envelope must reach the middleware
    # via TOOL_CALL_RESULT so it paints the hard-failure instead of hanging.
    fake, _ = _make_fake_acompletion([INVALID_ARGS, INVALID_ARGS])
    bus = _RecordingBus()
    monkeypatch.setattr(a2, "acompletion", fake)
    monkeypatch.setattr(a2, "crewai_event_bus", bus)
    tool = a2.get_a2ui_tools({"model": "m", "recovery": {"maxAttempts": 2}})
    envelope = await tool.run({"intent": "create"}, tool_call_id="outer-2")
    results = [e for e in bus.events if e.type == "TOOL_CALL_RESULT"]
    assert len(results) == 1 and results[0].content == envelope
    assert json.loads(envelope)["code"] == "a2ui_recovery_exhausted"


async def test_run_update_without_prior_surface_errors(monkeypatch):
    fake, _ = _make_fake_acompletion([VALID_ARGS])
    monkeypatch.setattr(a2, "acompletion", fake)
    monkeypatch.setattr(a2, "crewai_event_bus", _RecordingBus())
    tool = a2.get_a2ui_tools({"model": "m"})
    envelope = await tool.run({"intent": "update", "target_surface_id": "missing"})
    assert "no prior render" in json.loads(envelope)["error"]


# ---------------------------------------------------------------------------
# Endpoint wiring: crewai_prepare_inputs lifts A2UI into state["ag-ui"]
# ---------------------------------------------------------------------------


def _prepare(context=None, forwarded_props=None):
    inp = RunAgentInput(
        thread_id="t", run_id="r", state={}, messages=[], tools=[],
        context=context or [], forwarded_props=forwarded_props or {},
    )
    return ep.crewai_prepare_inputs(
        state=inp.state, messages=inp.messages, tools=inp.tools,
        context=inp.context, forwarded_props=inp.forwarded_props,
    )


def test_prepare_inputs_no_a2ui_leaves_state_clean():
    out = _prepare()
    assert "ag-ui" not in out


def test_prepare_inputs_lifts_schema_and_flag():
    schema = json.dumps({"catalogId": "cat://c", "components": []})
    out = _prepare(
        context=[
            Context(description=A2UI_SCHEMA_CONTEXT_DESCRIPTION, value=schema),
            Context(description="Other", value="keep"),
        ],
        forwarded_props={"injectA2UITool": True},
    )
    ns = out["ag-ui"]
    assert ns["a2ui_schema"] == schema
    assert ns["inject_a2ui_tool"] is True
    # The schema entry is split out of the regular context bag.
    assert [c["description"] for c in ns["context"]] == ["Other"]
    # And out of the top-level context too (schema lives only under ag-ui).
    assert [c["description"] for c in out["context"]] == ["Other"]


def test_prepare_inputs_flag_only_without_schema():
    out = _prepare(forwarded_props={"injectA2UITool": "customRender"})
    assert out["ag-ui"]["inject_a2ui_tool"] == "customRender"
    assert "a2ui_schema" not in out["ag-ui"]


def test_prepare_inputs_drops_stale_ag_ui_when_off():
    # A prior turn's server-injected ``ag-ui`` echoed back in ``state`` must not
    # survive a turn where the frontend left A2UI off (else injection re-enables).
    out = ep.crewai_prepare_inputs(
        state={"ag-ui": {"inject_a2ui_tool": True, "a2ui_schema": "stale"}},
        messages=[], tools=[], context=[], forwarded_props={},
    )
    assert "ag-ui" not in out


# ---------------------------------------------------------------------------
# classify_a2ui_subagent_error
# ---------------------------------------------------------------------------


def test_classify_subagent_error():
    import asyncio as _asyncio

    assert a2.classify_a2ui_subagent_error(_asyncio.CancelledError(), False) == "rethrow"
    assert a2.classify_a2ui_subagent_error(ValueError("x"), True) == "rethrow"  # aborted
    assert a2.classify_a2ui_subagent_error(TypeError("x"), False) == "rethrow"
    assert a2.classify_a2ui_subagent_error(NameError("x"), False) == "rethrow"
    assert a2.classify_a2ui_subagent_error(KeyboardInterrupt(), False) == "rethrow"
    assert a2.classify_a2ui_subagent_error(ValueError("x"), False) == "recoverable"
    assert a2.classify_a2ui_subagent_error(RuntimeError("x"), False) == "recoverable"


def test_strip_in_flight_preserves_other_tool_name():
    msgs = [
        {"role": "user", "content": "hi"},
        {"role": "assistant", "tool_calls": [{"function": {"name": "other_tool"}}]},
    ]
    # Only the named tool's trailing call is stripped; a different tool stays.
    assert a2.strip_in_flight_tool_call(msgs, "generate_a2ui") == msgs


# ---------------------------------------------------------------------------
# A2UITool.run - stream robustness (empty choices, empty-arg splice, no-call)
# ---------------------------------------------------------------------------


async def test_run_survives_empty_choices_chunk(monkeypatch):
    # Providers can emit a leading/trailing chunk with no choices (usage-only /
    # Azure); the sub-agent must skip it, not IndexError out of the attempt.
    async def fake(**kwargs):
        async def gen():
            yield {"choices": []}
            tc = _FakeToolCall("c1", VALID_ARGS)
            yield {"choices": [{"delta": {"tool_calls": [tc]}, "finish_reason": None}]}
            yield {"choices": [{"delta": {"tool_calls": None}, "finish_reason": "tool_calls"}]}
        return gen()

    monkeypatch.setattr(a2, "acompletion", fake)
    monkeypatch.setattr(a2, "crewai_event_bus", _RecordingBus())
    tool = a2.get_a2ui_tools({"model": "m"})
    envelope = await tool.run({"intent": "create"})
    assert A2UI_OPERATIONS_KEY in json.loads(envelope)


async def test_run_catalog_splice_stays_valid_json_for_empty_args(monkeypatch):
    # Empty render args must not produce ``{"catalogId": "x", }`` (trailing comma).
    fake, _ = _make_fake_acompletion(["{}"], frag_size=64)
    bus = _RecordingBus()
    monkeypatch.setattr(a2, "acompletion", fake)
    monkeypatch.setattr(a2, "crewai_event_bus", bus)
    tool = a2.get_a2ui_tools(
        {"model": "m", "default_catalog_id": "cat://x", "recovery": {"maxAttempts": 1}}
    )
    await tool.run({"intent": "create"})
    deltas = [e.delta for e in bus.events if e.type == "TOOL_CALL_CHUNK"]
    joined = "".join(deltas)
    assert json.loads(joined) == {"catalogId": "cat://x"}  # valid, no trailing comma


async def test_run_catalog_splice_valid_across_split_fragments(monkeypatch):
    # ``{`` and ``}`` arriving in separate stream fragments must still yield
    # valid JSON on the progressive-paint wire (deferred-comma path).
    fake, _ = _make_fake_acompletion(["{}"], frag_size=1)
    bus = _RecordingBus()
    monkeypatch.setattr(a2, "acompletion", fake)
    monkeypatch.setattr(a2, "crewai_event_bus", bus)
    tool = a2.get_a2ui_tools(
        {"model": "m", "default_catalog_id": "cat://x", "recovery": {"maxAttempts": 1}}
    )
    await tool.run({"intent": "create"})
    joined = "".join(e.delta for e in bus.events if e.type == "TOOL_CALL_CHUNK")
    assert json.loads(joined) == {"catalogId": "cat://x"}


async def test_run_catalog_splice_valid_for_real_args_split_charwise(monkeypatch):
    # Non-empty args streamed char-by-char reconstruct to valid JSON with the
    # host catalogId spliced ahead of the model's own fields.
    fake, _ = _make_fake_acompletion([VALID_ARGS], frag_size=1)
    bus = _RecordingBus()
    monkeypatch.setattr(a2, "acompletion", fake)
    monkeypatch.setattr(a2, "crewai_event_bus", bus)
    tool = a2.get_a2ui_tools({"model": "m", "default_catalog_id": "cat://x"})
    await tool.run({"intent": "create"})
    doc = json.loads("".join(e.delta for e in bus.events if e.type == "TOOL_CALL_CHUNK"))
    assert doc["catalogId"] == "cat://x"
    assert doc["surfaceId"] == "prod"


async def test_copilotkit_emit_tool_result_emits_bridged_event(monkeypatch):
    # The a2ui flows call this after a tool runs so middlewares that commit from
    # TOOL_CALL_RESULT (fixed-schema paint, outer-call close) receive it.
    from ag_ui_crewai import sdk
    from ag_ui_crewai.events import BridgedToolCallResultEvent

    captured = []

    class _Bus:
        def emit(self, source, event):
            captured.append(event)

    monkeypatch.setattr(sdk, "crewai_event_bus", _Bus())
    await sdk.copilotkit_emit_tool_result("call-1", '{"a2ui_operations":[]}')
    assert len(captured) == 1
    ev = captured[0]
    assert isinstance(ev, BridgedToolCallResultEvent)
    assert (ev.tool_call_id, ev.content, ev.role) == (
        "call-1", '{"a2ui_operations":[]}', "tool",
    )
    assert ev.message_id  # auto-generated when not supplied


async def test_run_no_tool_call_exhausts(monkeypatch):
    # Sub-agent produces no render call on every attempt -> recovery exhausts.
    fake, calls = _make_fake_acompletion([None, None])
    monkeypatch.setattr(a2, "acompletion", fake)
    monkeypatch.setattr(a2, "crewai_event_bus", _RecordingBus())
    tool = a2.get_a2ui_tools({"model": "m", "recovery": {"maxAttempts": 2}})
    envelope = await tool.run({"intent": "create"})
    assert json.loads(envelope)["code"] == "a2ui_recovery_exhausted"
    assert calls["n"] == 2
