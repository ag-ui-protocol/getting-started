"""Message/input translation: ``litellm_messages_to_ag_ui_messages`` (outbound)
and ``crewai_prepare_inputs`` (inbound). No network."""

from ag_ui.core import SystemMessage, Tool, UserMessage
from ag_ui_crewai import endpoint as ep
from ag_ui_crewai.sdk import litellm_messages_to_ag_ui_messages


# --------------------------------------------------------------------------
# litellm_messages_to_ag_ui_messages (outbound conversion)
# --------------------------------------------------------------------------

def test_litellm_conversion_whitelists_and_strips_none():
    """Only whitelisted keys survive; ``None``/unknown keys dropped."""
    out = litellm_messages_to_ag_ui_messages(
        [{"role": "assistant", "content": "hi", "id": "a1",
          "name": None, "unknown_field": "dropme"}]
    )
    assert len(out) == 1
    dumped = out[0].model_dump()
    assert dumped["id"] == "a1"
    assert dumped["role"] == "assistant"
    assert dumped["content"] == "hi"
    assert "unknown_field" not in dumped


def test_litellm_conversion_generates_id_when_missing():
    """A message without an ``id`` gets a generated UUID string."""
    out = litellm_messages_to_ag_ui_messages([{"role": "user", "content": "yo"}])
    assert isinstance(out[0].id, str)
    assert len(out[0].id) == 36  # canonical uuid4 string length


def test_litellm_conversion_injects_tool_call_type():
    """Tool calls missing an explicit ``type`` are stamped ``function``."""
    out = litellm_messages_to_ag_ui_messages(
        [{
            "role": "assistant",
            "id": "a2",
            "content": None,
            "tool_calls": [{"id": "t1", "function": {"name": "f", "arguments": "{}"}}],
        }]
    )
    tool_calls = out[0].model_dump()["tool_calls"]
    assert tool_calls[0]["type"] == "function"
    assert tool_calls[0]["function"]["name"] == "f"


def test_litellm_conversion_accepts_litellm_message_object():
    """A non-Mapping LiteLLM ``Message`` goes through the ``model_dump`` branch."""
    from litellm.types.utils import Message as LiteLLMMessage

    out = litellm_messages_to_ag_ui_messages(
        [LiteLLMMessage(role="assistant", content="from-object")]
    )
    assert out[0].role == "assistant"
    assert out[0].content == "from-object"
    assert isinstance(out[0].id, str)


# --------------------------------------------------------------------------
# crewai_prepare_inputs (inbound preparation)
# --------------------------------------------------------------------------

def test_prepare_inputs_strips_leading_system_message():
    """A leading system message is dropped; the rest survive."""
    out = ep.crewai_prepare_inputs(
        state={},
        messages=[
            SystemMessage(id="s", role="system", content="sys"),
            UserMessage(id="u", role="user", content="hello"),
        ],
        tools=[],
    )
    assert len(out["messages"]) == 1
    assert out["messages"][0]["role"] == "user"
    assert out["messages"][0]["content"] == "hello"


def test_prepare_inputs_keeps_non_leading_system_message():
    """Only a *leading* system message is stripped: [user, system] keeps
    both (fails if the impl deletes every system message)."""
    out = ep.crewai_prepare_inputs(
        state={},
        messages=[
            UserMessage(id="u", role="user", content="hello"),
            SystemMessage(id="s", role="system", content="sys"),
        ],
        tools=[],
    )
    assert len(out["messages"]) == 2
    assert out["messages"][0]["role"] == "user"
    assert out["messages"][1]["role"] == "system"
    assert out["messages"][1]["content"] == "sys"


def test_prepare_inputs_reshapes_tools_to_copilotkit_actions():
    """Each ``Tool`` becomes a ``{type:function, function:{...}}`` action."""
    out = ep.crewai_prepare_inputs(
        state={},
        messages=[],
        tools=[Tool(
            name="searchTool",
            description="search the web",
            parameters={"type": "object", "properties": {}},
        )],
    )
    actions = out["copilotkit"]["actions"]
    assert actions == [{
        "type": "function",
        "function": {
            "name": "searchTool",
            "description": "search the web",
            "parameters": {"type": "object", "properties": {}},
        },
    }]


def test_prepare_inputs_merges_incoming_state():
    """Existing state keys survive alongside injected messages/copilotkit keys."""
    out = ep.crewai_prepare_inputs(
        state={"existing": 1, "keep": "me"},
        messages=[],
        tools=[],
    )
    assert out["existing"] == 1
    assert out["keep"] == "me"
    assert out["messages"] == []
    assert out["copilotkit"] == {"actions": []}
