"""RunAgentInput.context must reach per-thread Strands agent state.

Mirrors the langgraph integration where tools read context off agent state.
Tools running on Strands read it via ``strands_agent.state.get("agui_context")``.

The model-facing half of the contract is checked twice over, because a native
Strands history can look correct and still serialize into a request the
provider rejects. So the cases below assert the native history AND run that
same history through the real installed provider formatters, where the tool
call/result adjacency an OpenAI-compatible request needs, and the role
alternation a block-level request needs, are actually decided.
"""

from __future__ import annotations

import base64
import copy
import logging
import re
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
import strands.event_loop.event_loop as strands_event_loop
from strands import Agent
from strands import tool as strands_tool
from strands.agent.state import AgentState
from strands.hooks.registry import HookRegistry
from strands.models.anthropic import AnthropicModel
from strands.models.model import Model
# Imported for its request formatter only. Nothing here opens a connection, so
# no LLM mock is involved; the live provider runs are the e2e suite's job.
from strands.models.openai import OpenAIModel
from strands.session.file_session_manager import FileSessionManager
from strands.tools.registry import ToolRegistry
from strands.types.exceptions import ModelThrottledException

from ag_ui.core import (
    AssistantMessage,
    Context,
    EventType,
    FunctionCall,
    ImageInputContent,
    InputContentDataSource,
    RunAgentInput,
    TextInputContent,
    Tool,
    ToolCall,
    ToolMessage,
    UserMessage,
)
from ag_ui_a2ui_toolkit import A2UI_SCHEMA_CONTEXT_DESCRIPTION

from ag_ui_strands.agent import (
    _MODEL_BOUND_HISTORY_OUTLINE,
    _MODEL_CONTEXT_BLOCK,
    _MODEL_CONTEXT_MUTATION_MARKER,
    StrandsAgent,
    _TransientModelContextHook,
    _carries_tool_result,
    describe_model_bound_history,
)
from ag_ui_strands.config import StrandsAgentConfig
from tests.hook_helpers import invoke_after_model_call, invoke_before_model_call


def _text_turn(text="ok"):
    """Stream events for one assistant turn that answers in plain text."""
    return [
        {"messageStart": {"role": "assistant"}},
        {"contentBlockStart": {"start": {}}},
        {"contentBlockDelta": {"delta": {"text": text}}},
        {"contentBlockStop": {}},
        {"messageStop": {"stopReason": "end_turn"}},
    ]


def _tool_use_turn(*calls):
    """Stream events for one assistant turn that calls the given tools."""
    events = [{"messageStart": {"role": "assistant"}}]
    for tool_use_id, name in calls:
        events += [
            {
                "contentBlockStart": {
                    "start": {"toolUse": {"toolUseId": tool_use_id, "name": name}}
                }
            },
            {"contentBlockDelta": {"delta": {"toolUse": {"input": "{}"}}}},
            {"contentBlockStop": {}},
        ]
    events.append({"messageStop": {"stopReason": "tool_use"}})
    return events


_USAGE_EVENT = {
    "metadata": {
        "usage": {"inputTokens": 1, "outputTokens": 1, "totalTokens": 2},
        "metrics": {"latencyMs": 1},
    }
}


class _CapturingModel(Model):
    """Real Strands model boundary that records the exact transient messages.

    ``turns`` scripts one stream-event list per model call so a case can drive a
    backend tool round trip; the default is a single plain-text answer.
    """

    def __init__(self, turns=None):
        self.calls = []
        self._turns = list(turns) if turns is not None else None

    def get_config(self):
        return {}

    def update_config(self, **kwargs):
        pass

    async def structured_output(self, *args, **kwargs):
        raise NotImplementedError

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs):
        self.calls.append(copy.deepcopy(messages))
        if self._turns is None:
            events = _text_turn()
        else:
            index = len(self.calls) - 1
            # Replaying the last turn would let a runaway loop spin on a
            # tool_use turn forever instead of reporting the extra call.
            assert index < len(self._turns), (
                f"the agent asked for model call {index + 1} but only "
                f"{len(self._turns)} turns were scripted"
            )
            events = self._turns[index]
        for event in events:
            yield event
        yield _USAGE_EVENT


def _mock_model():
    m = MagicMock()
    m.stateful = False
    return m


class _CapturingCore:
    """Stand-in for StrandsAgentCore that records ``state.set`` writes."""

    def __init__(self, **kwargs):
        self.init_kwargs = kwargs
        self.tool_registry = ToolRegistry()
        self.state = AgentState()
        self.messages = []
        self.stream_prompts = []
        self.model_messages = []
        self.hooks = HookRegistry()

    async def stream_async(self, prompt):
        self.stream_prompts.append(prompt)
        if isinstance(prompt, str):
            self.messages.append({"role": "user", "content": [{"text": prompt}]})
        elif isinstance(prompt, list):
            self.messages.append({"role": "user", "content": prompt})
        invoke_before_model_call(self.hooks, self)
        self.model_messages.append(copy.deepcopy(self.messages))
        invoke_after_model_call(self.hooks, self)
        if False:
            yield


def _run_input(context, thread_id="t-ctx", content="hello"):
    return RunAgentInput(
        thread_id=thread_id,
        run_id="r1",
        state={},
        messages=[UserMessage(id="u1", content=content)],
        tools=[],
        context=context,
        forwarded_props={},
    )


async def _drive(
    ag: StrandsAgent,
    run_input: RunAgentInput,
    *,
    complete: bool = False,
) -> _CapturingCore:
    async for _ in ag.run(run_input):
        if not complete:
            break
    return ag._agents_by_thread[run_input.thread_id]


@pytest.mark.asyncio
async def test_context_forwarded_to_agent_state():
    template = Agent(model=_mock_model())
    ag = StrandsAgent(template, name="test")

    ctx = [
        Context(description="catalog", value='{"items":["a","b"]}'),
        Context(description="user_id", value="u-42"),
    ]

    with patch("ag_ui_strands.agent.StrandsAgentCore", _CapturingCore):
        instance = await _drive(ag, _run_input(ctx))

    stored = instance.state.get("agui_context")
    assert stored == [
        {"description": "catalog", "value": '{"items":["a","b"]}'},
        {"description": "user_id", "value": "u-42"},
    ], f"expected context forwarded to state, got {stored!r}"


@pytest.mark.asyncio
async def test_empty_context_writes_empty_list():
    template = Agent(model=_mock_model())
    ag = StrandsAgent(template, name="test")

    with patch("ag_ui_strands.agent.StrandsAgentCore", _CapturingCore):
        instance = await _drive(ag, _run_input([]))

    assert instance.state.get("agui_context") == []


@pytest.mark.asyncio
async def test_context_joins_the_question_turn_when_history_is_replayed():
    template = Agent(model=_mock_model())
    ag = StrandsAgent(template, name="test")
    lookalike_description = "A2UI Component Schema for customer preferences"
    context = [
        Context(description=A2UI_SCHEMA_CONTEXT_DESCRIPTION, value="raw catalog"),
        Context(description=lookalike_description, value="keep me"),
        Context(description="user_id", value="u-42"),
    ]

    with patch("ag_ui_strands.agent.StrandsAgentCore", _CapturingCore):
        instance = await _drive(ag, _run_input(context), complete=True)

    assert instance.model_messages == [[
        {
            "role": "user",
            "content": [
                {
                    "text": (
                        "Context provided by the application:\n"
                        f"- {lookalike_description}: keep me\n"
                        "- user_id: u-42"
                    )
                },
                {"text": "hello"},
            ],
        },
    ]]
    assert instance.messages == [
        {"role": "user", "content": [{"text": "hello"}]}
    ]
    assert instance.stream_prompts == [None]


@pytest.mark.asyncio
async def test_context_is_transient_when_history_replay_is_disabled():
    template = Agent(model=_mock_model())
    ag = StrandsAgent(
        template,
        name="test",
        config=StrandsAgentConfig(replay_history_into_strands=False),
    )

    with patch("ag_ui_strands.agent.StrandsAgentCore", _CapturingCore):
        instance = await _drive(
            ag,
            _run_input([Context(description="account", value="premium")]),
            complete=True,
        )

    assert instance.stream_prompts == ["hello"]
    assert instance.model_messages == [[
        {
            "role": "user",
            "content": [
                {"text": "Context provided by the application:\n- account: premium"},
                {"text": "hello"},
            ],
        },
    ]]


@pytest.mark.asyncio
async def test_context_is_transient_for_a_multimodal_direct_prompt():
    template = Agent(model=_mock_model())
    ag = StrandsAgent(
        template,
        name="test",
        config=StrandsAgentConfig(replay_history_into_strands=False),
    )

    with patch("ag_ui_strands.agent.StrandsAgentCore", _CapturingCore):
        image_bytes = b"fake-image"
        instance = await _drive(
            ag,
            _run_input(
                [Context(description="locale", value="nl-NL")],
                content=[
                    TextInputContent(text="hello"),
                    ImageInputContent(
                        source=InputContentDataSource(
                            value=base64.b64encode(image_bytes).decode(),
                            mime_type="image/png",
                        )
                    ),
                ],
            ),
            complete=True,
        )

    assert instance.stream_prompts == [
        [
            {"text": "hello"},
            {
                "image": {
                    "format": "png",
                    "source": {"bytes": image_bytes},
                }
            },
        ]
    ]
    assert instance.model_messages == [[
        {
            "role": "user",
            "content": [
                {"text": "Context provided by the application:\n- locale: nl-NL"},
                {"text": "hello"},
                {
                    "image": {
                        "format": "png",
                        "source": {"bytes": image_bytes},
                    }
                },
            ],
        },
    ]]


@pytest.mark.asyncio
async def test_a2ui_schema_only_context_does_not_change_the_model_prompt():
    template = Agent(model=_mock_model())
    ag = StrandsAgent(
        template,
        name="test",
        config=StrandsAgentConfig(replay_history_into_strands=False),
    )

    with patch("ag_ui_strands.agent.StrandsAgentCore", _CapturingCore):
        instance = await _drive(
            ag,
            _run_input(
                [
                    Context(
                        description=A2UI_SCHEMA_CONTEXT_DESCRIPTION,
                        value="raw catalog",
                    )
                ]
            ),
            complete=True,
        )

    assert instance.stream_prompts == ["hello"]
    assert instance.model_messages == [[
        {"role": "user", "content": [{"text": "hello"}]}
    ]]


@pytest.mark.asyncio
async def test_current_context_joins_the_current_question_not_stale_history():
    template = Agent(model=_mock_model())
    agent = StrandsAgent(template, name="test")
    run_input = RunAgentInput(
        thread_id="t-order",
        run_id="r1",
        state={},
        messages=[
            UserMessage(id="u1", content="selected invoice 456"),
            AssistantMessage(id="a1", content="noted"),
            UserMessage(id="u2", content="which invoice is selected?"),
        ],
        tools=[],
        context=[Context(description="selected invoice", value="123")],
        forwarded_props={},
    )

    with patch("ag_ui_strands.agent.StrandsAgentCore", _CapturingCore):
        instance = await _drive(agent, run_input, complete=True)

    # The block lands on the question being asked now, leaving the stale turns
    # that mention an older invoice exactly as they were.
    assert instance.model_messages == [[
        {"role": "user", "content": [{"text": "selected invoice 456"}]},
        {"role": "assistant", "content": [{"text": "noted"}]},
        {
            "role": "user",
            "content": [
                {
                    "text": (
                        "Context provided by the application:\n"
                        "- selected invoice: 123"
                    )
                },
                {"text": "which invoice is selected?"},
            ],
        },
    ]]


@pytest.mark.asyncio
async def test_session_context_is_visible_for_one_model_call_but_never_persisted(tmp_path):
    model = _CapturingModel()
    session = FileSessionManager(session_id="context-session", storage_dir=str(tmp_path))
    template = Agent(model=model, callback_handler=None)
    agent = StrandsAgent(
        template,
        name="test",
        config=StrandsAgentConfig(
            session_manager_provider=lambda _input: session,
        ),
    )

    await _drive(
        agent,
        _run_input(
            [Context(description="token", value="secret-value")],
            thread_id="context-session",
            content="first question",
        ),
        complete=True,
    )

    instance = agent._agents_by_thread["context-session"]
    assert "secret-value" in repr(model.calls[0])
    assert "secret-value" not in repr(instance.messages)
    persisted_after_first = session.session_repository.list_messages(
        session.session_id, instance.agent_id
    )
    assert "secret-value" not in repr(persisted_after_first)

    await _drive(
        agent,
        _run_input(
            [],
            thread_id="context-session",
            content="second question",
        ),
        complete=True,
    )

    assert "secret-value" not in repr(model.calls[1])
    assert "secret-value" not in repr(instance.messages)
    persisted_after_second = session.session_repository.list_messages(
        session.session_id, instance.agent_id
    )
    assert "secret-value" not in repr(persisted_after_second)


# ---------------------------------------------------------------------------
# Provider-bound ordering during a tool continuation
# ---------------------------------------------------------------------------
#
# Strands carries a tool result in a message whose role is ``user``, so the
# turn the context block would naturally join during a continuation is the one
# answering a tool call. Both provider families refuse that for different
# reasons, and neither refusal is visible in the native history:
#
# * The OpenAI-compatible formatters emit a message's non-tool content as its
#   own ``user`` message and append the ``tool`` messages after it, whatever
#   order the blocks sit in. A text block anywhere in the tool-result turn
#   therefore lands between the assistant ``tool_calls`` and the results.
# * The block-level formatters (Anthropic, Bedrock, Gemini) map messages one
#   to one, so a separate context turn beside the results is two ``user``
#   messages in a row and fails role alternation.
#
# The block joins the question turn instead, which leaves the provider-bound
# message sequence exactly as it would be with no context at all.

_TOOL_CONTINUATION = [
    {"role": "user", "content": [{"text": "weather and time in SF?"}]},
    {
        "role": "assistant",
        "content": [
            {"toolUse": {"toolUseId": "t1", "name": "get_weather", "input": {}}},
            {"toolUse": {"toolUseId": "t2", "name": "get_time", "input": {}}},
        ],
    },
    {
        "role": "user",
        "content": [
            {
                "toolResult": {
                    "toolUseId": "t1",
                    "status": "success",
                    "content": [{"text": "sunny"}],
                }
            },
            {
                "toolResult": {
                    "toolUseId": "t2",
                    "status": "success",
                    "content": [{"text": "10am"}],
                }
            },
        ],
    },
]


def _inject_context(messages, block):
    """Run the real before-hook over *messages*, returning the hooked agent.

    The block reaches the hook through the same ``ContextVar`` the run loop
    sets, so this exercises the shipped code path rather than a restatement of
    it.
    """
    agent = SimpleNamespace(messages=messages)
    hook = _TransientModelContextHook()
    registry = HookRegistry()
    hook.register_hooks(registry)
    token = _MODEL_CONTEXT_BLOCK.set(block)
    try:
        invoke_before_model_call(registry, agent)
    finally:
        _MODEL_CONTEXT_BLOCK.reset(token)
    return agent, registry


def _openai_request_messages(messages):
    """Serialize native history with the real OpenAI Chat Completions formatter."""
    return OpenAIModel.format_request_messages(messages, None)


def _openai_role_sequence(messages):
    """Provider-bound roles, with the ids each ``tool_calls`` message opened."""
    sequence = []
    for message in _openai_request_messages(messages):
        role = message["role"]
        if message.get("tool_calls"):
            ids = ",".join(call["id"] for call in message["tool_calls"])
            sequence.append(f"{role}(tool_calls={ids})")
        elif role == "tool":
            sequence.append(f"tool({message['tool_call_id']})")
        else:
            sequence.append(role)
    return sequence


def _assert_tool_calls_answered_immediately(messages):
    """Every assistant ``tool_calls`` message is followed by its own results.

    This is the adjacency OpenAI states in the 400 the bridge used to turn into
    a terminal RUN_ERROR: "An assistant message with 'tool_calls' must be
    followed by tool messages responding to each 'tool_call_id'".
    """
    formatted = _openai_request_messages(messages)
    for index, message in enumerate(formatted):
        tool_calls = message.get("tool_calls")
        if not tool_calls:
            continue
        expected_ids = [call["id"] for call in tool_calls]
        answers = formatted[index + 1 : index + 1 + len(expected_ids)]
        assert [answer["role"] for answer in answers] == ["tool"] * len(
            expected_ids
        ), f"tool_calls at {index} not answered immediately: {_openai_role_sequence(messages)}"
        # As a set: the provider requires the answers to be the messages right
        # after the call, not to arrive in the order the calls were made.
        assert sorted(answer["tool_call_id"] for answer in answers) == sorted(
            expected_ids
        )


def _block_level_role_sequence(messages):
    """Provider-bound roles from the real Anthropic Messages formatter.

    Anthropic stands in for the block-level family: its formatter maps native
    messages to provider messages one to one and never merges same-role
    neighbours, exactly as Bedrock's and Gemini's do. Its ``format_request`` is
    public, so this does not couple the suite to a private SDK signature.
    """
    model = AnthropicModel(
        model_id="claude-sonnet-4-5", max_tokens=64, client_args={"api_key": "test-key"}
    )
    request = model.format_request(messages, [], None)
    return [message["role"] for message in request["messages"]]


def _assert_roles_alternate(messages):
    """No two provider-bound messages in a row share a role.

    The Anthropic Messages API and Bedrock Converse both refuse a repeated
    role, so a context turn placed next to any user turn is a rejected request
    on that whole family.
    """
    roles = _block_level_role_sequence(messages)
    repeated = [
        (index, role)
        for index, role in enumerate(roles[1:], start=1)
        if role == roles[index - 1]
    ]
    assert repeated == [], f"role repeats at {repeated}: {roles}"


class TestToolContinuationProviderOrdering:
    """The block must not disturb the request a tool continuation serializes to."""

    def test_every_tool_call_is_still_answered_immediately(self):
        messages = copy.deepcopy(_TOOL_CONTINUATION)
        _inject_context(messages, "Context provided by the application:\n- locale: en-US")

        _assert_tool_calls_answered_immediately(messages)
        assert _openai_role_sequence(messages) == [
            "user",
            "assistant(tool_calls=t1,t2)",
            "tool(t1)",
            "tool(t2)",
        ]

    def test_roles_still_alternate_for_the_block_level_formatters(self):
        messages = copy.deepcopy(_TOOL_CONTINUATION)
        _inject_context(messages, "Context provided by the application:\n- locale: en-US")

        _assert_roles_alternate(messages)

    def test_context_does_not_change_the_provider_bound_sequence(self):
        """A/B control: the same continuation with no context and with one entry.

        The sequence is what the provider validates, so a fix that keeps it
        identical cannot reintroduce the rejection for any entry count.
        """
        without = copy.deepcopy(_TOOL_CONTINUATION)
        with_context = copy.deepcopy(_TOOL_CONTINUATION)
        _inject_context(
            with_context, "Context provided by the application:\n- locale: en-US"
        )

        assert _openai_role_sequence(with_context) == _openai_role_sequence(without)
        assert _block_level_role_sequence(with_context) == _block_level_role_sequence(
            without
        )

    def test_block_joins_the_question_and_leaves_the_results_untouched(self):
        messages = copy.deepcopy(_TOOL_CONTINUATION)
        block = "Context provided by the application:\n- locale: en-US"

        _inject_context(messages, block)

        assert messages[0]["content"] == [
            {"text": block},
            {"text": "weather and time in SF?"},
        ]
        assert messages[1:] == _TOOL_CONTINUATION[1:]

    def test_the_block_is_withdrawn_after_the_model_call(self):
        messages = copy.deepcopy(_TOOL_CONTINUATION)
        agent, registry = _inject_context(
            messages, "Context provided by the application:\n- locale: en-US"
        )

        invoke_after_model_call(registry, agent)

        assert messages == _TOOL_CONTINUATION
        assert _MODEL_CONTEXT_MUTATION_MARKER not in agent.__dict__

    def test_a_skipped_restore_is_refused_rather_than_left_to_leak(self):
        messages = copy.deepcopy(_TOOL_CONTINUATION)
        block = "Context provided by the application:\n- locale: en-US"
        agent, registry = _inject_context(messages, block)

        token = _MODEL_CONTEXT_BLOCK.set(block)
        try:
            with pytest.raises(RuntimeError, match="was not restored"):
                invoke_before_model_call(registry, agent)
        finally:
            _MODEL_CONTEXT_BLOCK.reset(token)


@pytest.mark.asyncio
async def test_frontend_tool_continuation_serializes_to_a_request_openai_accepts():
    """The proxy path: the client answered the call and the run continues.

    The wire history carries the assistant call and the client's result, which
    the bridge replays as a native tool exchange, so the turn the block would
    otherwise join is the one answering the call.
    """
    model = _CapturingModel()
    template = Agent(model=model, callback_handler=None)
    agent = StrandsAgent(template, name="test")
    run_input = RunAgentInput(
        thread_id="t-frontend",
        run_id="r1",
        state={},
        messages=[
            UserMessage(id="u1", content="what is the weather?"),
            AssistantMessage(
                id="a1",
                tool_calls=[
                    ToolCall(
                        id="tc1",
                        type="function",
                        function=FunctionCall(name="get_weather", arguments="{}"),
                    )
                ],
            ),
            ToolMessage(id="m1", content="sunny", tool_call_id="tc1"),
        ],
        tools=[Tool(name="get_weather", description="d", parameters={})],
        context=[Context(description="locale", value="en-US")],
        forwarded_props={},
    )

    async for _ in agent.run(run_input):
        pass

    seen = model.calls[0]
    assert any("toolResult" in block for block in seen[-1]["content"])
    _assert_tool_calls_answered_immediately(seen)
    _assert_roles_alternate(seen)
    assert "en-US" in repr(seen)


@pytest.mark.asyncio
async def test_backend_tool_continuation_serializes_to_a_request_openai_accepts():
    """The native path: a Strands tool ran in-process and the loop came back."""

    @strands_tool(name="get_weather", description="d")
    def get_weather() -> str:
        return "sunny"

    model = _CapturingModel(
        turns=[_tool_use_turn(("t1", "get_weather")), _text_turn("done")]
    )
    template = Agent(model=model, tools=[get_weather], callback_handler=None)
    agent = StrandsAgent(template, name="test")

    async for _ in agent.run(
        _run_input([Context(description="locale", value="en-US")], thread_id="t-backend")
    ):
        pass

    assert len(model.calls) == 2, f"expected a continuation call, got {len(model.calls)}"
    continuation = model.calls[1]
    assert any("toolResult" in block for block in continuation[-1]["content"])
    _assert_tool_calls_answered_immediately(continuation)
    _assert_roles_alternate(continuation)
    assert "en-US" in repr(continuation)


class _ProviderRuleModel(_CapturingModel):
    """A model boundary that enforces the rule the provider enforces.

    The real formatter decides the request, and OpenAI rejects one whose
    assistant ``tool_calls`` message is not answered immediately. Raising the
    provider's own message here reproduces the reported failure end to end
    offline: the bridge wraps a provider raise into a terminal RUN_ERROR under
    ``STRANDS_FORCE_STOP``, which is what the run died of. It is not a
    substitute for a live provider run, only for the rule the provider applies.
    """

    PROVIDER_400 = (
        "An assistant message with 'tool_calls' must be followed by tool "
        "messages responding to each 'tool_call_id'"
    )

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs):
        # Recorded before the rule runs, so a rejected call still counts and
        # the call-count assertions report what actually happened.
        self.calls.append(copy.deepcopy(messages))
        formatted = _openai_request_messages(messages)
        for index, message in enumerate(formatted):
            tool_calls = message.get("tool_calls")
            if not tool_calls:
                continue
            answers = formatted[index + 1 : index + 1 + len(tool_calls)]
            if [answer["role"] for answer in answers] != ["tool"] * len(tool_calls):
                raise RuntimeError(self.PROVIDER_400)
        self.calls.pop()
        async for event in super().stream(
            messages, tool_specs=tool_specs, system_prompt=system_prompt, **kwargs
        ):
            yield event


@pytest.mark.asyncio
async def test_a_tool_continuation_with_context_finishes_instead_of_erroring():
    """The run-level symptom: the tool succeeded, then the run died.

    The tool call and its result are already on the wire when the provider
    rejects the continuation, so the UI shows a healthy tool card while the run
    terminates. Only the terminal event tells the two apart, which is why this
    asserts on it rather than on what was rendered.
    """

    @strands_tool(name="get_weather", description="d")
    def get_weather() -> str:
        return "sunny"

    model = _ProviderRuleModel(
        turns=[_tool_use_turn(("t1", "get_weather")), _text_turn("it is sunny")]
    )
    template = Agent(model=model, tools=[get_weather], callback_handler=None)
    agent = StrandsAgent(template, name="test")

    events = [
        event
        async for event in agent.run(
            _run_input(
                [Context(description="locale", value="en-US")], thread_id="t-terminal"
            )
        )
    ]

    types = [event.type for event in events]
    codes = [getattr(event, "code", None) for event in events]
    assert "STRANDS_FORCE_STOP" not in codes, f"run force-stopped: {types}"
    assert EventType.RUN_ERROR not in types, f"run errored: {types}"
    assert types[-1] == EventType.RUN_FINISHED, f"terminal event was {types[-1]}"
    assert len(model.calls) == 2, "the continuation call never happened"


class TestModelBoundHistoryOutline:
    """The failure-path diagnostic has to describe the request the provider saw."""

    QUESTION = {"role": "user", "content": [{"text": "q"}]}

    @staticmethod
    def _tool_use(call_id):
        return {"toolUse": {"toolUseId": call_id, "name": "a", "input": {}}}

    @staticmethod
    def _tool_result(call_id):
        return {"toolResult": {"toolUseId": call_id, "content": [{"text": "r"}]}}

    def test_it_renders_the_sequence_the_real_formatter_builds(self):
        """A diagnostic describing a request the provider never saw is worse
        than none, so the whole line is pinned against the formatter."""
        messages = copy.deepcopy(_TOOL_CONTINUATION)
        _inject_context(messages, "Context provided by the application:\n- l: en")

        rendered = describe_model_bound_history(messages)
        stripped = re.sub(r"\[[^\]]*\]", "", rendered)

        assert stripped == " -> ".join(_openai_role_sequence(messages))

    def test_a_wedged_message_is_visible_in_the_line(self):
        """The whole point: the reader can see the break without re-deriving it."""
        outline = describe_model_bound_history(
            [
                self.QUESTION,
                {"role": "assistant", "content": [self._tool_use("t1")]},
                {"role": "user", "content": [{"text": "ctx"}, self._tool_result("t1")]},
            ]
        )

        assert outline == (
            "user[text] -> assistant(tool_calls=t1) -> user[text] -> tool(t1)"
        )

    def test_a_tool_id_carrying_punctuation_survives_intact(self):
        weird = "a,b)c"
        outline = describe_model_bound_history(
            [
                {"role": "assistant", "content": [self._tool_use(weird)]},
                {"role": "user", "content": [self._tool_result(weird)]},
            ]
        )

        assert outline == f"assistant(tool_calls={weird}) -> tool({weird})"

    def test_a_block_naming_a_call_with_nothing_in_it_is_still_a_tool_block(self):
        """Placement and the outline must not disagree about a block's kind."""
        block = {"toolResult": None}
        message = {"role": "user", "content": [block]}

        assert _carries_tool_result(message) is True
        assert describe_model_bound_history([message]) == "tool(None)"

    def test_the_outline_carries_no_message_text(self):
        messages = copy.deepcopy(_TOOL_CONTINUATION)
        _inject_context(
            messages, "Context provided by the application:\n- token: s3cret"
        )

        outline = describe_model_bound_history(messages)

        assert "s3cret" not in outline
        assert "weather and time in SF?" not in outline
        assert "sunny" not in outline


class TestContextPlacementWithNoQuestionTurn:
    """The block still has to go somewhere when no question turn exists."""

    def test_a_replayed_tool_exchange_gets_the_block_as_its_opening_turn(self):
        messages = copy.deepcopy(_TOOL_CONTINUATION[1:])
        block = "Context provided by the application:\n- locale: en-US"

        _inject_context(messages, block)

        assert messages[0] == {"role": "user", "content": [{"text": block}]}
        assert messages[1:] == _TOOL_CONTINUATION[1:]
        _assert_tool_calls_answered_immediately(messages)
        _assert_roles_alternate(messages)

    def test_a_history_ending_on_an_assistant_turn_gets_a_new_trailing_turn(self):
        """A trailing user turn both alternates and sits closest to generation."""
        messages = [{"role": "assistant", "content": [{"text": "anything else?"}]}]
        block = "Context provided by the application:\n- locale: en-US"

        _inject_context(messages, block)

        assert messages == [
            {"role": "assistant", "content": [{"text": "anything else?"}]},
            {"role": "user", "content": [{"text": block}]},
        ]
        _assert_roles_alternate(messages)

    def test_an_empty_history_gets_the_block_as_its_only_turn(self):
        messages = []
        block = "Context provided by the application:\n- locale: en-US"

        _inject_context(messages, block)

        assert messages == [{"role": "user", "content": [{"text": block}]}]


@pytest.mark.asyncio
async def test_a_forced_stop_reports_the_history_the_failing_call_was_handed(
    monkeypatch, caplog
):
    """The whole point of the outline: a provider rejection names the shape.

    Driven through Strands' real forced-stop path, so the report this asserts on
    is the one an operator actually gets.
    """
    monkeypatch.setattr(strands_event_loop, "MAX_ATTEMPTS", 1)

    class _ThrottledModel(_CapturingModel):
        async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs):
            self.calls.append(copy.deepcopy(messages))
            raise ModelThrottledException("too many requests")
            yield  # pragma: no cover - unreachable, keeps this a generator

    template = Agent(model=_ThrottledModel(), tools=[], callback_handler=None)
    agent = StrandsAgent(template, name="test")

    with caplog.at_level(logging.ERROR, logger="ag_ui_strands.agent"):
        events = [
            event
            async for event in agent.run(
                _run_input(
                    [Context(description="locale", value="en-US")],
                    thread_id="t-forced",
                )
            )
        ]

    assert [getattr(e, "code", None) for e in events][-1] == "STRANDS_FORCE_STOP"
    forced = [r for r in caplog.records if "force-stopped" in r.getMessage()]
    assert forced, f"no forced-stop line: {[r.getMessage() for r in caplog.records]}"
    line = forced[0].getMessage()
    assert "model_bound_history=" in line
    # The sequence itself, which is what says whether each call was answered.
    assert "user[" in line
    assert "en-US" not in line, "the outline must not carry context text"


@pytest.mark.asyncio
async def test_a_later_context_free_run_does_not_report_the_earlier_outline():
    """Per-thread agents are reused, so a stale outline would name another run."""
    model = _CapturingModel()
    template = Agent(model=model, callback_handler=None)
    agent = StrandsAgent(template, name="test")

    async for _ in agent.run(
        _run_input([Context(description="locale", value="en-US")], thread_id="t-stale")
    ):
        pass
    instance = agent._agents_by_thread["t-stale"]
    assert getattr(instance, _MODEL_BOUND_HISTORY_OUTLINE, None) is not None

    async for _ in agent.run(
        _run_input([], thread_id="t-stale", content="second question")
    ):
        pass

    assert getattr(instance, _MODEL_BOUND_HISTORY_OUTLINE, None) is None


class TestOrdinaryTurnProviderOrdering:
    """The plain path has to survive the same two checks as a continuation.

    It is the default path and it used to place the block as its own user
    message next to the question, which reads fine as native history and is two
    consecutive user messages once a block-level formatter maps it one to one.
    """

    ORDINARY = [
        {"role": "user", "content": [{"text": "selected invoice 456"}]},
        {"role": "assistant", "content": [{"text": "noted"}]},
        {"role": "user", "content": [{"text": "which invoice is selected?"}]},
    ]

    def test_roles_still_alternate(self):
        messages = copy.deepcopy(self.ORDINARY)
        _inject_context(messages, "Context provided by the application:\n- l: en")

        _assert_roles_alternate(messages)

    def test_context_does_not_change_the_provider_bound_sequence(self):
        without = copy.deepcopy(self.ORDINARY)
        with_context = copy.deepcopy(self.ORDINARY)
        _inject_context(
            with_context, "Context provided by the application:\n- l: en"
        )

        assert _openai_role_sequence(with_context) == _openai_role_sequence(without)
        assert _block_level_role_sequence(with_context) == _block_level_role_sequence(
            without
        )

    def test_a_single_question_turn_does_not_gain_a_second_user_message(self):
        messages = [{"role": "user", "content": [{"text": "hello"}]}]
        block = "Context provided by the application:\n- l: en"

        _inject_context(messages, block)

        assert messages == [
            {"role": "user", "content": [{"text": block}, {"text": "hello"}]}
        ]
        _assert_roles_alternate(messages)


@pytest.mark.asyncio
async def test_the_block_is_withdrawn_when_the_consumer_abandons_the_run():
    """Cancellation is the path where the after-hook never fires, so the run
    loop's teardown is the only thing that takes the block back out."""
    model = _CapturingModel(turns=[_tool_use_turn(("t1", "get_weather"))])

    @strands_tool(name="get_weather", description="d")
    def get_weather() -> str:  # pragma: no cover - the run is abandoned first
        return "sunny"

    template = Agent(model=model, tools=[get_weather], callback_handler=None)
    agent = StrandsAgent(template, name="test")

    stream = agent.run(
        _run_input(
            [Context(description="token", value="s3cret")], thread_id="t-cancel"
        )
    )
    async for _ in stream:
        break
    await stream.aclose()

    instance = agent._agents_by_thread["t-cancel"]
    assert "s3cret" not in repr(instance.messages)
    assert _MODEL_CONTEXT_MUTATION_MARKER not in instance.__dict__
