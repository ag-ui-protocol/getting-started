"""Tests for the ADK A2UI subagent tool (OSS-158).

The adapter is a thin glue layer over ``ag-ui-a2ui-toolkit``: it owns the ADK
``BaseTool`` decorator, model bind + invoke (with explicit streaming), and the
per-run event-queue emission. The validate→retry recovery loop itself lives in
the toolkit and is exercised here through the adapter seam, mirroring the
LangGraph adapter's contract.
"""

from __future__ import annotations

import asyncio
import json
from typing import AsyncGenerator
from unittest.mock import patch

import pytest
from ag_ui.core import RunAgentInput, UserMessage
from google.adk.agents import LlmAgent
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.genai import types

from ag_ui_adk import get_a2ui_tool, CONTEXT_STATE_KEY, ADKAgent, A2UISubAgentTool
from ag_ui_adk.a2ui_tool import A2UI_SCHEMA_CONTEXT_DESCRIPTION


def _envelope_text(result) -> str:
    """``run_async`` returns the envelope as a dict so ADK serializes it as the
    bare envelope JSON the A2UI middleware inspects (rather than wrapping a string
    return as ``{"result": ...}``). Tests assert on that serialized text, so
    re-serialize the dict the same way ADK does."""
    return result if isinstance(result, str) else json.dumps(result)


# A structurally-valid single-root surface (no catalog, no children, no bindings).
VALID_ARGS = {
    "surfaceId": "s1",
    "components": [{"id": "root", "component": "Text", "text": "Hi"}],
}
# Structurally invalid: root's child "card" has no matching component (unresolved_child).
INVALID_ARGS = {
    "surfaceId": "s1",
    "components": [{"id": "root", "component": "Row", "children": ["card"]}],
}


class _FakeToolContext:
    """Minimal stand-in for ADK's ToolContext (only ``state`` is read here)."""

    def __init__(self, state=None):
        self.state = state if state is not None else {}


class _FakeEvent:
    """Stand-in for an ADK session Event carrying a genai Content turn."""

    def __init__(self, content, author):
        self.content = content
        self.author = author
        self.partial = False
        self.id = None

    def get_function_calls(self):
        return []

    def get_function_responses(self):
        return []


class _FakeSession:
    def __init__(self, events):
        self.events = events


class _FakeToolContextWithSession:
    """ToolContext stand-in exposing both ``state`` and ``session.events``."""

    def __init__(self, state=None, events=None):
        self.state = state if state is not None else {}
        self.session = _FakeSession(events or [])


def _user_event(text):
    return _FakeEvent(
        types.Content(role="user", parts=[types.Part(text=text)]), author="user"
    )


class _ToolResultEvent:
    """ADK session event carrying a generate_a2ui function RESPONSE, wrapped the
    way ADK wraps a string tool return: response = {"result": "<envelope json>"}."""

    def __init__(self, envelope_str, call_id):
        from types import SimpleNamespace

        self.content = types.Content(
            role="user", parts=[types.Part(text="(tool result)")]
        )
        self.author = "user"
        self.partial = False
        self.id = call_id
        self._fr = SimpleNamespace(response={"result": envelope_str}, id=call_id)

    def get_function_calls(self):
        return []

    def get_function_responses(self):
        return [self._fr]


class _RecordingRenderLlm(BaseLlm):
    """Records the LlmRequest it receives, then yields a valid render_a2ui call."""

    last_request: object = None

    async def generate_content_async(
        self, llm_request, stream: bool = False
    ) -> AsyncGenerator[LlmResponse, None]:
        type(self).last_request = llm_request
        yield LlmResponse(
            content=types.Content(
                role="model",
                parts=[
                    types.Part(
                        function_call=types.FunctionCall(
                            name="render_a2ui", args=VALID_ARGS
                        )
                    )
                ],
            ),
            partial=False,
            turn_complete=True,
        )


class _FreeformRenderLlm(BaseLlm):
    """Mimics Gemini under the free-form schema: returns components/data as JSON
    *strings* (not structured arrays/objects)."""

    async def generate_content_async(
        self, llm_request, stream: bool = False
    ) -> AsyncGenerator[LlmResponse, None]:
        yield LlmResponse(
            content=types.Content(
                role="model",
                parts=[
                    types.Part(
                        function_call=types.FunctionCall(
                            name="render_a2ui",
                            args={
                                "surfaceId": "s1",
                                "components": json.dumps(
                                    [{"id": "root", "component": "Text", "text": "Hi"}]
                                ),
                                "data": "{}",
                            },
                        )
                    )
                ],
            ),
            partial=False,
            turn_complete=True,
        )


def _drain(queue: asyncio.Queue) -> list:
    """Pop every event currently queued (non-blocking)."""
    out = []
    while not queue.empty():
        out.append(queue.get_nowait())
    return out


class _ScriptedRenderLlm(BaseLlm):
    """Test double: yields a ``render_a2ui`` function call per turn.

    ``scripts`` is a list of ``args`` dicts (one per attempt). Each
    ``generate_content_async`` call pops the next script and yields a single
    final ``LlmResponse`` carrying a ``render_a2ui`` FunctionCall with those
    args. A ``None`` entry yields a no-tool-call text response instead.
    """

    scripts: list = []
    calls: int = 0
    prompts: list = []

    async def generate_content_async(
        self, llm_request, stream: bool = False
    ) -> AsyncGenerator[LlmResponse, None]:
        idx = self.calls
        self.calls += 1
        # Record the user prompt this attempt received (to assert re-augmentation).
        try:
            self.prompts.append(llm_request.contents[-1].parts[0].text)
        except (AttributeError, IndexError, TypeError):
            self.prompts.append(None)
        args = self.scripts[idx] if idx < len(self.scripts) else None
        if args is None:
            yield LlmResponse(
                content=types.Content(
                    role="model", parts=[types.Part(text="(no tool call)")]
                ),
                partial=False,
                turn_complete=True,
            )
            return
        yield LlmResponse(
            content=types.Content(
                role="model",
                parts=[
                    types.Part(
                        function_call=types.FunctionCall(name="render_a2ui", args=args)
                    )
                ],
            ),
            partial=False,
            turn_complete=True,
        )


def test_factory_returns_tool_named_generate_a2ui():
    tool = get_a2ui_tool({"model": _ScriptedRenderLlm(model="scripted")})

    assert tool.name == "generate_a2ui"
    assert tool.description


@pytest.mark.asyncio
async def test_valid_first_attempt_emits_envelope_and_tool_call_events():
    model = _ScriptedRenderLlm(model="scripted", scripts=[VALID_ARGS])
    tool = get_a2ui_tool({"model": model})
    queue: asyncio.Queue = asyncio.Queue()
    tool.event_queue = queue

    result = await tool.run_async(
        args={"intent": "create"}, tool_context=_FakeToolContext()
    )

    # A validated surface was committed as an operations envelope.
    assert "a2ui_operations" in _envelope_text(result)
    envelope = json.loads(_envelope_text(result))
    assert "a2ui_operations" in envelope

    # Exactly one model attempt (valid on first try — no retry).
    assert model.calls == 1

    # The nested render_a2ui tool call streamed onto the run queue, framed by a
    # single stable id: START ... ARGS ... END.
    events = _drain(queue)
    type_names = [type(e).__name__ for e in events]
    assert type_names[0] == "ToolCallStartEvent"
    assert type_names[-1] == "ToolCallEndEvent"
    assert "ToolCallArgsEvent" in type_names
    assert events[0].tool_call_name == "render_a2ui"
    ids = {e.tool_call_id for e in events}
    assert len(ids) == 1


@pytest.mark.asyncio
async def test_invalid_first_attempt_recovers_and_reuses_stable_id():
    # Attempt 1: unresolved-child (invalid). Attempt 2: valid.
    model = _ScriptedRenderLlm(model="scripted", scripts=[INVALID_ARGS, VALID_ARGS])
    attempts: list = []
    tool = get_a2ui_tool({"model": model, "on_a2ui_attempt": attempts.append})
    queue: asyncio.Queue = asyncio.Queue()
    tool.event_queue = queue

    result = await tool.run_async(
        args={"intent": "create"}, tool_context=_FakeToolContext()
    )

    # Two attempts; only the valid surface (Text root) is committed — the faulty
    # Row-with-unresolved-child never reaches the envelope.
    assert model.calls == 2
    assert "Text" in _envelope_text(result) and "Row" not in _envelope_text(result)
    assert [a["ok"] for a in attempts] == [False, True]

    # The retry prompt was re-augmented with the prior attempt's structured error.
    assert "Previous attempt was invalid" in model.prompts[1]

    # Both attempts streamed under the SAME stable nested id (swap-in-place).
    events = _drain(queue)
    starts = [e for e in events if type(e).__name__ == "ToolCallStartEvent"]
    assert len(starts) == 2
    assert len({e.tool_call_id for e in events}) == 1


@pytest.mark.asyncio
async def test_exhaustion_returns_recovery_exhausted_envelope():
    # Every attempt invalid → recovery cap (3) hit → structured hard-failure.
    model = _ScriptedRenderLlm(
        model="scripted", scripts=[INVALID_ARGS, INVALID_ARGS, INVALID_ARGS]
    )
    tool = get_a2ui_tool({"model": model})
    queue: asyncio.Queue = asyncio.Queue()
    tool.event_queue = queue

    result = await tool.run_async(
        args={"intent": "create"}, tool_context=_FakeToolContext()
    )

    assert model.calls == 3
    envelope = json.loads(_envelope_text(result))
    assert envelope["code"] == "a2ui_recovery_exhausted"
    # No faulty surface committed.
    assert "a2ui_operations" not in _envelope_text(result)


@pytest.mark.asyncio
async def test_context_and_schema_routed_into_subagent_prompt():
    # The ADK middleware stores AG-UI context (flat {description, value} list)
    # under CONTEXT_STATE_KEY. The adapter must remap it into the toolkit's
    # state["ag-ui"] view, splitting the A2UI schema entry out of regular context.
    model = _ScriptedRenderLlm(model="scripted", scripts=[VALID_ARGS])
    tool = get_a2ui_tool({"model": model})
    tool.event_queue = asyncio.Queue()
    state = {
        CONTEXT_STATE_KEY: [
            {"description": "User preferences", "value": "dark mode please"},
            {
                "description": A2UI_SCHEMA_CONTEXT_DESCRIPTION,
                "value": "Card, Text, Row",
            },
        ]
    }

    await tool.run_async(
        args={"intent": "create"}, tool_context=_FakeToolContext(state=state)
    )

    prompt = model.prompts[0]
    assert "User preferences" in prompt
    assert "dark mode please" in prompt
    # The schema rides the "Available Components" section, not generic context.
    assert "Card, Text, Row" in prompt


def test_for_run_returns_isolated_clone_with_event_queue():
    # The construction-time tool is shared across concurrent runs; each run must
    # get its OWN clone carrying that run's queue, leaving the original untouched.
    tool = get_a2ui_tool({"model": _ScriptedRenderLlm(model="scripted")})
    queue: asyncio.Queue = asyncio.Queue()

    clone = tool.for_run(queue)

    assert clone is not tool
    assert clone.event_queue is queue
    assert tool.event_queue is None  # original never mutated
    assert clone.name == tool.name


@pytest.mark.asyncio
async def test_subagent_call_mirrors_langgraph_system_instruction_and_conversation():
    # Apples-to-apples with LangGraph's `[SystemMessage(prompt), *messages]`:
    # the assembled subagent prompt must ride as system_instruction, and the real
    # conversation messages must be forwarded as contents (not the prompt as a
    # lone user turn, and not the user request smuggled in as a context entry).
    model = _RecordingRenderLlm(model="rec")
    tool = get_a2ui_tool(
        {"model": model, "guidelines": {"composition_guide": "USE Row + HotelCard."}}
    )
    tool.event_queue = asyncio.Queue()
    ctx = _FakeToolContextWithSession(
        state={},
        events=[_user_event("Compare 3 luxury hotels with ratings and prices.")],
    )

    await tool.run_async(args={"intent": "create"}, tool_context=ctx)

    req = _RecordingRenderLlm.last_request
    # Assembled prompt (guidelines etc.) rides as system_instruction.
    sysi = req.config.system_instruction
    sysi_text = sysi if isinstance(sysi, str) else str(sysi)
    assert "HotelCard" in sysi_text  # composition guide reached system_instruction

    # The real conversation is forwarded as contents (a user turn with the request).
    user_texts = [
        p.text
        for c in req.contents
        for p in (c.parts or [])
        if getattr(p, "text", None)
    ]
    assert any("luxury hotels" in t for t in user_texts)
    # The prompt is NOT duplicated into a user content turn.
    assert not any("HotelCard" in t for t in user_texts)


@pytest.mark.asyncio
async def test_update_intent_finds_prior_surface_and_skips_create():
    # intent="update" must locate the PRIOR render in ADK session history and
    # produce an UPDATE (no createSurface). The prior generate_a2ui result is
    # stored by ADK as a wrapped/serialized function response, which the adapter
    # must unwrap so the toolkit's find_prior_surface can read a2ui_operations.
    prior_env = json.dumps(
        {
            "a2ui_operations": [
                {
                    "version": "v0.9",
                    "createSurface": {
                        "surfaceId": "hotel-comparison",
                        "catalogId": "cat://dynamic",
                    },
                },
                {
                    "version": "v0.9",
                    "updateComponents": {
                        "surfaceId": "hotel-comparison",
                        "components": [{"id": "root", "component": "Row"}],
                    },
                },
            ]
        }
    )
    tool = get_a2ui_tool({"model": _FreeformRenderLlm(model="ff")})
    tool.event_queue = asyncio.Queue()
    ctx = _FakeToolContextWithSession(
        state={},
        events=[
            _ToolResultEvent(prior_env, "call_prev"),
            _user_event("Make the layout a single column instead of a row."),
        ],
    )

    result = await tool.run_async(
        args={
            "intent": "update",
            "target_surface_id": "hotel-comparison",
            "changes": "use a column layout",
        },
        tool_context=ctx,
    )

    # Prior was found (not an error envelope) and committed as an UPDATE.
    assert "a2ui_operations" in _envelope_text(result), result
    assert "createSurface" not in _envelope_text(
        result
    )  # update reuses the surface, never re-creates
    env = json.loads(_envelope_text(result))
    assert any("updateComponents" in op for op in env["a2ui_operations"])


@pytest.mark.asyncio
async def test_render_tool_declares_components_and_data_as_freeform_strings():
    # Gemini fills typed `array<object>`/`object` args strictly -> empty {}.
    # The adapter declares components/data as STRING so Gemini writes free-form
    # JSON it can actually populate.
    model = _RecordingRenderLlm(model="rec")
    tool = get_a2ui_tool({"model": model})
    tool.event_queue = asyncio.Queue()

    await tool.run_async(args={"intent": "create"}, tool_context=_FakeToolContext())

    req = _RecordingRenderLlm.last_request
    props = req.config.tools[0].function_declarations[0].parameters.properties
    assert props["components"].type == types.Type.STRING
    assert props["data"].type == types.Type.STRING


@pytest.mark.asyncio
async def test_freeform_string_args_are_parsed_into_a_structured_surface():
    # When Gemini returns components/data as JSON strings, the adapter parses them
    # back into the structured shape the toolkit validates and commits.
    tool = get_a2ui_tool({"model": _FreeformRenderLlm(model="ff")})
    tool.event_queue = asyncio.Queue()

    result = await tool.run_async(
        args={"intent": "create"}, tool_context=_FakeToolContext()
    )

    assert "a2ui_operations" in _envelope_text(result)
    env = json.loads(_envelope_text(result))
    comps = next(
        op["updateComponents"]["components"]
        for op in env["a2ui_operations"]
        if "updateComponents" in op
    )
    # Parsed into a real component object, not left as a JSON string.
    assert comps[0]["component"] == "Text"
    assert comps[0]["id"] == "root"


@pytest.mark.asyncio
async def test_adk_agent_injects_per_run_event_queue_into_a2ui_tool():
    # ADKAgent must swap the shared A2UISubAgentTool for a per-run clone carrying
    # this run's event_queue (so the tool can emit nested tool-call events),
    # leaving the construction-time tool untouched for concurrent runs.
    a2ui = get_a2ui_tool({"model": _ScriptedRenderLlm(model="scripted")})
    root = LlmAgent(name="root", instruction="be helpful", tools=[a2ui])
    agent = ADKAgent(
        adk_agent=root,
        app_name="a2ui_app",
        user_id="u",
        use_in_memory_services=True,
    )

    captured: list = []

    async def _noop(self, **kwargs):
        captured.append(kwargs)
        return None

    with patch.object(ADKAgent, "_run_adk_in_background", _noop):
        execution = await agent._start_background_execution(
            RunAgentInput(
                thread_id="thread-A",
                run_id="run_A",
                messages=[UserMessage(id="m1", role="user", content="hi")],
                context=[],
                state={},
                tools=[],
                forwarded_props={},
            )
        )
        await asyncio.gather(execution.task, return_exceptions=True)

    run_tree = captured[0]["adk_agent"]
    run_queue = captured[0]["event_queue"]
    run_tool = run_tree.tools[0]

    assert isinstance(run_tool, A2UISubAgentTool)
    assert run_tool.event_queue is run_queue  # per-run queue injected
    assert run_tool is not a2ui  # replaced, not the shared original
    assert a2ui.event_queue is None  # construction-time tool untouched


# ---------------------------------------------------------------------------
# Auto-inject decision — plan_a2ui_injection
#
# Mirrors the Strands suite (integrations/aws-strands/python/tests/
# test_a2ui_tool.py). String literals mirror the shared wire contracts
# (GENERATE_A2UI_TOOL_NAME from the toolkit, render_a2ui +
# A2UI_SCHEMA_CONTEXT_DESCRIPTION from the middleware), hardcoded ON PURPOSE so
# the suite fails if an upstream constant drifts.
# ---------------------------------------------------------------------------

from unittest.mock import MagicMock

from ag_ui.core import Context
from ag_ui_adk import is_auto_injected_a2ui_tool, plan_a2ui_injection

_GENERATE_A2UI_TOOL_NAME = "generate_a2ui"
_RENDER_A2UI_TOOL_NAME = "render_a2ui"
_STUB_MODEL = MagicMock(name="stub-model")
_CATALOG = {
    "components": {
        "Row": {"required": ["children"]},
        "HotelCard": {"required": ["name", "rating"]},
    }
}


def _plan_input(forwarded_props=None, context=None, tools=None) -> RunAgentInput:
    return RunAgentInput(
        thread_id="thread-1",
        run_id="run-1",
        state={},
        messages=[],
        tools=tools or [],
        context=context or [],
        forwarded_props=forwarded_props or {},
    )


def test_plan_injects_when_flag_true_and_model_present():
    plan = plan_a2ui_injection(
        model=_STUB_MODEL,
        input=_plan_input(forwarded_props={"injectA2UITool": True}),
        existing_tool_names=[],
    )
    assert plan is not None
    assert plan["tool_name"] == _GENERATE_A2UI_TOOL_NAME
    assert _RENDER_A2UI_TOOL_NAME in plan["drop_tool_names"]
    assert isinstance(plan["tool"], A2UISubAgentTool)


def test_plan_drops_custom_named_render_tool_when_flag_is_string():
    plan = plan_a2ui_injection(
        model=_STUB_MODEL,
        input=_plan_input(forwarded_props={"injectA2UITool": "render_ui_custom"}),
        existing_tool_names=[],
    )
    assert plan is not None
    assert "render_ui_custom" in plan["drop_tool_names"]


def test_plan_skips_and_warns_when_no_model_inferable():
    log = MagicMock()
    plan = plan_a2ui_injection(
        model=None,
        input=_plan_input(forwarded_props={"injectA2UITool": True}),
        existing_tool_names=[],
        log=log,
    )
    assert plan is None
    log.warning.assert_called_once()


def test_plan_no_inject_without_flag_or_override():
    plan = plan_a2ui_injection(
        model=_STUB_MODEL,
        input=_plan_input(),
        existing_tool_names=[],
    )
    assert plan is None


def test_plan_backend_override_injects_without_runtime_flag():
    plan = plan_a2ui_injection(
        model=_STUB_MODEL,
        input=_plan_input(),
        existing_tool_names=[],
        config={"inject_a2ui_tool": True},
    )
    assert plan is not None
    assert plan["tool_name"] == _GENERATE_A2UI_TOOL_NAME


def test_plan_runtime_false_disables_backend_override():
    # Explicit runtime injectA2UITool=False wins over a backend opt-in.
    plan = plan_a2ui_injection(
        model=_STUB_MODEL,
        input=_plan_input(forwarded_props={"injectA2UITool": False}),
        existing_tool_names=[],
        config={"inject_a2ui_tool": True},
    )
    assert plan is None


def test_plan_user_prevails_no_double_inject():
    # THE "USER PREVAILS" REQUIREMENT: explicit dev wiring wins.
    plan = plan_a2ui_injection(
        model=_STUB_MODEL,
        input=_plan_input(forwarded_props={"injectA2UITool": True}),
        existing_tool_names=[_GENERATE_A2UI_TOOL_NAME],
    )
    assert plan is None


def test_plan_resolves_catalog_from_schema_context_entry():
    plan = plan_a2ui_injection(
        model=_STUB_MODEL,
        input=_plan_input(
            forwarded_props={"injectA2UITool": True},
            context=[
                Context(
                    description=A2UI_SCHEMA_CONTEXT_DESCRIPTION,
                    value=json.dumps(_CATALOG),
                )
            ],
        ),
        existing_tool_names=[],
    )
    assert plan is not None
    assert plan["catalog"] == _CATALOG


def test_plan_marker_distinguishes_auto_injected_from_dev_wired():
    plan = plan_a2ui_injection(
        model=_STUB_MODEL,
        input=_plan_input(forwarded_props={"injectA2UITool": True}),
        existing_tool_names=[],
    )
    assert plan is not None
    assert is_auto_injected_a2ui_tool(plan["tool"]) is True
    # A dev-wired tool carries no marker.
    assert is_auto_injected_a2ui_tool(get_a2ui_tool({"model": _STUB_MODEL})) is False


@pytest.mark.asyncio
async def test_adk_agent_auto_injects_generate_a2ui_when_flag_forwarded():
    # No A2UI tool wired on the agent; the runtime flag triggers injection of a
    # per-run generate_a2ui bound to this run's event_queue.
    root = LlmAgent(
        name="root",
        model=_ScriptedRenderLlm(model="scripted"),
        instruction="be helpful",
    )
    agent = ADKAgent(
        adk_agent=root,
        app_name="a2ui_app",
        user_id="u",
        use_in_memory_services=True,
        a2ui={"default_catalog_id": "cat-1"},
    )

    captured: list = []

    async def _noop(self, **kwargs):
        captured.append(kwargs)
        return None

    with patch.object(ADKAgent, "_run_adk_in_background", _noop):
        execution = await agent._start_background_execution(
            RunAgentInput(
                thread_id="thread-A",
                run_id="run_A",
                messages=[UserMessage(id="m1", role="user", content="hi")],
                context=[],
                state={},
                tools=[],
                forwarded_props={"injectA2UITool": True},
            )
        )
        await asyncio.gather(execution.task, return_exceptions=True)

    run_tree = captured[0]["adk_agent"]
    run_queue = captured[0]["event_queue"]
    injected = [t for t in run_tree.tools if isinstance(t, A2UISubAgentTool)]

    assert len(injected) == 1
    assert injected[0].name == _GENERATE_A2UI_TOOL_NAME
    assert is_auto_injected_a2ui_tool(injected[0]) is True
    assert injected[0].event_queue is run_queue  # per-run queue bound
    # The construction-time agent stays clean (no A2UI tool leaks onto it).
    assert not any(isinstance(t, A2UISubAgentTool) for t in (root.tools or []))


@pytest.mark.asyncio
async def test_adk_agent_no_auto_inject_without_flag():
    root = LlmAgent(
        name="root",
        model=_ScriptedRenderLlm(model="scripted"),
        instruction="be helpful",
    )
    agent = ADKAgent(
        adk_agent=root,
        app_name="a2ui_app",
        user_id="u",
        use_in_memory_services=True,
        a2ui={"default_catalog_id": "cat-1"},
    )

    captured: list = []

    async def _noop(self, **kwargs):
        captured.append(kwargs)
        return None

    with patch.object(ADKAgent, "_run_adk_in_background", _noop):
        execution = await agent._start_background_execution(
            RunAgentInput(
                thread_id="thread-A",
                run_id="run_A",
                messages=[UserMessage(id="m1", role="user", content="hi")],
                context=[],
                state={},
                tools=[],
                forwarded_props={},  # no injectA2UITool
            )
        )
        await asyncio.gather(execution.task, return_exceptions=True)

    run_tree = captured[0]["adk_agent"]
    assert not any(isinstance(t, A2UISubAgentTool) for t in (run_tree.tools or []))


@pytest.mark.asyncio
async def test_adk_agent_user_prevails_over_auto_inject():
    # USER PREVAILS: a dev-wired generate_a2ui beats auto-injection even when
    # the runtime forwards injectA2UITool. Exactly one tool survives — the
    # dev's (no marker) — and it still gets this run's event_queue bound.
    dev_tool = get_a2ui_tool({"model": _ScriptedRenderLlm(model="scripted")})
    root = LlmAgent(
        name="root",
        model=_ScriptedRenderLlm(model="scripted"),
        instruction="be helpful",
        tools=[dev_tool],
    )
    agent = ADKAgent(
        adk_agent=root,
        app_name="a2ui_app",
        user_id="u",
        use_in_memory_services=True,
        a2ui={"default_catalog_id": "cat-1"},
    )

    captured: list = []

    async def _noop(self, **kwargs):
        captured.append(kwargs)
        return None

    with patch.object(ADKAgent, "_run_adk_in_background", _noop):
        execution = await agent._start_background_execution(
            RunAgentInput(
                thread_id="thread-A",
                run_id="run_A",
                messages=[UserMessage(id="m1", role="user", content="hi")],
                context=[],
                state={},
                tools=[],
                forwarded_props={"injectA2UITool": True},
            )
        )
        await asyncio.gather(execution.task, return_exceptions=True)

    run_tree = captured[0]["adk_agent"]
    run_queue = captured[0]["event_queue"]
    a2ui_tools = [t for t in run_tree.tools if isinstance(t, A2UISubAgentTool)]

    assert len(a2ui_tools) == 1  # no double-inject
    assert is_auto_injected_a2ui_tool(a2ui_tools[0]) is False  # the dev's tool
    assert a2ui_tools[0].event_queue is run_queue  # still per-run bound
