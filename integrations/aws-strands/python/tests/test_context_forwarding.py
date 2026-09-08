"""RunAgentInput.context must reach per-thread Strands agent state.

Mirrors the langgraph integration where tools read context off agent state.
Tools running on Strands read it via ``strands_agent.state.get("agui_context")``.
"""

from __future__ import annotations

import base64
import copy
from unittest.mock import MagicMock, patch

import pytest
from strands import Agent
from strands import tool as strands_tool
from strands.agent.state import AgentState
from strands.hooks.registry import HookRegistry
from strands.models.model import Model
from strands.session.file_session_manager import FileSessionManager
from strands.tools.registry import ToolRegistry

from ag_ui.core import (
    AssistantMessage,
    Context,
    EventType,
    ImageInputContent,
    InputContentDataSource,
    RunAgentInput,
    TextInputContent,
    UserMessage,
)
from ag_ui_a2ui_toolkit import A2UI_SCHEMA_CONTEXT_DESCRIPTION

try:
    from strands.types.json_dict import JSONSerializableDict  # strands <2.0
except ImportError:
    try:
        from strands.types import JSONSerializableDict  # strands >=2.0 (reorganized)
    except ImportError:
        class JSONSerializableDict(dict):  # type: ignore[no-redef]
            def set(self, key, value): self[key] = value  # noqa: E704

from ag_ui_strands.agent import StrandsAgent, describe_model_bound_history
from ag_ui_strands.config import StrandsAgentConfig
from tests.hook_helpers import invoke_after_model_call, invoke_before_model_call
from tests.provider_binding import (
    PROVIDER_FORMATTERS,
    SPLITTING,
    assert_binds_cleanly,
)


class _CapturingModel(Model):
    """Real Strands model boundary that records the exact transient messages."""

    def __init__(self):
        self.calls = []

    def get_config(self):
        return {}

    def update_config(self, **kwargs):
        pass

    async def structured_output(self, *args, **kwargs):
        raise NotImplementedError

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs):
        self.calls.append(copy.deepcopy(messages))
        yield {"messageStart": {"role": "assistant"}}
        yield {"contentBlockStart": {"start": {}}}
        yield {"contentBlockDelta": {"delta": {"text": "ok"}}}
        yield {"contentBlockStop": {}}
        yield {"messageStop": {"stopReason": "end_turn"}}
        yield {
            "metadata": {
                "usage": {"inputTokens": 1, "outputTokens": 1, "totalTokens": 2},
                "metrics": {"latencyMs": 1},
            }
        }


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
async def test_context_rides_in_the_latest_user_turn_when_history_is_replayed():
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

    # One turn and one text block. A turn of its own would be a second user
    # turn beside the question, which the one-to-one formatters reject, and a
    # second text block inside the turn is what the writer formatter refuses.
    assert instance.model_messages == [[
        {
            "role": "user",
            "content": [
                {
                    "text": (
                        "Context provided by the application:\n"
                        f"- {lookalike_description}: keep me\n"
                        "- user_id: u-42"
                        "\n\nhello"
                    )
                },
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
                {
                    "text": (
                        "Context provided by the application:\n- account: premium"
                        "\n\nhello"
                    )
                },
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
                {
                    "text": (
                        "Context provided by the application:\n- locale: nl-NL"
                        "\n\nhello"
                    )
                },
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
async def test_current_context_follows_stale_history_into_the_latest_user_turn():
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
                        "\n\nwhich invoice is selected?"
                    )
                },
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
# What the block binds to
# ---------------------------------------------------------------------------


class _ToolThenTextModel(Model):
    """One tool call, then a plain answer, recording what each call was handed."""

    def __init__(self):
        self.calls = []

    def get_config(self):
        return {}

    def update_config(self, **kwargs):
        pass

    async def structured_output(self, *args, **kwargs):
        raise NotImplementedError

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs):
        self.calls.append(copy.deepcopy(messages))
        yield {"messageStart": {"role": "assistant"}}
        if len(self.calls) == 1:
            yield {
                "contentBlockStart": {
                    "start": {"toolUse": {"toolUseId": "t1", "name": "lookup"}}
                }
            }
            yield {"contentBlockDelta": {"delta": {"toolUse": {"input": "{}"}}}}
            yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "tool_use"}}
            return
        yield {"contentBlockDelta": {"delta": {"text": "done"}}}
        yield {"contentBlockStop": {}}
        yield {"messageStop": {"stopReason": "end_turn"}}


class _ProviderRuleModel(_ToolThenTextModel):
    """A model that refuses the shapes the providers refuse.

    A replaying double answers whatever it is handed, so on its own it cannot
    tell a run that would have worked from one OpenAI would have answered with a
    400. This one applies both rules first, which is what makes the terminal
    event below mean anything: a raise here reaches the client as the same
    ``STRANDS_FORCE_STOP`` the provider's own rejection produces."""

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs):
        for provider in PROVIDER_FORMATTERS:
            try:
                roles = provider.bind(list(messages))
            except ImportError:
                continue
            if provider.family is SPLITTING:
                for index, role in enumerate(roles):
                    if role != "assistant":
                        continue
                    answer = roles[index + 1] if index + 1 < len(roles) else None
                    if answer != "tool":
                        raise RuntimeError(
                            "An assistant message with 'tool_calls' must be "
                            "followed by tool messages responding to each "
                            f"'tool_call_id' ({provider.name}: {roles})"
                        )
            else:
                for index in range(1, len(roles)):
                    if roles[index] == roles[index - 1]:
                        raise RuntimeError(
                            "A conversation must alternate between user and "
                            f"assistant roles ({provider.name}: {roles})"
                        )
        async for event in super().stream(
            messages, tool_specs=tool_specs, system_prompt=system_prompt, **kwargs
        ):
            yield event


@strands_tool
def lookup() -> dict:
    """Look an invoice up."""
    return {"invoice": 42}


def _tool_round_trip_agent(model: Model) -> StrandsAgent:
    template = Agent(model=model, tools=[lookup], callback_handler=None)
    return StrandsAgent(template, name="test")


def _context_run(thread_id: str) -> RunAgentInput:
    return _run_input(
        [Context(description="selected invoice", value="123")],
        thread_id=thread_id,
        content="which invoice is selected?",
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("provider", PROVIDER_FORMATTERS, ids=str)
async def test_the_context_block_binds_to_a_request_the_provider_accepts(provider):
    """The turn that answers a tool call is the one place the block may not go.

    The bridge does not know which provider the host configured, so the history
    it shows the model has to satisfy both families at once: the splitting
    formatters need every tool call answered with nothing in between, and the
    one-to-one formatters need the roles to alternate."""
    model = _ToolThenTextModel()
    agent = _tool_round_trip_agent(model)

    events = [event async for event in agent.run(_context_run(f"ctx-{provider}"))]
    assert [e for e in events if e.type == EventType.RUN_ERROR] == []

    # The second call is the one whose history ends on the tool result.
    assert len(model.calls) == 2
    assert_binds_cleanly(provider, model.calls[1])


@pytest.mark.asyncio
async def test_a_run_finishes_under_a_model_that_enforces_the_provider_rules():
    model = _ProviderRuleModel()
    agent = _tool_round_trip_agent(model)

    events = [event async for event in agent.run(_context_run("ctx-rules"))]

    assert [e for e in events if e.type == EventType.RUN_ERROR] == []
    assert [e.type for e in events][-1] == EventType.RUN_FINISHED


def test_the_diagnostic_names_the_turn_that_breaks_a_tool_call():
    folded = [
        {"role": "user", "content": [{"text": "call the tool"}]},
        {
            "role": "assistant",
            "content": [{"toolUse": {"toolUseId": "t1", "name": "lookup", "input": {}}}],
        },
        {
            "role": "user",
            "content": [
                {
                    "toolResult": {
                        "toolUseId": "t1",
                        "status": "success",
                        "content": [{"text": "ok"}],
                    }
                },
                {"text": "lookup returned: ok"},
            ],
        },
    ]

    assert describe_model_bound_history(folded) == (
        "roles=[user, assistant, user] tool-call adjacency=broken at [2] "
        "role alternation=ok"
    )
