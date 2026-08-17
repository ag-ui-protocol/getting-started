"""Tests for the CrewAI A2UI subagent tool.

Covers the four pillars:
- auto-injection with opt-out (``plan_a2ui_injection`` / the endpoint state lift),
- subagent-based generation (``A2UITool.run`` driving a forced render_a2ui call),
- progressive streaming (inner ``render_a2ui`` chunks emitted on the wire),
- error recovery (validate -> retry through the shared toolkit loop).
"""

import contextvars
import json

import pytest

from ag_ui.core import Context, RunAgentInput, Tool
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
    # More than one chunk, else "progressive" is unproven and the
    # name-only-on-the-opener assertion below has nothing to check.
    assert len(chunks) > 1, chunks
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


async def test_run_propagates_contextvars_into_recovery_worker(monkeypatch):
    """Recovery runs in ``run_in_executor``, which does NOT carry ``contextvars``
    into its worker thread. ``run()`` must dispatch it on a COPIED context, or the
    request-scoped state the subagent resolves there (``flow_context`` and the
    litellm/bus context an ``acompletion`` turn reads) is ``None`` mid-recovery
    and the a2ui surface is dropped. Guards exactly that: the sub-agent
    ``acompletion`` runs in the executor thread, so a var set on the request
    coroutine must still be visible to it."""
    probe = contextvars.ContextVar("a2ui_recovery_ctx_probe", default=None)
    seen: dict = {}

    base_fake, _ = _make_fake_acompletion([VALID_ARGS])

    async def context_reading_fake(**kwargs):
        # Runs inside the run_in_executor worker thread.
        seen["value"] = probe.get()
        return await base_fake(**kwargs)

    monkeypatch.setattr(a2, "acompletion", context_reading_fake)
    monkeypatch.setattr(a2, "crewai_event_bus", _RecordingBus())
    tool = a2.get_a2ui_tools(
        {"model": "openai/gpt-4o", "default_catalog_id": BASIC_CATALOG_ID}
    )

    token = probe.set("request-scoped-sentinel")
    try:
        await tool.run({"intent": "create"})
    finally:
        probe.reset(token)

    # Without the copied context this is None (fresh worker-thread context).
    assert seen["value"] == "request-scoped-sentinel"


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


# ---------------------------------------------------------------------------
# Action -> agent-response loop
#
# The A2UI middleware feeds a surface action back to the server as a synthetic
# ``log_a2ui_event`` assistant call plus its tool result, then the run has to
# answer it. A flow that streams the model ONCE per run and stops on its own
# tool call never produces that answer: the user sees the tool card flip and the
# previous generic summary, and nothing about the choice they made. These drive
# the real demo flows through BOTH transports.
# ---------------------------------------------------------------------------

from litellm import CustomStreamWrapper  # noqa: E402

from ag_ui.encoder import EventEncoder  # noqa: E402
from agents import a2ui_fixed_schema as fixed_demo  # noqa: E402
from agents import _a2ui_subagent as subagent_demo  # noqa: E402
from agents import _model_turn as mt  # noqa: E402

HOTELS = [
    {
        "id": "1",
        "name": "The Ritz Paris",
        "location": "Paris",
        "rating": 4.9,
        "price": 1200,
    }
]
HOTELS_ARGS = json.dumps({"hotels": HOTELS})

# What ``search_hotels`` actually hands back: the a2ui_operations envelope the
# middleware paints from. A synthetic ``"{}"`` would let a flow that never reads
# the render result pass.
HOTEL_RENDER_RESULT = fixed_demo._envelope(
    fixed_demo.HOTEL_SURFACE_ID, fixed_demo.HOTEL_SCHEMA, {"hotels": HOTELS}
)

# The Book button as the hotel schema declares it: action name ``book_hotel``
# with a ``hotelName`` / ``price`` context (see
# ``a2ui_fixed_schema_schemas/hotel_schema.json``).
BOOK_ACTION = {
    "name": "book_hotel",
    "surfaceId": fixed_demo.HOTEL_SURFACE_ID,
    "sourceComponentId": "hotel-card",
    "context": {"hotelName": "The Ritz Paris", "price": 1200},
}
# The middleware's own rendering of that action (``formatUserActionResult``).
BOOK_ACTION_RESULT = (
    'User performed action "book_hotel" on surface "hotel-search-results" '
    '(component: hotel-card). Context: '
    '{"hotelName":"The Ritz Paris","price":1200}'
)


def _book_click_messages(*, render_tool, render_args, render_result):
    """The message list the A2UI middleware sends on a Book click.

    ``m1``-``m3`` are the turn that rendered the surface: the model's rendering
    tool call and the a2ui_operations envelope it returned. ``m4``/``m5`` are the
    synthetic pair the middleware appends, matching its own shapes: the
    ``log_a2ui_event`` arguments are the whole userAction object and the tool
    result is that action's formatted report.
    """
    return [
        {"id": "m1", "role": "user", "content": "compare 3 luxury hotels in Paris"},
        {
            "id": "m2",
            "role": "assistant",
            "content": "Here are your results.",
            "tool_calls": [
                {
                    "id": "call_render1",
                    "type": "function",
                    "function": {"name": render_tool, "arguments": render_args},
                }
            ],
        },
        {
            "id": "m3",
            "role": "tool",
            "tool_call_id": "call_render1",
            "content": render_result,
        },
        {
            "id": "m4",
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {
                    "id": "call_log",
                    "type": "function",
                    "function": {
                        "name": "log_a2ui_event",
                        "arguments": json.dumps(BOOK_ACTION),
                    },
                }
            ],
        },
        {
            "id": "m5",
            "role": "tool",
            "tool_call_id": "call_log",
            "content": BOOK_ACTION_RESULT,
        },
    ]


# Fixed schema: the surface was rendered by the backend ``search_hotels`` tool.
BOOK_CLICK_MESSAGES = _book_click_messages(
    render_tool="search_hotels",
    render_args=HOTELS_ARGS,
    render_result=HOTEL_RENDER_RESULT,
)

# Dynamic schema: the surface was rendered by the auto-injected sub-agent tool,
# whose result is the envelope ``A2UITool.run`` returns.
DYNAMIC_BOOK_CLICK_MESSAGES = _book_click_messages(
    render_tool="generate_a2ui",
    render_args=json.dumps({"intent": "create", "changes": "3 luxury hotels in Paris"}),
    render_result=json.dumps({A2UI_OPERATIONS_KEY: []}),
)


class _LoopFakeStream(CustomStreamWrapper):
    def __init__(self, gen):  # pylint: disable=super-init-not-called
        self._gen = gen

    def __aiter__(self):
        return self._gen


def _loop_chunk(delta, finish=None, chunk_id="chatcmpl-1"):
    return {
        "id": chunk_id,
        "created": 1700000000,
        "model": "gpt-5.4",
        "system_fingerprint": "fp",
        "choices": [{"delta": delta, "finish_reason": finish}],
    }


def _tool_call_turn(call_id, name, arguments, text, chunk_id):
    """A model turn that says something and then calls a tool."""
    return [
        _loop_chunk({"content": text, "tool_calls": None}, chunk_id=chunk_id),
        _loop_chunk(
            {
                "content": None,
                "tool_calls": [
                    _FakeStreamToolCall(call_id, name, arguments),
                ],
            },
            chunk_id=chunk_id,
        ),
        _loop_chunk({"content": None, "tool_calls": None}, finish="tool_calls",
                    chunk_id=chunk_id),
    ]


def _text_turn(text, chunk_id):
    """A model turn that only answers in text."""
    return [
        _loop_chunk({"content": text, "tool_calls": None}, chunk_id=chunk_id),
        _loop_chunk({"content": None, "tool_calls": None}, finish="stop",
                    chunk_id=chunk_id),
    ]


class _FakeStreamToolCall:
    """A litellm streaming tool-call delta (``index`` / ``id`` / ``function``)."""

    def __init__(self, call_id, name, arguments):
        self.index = 0
        self.id = call_id
        self.function = {"name": name, "arguments": arguments}


class _TurnScript:
    """Serves one scripted model turn per ``acompletion`` call, in order."""

    def __init__(self, turns):
        self._turns = list(turns)
        self.calls = []

    async def __call__(self, **kwargs):  # noqa: ANN001 - acompletion stand-in
        self.calls.append(kwargs)
        assert self._turns, "the flow called the model more times than scripted"
        chunks = self._turns.pop(0)

        async def gen():
            for chunk in chunks:
                yield chunk

        return _LoopFakeStream(gen())


def _decode(encoded):
    payloads = []
    for chunk in encoded:
        for line in chunk.splitlines():
            if line.startswith("data:"):
                payloads.append(json.loads(line[len("data:"):].strip()))
    return payloads


def _assistant_text(payloads):
    return "".join(
        p.get("delta") or ""
        for p in payloads
        if p["type"] in ("TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_CHUNK")
    )


async def _drive_flow(driver_name, flow, messages, *, tools=None, forwarded_props=None):
    data = RunAgentInput(
        thread_id="t-1", run_id="r-1", state={},
        messages=messages, tools=tools or [], context=[],
        forwarded_props=forwarded_props or {},
    )
    inputs = ep.crewai_prepare_inputs(
        state=data.state, messages=data.messages, tools=data.tools,
        context=data.context, forwarded_props=data.forwarded_props,
    )
    ep.FastAPICrewFlowEventListener()
    encoded = [
        chunk
        async for chunk in getattr(ep, driver_name)(
            flow_copy=flow, encoder=EventEncoder(), input_data=data,
            inputs=inputs, timeout=30.0,
        )
    ]
    return _decode(encoded)


BOTH_TRANSPORTS = pytest.mark.parametrize(
    "driver", ["_run_flow_frame_stream", "_run_flow_event_stream"]
)

# A frontend tool: the client runs it and sends the result back on the next run.
CHANGE_BACKGROUND_TOOL = {
    "name": "change_background",
    "description": "Change the page background colour.",
    "parameters": {
        "type": "object",
        "properties": {"background": {"type": "string"}},
        "required": ["background"],
    },
}


def _snapshot_messages(payloads):
    """The terminal MESSAGES_SNAPSHOT: the conversation the flow persisted, which
    the client stores and replays on the next run of this thread."""
    snapshots = [p for p in payloads if p["type"] == "MESSAGES_SNAPSHOT"]
    assert snapshots, "the run emitted no MESSAGES_SNAPSHOT"
    return snapshots[-1]["messages"]


def _unanswered_tool_call_names(messages):
    """Names of the tool calls with no matching tool result in ``messages``."""
    answered = {m.get("toolCallId") for m in messages if m.get("role") == "tool"}
    return [
        call["function"]["name"]
        for message in messages
        for call in (message.get("toolCalls") or [])
        if call["id"] not in answered
    ]


def test_book_click_fixture_matches_production_shapes():
    """The synthetic click history must stay pinned to what production emits.

    The action name and surface id come from the hotel schema and the demo, and
    the rendering tool's result is a real a2ui_operations envelope. Renaming the
    schema's action or the surface without updating the fixture fails here, so the
    action tests cannot keep passing against a history no client would send.
    """
    hotel_card = next(
        c for c in fixed_demo.HOTEL_SCHEMA if c["component"] == "HotelCard"
    )
    assert BOOK_ACTION["name"] == hotel_card["action"]["event"]["name"]
    assert set(BOOK_ACTION["context"]) == set(
        hotel_card["action"]["event"]["context"]
    )
    assert BOOK_ACTION["surfaceId"] == fixed_demo.HOTEL_SURFACE_ID
    # The middleware's report is what the model reads; it must name the action.
    assert BOOK_ACTION["name"] in BOOK_ACTION_RESULT
    assert BOOK_ACTION["surfaceId"] in BOOK_ACTION_RESULT
    # The render turn's tool result is the envelope the middleware paints from.
    assert A2UI_OPERATIONS_KEY in json.loads(BOOK_CLICK_MESSAGES[2]["content"])
    assert A2UI_OPERATIONS_KEY in json.loads(
        DYNAMIC_BOOK_CLICK_MESSAGES[2]["content"]
    )


@BOTH_TRANSPORTS
async def test_fixed_schema_action_click_gets_a_choice_specific_reply(
    monkeypatch, driver
):
    """Clicking Book elicits a reply naming the hotel. The model answers the
    action only on a follow-up turn fed its own tool result; a single-shot flow
    ends on the search call and the choice is never acknowledged."""
    script = _TurnScript([
        _tool_call_turn("call_search2", "search_hotels", HOTELS_ARGS,
                        "Here are your results.", "chatcmpl-2"),
        _text_turn("You've booked The Ritz Paris. Confirmation is on its way.",
                   "chatcmpl-3"),
    ])
    monkeypatch.setattr(fixed_demo, "acompletion", script)

    payloads = await _drive_flow(
        driver, fixed_demo.A2UIFixedSchemaFlow(), BOOK_CLICK_MESSAGES
    )

    assert len(script.calls) == 2, "the tool result must drive a follow-up turn"
    text = _assistant_text(payloads)
    assert "The Ritz Paris" in text, text
    assert "RUN_ERROR" not in [p["type"] for p in payloads]

    # The follow-up turn sees the tool result it is answering.
    replayed = script.calls[1]["messages"]
    assert replayed[-1]["role"] == "tool"
    assert replayed[-1]["tool_call_id"] == "call_search2"


@BOTH_TRANSPORTS
async def test_fixed_schema_stops_on_a_frontend_tool_call(monkeypatch, driver):
    """A frontend tool the flow does not execute ends the run so the client can
    run it, and the call is persisted INTACT (the client answers it on the next
    run). Looping here would feed the model a history with an unanswered call."""
    script = _TurnScript([
        _tool_call_turn("call_front", "change_background", '{"background":"red"}',
                        "Sure.", "chatcmpl-2"),
    ])
    monkeypatch.setattr(fixed_demo, "acompletion", script)

    payloads = await _drive_flow(
        driver, fixed_demo.A2UIFixedSchemaFlow(),
        [{"id": "m1", "role": "user", "content": "make it red"}],
        tools=[CHANGE_BACKGROUND_TOOL],
    )

    assert len(script.calls) == 1
    types = [p["type"] for p in payloads]
    assert "TOOL_CALL_START" in types
    assert "RUN_ERROR" not in types
    assert _unanswered_tool_call_names(_snapshot_messages(payloads)) == ["change_background"]


@BOTH_TRANSPORTS
async def test_fixed_schema_loop_is_bounded(monkeypatch, driver):
    """A model that keeps calling the tool cannot spin the run: the loop stops at
    the turn cap and the run still finishes cleanly."""
    turns = [
        _tool_call_turn(f"call_{i}", "search_hotels", HOTELS_ARGS, "Results.",
                        f"chatcmpl-{i}")
        for i in range(fixed_demo.MAX_MODEL_TURNS + 3)
    ]
    script = _TurnScript(turns)
    monkeypatch.setattr(fixed_demo, "acompletion", script)

    payloads = await _drive_flow(
        driver, fixed_demo.A2UIFixedSchemaFlow(),
        [{"id": "m1", "role": "user", "content": "hotels please"}],
    )

    assert len(script.calls) == fixed_demo.MAX_MODEL_TURNS
    types = [p["type"] for p in payloads]
    assert "RUN_FINISHED" in types
    assert "RUN_ERROR" not in types


@BOTH_TRANSPORTS
async def test_dynamic_schema_action_click_gets_a_choice_specific_reply(
    monkeypatch, driver
):
    """The auto-injected subagent demo answers a surface action too, with A2UI
    injection running for REAL: the ``injectA2UITool`` runtime flag is what puts
    ``generate_a2ui`` on the model's tool list, the real ``A2UITool`` generates
    the surface (its own sub-agent completion stubbed), and its envelope drives a
    follow-up turn that names the choice.

    Only the two model calls are stubbed: the outer flow's ``acompletion`` and the
    sub-agent's. ``plan_a2ui_injection`` / ``apply_a2ui_plan_to_tools`` are NOT,
    so a regression that stops injecting the tool fails here."""
    script = _TurnScript([
        _tool_call_turn(
            "call_gen", "generate_a2ui",
            json.dumps({"intent": "create", "changes": "3 luxury hotels in Paris"}),
            "Rendered a comparison of 3 luxury hotels.", "chatcmpl-2",
        ),
        _text_turn("You've booked The Ritz Paris. Enjoy your stay.", "chatcmpl-3"),
    ])
    monkeypatch.setattr(subagent_demo, "acompletion", script)
    # The sub-agent's own render_a2ui completion (A2UITool.run drives it).
    inner, inner_calls = _make_fake_acompletion([VALID_ARGS])
    monkeypatch.setattr(a2, "acompletion", inner)

    payloads = await _drive_flow(
        driver,
        subagent_demo_flow(),
        DYNAMIC_BOOK_CLICK_MESSAGES,
        # The middleware sends its render proxy alongside the flag; the plan has to
        # SWAP it, so it must actually be on the input for that to mean anything.
        tools=[
            Tool(
                name="render_a2ui",
                description="middleware-injected render proxy",
                parameters={"type": "object", "properties": {}},
            )
        ],
        forwarded_props={"injectA2UITool": True},
    )

    # Injection: the flag alone put generate_a2ui on the tool list, and the
    # middleware's render proxy was swapped out rather than offered alongside.
    offered = [
        t["function"]["name"] for t in (script.calls[0].get("tools") or [])
    ]
    assert "generate_a2ui" in offered, offered
    assert "render_a2ui" not in offered, offered

    # The real A2UITool ran and its envelope reached the wire.
    assert inner_calls["n"] == 1
    results = [p for p in payloads if p["type"] == "TOOL_CALL_RESULT"]
    assert results, [p["type"] for p in payloads]
    assert A2UI_OPERATIONS_KEY in json.loads(results[0]["content"])

    assert len(script.calls) == 2, "the generate_a2ui result must drive a follow-up"
    replayed = script.calls[1]["messages"]
    assert replayed[-1]["role"] == "tool"
    assert replayed[-1]["tool_call_id"] == "call_gen"
    assert "The Ritz Paris" in _assistant_text(payloads)
    assert "RUN_ERROR" not in [p["type"] for p in payloads]


@BOTH_TRANSPORTS
async def test_dynamic_schema_replans_against_the_current_conversation(
    monkeypatch, driver
):
    """Every model turn must plan against the CURRENT conversation.

    The plan snapshots the messages it hands the render sub-agent, so a plan
    built once before the loop shows turn 2's sub-agent the turn-1 history: no
    assistant message, no tool result, no action report. An in-run
    ``intent="update"`` then finds no prior surface and paints a hard failure,
    and a second create is designed blind to the first surface.
    """
    script = _TurnScript([
        _tool_call_turn("call_gen1", "generate_a2ui", '{"intent":"create"}',
                        "Rendered the hotels.", "chatcmpl-2"),
        _tool_call_turn("call_gen2", "generate_a2ui", '{"intent":"update"}',
                        "Updating it.", "chatcmpl-3"),
        _text_turn("All set.", "chatcmpl-4"),
    ])
    monkeypatch.setattr(subagent_demo, "acompletion", script)

    glue_per_call = []

    async def _record_run(self, args, *, tool_call_id=None, flow=None, **_kw):  # noqa: ANN001
        glue_per_call.append(list(self._glue.get("messages") or []))
        return json.dumps({A2UI_OPERATIONS_KEY: []})

    monkeypatch.setattr(a2.A2UITool, "run", _record_run)

    payloads = await _drive_flow(
        driver, subagent_demo_flow(),
        [{"id": "m1", "role": "user", "content": "compare 3 luxury hotels in Paris"}],
        forwarded_props={"injectA2UITool": True},
    )

    assert "RUN_ERROR" not in [p["type"] for p in payloads]
    assert len(glue_per_call) == 2, "both generate_a2ui calls must run"
    first, second = glue_per_call
    assert [m["role"] for m in first] == ["user"]
    assert [m["role"] for m in second] == ["user", "assistant", "tool"]
    assert second[-1]["tool_call_id"] == "call_gen1"


@BOTH_TRANSPORTS
async def test_fixed_schema_drops_a_tool_call_nobody_will_answer(monkeypatch, driver):
    """A tool name neither this flow nor the frontend knows (a hallucination) is
    answered by no one. Persisting the call would leave an assistant
    ``tool_calls`` entry with no matching result, which the chat-completions API
    rejects on every later run of the thread.

    Dropping the call must not cost the user a reply: the turn continues so the
    model can answer in text, and the dropped call is absent from the history it
    is re-prompted with.
    """
    script = _TurnScript([
        _tool_call_turn("call_ghost", "search_restaurants", '{"city":"Paris"}',
                        "Looking that up.", "chatcmpl-2"),
        _text_turn("I can search flights and hotels, not restaurants.",
                   "chatcmpl-3"),
    ])
    monkeypatch.setattr(fixed_demo, "acompletion", script)

    payloads = await _drive_flow(
        driver, fixed_demo.A2UIFixedSchemaFlow(),
        [{"id": "m1", "role": "user", "content": "where should I eat?"}],
        tools=[CHANGE_BACKGROUND_TOOL],
    )

    assert "RUN_ERROR" not in [p["type"] for p in payloads]
    messages = _snapshot_messages(payloads)
    assert _unanswered_tool_call_names(messages) == []
    # What the model did say is still persisted.
    assert any(m.get("content") == "Looking that up." for m in messages)
    # The run does not end silently on a call nobody can answer.
    assert len(script.calls) == 2
    assert "search_restaurants" not in json.dumps(script.calls[1]["messages"])
    assert "not restaurants" in _assistant_text(payloads)


@BOTH_TRANSPORTS
async def test_dynamic_schema_drops_a_tool_call_nobody_will_answer(
    monkeypatch, driver
):
    """Same for the subagent demo: only ``generate_a2ui`` and the frontend tools
    can be answered, so an unknown name must not be persisted unanswered - and
    dropping it still leaves the model a turn to reply in text."""
    script = _TurnScript([
        _tool_call_turn("call_ghost", "search_restaurants", '{"city":"Paris"}',
                        "Looking that up.", "chatcmpl-2"),
        _text_turn("I can render surfaces, not look up restaurants.",
                   "chatcmpl-3"),
    ])
    monkeypatch.setattr(subagent_demo, "acompletion", script)

    class _NeverRunTool:
        schema = {"type": "function", "function": {"name": "generate_a2ui"}}

        async def run(self, args, tool_call_id=None, **_kw):  # noqa: ANN001 - test double
            raise AssertionError("the flow must not run an unknown tool call")

    monkeypatch.setattr(
        subagent_demo,
        "plan_a2ui_injection",
        lambda **kwargs: {"tool_name": "generate_a2ui", "tool": _NeverRunTool()},
    )

    payloads = await _drive_flow(
        driver, subagent_demo_flow(),
        [{"id": "m1", "role": "user", "content": "where should I eat?"}],
        tools=[CHANGE_BACKGROUND_TOOL],
    )

    assert "RUN_ERROR" not in [p["type"] for p in payloads]
    assert _unanswered_tool_call_names(_snapshot_messages(payloads)) == []
    assert len(script.calls) == 2
    assert "search_restaurants" not in json.dumps(script.calls[1]["messages"])
    assert "not look up restaurants" in _assistant_text(payloads)


@BOTH_TRANSPORTS
async def test_dynamic_schema_stops_on_a_frontend_tool_call(monkeypatch, driver):
    """A genuine frontend call still ends the run with the call intact, so the
    client can run it and send the result back on the next one."""
    script = _TurnScript([
        _tool_call_turn("call_front", "change_background", '{"background":"red"}',
                        "Sure.", "chatcmpl-2"),
    ])
    monkeypatch.setattr(subagent_demo, "acompletion", script)

    payloads = await _drive_flow(
        driver, subagent_demo_flow(),
        [{"id": "m1", "role": "user", "content": "make it red"}],
        tools=[CHANGE_BACKGROUND_TOOL],
    )

    assert len(script.calls) == 1
    assert "RUN_ERROR" not in [p["type"] for p in payloads]
    assert _unanswered_tool_call_names(_snapshot_messages(payloads)) == [
        "change_background"
    ]


def subagent_demo_flow():
    from agents.a2ui_dynamic_schema import A2UIDynamicSchemaFlow

    return A2UIDynamicSchemaFlow()


# ---------------------------------------------------------------------------
# Shared model-turn bookkeeping (``_model_turn``)
# ---------------------------------------------------------------------------


class _FakeStreamedResponse:
    def __init__(self, response_id="chatcmpl-x"):
        self.id = response_id


class _FakeStreamedMessage:
    """Stands in for the ``ModelResponse`` message ``copilotkit_stream`` returns."""

    def __init__(self, content="", tool_calls=None):
        self._dump = {
            "role": "assistant",
            "content": content,
            "tool_calls": tool_calls,
            "function_call": None,
        }

    def model_dump(self):
        return dict(self._dump)


def _fake_call_dump(name):
    return {"id": "c1", "type": "function",
            "function": {"name": name, "arguments": "{}"}}


def test_append_assistant_message_skips_an_empty_turn():
    """A turn that produced neither text nor a tool call carries nothing. It must
    not be persisted: it would be replayed as an empty assistant message on every
    later run of the thread."""
    state = {"messages": []}
    assert mt.append_assistant_message(
        state, _FakeStreamedResponse(), _FakeStreamedMessage()
    ) is None
    assert state["messages"] == []


def test_append_assistant_message_persists_text_and_tool_calls():
    """The empty-turn guard must not swallow a turn with real payload: text
    alone, a tool call alone, and the streamed id all survive."""
    state = {"messages": []}
    text_only = mt.append_assistant_message(
        state, _FakeStreamedResponse("chatcmpl-1"), _FakeStreamedMessage("hi")
    )
    assert text_only["content"] == "hi"
    assert text_only["id"] == "chatcmpl-1"

    call_only = mt.append_assistant_message(
        state,
        _FakeStreamedResponse("chatcmpl-2"),
        _FakeStreamedMessage("", [_fake_call_dump("search_hotels")]),
    )
    assert [c["function"]["name"] for c in call_only["tool_calls"]] == [
        "search_hotels"
    ]
    assert len(state["messages"]) == 2


def test_append_assistant_message_drops_orphans_and_skips_a_call_only_turn():
    """Dropping every tool call from a turn with no text leaves nothing to
    persist, while a turn that also said something keeps the text."""
    state = {"messages": []}
    assert mt.append_assistant_message(
        state,
        _FakeStreamedResponse(),
        _FakeStreamedMessage("", [_fake_call_dump("ghost")]),
        drop_indexes={0},
    ) is None
    assert state["messages"] == []

    kept = mt.append_assistant_message(
        state,
        _FakeStreamedResponse(),
        _FakeStreamedMessage("Looking that up.", [_fake_call_dump("ghost")]),
        drop_indexes={0},
    )
    assert kept["content"] == "Looking that up."
    assert kept["tool_calls"] is None


def test_resolve_client_tools_excludes_the_swapped_out_render_proxy():
    """A tool the flow swapped out is neither offered to the model nor treated as
    the client's to answer."""
    actions = [_fn_tool("render_a2ui"), _fn_tool("change_background")]
    offered, client_names = mt.resolve_client_tools(
        actions, backend_names={"generate_a2ui"}, drop_names=["render_a2ui"]
    )
    assert [t["function"]["name"] for t in offered] == ["change_background"]
    assert client_names == {"change_background"}


def test_resolve_client_tools_logs_a_backend_name_collision(caplog):
    """A frontend action sharing a backend tool's name loses to the backend, and
    the collision is logged rather than resolved silently."""
    actions = [_fn_tool("search_hotels"), _fn_tool("change_background")]
    with caplog.at_level("WARNING", logger="ag_ui_crewai"):
        offered, client_names = mt.resolve_client_tools(
            actions, backend_names={"search_hotels", "search_flights"}
        )
    assert [t["function"]["name"] for t in offered] == ["change_background"]
    assert client_names == {"change_background"}
    assert any(
        "search_hotels" in r.getMessage() for r in caplog.records
    ), [r.getMessage() for r in caplog.records]


@BOTH_TRANSPORTS
async def test_dynamic_schema_keeps_a_render_call_inside_the_recovery_loop(
    monkeypatch, driver, caplog
):
    """A call to the SWAPPED-OUT render proxy must not be handed to the client.

    Auto-injection replaces the middleware's ``render_a2ui`` proxy with
    ``generate_a2ui``, whose sub-agent validates and retries the surface. Treating
    a render call as a frontend call would end the run with that call intact, so
    the client paints it directly and the whole validate/retry path this demo
    exists to show is skipped.
    """
    script = _TurnScript([
        _tool_call_turn(
            "call_render", "render_a2ui",
            json.dumps({"surfaceId": "s", "components": []}),
            "Rendering that.", "chatcmpl-2",
        ),
        _text_turn("Here is your comparison.", "chatcmpl-3"),
    ])
    monkeypatch.setattr(subagent_demo, "acompletion", script)

    with caplog.at_level("WARNING", logger="ag_ui_crewai"):
        payloads = await _drive_flow(
            driver, subagent_demo_flow(),
            [{"id": "m1", "role": "user", "content": "compare 3 hotels"}],
            tools=[
                Tool(
                    name="render_a2ui",
                    description="middleware-injected render proxy",
                    parameters={"type": "object", "properties": {}},
                )
            ],
            forwarded_props={"injectA2UITool": True},
        )

    assert "RUN_ERROR" not in [p["type"] for p in payloads]
    offered = [t["function"]["name"] for t in (script.calls[0].get("tools") or [])]
    assert offered == ["generate_a2ui"], offered
    # The render call is NOT left for the client to answer.
    assert _unanswered_tool_call_names(_snapshot_messages(payloads)) == []
    assert any("render_a2ui" in r.getMessage() for r in caplog.records), [
        r.getMessage() for r in caplog.records
    ]


@BOTH_TRANSPORTS
async def test_dynamic_schema_still_answers_the_render_proxy_when_a2ui_is_off(
    monkeypatch, driver
):
    """With no injection there is no plan and nothing was swapped out, so the
    middleware's render proxy IS a plain frontend tool: the run ends with the call
    intact for the client to answer."""
    script = _TurnScript([
        _tool_call_turn(
            "call_render", "render_a2ui", "{}", "Rendering that.", "chatcmpl-2"
        ),
    ])
    monkeypatch.setattr(subagent_demo, "acompletion", script)

    payloads = await _drive_flow(
        driver, subagent_demo_flow(),
        [{"id": "m1", "role": "user", "content": "compare 3 hotels"}],
        tools=[
            Tool(
                name="render_a2ui",
                description="middleware-injected render proxy",
                parameters={"type": "object", "properties": {}},
            )
        ],
    )

    assert len(script.calls) == 1
    assert "RUN_ERROR" not in [p["type"] for p in payloads]
    assert _unanswered_tool_call_names(_snapshot_messages(payloads)) == [
        "render_a2ui"
    ]


@BOTH_TRANSPORTS
async def test_fixed_schema_does_not_persist_an_empty_model_turn(
    monkeypatch, driver
):
    """A model turn that streamed nothing at all must not land in the history as
    an empty assistant message."""
    script = _TurnScript([
        [_loop_chunk({"content": None, "tool_calls": None}, finish="stop",
                     chunk_id="chatcmpl-2")],
    ])
    monkeypatch.setattr(fixed_demo, "acompletion", script)

    payloads = await _drive_flow(
        driver, fixed_demo.A2UIFixedSchemaFlow(),
        [{"id": "m1", "role": "user", "content": "hi"}],
    )

    assert "RUN_ERROR" not in [p["type"] for p in payloads]
    assert [m["role"] for m in _snapshot_messages(payloads)] == ["user"]


@BOTH_TRANSPORTS
async def test_fixed_schema_backend_tool_wins_a_frontend_name_collision(
    monkeypatch, driver, caplog
):
    """A frontend action that shares a backend tool's name is a wiring bug: the
    model would be offered two definitions of one name and only the backend half
    can run. The backend wins and the collision is logged, not swallowed."""
    script = _TurnScript([
        _tool_call_turn("call_search3", "search_hotels", HOTELS_ARGS,
                        "Here are your results.", "chatcmpl-2"),
        _text_turn("Anything else?", "chatcmpl-3"),
    ])
    monkeypatch.setattr(fixed_demo, "acompletion", script)

    with caplog.at_level("WARNING", logger="ag_ui_crewai"):
        payloads = await _drive_flow(
            driver, fixed_demo.A2UIFixedSchemaFlow(),
            [{"id": "m1", "role": "user", "content": "hotels in Paris"}],
            tools=[
                {
                    "name": "search_hotels",
                    "description": "a frontend action shadowing the backend tool",
                    "parameters": {"type": "object", "properties": {}},
                }
            ],
        )

    offered = [t["function"]["name"] for t in (script.calls[0].get("tools") or [])]
    assert offered.count("search_hotels") == 1, offered
    assert any("search_hotels" in r.getMessage() for r in caplog.records), [
        r.getMessage() for r in caplog.records
    ]
    # Backend precedence: this flow ran the search and the run continued.
    assert len(script.calls) == 2
    assert "RUN_ERROR" not in [p["type"] for p in payloads]
    assert _unanswered_tool_call_names(_snapshot_messages(payloads)) == []


def test_system_prompts_do_not_name_the_synthetic_action_tool():
    """The middleware SYNTHESISES the surface-action call and its result into the
    history; it never offers that tool. Naming it in a system prompt invites the
    model to call a tool it does not have, and that call can only be dropped."""
    for prompt in (fixed_demo.SYSTEM_PROMPT, subagent_demo.SYSTEM_PROMPT):
        assert "log_a2ui_event" not in prompt, prompt
        # The surface-interaction guidance itself must survive the rewording: the
        # model still has to recognise the report and answer it in text.
        assert "interacted with" in prompt, prompt
        assert "Reply in text" in prompt, prompt


def test_fixed_schema_envelope_coerces_a_null_list_argument():
    """An explicit JSON ``null`` for the results argument must paint an EMPTY
    surface, not ``updateDataModel {"hotels": null}``."""
    envelope = json.loads(fixed_demo._TOOL_ENVELOPE["search_hotels"]({"hotels": None}))
    data_ops = [
        op["updateDataModel"]
        for op in envelope[A2UI_OPERATIONS_KEY]
        if "updateDataModel" in op
    ]
    assert data_ops and data_ops[0]["value"] == {"hotels": []}, data_ops
    flights = json.loads(
        fixed_demo._TOOL_ENVELOPE["search_flights"]({"flights": None})
    )
    flight_ops = [
        op["updateDataModel"]
        for op in flights[A2UI_OPERATIONS_KEY]
        if "updateDataModel" in op
    ]
    assert flight_ops[0]["value"] == {"flights": []}


GUIDE_CARD_COMPONENTS = ("HotelCard", "ProductCard", "TeamMemberCard")


def _guide_json_objects(guide: str) -> list[dict]:
    """Every top-level JSON object the guide spells out.

    Brace counting is enough: the guide's snippets carry no braces inside string
    literals, and a snippet that failed to parse would be one the sub-agent could
    not copy either, so it is skipped rather than tolerated.
    """
    objects: list[dict] = []
    depth = 0
    start = None
    for index, char in enumerate(guide):
        if char == "{":
            if depth == 0:
                start = index
            depth += 1
        elif char == "}" and depth:
            depth -= 1
            if depth == 0 and start is not None:
                try:
                    parsed = json.loads(guide[start : index + 1])
                except json.JSONDecodeError:
                    continue
                if isinstance(parsed, dict):
                    objects.append(parsed)
    return objects

def test_composition_guide_teaches_the_action_event_shape():
    """Every card the guide teaches must carry an ``action`` in the shape the a2ui
    middleware documents: ``{"event": {"name": ..., "context": {...}}}``.

    A model shown only ``Props: ... action`` can emit a bare string or drop the
    prop, and the rendered card's button then fires nothing, so the action-click
    reply the demo exists to show can never happen.
    """
    examples = {
        obj["component"]: obj
        for obj in _guide_json_objects(subagent_demo.COMPOSITION_GUIDE)
        if isinstance(obj.get("component"), str)
    }

    for component in GUIDE_CARD_COMPONENTS:
        card = examples.get(component)
        assert card, f"the guide shows no {component} example to copy"
        action = card.get("action")
        assert isinstance(action, dict), (
            f"{component}'s example action must be an object, not {action!r}"
        )
        event = action.get("event")
        assert isinstance(event, dict), (
            f"{component}'s action must nest an event object, got {action!r}"
        )
        assert isinstance(event.get("name"), str) and event["name"], (
            f"{component}'s action event must name the action, got {event!r}"
        )
        # The context is what lets the reply name the chosen item: the click is
        # forwarded as the action name plus this context and nothing else.
        context = event.get("context")
        assert isinstance(context, dict) and context, (
            f"{component}'s action event must carry a context, got {event!r}"
        )
        for field, binding in context.items():
            assert isinstance(binding, dict) and isinstance(binding.get("path"), str), (
                f"{component}'s action context {field!r} must bind a data path, "
                f"got {binding!r}"
            )
            # Inside a repeated card template the path is relative, so an
            # absolute one silently resolves against the whole data model.
            assert not binding["path"].startswith("/"), (
                f"{component}'s action context {field!r} must use a relative path"
            )

def _streamed_tool_result(payloads):
    """The single streamed TOOL_CALL_RESULT of a run."""
    results = [p for p in payloads if p["type"] == "TOOL_CALL_RESULT"]
    assert len(results) == 1, [p["type"] for p in payloads]
    return results[0]

def _snapshot_tool_message_ids(payloads):
    return [
        message["id"]
        for message in _snapshot_messages(payloads)
        if message.get("role") == "tool"
    ]

@BOTH_TRANSPORTS
async def test_fixed_schema_tool_result_keeps_one_message_id(monkeypatch, driver):
    """The streamed search result and the snapshot's copy of it are ONE message."""
    script = _TurnScript([
        _tool_call_turn("call_search", "search_hotels", HOTELS_ARGS,
                        "Here are your results.", "chatcmpl-2"),
        _text_turn("Anything else?", "chatcmpl-3"),
    ])
    monkeypatch.setattr(fixed_demo, "acompletion", script)

    payloads = await _drive_flow(
        driver, fixed_demo.A2UIFixedSchemaFlow(),
        [{"id": "m1", "role": "user", "content": "hotels in Paris please"}],
    )

    assert "RUN_ERROR" not in [p["type"] for p in payloads]
    streamed = _streamed_tool_result(payloads)
    assert _snapshot_tool_message_ids(payloads) == [streamed["messageId"]]

@BOTH_TRANSPORTS
async def test_dynamic_schema_tool_result_keeps_one_message_id(monkeypatch, driver):
    """Same for the sub-agent demo, whose TOOL_CALL_RESULT ``A2UITool.run`` emits:
    the id it streams has to be the id the flow persists."""
    script = _TurnScript([
        _tool_call_turn("call_gen", "generate_a2ui", '{"intent":"create"}',
                        "Rendered the comparison.", "chatcmpl-2"),
        _text_turn("Anything else?", "chatcmpl-3"),
    ])
    monkeypatch.setattr(subagent_demo, "acompletion", script)
    inner, inner_calls = _make_fake_acompletion([VALID_ARGS])
    monkeypatch.setattr(a2, "acompletion", inner)

    payloads = await _drive_flow(
        driver, subagent_demo_flow(),
        [{"id": "m1", "role": "user", "content": "compare 3 luxury hotels in Paris"}],
        forwarded_props={"injectA2UITool": True},
    )

    assert "RUN_ERROR" not in [p["type"] for p in payloads]
    assert inner_calls["n"] == 1
    streamed = _streamed_tool_result(payloads)
    assert _snapshot_tool_message_ids(payloads) == [streamed["messageId"]]


