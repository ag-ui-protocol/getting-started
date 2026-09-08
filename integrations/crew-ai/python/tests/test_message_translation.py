"""Message/input translation: ``litellm_messages_to_ag_ui_messages`` (outbound)
and ``crewai_prepare_inputs`` (inbound). No network."""

from ag_ui.core import Context, SystemMessage, Tool, UserMessage
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


def test_litellm_conversion_generates_id_when_explicitly_none():
    """A message with ``id`` present but ``None`` still gets a generated UUID.

    Regression: the backfill guarded only on the key being absent, so an
    explicit ``id=None`` survived to the None-strip, which then dropped the key
    and left pydantic ``Message`` validation to fail on a missing id."""
    out = litellm_messages_to_ag_ui_messages(
        [{"role": "user", "content": "yo", "id": None}]
    )
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


def test_litellm_conversion_does_not_mutate_caller_tool_calls():
    """Stamping ``type=function`` must not mutate the caller's (flow-state)
    tool_call dicts in place: the whitelist comprehension is a shallow copy,
    so a deep-enough copy is required before writing back."""
    tool_call = {"id": "t1", "function": {"name": "f", "arguments": "{}"}}
    message = {"role": "assistant", "id": "a3", "content": None,
               "tool_calls": [tool_call]}

    out = litellm_messages_to_ag_ui_messages([message])

    # Output is stamped...
    assert out[0].model_dump()["tool_calls"][0]["type"] == "function"
    # ...but the caller's original dict is untouched.
    assert "type" not in tool_call
    assert message["tool_calls"][0] is tool_call


def test_litellm_conversion_accepts_litellm_message_object():
    """A non-Mapping LiteLLM ``Message`` goes through the ``model_dump`` branch."""
    from litellm.types.utils import Message as LiteLLMMessage

    out = litellm_messages_to_ag_ui_messages(
        [LiteLLMMessage(role="assistant", content="from-object")]
    )
    assert out[0].role == "assistant"
    assert out[0].content == "from-object"
    assert isinstance(out[0].id, str)


def test_litellm_conversion_omits_client_owned_reasoning_from_snapshot():
    """CrewAI does not own a complete canonical reasoning-message set.

    Including prior reasoning in an authoritative ``MESSAGES_SNAPSHOT`` makes
    the client replace all streamed reasoning, including the current turn, and
    the whitelist also strips its encrypted continuation value. A snapshot with
    no reasoning tells the client to preserve its complete local set instead.
    """
    out = litellm_messages_to_ag_ui_messages([
        {"role": "user", "id": "u1", "content": "question"},
        {
            "role": "reasoning",
            "id": "rs_1",
            "content": "thinking",
            "encrypted_value": "ENCRYPTED_STATE",
        },
        {"role": "assistant", "id": "a1", "content": "answer"},
    ])

    assert [message.id for message in out] == ["u1", "a1"]
    assert all(message.role != "reasoning" for message in out)


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


# --------------------------------------------------------------------------
# context / forwardedProps / top-level tools forwarding
# --------------------------------------------------------------------------

def test_prepare_inputs_threads_context_into_state():
    """``input.context`` is serialized to a top-level ``context`` list so
    agent code and tools can read it from state."""
    out = ep.crewai_prepare_inputs(
        state={},
        messages=[],
        tools=[],
        context=[
            Context(description="user timezone", value="UTC"),
            Context(description="locale", value="en-US"),
        ],
    )
    assert out["context"] == [
        {"description": "user timezone", "value": "UTC"},
        {"description": "locale", "value": "en-US"},
    ]


def test_prepare_inputs_defaults_context_to_empty_list():
    """A run with no context yields an empty ``context`` list, not a missing
    key (so downstream ``state["context"]`` reads never KeyError)."""
    out = ep.crewai_prepare_inputs(state={}, messages=[], tools=[])
    assert out["context"] == []


def test_prepare_inputs_exposes_top_level_tools():
    """Frontend tools are also surfaced at a top-level ``tools`` key, mirroring
    the existing ``copilotkit.actions`` shape."""
    out = ep.crewai_prepare_inputs(
        state={},
        messages=[],
        tools=[Tool(
            name="searchTool",
            description="search the web",
            parameters={"type": "object", "properties": {}},
        )],
    )
    expected = [{
        "type": "function",
        "function": {
            "name": "searchTool",
            "description": "search the web",
            "parameters": {"type": "object", "properties": {}},
        },
    }]
    assert out["tools"] == expected
    # backward compatibility: copilotkit.actions still carries the same shape.
    assert out["copilotkit"]["actions"] == expected


def test_prepare_inputs_normalizes_and_threads_forwarded_props():
    """``forwardedProps`` keys are camel_to_snake normalized and merged into
    the top-level run state."""
    out = ep.crewai_prepare_inputs(
        state={},
        messages=[],
        tools=[],
        forwarded_props={"streamSubgraphs": False, "nodeName": "planner"},
    )
    assert out["stream_subgraphs"] is False
    assert out["node_name"] == "planner"
    # the original camelCase keys are not leaked alongside.
    assert "streamSubgraphs" not in out
    assert "nodeName" not in out


def test_prepare_inputs_forwarded_props_cannot_clobber_reserved_keys():
    """A stray forwarded key must not override messages/tools/context/
    copilotkit — the explicit keys win."""
    out = ep.crewai_prepare_inputs(
        state={},
        messages=[UserMessage(id="u", role="user", content="hi")],
        tools=[],
        context=[Context(description="d", value="v")],
        forwarded_props={
            "messages": "evil",
            "tools": "evil",
            "context": "evil",
            "copilotkit": "evil",
        },
    )
    assert out["messages"][0]["content"] == "hi"
    assert out["tools"] == []
    assert out["context"] == [{"description": "d", "value": "v"}]
    assert out["copilotkit"] == {"actions": []}


def test_prepare_inputs_state_wins_over_forwarded_props():
    """On a key collision, persisted ``state`` wins over transient
    ``forwardedProps`` (parity with LangGraph, where the payload is spread
    after forwarded_props). Forwarded props are per-request streaming hints and
    must not silently overwrite the agent's own accumulated state."""
    out = ep.crewai_prepare_inputs(
        state={"shared_key": "from-state"},
        messages=[],
        tools=[],
        forwarded_props={"sharedKey": "from-forwarded"},
    )
    assert out["shared_key"] == "from-state"


def test_prepare_inputs_coerces_null_or_non_mapping_state():
    """``RunAgentInput.state`` is typed ``Any``/required, so a client can send
    ``state: null`` or a non-mapping. crewai_prepare_inputs runs in the endpoint
    body BEFORE the StreamingResponse, so a ``{**state}`` TypeError there would
    escape the RUN_ERROR taxonomy as an uncorrelated 500. A non-mapping state
    must coerce to an empty dict, never crash."""
    for bad in (None, "nope", 42, ["a", "b"]):
        out = ep.crewai_prepare_inputs(state=bad, messages=[], tools=[])
        assert out["messages"] == []
        assert out["copilotkit"] == {"actions": []}
        assert out["context"] == []


def test_prepare_inputs_ignores_non_dict_forwarded_props():
    """A non-dict (or None) ``forwarded_props`` is a no-op, never a crash."""
    for bad in (None, "nope", 42, ["a", "b"]):
        out = ep.crewai_prepare_inputs(
            state={"keep": 1},
            messages=[],
            tools=[],
            forwarded_props=bad,
        )
        assert out["keep"] == 1
        assert out["messages"] == []
