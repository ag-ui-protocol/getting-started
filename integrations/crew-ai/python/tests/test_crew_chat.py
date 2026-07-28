"""ChatWithCrewFlow crew-invocation branch: when a tool call names the crew,
``chat`` runs the crew tool and records its output. No network."""

from contextlib import contextmanager
from unittest.mock import patch


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


async def test_chat_runs_crew_and_records_string_output():
    """A crew tool call runs the crew fn, records its string result under
    ``state['outputs']`` and appends a matching ``tool`` message."""
    from ag_ui_crewai import crews as crews_mod

    async def _fake_acompletion(**_kwargs):
        return object()

    async def _fake_stream(_resp):
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
    # Two messages: the assistant tool-call message, then the tool result.
    assert len(state["messages"]) == 2
    tool_message = state["messages"][-1]
    assert tool_message["role"] == "tool"
    assert tool_message["content"] == "CREW OUTPUT"
    assert tool_message["tool_call_id"] == "call-crew"


async def test_chat_crew_output_from_raw_attribute():
    """A crew result exposing ``.raw`` (and no ``.json_dict``) records ``raw``."""
    from ag_ui_crewai import crews as crews_mod

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
