"""Crew-chat feature suite: ``ChatWithCrewFlow`` / crew-serving behaviour.

Covers the crew-invocation branch (a tool call names the crew, ``chat`` runs
the crew tool and records its output), the LLM connection-field forwarding
into ``acompletion``, the text follow-up after a backend tool result, the
crew-run state snapshot, real ``@CrewBase`` name reads + unnamed-crew errors,
the identity-safe crew-inputs cache, and the package top-level exports.

The tests exercise REAL crewai objects; only the LLM NETWORK boundary is
stubbed (crewai's ``generate_*_with_ai`` helpers and ``acompletion`` /
``copilotkit_stream``) so nothing reaches the network, while the real
``generate_crew_chat_inputs`` / ``ChatInputs`` are otherwise untouched.
"""

import gc
import json
import weakref
from contextlib import contextmanager
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

# The crew-chat helpers (and the two ``generate_*_with_ai``
# network helpers ``_stub_llm_network`` patches) moved from
# ``crewai.cli.crew_chat`` (0.x - 1.14) to ``crewai.utilities.crew_chat``
# (1.15+). Resolve whichever the installed crewai exposes so the stub patches
# the module ``generate_crew_chat_inputs`` actually calls into.
try:
    import crewai.utilities.crew_chat as crew_chat_mod
except ImportError:  # pragma: no cover - crewai 0.x fallback
    import crewai.cli.crew_chat as crew_chat_mod
from crewai import Agent, Crew, CrewOutput, LLM, Task
from crewai.project import CrewBase, agent, crew, task
from crewai.flow.flow import Flow, start
from crewai.types.crew_chat import ChatInputs

from ag_ui.core import EventType, Tool, UserMessage
from ag_ui_crewai import crews as crews_mod
from ag_ui_crewai import endpoint as ep
from ag_ui_crewai.context import flow_context


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------

@contextmanager
def _patch_instance_state(flow, state):
    """Install ``state`` on a single flow instance via a throwaway subclass.

    ``Flow.state`` is a class-level descriptor; rebind ``__class__`` to a
    per-instance subclass exposing ``state`` as a plain property so parallel
    tests cannot race on the shared descriptor."""
    flow._state = state  # pylint: disable=protected-access
    original_cls = type(flow)
    subclass = type(
        f"{original_cls.__name__}_StatePatched",
        (original_cls,),
        {"state": property(lambda self: self._state)},
    )
    flow.__class__ = subclass
    try:
        yield
    finally:
        if flow.__class__ is subclass:
            flow.__class__ = original_cls


def _drain(queue):
    items = []
    while not queue.empty():
        items.append(queue.get_nowait())
    return items


@contextmanager
def _stub_llm_network():
    """Stub ONLY crewai's LLM-calling description helpers so the real
    ``generate_crew_chat_inputs`` + real ``ChatInputs`` still run offline.

    The prior approach replaced ``crew_chat_generate_crew_chat_inputs``
    wholesale, so the real ``ChatInputs`` construction (and the
    ``crew_name`` it validates) never ran. Here we patch one level
    deeper — the two functions that make the
    actual ``chat_llm.call`` network requests — leaving the generator and
    the Pydantic model untouched.
    """
    with patch.object(
        crew_chat_mod, "generate_input_description_with_ai",
        lambda *a, **k: "an input field",
    ), patch.object(
        crew_chat_mod, "generate_crew_description_with_ai",
        lambda *a, **k: "a real crew",
    ):
        yield


def _make_real_crewbase(cls_name="ResearchCrew"):
    """Construct and return a REAL ``@CrewBase``-decorated instance.

    crewai's ``@CrewBase`` sets ``_crew_name`` (to the class ``__name__``)
    and exposes a ``crew()`` factory — it does NOT expose ``.name``. That
    is exactly the shape the name-read fix must handle.
    """
    @CrewBase
    class _Crew:
        @agent
        def researcher(self) -> Agent:
            return Agent(
                role="researcher", goal="research {topic}",
                backstory="an expert",
                llm=LLM(model="gpt-4o", api_key="k"),
            )

        @task
        def research_task(self) -> Task:
            return Task(
                description="Research {topic} thoroughly",
                expected_output="a report",
                agent=self.researcher(),
            )

        @crew
        def crew(self) -> Crew:
            return Crew(
                agents=self.agents, tasks=self.tasks,
                chat_llm=LLM(model="gpt-4o", api_key="k"),
            )

    _Crew.__name__ = cls_name
    _Crew._crew_name = cls_name
    return _Crew()


def _build_real_crew() -> Crew:
    """Build a REAL ``crewai.Crew`` (like the repo's own ``CrewChatCrew``)
    without ``@CrewBase`` so no config lookups or init-time LLM calls fire.
    Shared by the value-equal and non-weakref-able cache-test wrappers."""
    assistant = Agent(
        role="assistant", goal="help with {topic}",
        backstory="a helpful assistant",
        llm=LLM(model="gpt-4o", api_key="k"),
    )
    assist_task = Task(
        description="Handle {topic}", expected_output="a response",
        agent=assistant,
    )
    return Crew(
        agents=[assistant], tasks=[assist_task],
        chat_llm=LLM(model="gpt-4o", api_key="k"),
    )


class _ValueEqualCrew:
    """Crew wrapper with VALUE-BASED ``__eq__`` / ``__hash__``.

    Defined once at module level (NOT per factory call) so two instances
    share the same class and ``isinstance`` in ``__eq__`` succeeds. Two
    instances built with the same ``equal_key`` are distinct objects that
    compare equal and hash equal — the exact shape a ``WeakKeyDictionary``
    would collapse to a single (cross-serving) cache entry. Its ``crew()``
    returns a REAL ``crewai.Crew``.
    """

    def __init__(self, cls_name, equal_key):
        self._crew_name = cls_name
        self._key = equal_key

    def __eq__(self, other):
        return isinstance(other, _ValueEqualCrew) and self._key == other._key

    def __hash__(self):
        return hash(self._key)

    def crew(self) -> Crew:
        return _build_real_crew()


def _make_value_equal_crew(*, cls_name, equal_key):
    return _ValueEqualCrew(cls_name, equal_key)


class _NonWeakrefableCrew:
    """Crew wrapper that CANNOT be weak-referenced.

    ``__slots__`` without a ``__weakref__`` entry makes instances reject
    ``weakref.ref``, exercising the cache's non-weakref-able skip path.
    Its ``crew()`` returns a REAL ``crewai.Crew``.
    """

    __slots__ = ("_crew_name",)

    def __init__(self, cls_name):
        self._crew_name = cls_name

    def crew(self) -> Crew:
        return _build_real_crew()


def _make_non_weakrefable_crew(*, cls_name):
    return _NonWeakrefableCrew(cls_name)


def _new_crew_flow(*, chat_llm=None, crew_model="crew-model-string"):
    """Build a ``ChatWithCrewFlow`` via ``__new__`` with the minimal
    attributes the ``chat`` method reads, bypassing the LLM-calling
    constructor. ``chat_llm`` is a real ``crewai.LLM`` in the callers."""
    flow = crews_mod.ChatWithCrewFlow.__new__(crews_mod.ChatWithCrewFlow)
    flow.crew = type("C", (), {"chat_llm": crew_model})()
    if chat_llm is not None:
        flow.chat_llm = chat_llm
    flow.crew_name = "dummy"
    flow.crew_tool_schema = {
        "type": "function",
        "function": {"name": "dummy", "description": "", "parameters": {"type": "object"}},
    }
    flow.system_message = "sys"
    return flow


# --------------------------------------------------------------------------
# Crew-invocation branch: run the crew tool and record its output
# --------------------------------------------------------------------------

async def test_chat_runs_crew_and_records_string_output():
    """A crew tool call runs the crew fn, records its string result, appends a
    ``tool`` message, then issues a follow-up completion so the assistant
    speaks. Strengthened from the pre-fix 2-message version that
    encoded the silent-assistant bug."""
    async def _fake_acompletion(**_kwargs):
        return object()

    # Stateful stream mock: turn 1 names the crew tool; the follow-up
    # turn returns plain text.
    stream_calls = {"n": 0}

    async def _fake_stream(_resp):
        stream_calls["n"] += 1
        if stream_calls["n"] == 1:
            class _Resp:
                choices = [{
                    "message": {
                        "role": "assistant",
                        "tool_calls": [{
                            "id": "call-crew",
                            "function": {"name": "dummy", "arguments": '{"topic": "ai"}'},
                        }],
                    }
                }]
            return _Resp()

        class _FollowUp:
            choices = [{
                "message": {
                    "role": "assistant",
                    "content": "Here is what the crew produced.",
                }
            }]
        return _FollowUp()

    captured = {}

    def _fake_tool_factory(crew, messages):  # pylint: disable=unused-argument
        def _fn(**kwargs):
            captured["args"] = kwargs
            return "CREW OUTPUT"
        return _fn

    flow = crews_mod.ChatWithCrewFlow.__new__(crews_mod.ChatWithCrewFlow)
    flow.crew = type("C", (), {"chat_llm": "gpt-4o"})()
    flow.crew_name = "dummy"
    flow.crew_tool_schema = {
        "type": "function",
        "function": {"name": "dummy", "description": "", "parameters": {"type": "object"}},
    }
    flow.system_message = "sys"
    state = {"messages": [], "inputs": {"topic": "ai"}, "copilotkit": {"actions": []}}

    with _patch_instance_state(flow, state):
        with patch.object(crews_mod, "acompletion", _fake_acompletion):
            with patch.object(crews_mod, "copilotkit_stream", _fake_stream):
                with patch.object(
                    crews_mod, "crew_chat_create_tool_function", _fake_tool_factory
                ):
                    await flow.chat()

    assert captured["args"] == {"topic": "ai"}
    assert state["outputs"] == "CREW OUTPUT"
    # Three messages: assistant tool-call, tool result, follow-up text.
    assert len(state["messages"]) == 3
    tool_message = state["messages"][1]
    assert tool_message["role"] == "tool"
    assert tool_message["content"] == "CREW OUTPUT"
    assert tool_message["tool_call_id"] == "call-crew"
    assert stream_calls["n"] == 2
    follow_up = state["messages"][-1]
    assert follow_up["role"] == "assistant"
    assert follow_up["content"] == "Here is what the crew produced."


async def test_chat_crew_output_from_raw_attribute():
    """A crew result exposing ``.raw`` (and no ``.json_dict``) records ``raw``."""
    async def _fake_acompletion(**_kwargs):
        return object()

    async def _fake_stream(_resp):
        class _Resp:
            choices = [{
                "message": {
                    "role": "assistant",
                    "tool_calls": [{
                        "id": "call-crew",
                        "function": {"name": "dummy", "arguments": "{}"},
                    }],
                }
            }]
        return _Resp()

    class _CrewResult:
        raw = "raw-output"

    def _fake_tool_factory(crew, messages):  # pylint: disable=unused-argument
        return lambda **_kwargs: _CrewResult()

    flow = crews_mod.ChatWithCrewFlow.__new__(crews_mod.ChatWithCrewFlow)
    flow.crew = type("C", (), {"chat_llm": "gpt-4o"})()
    flow.crew_name = "dummy"
    flow.crew_tool_schema = {
        "type": "function",
        "function": {"name": "dummy", "description": "", "parameters": {"type": "object"}},
    }
    flow.system_message = "sys"
    state = {"messages": [], "inputs": {}, "copilotkit": {"actions": []}}

    with _patch_instance_state(flow, state):
        with patch.object(crews_mod, "acompletion", _fake_acompletion):
            with patch.object(crews_mod, "copilotkit_stream", _fake_stream):
                with patch.object(
                    crews_mod, "crew_chat_create_tool_function", _fake_tool_factory
                ):
                    await flow.chat()

    assert state["outputs"] == "raw-output"


async def _run_chat_with_crew_result(crew_result):
    """Drive ``ChatWithCrewFlow.chat`` once where the crew tool returns
    ``crew_result``; return the resulting ``state``.

    Turn 1 of the stubbed stream names the crew tool; the defect-2 follow-up
    turn returns plain assistant text, so ``state['messages']`` ends as
    ``[assistant tool-call, tool result, follow-up text]``. Only the crew
    tool factory and the LLM network boundary are stubbed — the real
    ``chat`` crew-run branch under test runs unchanged.
    """
    async def _fake_acompletion(**_kwargs):
        return object()

    stream_calls = {"n": 0}

    async def _fake_stream(_resp):
        stream_calls["n"] += 1
        if stream_calls["n"] == 1:
            class _Resp:
                choices = [{
                    "message": {
                        "role": "assistant",
                        "tool_calls": [{
                            "id": "call-crew",
                            "function": {"name": "dummy", "arguments": "{}"},
                        }],
                    }
                }]
            return _Resp()

        class _FollowUp:
            choices = [{
                "message": {"role": "assistant", "content": "done"}
            }]
        return _FollowUp()

    def _fake_tool_factory(crew, messages):  # pylint: disable=unused-argument
        return lambda **_kwargs: crew_result

    flow = crews_mod.ChatWithCrewFlow.__new__(crews_mod.ChatWithCrewFlow)
    flow.crew = type("C", (), {"chat_llm": "gpt-4o"})()
    flow.crew_name = "dummy"
    flow.crew_tool_schema = {
        "type": "function",
        "function": {"name": "dummy", "description": "", "parameters": {"type": "object"}},
    }
    flow.system_message = "sys"
    state = {"messages": [], "inputs": {}, "copilotkit": {"actions": []}}

    with _patch_instance_state(flow, state):
        with patch.object(crews_mod, "acompletion", _fake_acompletion):
            with patch.object(crews_mod, "copilotkit_stream", _fake_stream):
                with patch.object(
                    crews_mod, "crew_chat_create_tool_function", _fake_tool_factory
                ):
                    await flow.chat()
    return state


async def test_chat_crew_output_real_crewoutput_text_result_records_string():
    """A text-producing ``CrewOutput`` (``.raw`` set, ``.json_dict`` None) records
    its text as a string in ``state['outputs']`` and the tool message content,
    not ``None`` and not the raw object. Fails against the pre-fix
    ``hasattr``-gated code, which dropped the text to ``None``.
    """
    crew_output = CrewOutput(raw="the crew's final answer", json_dict=None)

    state = await _run_chat_with_crew_result(crew_output)

    assert state["outputs"] == "the crew's final answer"
    tool_message = next(m for m in state["messages"] if m.get("role") == "tool")
    assert tool_message["content"] == "the crew's final answer"
    assert isinstance(tool_message["content"], str)


async def test_chat_crew_output_real_crewoutput_structured_result_serializes_json():
    """A structured ``CrewOutput`` (``.json_dict`` populated) records the
    JSON-serialized string, not the raw object and not the non-JSON ``str()``
    repr. ``.raw`` is non-empty to prove ``json_dict`` wins over it.
    """
    payload = {"topic": "ai", "score": 9}
    crew_output = CrewOutput(raw="ignored raw text", json_dict=payload)
    expected = json.dumps(payload)

    state = await _run_chat_with_crew_result(crew_output)

    assert state["outputs"] == expected
    assert isinstance(state["outputs"], str)
    tool_message = next(m for m in state["messages"] if m.get("role") == "tool")
    assert tool_message["content"] == expected
    assert isinstance(tool_message["content"], str)


def test_crew_result_to_text_returns_string_across_branches():
    """``_crew_result_to_text`` returns a string for every result shape:
    plain str, ``json_dict``, ``pydantic``, string ``.raw``, and the
    ``str(result)`` fallback. A non-string ``.raw`` is never returned as-is —
    the helper's contract is to always yield a ``str``.
    """
    from pydantic import BaseModel

    class _Model(BaseModel):
        topic: str

    to_text = crews_mod._crew_result_to_text

    assert to_text("plain") == "plain"
    assert to_text(CrewOutput(raw="", json_dict={"a": 1})) == json.dumps({"a": 1})

    model = _Model(topic="ai")
    assert to_text(CrewOutput(raw="", pydantic=model)) == model.model_dump_json()

    assert to_text(CrewOutput(raw="hello", json_dict=None)) == "hello"

    # Empty raw with no structured output falls back to str(result), a string.
    assert isinstance(to_text(CrewOutput(raw="", json_dict=None)), str)

    # A non-string raw must not leak through unchanged (always returns str).
    class _NonStrRaw:
        json_dict = None
        pydantic = None
        raw = 123

    assert isinstance(to_text(_NonStrRaw()), str)


# --------------------------------------------------------------------------
# LLM connection fields forwarded to acompletion
# --------------------------------------------------------------------------

def test_completion_llm_kwargs_forwards_all_connection_fields_real_llm():
    """A REAL ``crewai.LLM`` carrying custom connection settings has ALL of
    them forwarded — model, api_key, api_base, api_version — plus
    provider-specific ``additional_params`` spread. The failing case
    built exactly this LLM and saw only model+api_key.

    The model string is ``gpt-4o`` rather than ``azure/deployment``
    because crewai 1.x eagerly loads a NATIVE provider for ``azure/*`` that
    requires the ``crewai[azure-ai-inference]`` extra — unrelated to the
    (provider-agnostic) field forwarding under test. On crewai 1.x ``LLM``
    routes ``api_version`` (and unknown kwargs) into ``additional_params``,
    which ``_completion_llm_kwargs`` spreads — so the forwarding still holds."""
    real_llm = LLM(
        model="gpt-4o",
        api_key="secret",
        api_base="https://azure.example",
        api_version="2024-02-01",
        custom_provider_param="xyz",
    )
    flow = _new_crew_flow(chat_llm=real_llm)
    kwargs = flow._completion_llm_kwargs()

    assert kwargs["model"] == "gpt-4o"
    assert kwargs["api_key"] == "secret"
    assert kwargs["api_base"] == "https://azure.example"
    # api_version is forwarded (a direct attr on crewai 0.x, routed through
    # additional_params on crewai 1.x — either way it lands in the kwargs).
    assert kwargs["api_version"] == "2024-02-01"
    # additional_params (litellm **kwargs on the crewai LLM) are spread.
    assert kwargs["custom_provider_param"] == "xyz"


def test_completion_llm_kwargs_forwards_base_url_when_set_real_llm():
    """A REAL ``crewai.LLM`` with ``base_url`` (local/self-hosted) forwards
    it (the original local-model repro).

    crewai 1.x normalises the stored ``base_url`` (e.g. appends
    ``/v1``), so we assert the forwarded value matches the LLM's OWN
    ``base_url`` attribute rather than a hard-coded literal — the point under
    test is that ``_completion_llm_kwargs`` forwards whatever the LLM exposes,
    not crewai's normalisation policy."""
    real_llm = LLM(model="ollama/llama3", api_key="sk-local",
                   base_url="http://localhost:11434")
    kwargs = _new_crew_flow(chat_llm=real_llm)._completion_llm_kwargs()
    assert kwargs["model"] == real_llm.model
    assert kwargs["api_key"] == "sk-local"
    assert kwargs["base_url"] == real_llm.base_url
    assert real_llm.base_url  # sanity: the LLM actually carries a base_url


def test_completion_llm_kwargs_omits_absent_connection_fields_real_llm():
    """A REAL ``crewai.LLM`` with only model+api_key forwards just those —
    absent api_base/api_version/base_url are never sent as ``None`` (which
    would override litellm's own resolution)."""
    real_llm = LLM(model="gpt-4o", api_key="sk-1")
    kwargs = _new_crew_flow(chat_llm=real_llm)._completion_llm_kwargs()
    assert kwargs == {"model": "gpt-4o", "api_key": "sk-1"}


def test_completion_llm_kwargs_falls_back_when_llm_unresolved():
    """With no resolved ``chat_llm``, the helper falls back to the crew's
    model string and forwards only the model."""
    flow = _new_crew_flow(chat_llm=None, crew_model="gpt-4o")
    assert flow._completion_llm_kwargs() == {"model": "gpt-4o"}


def test_completion_llm_kwargs_forwards_generation_config_real_llm():
    """A REAL ``crewai.LLM`` carrying generation config has it forwarded.
    crewai's own ``LLM._prepare_completion_params``
    forwards temperature/top_p/max_tokens/etc., so the bridge must too or
    the config is silently replaced by provider defaults. ``temperature=0``
    (falsy but meaningful) survives; the empty default ``stop=[]`` is not
    forwarded."""
    real_llm = LLM(
        model="gpt-4o",
        api_key="sk-1",
        temperature=0,
        top_p=0.9,
        max_tokens=256,
        seed=42,
    )
    kwargs = _new_crew_flow(chat_llm=real_llm)._completion_llm_kwargs()
    assert kwargs["temperature"] == 0
    assert kwargs["top_p"] == 0.9
    assert kwargs["max_tokens"] == 256
    assert kwargs["seed"] == 42
    assert "stop" not in kwargs  # empty default not forwarded


async def test_chat_forwards_connection_fields_to_acompletion_real_llm():
    """Both completion call sites receive the resolved connection fields
    from a REAL ``crewai.LLM`` — the crew-run turn AND the
    follow-up."""
    calls = []

    async def _fake_acompletion(**kwargs):
        calls.append(kwargs)
        return object()

    stream_n = {"n": 0}

    async def _fake_stream(_resp):
        stream_n["n"] += 1
        if stream_n["n"] == 1:
            class _R:
                choices = [{
                    "message": {
                        "role": "assistant",
                        "tool_calls": [{
                            "id": "call-crew",
                            "function": {"name": "dummy", "arguments": "{}"},
                        }],
                    }
                }]
            return _R()

        class _F:
            choices = [{"message": {"role": "assistant", "content": "done"}}]
        return _F()

    async def _noop_emit_state(_state):
        return True

    # ``gpt-4o`` (not ``azure/deployment``) — crewai 1.x eagerly
    # loads a native azure provider needing an extra; the forwarding under test
    # is provider-agnostic. ``api_version`` rides ``additional_params`` on 1.x.
    real_llm = LLM(model="gpt-4o", api_key="secret",
                   api_base="https://azure.example", api_version="2024-02-01")
    flow = _new_crew_flow(chat_llm=real_llm)
    state = {"messages": [], "inputs": {}, "copilotkit": {"actions": []}}

    with _patch_instance_state(flow, state):
        with patch.object(crews_mod, "acompletion", _fake_acompletion):
            with patch.object(crews_mod, "copilotkit_stream", _fake_stream):
                with patch.object(crews_mod, "copilotkit_emit_state", _noop_emit_state):
                    with patch.object(
                        crews_mod, "crew_chat_create_tool_function",
                        lambda crew, messages: (lambda **_k: "OUT"),
                    ):
                        await flow.chat()

    assert len(calls) == 2
    for call in calls:
        assert call["model"] == "gpt-4o"
        assert call["api_key"] == "secret"
        assert call["api_base"] == "https://azure.example"
        assert call["api_version"] == "2024-02-01"
    # The follow-up forces text, not another tool call.
    assert calls[1]["tool_choice"] == "none"


async def test_additional_params_do_not_collide_with_call_owned_kwargs():
    """A REAL ``crewai.LLM`` whose ``additional_params`` include keys the
    ``chat()`` call sites ALSO set explicitly must NOT raise ``TypeError:
    got multiple values for keyword argument`` — and the CALL-OWNED values
    must win.

    The repro was ``LLM(model="gpt-4o",
    parallel_tool_calls=True)``: crewai routes ``parallel_tool_calls`` into
    ``additional_params``, which the old code spread into the same
    ``acompletion(**kwargs, parallel_tool_calls=False, ...)`` call. Here we
    additionally seed ``messages`` / ``tools`` / ``tool_choice`` sentinels
    into ``additional_params`` and assert the framework's own values are
    used, plus a benign custom param survives."""
    # ``api_key`` is supplied because crewai 1.0.x's native OpenAI provider
    # validates ``OPENAI_API_KEY`` at construction time;
    # it goes to the LLM's ``api_key`` attr, not ``additional_params``, so the
    # collision preconditions below are unaffected.
    real_llm = LLM(
        model="gpt-4o",
        api_key="k",
        parallel_tool_calls=True,
        messages="SHOULD_LOSE",
        tools="SHOULD_LOSE",
        tool_choice="SHOULD_LOSE",
        foo_custom="bar",
    )
    # Sanity: these all landed in additional_params (the collision source).
    for key in ("parallel_tool_calls", "messages", "tools", "tool_choice", "foo_custom"):
        assert key in real_llm.additional_params

    calls = []

    async def _fake_acompletion(**kwargs):
        calls.append(kwargs)
        return object()

    stream_n = {"n": 0}

    async def _fake_stream(_resp):
        stream_n["n"] += 1
        if stream_n["n"] == 1:
            class _R:
                choices = [{
                    "message": {
                        "role": "assistant",
                        "tool_calls": [{
                            "id": "call-crew",
                            "function": {"name": "dummy", "arguments": "{}"},
                        }],
                    }
                }]
            return _R()

        class _F:
            choices = [{"message": {"role": "assistant", "content": "done"}}]
        return _F()

    async def _noop_emit_state(_state):
        return True

    flow = _new_crew_flow(chat_llm=real_llm)
    state = {"messages": [], "inputs": {}, "copilotkit": {"actions": []}}

    with _patch_instance_state(flow, state):
        with patch.object(crews_mod, "acompletion", _fake_acompletion):
            with patch.object(crews_mod, "copilotkit_stream", _fake_stream):
                with patch.object(crews_mod, "copilotkit_emit_state", _noop_emit_state):
                    with patch.object(
                        crews_mod, "crew_chat_create_tool_function",
                        lambda crew, messages: (lambda **_k: "OUT"),
                    ):
                        # Must NOT raise TypeError on the collision.
                        await flow.chat()

    assert len(calls) == 2
    for call in calls:
        assert call["model"] == "gpt-4o"
        # Call-owned settings WIN over additional_params.
        assert call["parallel_tool_calls"] is False
        assert call["stream"] is True
        assert isinstance(call["messages"], list) and call["messages"]
        assert isinstance(call["tools"], list) and call["tools"]
        # Benign custom additional_param is still forwarded.
        assert call["foo_custom"] == "bar"
    # The follow-up turn sets tool_choice explicitly, so the
    # call-owned "none" overrides the additional_params "SHOULD_LOSE"
    # sentinel — proving call-owned tool_choice wins on collision.
    assert calls[1]["tool_choice"] == "none"


def test_a_disabled_timeout_leaves_a_users_own_additional_param_alone(monkeypatch):
    """Call-owned settings win, except a ``timeout`` of ``None``.

    ``None`` is the env knob's "this integration passes no timeout" spelling. Let
    it win and a user who put their own ``timeout`` in ``additional_params`` loses
    it to nothing, which is the one case where the framework has no opinion to
    impose.
    """
    monkeypatch.setenv("AGUI_CREWAI_LLM_TIMEOUT_SECONDS", "0")
    real_llm = LLM(model="gpt-4o", api_key="k", additional_params={"timeout": 45})
    # The precondition: crewai keeps a directly-supplied ``additional_params``
    # timeout there rather than on the field, so it reaches the call through the
    # spread and is the value a ``None`` would replace.
    assert real_llm.additional_params.get("timeout") == 45
    assert real_llm.timeout is None
    flow = _new_crew_flow(chat_llm=real_llm)
    assert flow._completion_timeout_seconds() is None

    params = flow._completion_call_params(
        messages=[],
        timeout=flow._completion_timeout_seconds(),
    )

    assert params["timeout"] == 45

    # A real timeout still wins over an additional_params one.
    monkeypatch.setenv("AGUI_CREWAI_LLM_TIMEOUT_SECONDS", "30")
    with_timeout = flow._completion_call_params(
        messages=[],
        timeout=flow._completion_timeout_seconds(),
    )
    assert with_timeout["timeout"] == 30.0


# --------------------------------------------------------------------------
# Crew-run state mutation surfaced as a StateSnapshotEvent
# --------------------------------------------------------------------------

async def test_crew_run_emits_state_snapshot():
    """Running the crew emits a STATE_SNAPSHOT reflecting the applied
    output, routed to the bridge via the endpoint listener."""
    async def _fake_acompletion(**_kwargs):
        return object()

    stream_n = {"n": 0}

    async def _fake_stream(_resp):
        stream_n["n"] += 1
        if stream_n["n"] == 1:
            class _R:
                choices = [{
                    "message": {
                        "role": "assistant",
                        "tool_calls": [{
                            "id": "call-crew",
                            "function": {"name": "dummy", "arguments": "{}"},
                        }],
                    }
                }]
            return _R()

        class _F:
            choices = [{"message": {"role": "assistant", "content": "done"}}]
        return _F()

    ep.FastAPICrewFlowEventListener()  # registers bus handlers
    flow = _new_crew_flow(chat_llm=LLM(model="gpt-4o", api_key="k"))
    queue = await ep.create_queue(flow)
    state = {"messages": [], "inputs": {}, "copilotkit": {"actions": []}}

    token = flow_context.set(flow)
    try:
        with _patch_instance_state(flow, state):
            with patch.object(crews_mod, "acompletion", _fake_acompletion):
                with patch.object(crews_mod, "copilotkit_stream", _fake_stream):
                    with patch.object(
                        crews_mod, "crew_chat_create_tool_function",
                        lambda crew, messages: (lambda **_k: "OUT"),
                    ):
                        await flow.chat()
        # The MethodExecutionFinished handler that emits the STATE_SNAPSHOT runs
        # on crewai's off-thread pool; settle it before the synchronous drain so
        # the snapshot has landed. Real HTTP streams drain in an awaiting loop,
        # so they never need this.
        await ep._flush_event_bus()
        items = _drain(queue)
    finally:
        flow_context.reset(token)
        await ep.delete_queue(flow)

    snapshots = [i for i in items if i.type == EventType.STATE_SNAPSHOT]
    assert len(snapshots) >= 1
    assert snapshots[-1].snapshot["outputs"] == "OUT"


async def test_crew_run_executes_off_the_event_loop():
    """The synchronous ``crew.kickoff``
    tool function runs on a WORKER thread (``asyncio.to_thread``), not inline on
    the event loop — so SSE flushing / the wall-clock ceiling / client-disconnect
    cancellation can fire DURING the crew run instead of being blocked until it
    returns."""
    import threading

    loop_thread_id = threading.get_ident()
    captured = {}

    async def _fake_acompletion(**_kwargs):
        return object()

    stream_n = {"n": 0}

    async def _fake_stream(_resp):
        stream_n["n"] += 1
        if stream_n["n"] == 1:
            class _R:
                choices = [{
                    "message": {
                        "role": "assistant",
                        "tool_calls": [{
                            "id": "call-crew",
                            "function": {"name": "dummy", "arguments": "{}"},
                        }],
                    }
                }]
            return _R()

        class _F:
            choices = [{"message": {"role": "assistant", "content": "done"}}]
        return _F()

    def _tool_factory(crew, messages):  # pylint: disable=unused-argument
        def _fn(**_kwargs):
            captured["thread_id"] = threading.get_ident()
            return "OUT"
        return _fn

    flow = crews_mod.ChatWithCrewFlow.__new__(crews_mod.ChatWithCrewFlow)
    flow.crew = type("C", (), {"chat_llm": "gpt-4o"})()
    flow.crew_name = "dummy"
    flow.crew_tool_schema = {
        "type": "function",
        "function": {"name": "dummy", "description": "", "parameters": {"type": "object"}},
    }
    flow.system_message = "sys"
    state = {"messages": [], "inputs": {}, "copilotkit": {"actions": []}}

    with _patch_instance_state(flow, state):
        with patch.object(crews_mod, "acompletion", _fake_acompletion):
            with patch.object(crews_mod, "copilotkit_stream", _fake_stream):
                with patch.object(
                    crews_mod, "crew_chat_create_tool_function", _tool_factory
                ):
                    await flow.chat()

    assert state["outputs"] == "OUT"
    assert "thread_id" in captured
    # The crew function ran on a different (worker) thread, not the loop thread.
    assert captured["thread_id"] != loop_thread_id


# --------------------------------------------------------------------------
# Real @CrewBase name read + unnamed-crew clear error
# --------------------------------------------------------------------------

def test_real_crewbase_matches_structural_protocol():
    """A REAL ``@CrewBase`` instance satisfies ``CrewBaseInstance``
    (structural: presence of ``crew()``); a bare object does not."""
    real = _make_real_crewbase()
    assert isinstance(real, ep.CrewBaseInstance)
    assert isinstance(real, crews_mod.CrewBaseInstance)
    assert not isinstance(object(), ep.CrewBaseInstance)


def test_protocol_accepts_name_only_and_crew_name_only_wrappers():
    """The protocol pins ONLY ``crew()``, so BOTH
    supported shapes conform: the repo's own ``CrewChatCrew`` (which
    exposes ``.name`` only, no ``_crew_name``) AND a real ``@CrewBase``
    instance (which exposes ``_crew_name`` only, no ``.name``). Requiring
    ``_crew_name`` in the protocol — as an earlier round did — wrongly
    rejected the name-only ``CrewChatCrew`` even though it works at
    runtime."""
    from agents.crew_chat import CrewChatCrew

    name_only = CrewChatCrew()
    # Precondition: name-only shape (has .name, lacks _crew_name).
    assert isinstance(getattr(name_only, "name", None), str)
    assert not hasattr(name_only, "_crew_name")
    assert isinstance(name_only, crews_mod.CrewBaseInstance)
    assert isinstance(name_only, ep.CrewBaseInstance)

    crew_name_only = _make_real_crewbase(cls_name="CrewNameOnly")
    # Precondition: _crew_name shape (has _crew_name, lacks a real .name).
    assert isinstance(getattr(crew_name_only, "_crew_name", None), str)
    assert not hasattr(crew_name_only, "name")
    assert isinstance(crew_name_only, crews_mod.CrewBaseInstance)
    assert isinstance(crew_name_only, ep.CrewBaseInstance)


def test_real_crewbase_direct_construction_reads_crew_name_and_builds_chatinputs():
    """Constructing ``ChatWithCrewFlow`` from a REAL ``@CrewBase`` reads the
    name off ``_crew_name`` (not ``.name`` — which does not exist on a real
    @CrewBase and previously AttributeError'd) and feeds it into a REAL
    ``ChatInputs`` with no validation error."""
    crews_mod._CREW_INPUTS_CACHE.clear()

    real = _make_real_crewbase(cls_name="ResearchCrew")
    with _stub_llm_network():
        flow = crews_mod.ChatWithCrewFlow(crew=real)

    assert flow.crew_name == "ResearchCrew"
    assert isinstance(flow.crew_chat_inputs, ChatInputs)
    assert flow.crew_chat_inputs.crew_name == "ResearchCrew"


def test_real_crewbase_endpoint_triggers_lazy_flow_without_attribute_error():
    """Registering a REAL ``@CrewBase`` via ``add_crewai_crew_fastapi_endpoint``
    and driving a real first request triggers the deferred
    ``ChatWithCrewFlow(crew=...)`` construction — the exact site that
    AttributeError'd on ``crew.name`` before the fix. The request must
    complete (HTTP 200), proving the real ``_crew_name`` read and real
    ``ChatInputs`` construction succeed end-to-end."""
    real = _make_real_crewbase(cls_name="EndpointCrew")

    async def _fake_acompletion(**_kwargs):
        return object()

    async def _fake_stream(_resp):
        class _R:
            choices = [{"message": {"role": "assistant", "content": "hello"}}]
        return _R()

    app = FastAPI()
    with _stub_llm_network():
        with patch.object(crews_mod, "acompletion", _fake_acompletion):
            with patch.object(crews_mod, "copilotkit_stream", _fake_stream):
                ep.add_crewai_crew_fastapi_endpoint(app, real, path="/crew")
                client = TestClient(app)
                payload = {
                    "thread_id": "t1", "run_id": "r1", "state": {},
                    "messages": [{"id": "m1", "role": "user", "content": "hi"}],
                    "tools": [], "context": [], "forwarded_props": {},
                }
                resp = client.post("/crew", json=payload)

    assert resp.status_code == 200


def test_unnamed_crew_raises_clear_error():
    """A crew exposing ``crew()`` but neither a non-empty ``name`` nor
    ``_crew_name`` raises a CLEAR ``ValueError`` — never ``None`` into
    ``ChatInputs`` (which would surface as an opaque Pydantic validation
    error deep in ``generate_crew_chat_inputs``)."""
    class _Unnamed:
        def crew(self):
            return type("C", (), {"chat_llm": LLM(model="gpt-4o", api_key="k")})()

    with _stub_llm_network():
        try:
            crews_mod.ChatWithCrewFlow(crew=_Unnamed())
        except ValueError as exc:
            assert "crew name" in str(exc).lower()
        else:
            raise AssertionError("expected a clear ValueError for an unnamed crew")


def test_empty_string_crew_name_raises_clear_error():
    """An empty/whitespace ``_crew_name`` is rejected (it would produce an
    empty crew-tool function name) — the name reader requires a non-empty
    string."""
    real = _make_real_crewbase()
    real._crew_name = "   "  # whitespace-only: not a usable name
    with _stub_llm_network():
        try:
            crews_mod.ChatWithCrewFlow(crew=real)
        except ValueError as exc:
            assert "crew name" in str(exc).lower()
        else:
            raise AssertionError("expected a clear ValueError for a blank name")


# --------------------------------------------------------------------------
# Identity-safe cache (no id-reuse cross-serve)
# --------------------------------------------------------------------------

def test_same_crew_reuses_cached_inputs_real_crewbase():
    """Reconstructing a flow for the SAME real ``@CrewBase`` reuses the
    cached schema and does NOT re-run the (network-driven) real
    ``generate_crew_chat_inputs`` — the caching win is preserved. The real
    generator still runs (wrapped, not replaced) so nothing is masked."""
    crews_mod._CREW_INPUTS_CACHE.clear()

    real = _make_real_crewbase(cls_name="ReuseCrew")
    wrapped = crews_mod.crew_chat_generate_crew_chat_inputs

    with _stub_llm_network():
        with patch.object(
            crews_mod, "crew_chat_generate_crew_chat_inputs",
            side_effect=wrapped,
        ) as gen_spy:
            f1 = crews_mod.ChatWithCrewFlow(crew=real)
            f2 = crews_mod.ChatWithCrewFlow(crew=real)

    assert f1.crew_chat_inputs is f2.crew_chat_inputs
    assert gen_spy.call_count == 1


def test_constructor_regenerates_inputs_after_cache_eviction():
    """CONSTRUCTOR-level regenerate-on-miss.

    The GC test below was narrowed to a direct cache-helper assertion because
    crewai pins the constructing frame (so a real crew never GCs mid-test); it
    no longer exercised the ``ChatWithCrewFlow.__init__`` path that MISSES the
    cache and REGENERATES. This restores that end-to-end constructor coverage
    by evicting the cache entry (the exact post-state the weakref ``evict_cb``
    leaves after a GC) and asserting the NEXT construction for the SAME crew
    re-runs the real ``generate_crew_chat_inputs`` rather than serving a stale
    schema."""
    crews_mod._CREW_INPUTS_CACHE.clear()

    real = _make_real_crewbase(cls_name="RegenCrew")
    wrapped = crews_mod.crew_chat_generate_crew_chat_inputs

    with _stub_llm_network():
        with patch.object(
            crews_mod, "crew_chat_generate_crew_chat_inputs",
            side_effect=wrapped,
        ) as gen_spy:
            f1 = crews_mod.ChatWithCrewFlow(crew=real)
            # First construction generated + cached.
            assert gen_spy.call_count == 1
            assert id(real) in crews_mod._CREW_INPUTS_CACHE

            # Evict the entry, mirroring the weakref evict_cb firing on GC.
            crews_mod._CREW_INPUTS_CACHE.pop(id(real), None)

            # Constructing again for the SAME crew misses the (evicted) cache
            # and REGENERATES — the constructor invariant the narrowed GC test
            # stopped covering.
            f2 = crews_mod.ChatWithCrewFlow(crew=real)
            assert gen_spy.call_count == 2

    # A fresh schema object was produced on the regenerate (not the stale one),
    # and it is re-cached.
    assert f1.crew_chat_inputs is not f2.crew_chat_inputs
    assert crews_mod._crew_inputs_cache_get(real) is f2.crew_chat_inputs

    crews_mod._CREW_INPUTS_CACHE.clear()


def test_cache_evicts_on_gc_and_regenerates_for_new_crew():
    """The cache maps ``id(crew) -> (weakref.ref(crew, evict_cb), schema)``,
    so when a weakref-able crew is garbage-collected the ``evict_cb`` pops
    its entry — eliminating the ``id(crew)`` reuse hazard where a freshly
    allocated wrapper inherits a collected wrapper's id and is silently
    served the wrong schema. A brand-new crew therefore
    regenerates rather than receiving the old schema.

    On crewai 1.x, constructing a real ``ChatWithCrewFlow`` can no
    longer be used to drive this invariant — crewai retains a traceback frame
    from ``generate_crew_chat_inputs`` that pins the constructing frame (and
    thus the ``crew`` local) alive, so a real crew is never collected during
    the test regardless of wrapper type. We therefore exercise the eviction
    mechanism DIRECTLY against the cache helpers (``_crew_inputs_cache_set`` /
    ``_crew_inputs_cache_get`` / the ``evict_cb``), which is exactly the
    id-reuse-safety logic under test — no crewai frame retention in the
    path."""
    crews_mod._CREW_INPUTS_CACHE.clear()

    class _Key:
        """Minimal weakref-able stand-in for a crew object (cache key)."""

    schema_a = object()
    crew_a = _Key()
    crews_mod._crew_inputs_cache_set(crew_a, schema_a)
    ref_a = weakref.ref(crew_a)

    # A live key keeps its cache entry, keyed on ``id(crew)``, and reads back.
    assert id(crew_a) in crews_mod._CREW_INPUTS_CACHE
    assert crews_mod._crew_inputs_cache_get(crew_a) is schema_a

    # Drop every strong reference to crew A, then collect.
    del crew_a
    gc.collect()

    # The weak reference is dead => the ``evict_cb`` fired and popped the
    # entry. No stale schema can be served under a reused id.
    assert ref_a() is None
    assert len(crews_mod._CREW_INPUTS_CACHE) == 0

    # A brand-new key is a cache MISS (regenerates rather than inheriting a
    # stale schema under a reused id).
    crew_b = _Key()
    assert crews_mod._crew_inputs_cache_get(crew_b) is None

    crews_mod._CREW_INPUTS_CACHE.clear()


def test_distinct_but_equal_crews_get_distinct_schemas_no_cross_serve():
    """Two DISTINCT-BUT-EQUAL crew wrappers (value-based ``__eq__`` /
    ``__hash__``) must receive DISTINCT schemas. The
    prior ``WeakKeyDictionary`` keyed by ``__eq__`` / ``__hash__`` and so
    collapsed the two to one entry, cross-serving the first crew's schema
    to the second. The ``id(crew)`` key keys on identity, so each wrapper
    regenerates its own schema. Each wrapper's ``crew()`` returns a REAL
    ``crewai.Crew`` and the real ``generate_crew_chat_inputs`` runs."""
    crews_mod._CREW_INPUTS_CACHE.clear()

    crew_1 = _make_value_equal_crew(cls_name="EqualCrew", equal_key="same")
    crew_2 = _make_value_equal_crew(cls_name="EqualCrew", equal_key="same")

    # Precondition: the two wrappers are DISTINCT objects that compare EQUAL
    # and hash equal — exactly the shape that collapsed under a
    # WeakKeyDictionary.
    assert crew_1 is not crew_2
    assert crew_1 == crew_2
    assert hash(crew_1) == hash(crew_2)

    with _stub_llm_network():
        flow_1 = crews_mod.ChatWithCrewFlow(crew=crew_1)
        flow_2 = crews_mod.ChatWithCrewFlow(crew=crew_2)

    # No cross-serve: each equal-but-distinct crew has its OWN schema.
    assert flow_1.crew_chat_inputs is not flow_2.crew_chat_inputs
    assert id(crew_1) in crews_mod._CREW_INPUTS_CACHE
    assert id(crew_2) in crews_mod._CREW_INPUTS_CACHE

    crews_mod._CREW_INPUTS_CACHE.clear()


def test_non_weakrefable_crew_is_not_cached_no_permanent_entry():
    """A genuinely non-weakref-able crew (``__slots__`` without
    ``__weakref__``) is NOT cached — the set path skips it rather than
    pinning a strong reference forever (which would leak the wrapper).
    Constructing multiple flows for such crews therefore accumulates NO
    permanent cache entries. ``crew()`` returns a REAL
    ``crewai.Crew`` and the real ``generate_crew_chat_inputs`` runs."""
    crews_mod._CREW_INPUTS_CACHE.clear()

    crew_1 = _make_non_weakrefable_crew(cls_name="NoWeakrefCrewA")
    crew_2 = _make_non_weakrefable_crew(cls_name="NoWeakrefCrewB")

    # Precondition: these instances truly cannot be weak-referenced.
    for c in (crew_1, crew_2):
        try:
            weakref.ref(c)
        except TypeError:
            pass
        else:
            raise AssertionError("test crew was unexpectedly weak-referenceable")

    with _stub_llm_network():
        flow_1 = crews_mod.ChatWithCrewFlow(crew=crew_1)
        flow_2 = crews_mod.ChatWithCrewFlow(crew=crew_2)

    # Nothing was cached, so no permanent strong references accumulate.
    assert len(crews_mod._CREW_INPUTS_CACHE) == 0
    # Correctness is preserved: each still gets a valid, distinct schema.
    assert flow_1.crew_chat_inputs is not flow_2.crew_chat_inputs

    crews_mod._CREW_INPUTS_CACHE.clear()


# --------------------------------------------------------------------------
# Endpoint symbols exported from the package top level
# --------------------------------------------------------------------------

def test_crew_path_symbols_exported_from_package_top_level():
    """The previously-hidden Crew-path symbols are importable from the
    package top level and declared in ``__all__``."""
    import ag_ui_crewai as pkg

    for name in (
        "add_crewai_crew_fastapi_endpoint",
        "copilotkit_exit",
        "crewai_prepare_inputs",
        "ChatWithCrewFlow",
    ):
        assert hasattr(pkg, name), f"{name} not importable from ag_ui_crewai"
        assert name in pkg.__all__, f"{name} missing from ag_ui_crewai.__all__"


# --------------------------------------------------------------------------
# per-request flow COPY seeds state before ``@start`` runs
# --------------------------------------------------------------------------

class _CrewShapedFlow(Flow):
    """A real crewai Flow whose ``@start`` reads state EXACTLY like
    ``ChatWithCrewFlow.chat`` does — ``self.state["messages"]`` and
    ``self.state["copilotkit"]["actions"]`` (dict state). The class-level
    ``_seen`` sink records what the running method observed so the test can
    assert against the instance the engine actually executed."""

    _seen: dict = {}

    @start()
    async def chat(self):
        # The exact reads that raised ``KeyError`` at crews.py pre-fix.
        _CrewShapedFlow._seen = {
            "self_id": id(self),
            "messages": list(self.state["messages"]),
            "actions": list(self.state["copilotkit"]["actions"]),
            "inputs": self.state.get("inputs"),
        }


async def test_copied_crew_flow_kickoff_seeds_state_before_start_runs():
    """A per-request COPY of a crew-shaped Flow, driven through
    the REAL ``crewai_prepare_inputs`` -> ``kickoff_async(inputs=...)`` seam the
    crew endpoint uses, must seed ``messages`` / ``copilotkit`` into the COPY's
    ``self.state`` BEFORE ``@start`` runs.

    Reproduces the crewai 1.x hang: ``_copy_flow``'s pin-and-share fallback
    shared the original's ``_methods`` (bound to the ORIGINAL), so
    ``kickoff_async`` seeded the COPY's state while ``chat`` executed against
    the un-seeded ORIGINAL -> ``KeyError: 'messages'`` at
    ``crews.py`` ``*self.state["messages"]``. Pre-fix this test raises
    KeyError; with the ``_copy_flow`` rebind it passes."""
    _CrewShapedFlow._seen = {}
    flow = _CrewShapedFlow()
    flow_copy = ep._copy_flow(flow)

    # Build inputs through the REAL bridge contract (messages/copilotkit/id).
    inputs = ep.crewai_prepare_inputs(
        state={},
        messages=[UserMessage(id="u1", role="user", content="hello crew")],
        tools=[Tool(name="search", description="", parameters={"type": "object"})],
    )
    inputs["id"] = "thread-xyz"

    # The seam the endpoint drives (crew path uses kickoff_async on 1.0-1.5 and
    # under astream on 1.6+; both funnel through kickoff_async's state seeding).
    await flow_copy.kickoff_async(inputs=inputs)

    seen = _CrewShapedFlow._seen
    # (1) State reached the running @start method without a KeyError.
    assert [m["content"] for m in seen["messages"]] == ["hello crew"]
    assert [a["function"]["name"] for a in seen["actions"]] == ["search"]
    # (2) The method executed against the COPY, not the original.
    assert seen["self_id"] == id(flow_copy)
    # (3) Per-request isolation: the ORIGINAL flow's state was never seeded,
    #     and each instance keeps its OWN ``chat`` binding.
    assert "messages" not in flow._state
    assert flow_copy._methods["chat"].__self__ is flow_copy
    assert flow._methods["chat"].__self__ is flow
