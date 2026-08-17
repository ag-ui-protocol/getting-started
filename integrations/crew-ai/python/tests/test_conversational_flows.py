"""Native CrewAI Conversational Flow bridge behavior."""

import asyncio
import functools
import importlib
import threading
import typing
from types import SimpleNamespace

import pytest
from pydantic import BaseModel, ConfigDict

from ag_ui.core import (
    AssistantMessage,
    DeveloperMessage,
    ImageInputContent,
    InputContentUrlSource,
    SystemMessage,
    TextInputContent,
    ToolCall,
    ToolMessage,
    FunctionCall,
    UserMessage,
    EventType,
    RunAgentInput,
)
from ag_ui.core.types import ResumeEntry
from ag_ui.encoder import EventEncoder
from crewai.flow.flow import Flow, listen, start

from ag_ui_crewai import _capabilities as capabilities
from ag_ui_crewai.sdk import CopilotKitState
from ag_ui_crewai.context import flow_context
from ag_ui_crewai.events import BridgedTextMessageChunkEvent
from ag_ui_crewai._hitl import (
    HITLOptions,
    agui_feedback_provider,
)

from .conftest import (
    WORKER_GUARD,
    WORKER_WAIT,
    capture_stream_sink,
    run_abandonment_signal,
)


class _WithStreamTurn:
    conversational = True

    def stream_turn(self, message, *, session_id=None):
        return (message, session_id)


class _WithoutStreamTurn:
    conversational = True


class _DisabledWithStreamTurn:
    conversational = False

    def stream_turn(self, message, *, session_id=None):
        return (message, session_id)


class _RaisingStreamTurn:
    conversational = True

    @property
    def stream_turn(self):
        raise RuntimeError("probe must degrade")


class _DocumentState(CopilotKitState):
    document: str = ""


def test_conversational_stream_probe_uses_callable_surface():
    probe = capabilities.flow_supports_conversational_stream

    assert probe(_WithStreamTurn()) is True
    assert probe(_WithoutStreamTurn()) is False
    assert probe(_DisabledWithStreamTurn()) is False
    assert probe(_RaisingStreamTurn()) is False


def test_conversational_stream_probe_requires_stream_frame_transport(monkeypatch):
    monkeypatch.setattr(capabilities, "_stream_frame_available", False)

    assert capabilities.flow_supports_conversational_stream(_WithStreamTurn()) is False


def test_copilotkit_state_carries_crewai_conversation_runtime_fields():
    state = CopilotKitState()

    assert state.current_user_message is None
    assert state.last_user_message is None
    assert state.last_intent is None
    assert state.ended is False
    assert state.events == []
    assert state.agent_threads == {}
    assert state.session_ready is False


def test_conversational_turn_preparer_is_available():
    try:
        module = importlib.import_module("ag_ui_crewai._conversation")
    except ModuleNotFoundError:
        pytest.fail("ag_ui_crewai._conversation is not implemented")

    assert callable(getattr(module, "prepare_conversational_turn", None))


def test_prepare_conversational_turn_splits_history_from_latest_user_text():
    from ag_ui_crewai._conversation import prepare_conversational_turn

    messages = [
        SystemMessage(id="s1", role="system", content="system"),
        UserMessage(id="u1", role="user", content="first"),
        AssistantMessage(id="a1", role="assistant", content="answer"),
        UserMessage(id="u2", role="user", content="second"),
    ]

    turn = prepare_conversational_turn(messages)

    assert turn.message == "second"
    assert [
        {key: message[key] for key in ("id", "role", "content")}
        for message in turn.history
    ] == [
        {"id": "u1", "role": "user", "content": "first"},
        {"id": "a1", "role": "assistant", "content": "answer"},
    ]
    assert turn.current_media == []
    assert messages[-1].content == "second"


def test_prepare_conversational_turn_keeps_media_out_of_text_argument():
    from ag_ui_crewai._conversation import prepare_conversational_turn

    messages = [
        UserMessage(
            id="u2",
            role="user",
            content=[
                TextInputContent(type="text", text="look here"),
                ImageInputContent(
                    type="image",
                    source=InputContentUrlSource(
                        type="url", value="https://example.com/image.png"
                    ),
                ),
            ],
        )
    ]

    turn = prepare_conversational_turn(messages)

    assert turn.message == "look here"
    assert turn.history == []
    assert turn.current_media == [
        {
            "type": "image_url",
            "image_url": {"url": "https://example.com/image.png"},
        }
    ]


def test_prepare_conversational_turn_allows_image_only_turn():
    from ag_ui_crewai._conversation import prepare_conversational_turn

    turn = prepare_conversational_turn(
        [
            UserMessage(
                id="u1",
                role="user",
                content=[
                    ImageInputContent(
                        type="image",
                        source=InputContentUrlSource(
                            type="url", value="https://example.com/image.png"
                        ),
                    )
                ],
            )
        ]
    )

    assert turn.message == ""
    assert len(turn.current_media) == 1


def test_prepare_conversational_turn_preserves_frontend_tool_continuation():
    from ag_ui_crewai._conversation import prepare_conversational_turn

    messages = [
        UserMessage(id="u1", role="user", content="change the background"),
        AssistantMessage(
            id="a1",
            role="assistant",
            tool_calls=[
                ToolCall(
                    id="call-1",
                    type="function",
                    function=FunctionCall(
                        name="change_background",
                        arguments='{"background":"blue"}',
                    ),
                )
            ],
        ),
        ToolMessage(
            id="t1",
            role="tool",
            tool_call_id="call-1",
            content='{"status":"success"}',
        ),
    ]

    turn = prepare_conversational_turn(messages)

    assert turn.message == ""
    assert [message["role"] for message in turn.history] == [
        "user",
        "assistant",
        "tool",
    ]
    assert turn.history[-1]["tool_call_id"] == "call-1"


def test_hydrate_conversational_flow_preserves_regular_inputs_and_media():
    from ag_ui_crewai._conversation import (
        ConversationalTurn,
        hydrate_conversational_flow,
    )

    flow = SimpleNamespace(_state=_DocumentState())
    turn = ConversationalTurn(
        message="describe it",
        history=[{"role": "assistant", "content": "send an image"}],
        current_media=[
            {
                "type": "image_url",
                "image_url": {"url": "https://example.com/image.png"},
            }
        ],
    )

    hydrate_conversational_flow(
        flow,
        {
            "id": "thread-1",
            "messages": [{"role": "user", "content": "ignored duplicate"}],
            "document": "shared state",
            "copilotkit": {"actions": [{"name": "frontend_tool"}]},
        },
        turn,
    )

    assert flow._state.id == "thread-1"
    assert flow._state.document == "shared state"
    assert flow._state.copilotkit.actions == [{"name": "frontend_tool"}]
    assert flow._state.messages == [
        {"role": "assistant", "content": "send an image"},
        {
            "role": "user",
            "content": [
                {
                    "type": "image_url",
                    "image_url": {"url": "https://example.com/image.png"},
                }
            ],
        },
    ]


def test_hydrate_conversational_flow_isolates_the_turn_and_the_overlay_inputs():
    """A flow that edits its own history must not reach past its own state.

    Two aliases, both of them one ``dict(message)`` away. The turn is frozen but
    its messages are not, so a shallow copy leaves ``content`` / ``tool_calls``
    shared with the turn the persistence overlay is built from; and the ``messages``
    the seeding RETURNS become that overlay's inputs, so handing the flow the same
    list makes an append to the flow's history an append to the write gate's
    restore overlay.
    """
    from ag_ui_crewai._conversation import (
        ConversationalTurn,
        hydrate_conversational_flow,
    )

    history = [
        {
            "role": "assistant",
            "content": [{"type": "text", "text": "original"}],
            "tool_calls": [{"id": "call-1", "function": {"arguments": "{}"}}],
        }
    ]
    turn = ConversationalTurn(
        message="go on",
        history=history,
        current_media=[{"type": "image_url", "image_url": {"url": "https://x/y.png"}}],
    )
    flow = SimpleNamespace(_state={})

    overlay_inputs = hydrate_conversational_flow(flow, {"id": "thread-3"}, turn)

    flow_messages = flow._state["messages"]
    assert flow_messages is not overlay_inputs["messages"]
    # A flow rewriting its own history, at every depth a message has.
    flow_messages[0]["content"][0]["text"] = "rewritten"
    flow_messages[0]["tool_calls"][0]["function"]["arguments"] = '{"tampered":true}'
    flow_messages[1]["content"][0]["image_url"]["url"] = "https://x/tampered.png"
    flow_messages.append({"role": "assistant", "content": "appended"})

    assert history[0]["content"][0]["text"] == "original", "the frozen turn was edited"
    assert history[0]["tool_calls"][0]["function"]["arguments"] == "{}"
    assert turn.current_media[0]["image_url"]["url"] == "https://x/y.png"
    assert overlay_inputs["messages"] == [
        {
            "role": "assistant",
            "content": [{"type": "text", "text": "original"}],
            "tool_calls": [{"id": "call-1", "function": {"arguments": "{}"}}],
        },
        {
            "role": "user",
            "content": [
                {"type": "image_url", "image_url": {"url": "https://x/y.png"}}
            ],
        },
    ]


def test_hydrate_conversational_flow_supports_mapping_state():
    from ag_ui_crewai._conversation import (
        ConversationalTurn,
        hydrate_conversational_flow,
    )

    flow = SimpleNamespace(_state={"existing": True})
    turn = ConversationalTurn(message="hello", history=[], current_media=[])

    hydrate_conversational_flow(flow, {"id": "thread-2", "value": 3}, turn)

    assert flow._state == {
        "existing": True,
        "id": "thread-2",
        "value": 3,
        "messages": [],
    }


class _RealFlowWithPydanticState(Flow[_DocumentState]):
    """A REAL crewai Flow, whose ``_state`` is a pydantic private attribute.

    The other hydration tests seed a ``SimpleNamespace``, where every write
    channel is the same one. On the real thing they are two, and only one of them
    is what crewai reads.
    """

    conversational = True

    @start()
    def go(self):
        return None


def test_hydrate_conversational_flow_writes_state_where_crewai_reads_it():
    """Seeding must not shadow the private attribute pydantic manages.

    ``object.__setattr__`` lands in the instance ``__dict__``, which wins every
    later READ, while crewai's own ``self._state = ...`` (its persistence restore,
    among others) keeps writing the pydantic private store. The flow would then
    read a state nothing can update again.
    """
    from ag_ui_crewai._conversation import (
        ConversationalTurn,
        hydrate_conversational_flow,
    )

    flow = _RealFlowWithPydanticState()
    turn = ConversationalTurn(message="hello", history=[], current_media=[])

    hydrate_conversational_flow(flow, {"id": "thread-real", "document": "seeded"}, turn)

    assert "_state" not in flow.__dict__, "seeding shadowed the private attribute"
    assert flow.__pydantic_private__["_state"].document == "seeded"
    assert flow.state.document == "seeded"

    # crewai's own write channel, which its persistence restore uses.
    flow._state = _DocumentState(document="restored by crewai")

    assert flow.state.document == "restored by crewai"


def test_hydrate_conversational_flow_keeps_the_crewai_conversation_runtime_fields():
    """The seeding round trip must not reset ``Field(exclude=True)`` fields.

    ``model_dump()`` honours ``exclude=True``, so dumping and revalidating drops
    every conversational runtime field CrewAI keeps on the state and hands back
    its default. That is all of them, on every single turn.
    """
    from ag_ui_crewai._conversation import (
        ConversationalTurn,
        hydrate_conversational_flow,
    )

    flow = SimpleNamespace(
        _state=_DocumentState(
            current_user_message="asked already",
            last_user_message="asked already",
            last_intent="book_flight",
            ended=False,
            events=[{"type": "route_selected"}],
            agent_threads={"planner": [{"role": "assistant", "content": "scratch"}]},
            session_ready=True,
        )
    )

    hydrate_conversational_flow(
        flow,
        {"id": "thread-runtime"},
        ConversationalTurn(message="and now this", history=[], current_media=[]),
    )

    assert flow._state.last_intent == "book_flight"
    assert flow._state.last_user_message == "asked already"
    assert flow._state.current_user_message == "asked already"
    assert flow._state.session_ready is True
    assert flow._state.events == [{"type": "route_selected"}]
    assert flow._state.agent_threads == {
        "planner": [{"role": "assistant", "content": "scratch"}]
    }


class _StateWithoutMessages(BaseModel):
    """A conversational state that cannot represent a conversation."""

    id: str = ""
    document: str = ""


class _ExtraAllowingState(BaseModel):
    model_config = ConfigDict(extra="allow")

    id: str = ""


def test_hydrate_conversational_flow_refuses_a_state_that_cannot_hold_messages():
    """A state with no ``messages`` field must fail, not start with no history.

    pydantic's default ``extra="ignore"`` throws the seeded key away, so the turn
    runs against an empty conversation and the agent has amnesia every time.
    """
    from ag_ui_crewai._conversation import (
        ConversationalTurn,
        hydrate_conversational_flow,
    )

    flow = SimpleNamespace(_state=_StateWithoutMessages())
    turn = ConversationalTurn(
        message="and now this",
        history=[{"role": "user", "content": "asked already"}],
        current_media=[],
    )

    with pytest.raises(TypeError, match="messages"):
        hydrate_conversational_flow(flow, {"id": "thread-no-messages"}, turn)


def test_hydrate_conversational_flow_seeds_messages_into_an_extra_allowing_state():
    """``extra="allow"`` holds the seeded history, so it must NOT be refused."""
    from ag_ui_crewai._conversation import (
        ConversationalTurn,
        hydrate_conversational_flow,
    )

    flow = SimpleNamespace(_state=_ExtraAllowingState())
    turn = ConversationalTurn(
        message="and now this",
        history=[{"role": "user", "content": "asked already"}],
        current_media=[],
    )

    hydrate_conversational_flow(flow, {"id": "thread-extra"}, turn)

    assert flow._state.messages == [{"role": "user", "content": "asked already"}]


def test_prepare_conversational_turn_drops_history_roles_crewai_cannot_hold():
    """A ``developer`` message must not reach CrewAI's conversational history.

    ``ConversationMessage.role`` is a closed literal, so any AG-UI role outside it
    fails validation and takes the whole turn down with it.
    """
    from crewai.experimental.conversational import ConversationMessageRole

    from ag_ui_crewai._conversation import prepare_conversational_turn

    accepted = set(typing.get_args(ConversationMessageRole))
    messages = [
        SystemMessage(id="s1", role="system", content="system"),
        DeveloperMessage(id="d1", role="developer", content="developer"),
        UserMessage(id="u1", role="user", content="first"),
        AssistantMessage(id="a1", role="assistant", content="answer"),
        UserMessage(id="u2", role="user", content="second"),
    ]

    turn = prepare_conversational_turn(messages)

    assert [message["role"] for message in turn.history] == ["user", "assistant"]
    assert {message["role"] for message in turn.history} <= accepted


def test_prepare_conversational_turn_drops_unheld_roles_without_a_trailing_user_turn():
    """The no-current-message branch filters by the same rule."""
    from ag_ui_crewai._conversation import prepare_conversational_turn

    turn = prepare_conversational_turn(
        [
            SystemMessage(id="s1", role="system", content="system"),
            DeveloperMessage(id="d1", role="developer", content="developer"),
            AssistantMessage(id="a1", role="assistant", content="answer"),
        ]
    )

    assert turn.message == ""
    assert [message["role"] for message in turn.history] == ["assistant"]


def test_developer_history_hydrates_a_typed_crewai_conversation_state():
    """End to end for the crash: a developer message no longer kills the turn.

    A state deriving from CrewAI's own ``ConversationState`` types ``messages`` as
    ``list[ConversationMessage]``, so the unheld role fails validation right at
    hydration.
    """
    from crewai.experimental.conversational import ConversationState

    from ag_ui_crewai._conversation import (
        hydrate_conversational_flow,
        prepare_conversational_turn,
    )

    class _TypedConversationState(ConversationState):
        document: str = ""

    turn = prepare_conversational_turn(
        [
            DeveloperMessage(id="d1", role="developer", content="developer"),
            UserMessage(id="u1", role="user", content="first"),
            AssistantMessage(id="a1", role="assistant", content="answer"),
            UserMessage(id="u2", role="user", content="second"),
        ]
    )
    flow = SimpleNamespace(_state=_TypedConversationState())

    hydrate_conversational_flow(flow, {"id": "thread-typed"}, turn)

    assert [message.role for message in flow._state.messages] == ["user", "assistant"]


class _AstreamOnlyFlow:
    """A REGULAR flow double: records what ``astream`` was handed."""

    def __init__(self):
        self.received = None

    def __deepcopy__(self, memo):
        return self

    def astream(self, inputs=None):
        self.received = inputs
        return _EmptyAsyncSession()


class _EmptyAsyncSession:
    def __aiter__(self):
        return self

    async def __anext__(self):
        raise StopAsyncIteration

    async def aclose(self):
        return None


async def test_regular_flow_receives_its_inputs_only_through_astream(monkeypatch):
    """The regular path is seeded by crewai from ``astream(inputs=...)``.

    ``stream_turn`` takes only the new message and the session id, which is the
    whole reason the conversational path needs a hydration step at all. The regular
    path must never acquire one.
    """
    from ag_ui_crewai import endpoint

    calls = []

    def _spy(*args, **kwargs):
        calls.append((args, kwargs))
        raise AssertionError("a regular flow must not be hydrated")

    monkeypatch.setattr(endpoint, "hydrate_conversational_flow", _spy)

    flow = _AstreamOnlyFlow()
    inputs = {
        "id": "thread-regular",
        "messages": [{"role": "user", "content": "hello"}],
        "document": "incoming",
    }

    _ = [
        chunk
        async for chunk in endpoint._run_flow_frame_stream(
            flow_copy=flow,
            encoder=EventEncoder(),
            input_data=RunAgentInput(
                thread_id="thread-regular",
                run_id="run-regular",
                state={"document": "incoming"},
                messages=[UserMessage(id="u1", role="user", content="hello")],
                tools=[],
                context=[],
                forwarded_props={},
            ),
            inputs=inputs,
            timeout=30,
            conversational_turn=None,
        )
    ]

    assert calls == []
    assert flow.received == inputs


class _SyncSession:
    def __init__(self, frames=(), error=None):
        self.frames = list(frames)
        self.error = error
        self.closed = False

    def __iter__(self):
        yield from self.frames
        if self.error is not None:
            raise self.error

    def close(self):
        self.closed = True


class _StoredStatePersistence:
    def load_state(self, flow_id):
        return {
            "id": flow_id,
            "messages": [{"role": "assistant", "content": "stored history"}],
            "document": "stored document",
        }


class _PersistentRestoreFlow:
    conversational = True

    def __init__(self):
        self._state = _DocumentState()
        self.persistence = _StoredStatePersistence()
        self.state_seen_after_restore = None

    def stream_turn(self, _message, *, session_id=None):
        self._state = _DocumentState.model_validate(
            self.persistence.load_state(session_id)
        )
        self.state_seen_after_restore = self._state.model_dump()
        return _SyncSession()


@pytest.mark.asyncio
async def test_sync_stream_session_adapter_preserves_order_and_closes():
    from ag_ui_crewai._conversation import SyncStreamSessionAdapter

    session = _SyncSession(["one", "two", "three"])
    adapter = SyncStreamSessionAdapter(session)

    assert [frame async for frame in adapter] == ["one", "two", "three"]
    assert session.closed is True


@pytest.mark.asyncio
async def test_sync_stream_session_adapter_propagates_producer_error():
    from ag_ui_crewai._conversation import SyncStreamSessionAdapter

    adapter = SyncStreamSessionAdapter(
        _SyncSession(["one"], error=RuntimeError("producer failed"))
    )

    with pytest.raises(RuntimeError, match="producer failed"):
        _ = [frame async for frame in adapter]


@pytest.mark.asyncio
async def test_sync_stream_session_adapter_aclose_is_non_blocking(caplog):
    from ag_ui_crewai._conversation import SyncStreamSessionAdapter

    release = threading.Event()

    class _BlockedSession(_SyncSession):
        def __iter__(self):
            release.wait(timeout=5)
            yield "late"

    session = _BlockedSession()
    adapter = SyncStreamSessionAdapter(session)
    iterator = adapter.__aiter__()
    pending = asyncio.create_task(iterator.__anext__())
    await asyncio.sleep(0)

    await asyncio.wait_for(adapter.aclose(), timeout=0.1)
    # The cooperative-stop flag must actually be set, not just logged: the worker
    # observes it between frames. Without this assertion, deleting
    # ``self._stop.set()`` leaves the whole mechanism silently removable.
    assert adapter._stop.is_set()
    assert "requested cooperative cancellation" in caplog.text
    release.set()
    pending.cancel()
    with pytest.raises(asyncio.CancelledError):
        await pending


@pytest.mark.asyncio
async def test_sync_stream_session_adapter_logs_close_failures(caplog):
    from ag_ui_crewai._conversation import SyncStreamSessionAdapter

    class _CloseFailingSession(_SyncSession):
        def close(self):
            raise RuntimeError("close failed")

    adapter = SyncStreamSessionAdapter(_CloseFailingSession(["one"]))

    assert [frame async for frame in adapter] == ["one"]
    assert "failed to close a conversational StreamSession" in caplog.text
    assert "close failed" in caplog.text


@pytest.mark.asyncio
async def test_frame_driver_reapplies_agui_inputs_after_persistence_restore():
    from ag_ui_crewai import endpoint
    from ag_ui_crewai._conversation import ConversationalTurn

    flow = _PersistentRestoreFlow()
    input_data = RunAgentInput(
        thread_id="thread-persisted",
        run_id="run-persisted",
        state={"document": "incoming document"},
        messages=[UserMessage(id="u2", role="user", content="next turn")],
        tools=[],
        context=[],
        forwarded_props={},
    )
    turn = ConversationalTurn(
        message="next turn",
        history=[{"role": "user", "content": "incoming history"}],
        current_media=[],
    )

    _ = [
        chunk
        async for chunk in endpoint._run_flow_frame_stream(
            flow_copy=flow,
            encoder=EventEncoder(),
            input_data=input_data,
            inputs={
                "id": input_data.thread_id,
                "messages": turn.history,
                "document": "incoming document",
            },
            timeout=30,
            conversational_turn=turn,
        )
    ]

    assert flow.state_seen_after_restore["document"] == "incoming document"
    assert flow.state_seen_after_restore["messages"] == turn.history


# The conversational Flow types below are built on FIRST USE, with the crewai
# imports they need inside the factories. ``crewai.experimental.conversational``
# and ``crewai.flow.human_feedback`` do not exist on the declared crewai floor, and
# importing them at module level fails this whole file at COLLECTION there, which
# would void the floor story the sibling containment suite's skipif markers tell.


@functools.lru_cache(maxsize=1)
def _conversational_bridge_flow_type():
    """A conversational Flow that emits one bridged assistant chunk and finishes."""
    from crewai.experimental.conversational import ConversationConfig

    @ConversationConfig(defer_trace_finalization=False)
    class _ConversationalBridgeFlow(Flow[CopilotKitState]):
        conversational = True

        @start()
        async def chat(self):
            running = flow_context.get()
            from ag_ui_crewai._capabilities import crewai_event_bus

            crewai_event_bus.emit(
                running,
                BridgedTextMessageChunkEvent(
                    type=EventType.TEXT_MESSAGE_CHUNK,
                    message_id="assistant-1",
                    role="assistant",
                    delta="hello back",
                ),
            )
            self.state.messages.append(
                {"role": "assistant", "content": "hello back", "id": "assistant-1"}
            )

        def route_turn(self, _context):
            return "ag_ui_complete"

        @listen("ag_ui_complete")
        def finish_ag_ui_turn(self):
            return None

    return _ConversationalBridgeFlow


@functools.lru_cache(maxsize=1)
def _deferred_conversational_flow_type():
    """The same flow, left with crewai's default deferred trace finalization."""
    from crewai.experimental.conversational import ConversationConfig

    @ConversationConfig()
    class _DeferredConversationalFlow(_conversational_bridge_flow_type()):
        conversational = True

    return _DeferredConversationalFlow


class _RegularOnlyFlow(Flow[CopilotKitState]):
    @start()
    def run_regular(self):
        raise AssertionError("regular execution must not be used as fallback")


class _ConversationalInterruptState(CopilotKitState):
    result: str = ""


@functools.lru_cache(maxsize=1)
def _conversational_interrupt_flow_type():
    """A conversational Flow that pauses for human feedback, then applies it."""
    from crewai.experimental.conversational import ConversationConfig
    from crewai.flow import human_feedback

    @ConversationConfig(defer_trace_finalization=False)
    class _ConversationalInterruptFlow(Flow[_ConversationalInterruptState]):
        conversational = True

        @start()
        @human_feedback(message="Approve the plan?", provider=agui_feedback_provider)
        def propose(self):
            return {"plan": ["a", "b"]}

        @listen(propose)
        def apply(self, feedback):
            answer = getattr(feedback, "feedback", feedback)
            self.state.result = f"done: {answer}"

        def route_turn(self, _context):
            return "ag_ui_complete"

        @listen("ag_ui_complete")
        def finish_ag_ui_turn(self):
            return None

    return _ConversationalInterruptFlow


def _decode_sse(chunks):
    import json

    return [
        json.loads(line.removeprefix("data:").strip())
        for chunk in chunks
        for line in chunk.splitlines()
        if line.startswith("data:")
    ]


def _turn_input(thread_id, run_id, text="hello"):
    return RunAgentInput(
        thread_id=thread_id,
        run_id=run_id,
        state={},
        messages=[UserMessage(id="u1", role="user", content=text)],
        tools=[],
        context=[],
        forwarded_props={},
    )


async def _run_conversational_turn(flow, input_data):
    from ag_ui_crewai import endpoint
    from ag_ui_crewai._conversation import prepare_conversational_turn

    return _decode_sse(
        [
            chunk
            async for chunk in endpoint._run_flow_frame_stream(
                flow_copy=flow,
                encoder=EventEncoder(),
                input_data=input_data,
                inputs={"id": input_data.thread_id, "messages": []},
                timeout=30,
                conversational_turn=prepare_conversational_turn(input_data.messages),
            )
        ]
    )


@pytest.mark.asyncio
async def test_frame_driver_opens_public_conversational_turn():
    from ag_ui_crewai import endpoint
    from ag_ui_crewai._conversation import prepare_conversational_turn

    flow = _conversational_bridge_flow_type()()
    input_data = RunAgentInput(
        thread_id="thread-1",
        run_id="run-1",
        state={},
        messages=[UserMessage(id="u1", role="user", content="hello")],
        tools=[],
        context=[],
        forwarded_props={},
    )
    turn = prepare_conversational_turn(input_data.messages)

    chunks = [
        chunk
        async for chunk in endpoint._run_flow_frame_stream(
            flow_copy=flow,
            encoder=EventEncoder(),
            input_data=input_data,
            inputs={"id": "thread-1", "messages": []},
            timeout=30,
            conversational_turn=turn,
        )
    ]
    events = _decode_sse(chunks)

    assert events[0]["type"] == "RUN_STARTED"
    assert events[-1]["type"] == "RUN_FINISHED"
    assert [
        event["delta"] for event in events if event["type"] == "TEXT_MESSAGE_CONTENT"
    ] == ["hello back"]
    current_user_snapshot = next(
        index
        for index, event in enumerate(events)
        if event["type"] == "MESSAGES_SNAPSHOT"
        and any(
            message.get("role") == "user" and message.get("content") == "hello"
            for message in event["messages"]
        )
    )
    first_assistant_content = next(
        index
        for index, event in enumerate(events)
        if event["type"] == "TEXT_MESSAGE_CONTENT"
    )
    assert current_user_snapshot < first_assistant_content
    assert {
        message["id"]
        for event in events
        if event["type"] == "MESSAGES_SNAPSHOT"
        for message in event["messages"]
        if message["role"] == "user" and message["content"] == "hello"
    } == {"u1"}
    assert flow.state.id == "thread-1"
    assert (
        sum(
            1
            for message in flow.state.messages
            if (
                message.get("role")
                if isinstance(message, dict)
                else getattr(message, "role", None)
            )
            == "user"
            and (
                message.get("content")
                if isinstance(message, dict)
                else getattr(message, "content", None)
            )
            == "hello"
        )
        == 1
    )


@pytest.mark.asyncio
async def test_completed_conversational_turn_is_never_marked_abandoned(
    monkeypatch,
    caplog,
):
    """RUN_FINISHED is terminal, even when the turn's tail outruns the drain grace.

    After RUN_FINISHED crewai still appends the assistant message, runs its
    terminal turn handlers (whose bus flush waits by default), then joins its
    thread. That routinely outlasts the drain grace, so a predicate built on the
    drain result alone marks a SUCCESSFUL turn abandoned: its persistence writes
    are dropped and the next message on the thread is refused as busy. The grace
    is pinned to zero here to make that tail unconditional.
    """
    from ag_ui_crewai import endpoint
    from ag_ui_crewai._conversation import conversation_worker_stats

    caplog.set_level("DEBUG", logger="ag_ui_crewai._conversation")
    monkeypatch.setattr(endpoint, "_CANCEL_GRACE_SECONDS", 0.0)

    captured = capture_stream_sink(monkeypatch)

    first = await _run_conversational_turn(
        _conversational_bridge_flow_type()(), _turn_input("thread-tail", "run-tail-1")
    )

    assert first[-1]["type"] == "RUN_FINISHED"
    assert run_abandonment_signal(captured).abandoned is False
    assert "reason=abandoned" not in caplog.text
    assert conversation_worker_stats().abandoned_active == 0

    second = await _run_conversational_turn(
        _conversational_bridge_flow_type()(), _turn_input("thread-tail", "run-tail-2", "again")
    )

    assert [event for event in second if event["type"] == "RUN_ERROR"] == []
    assert second[-1]["type"] == "RUN_FINISHED"


# A raising adapter constructor returning the worker slot is covered by
# ``test_failed_adapter_construction_closes_the_opened_sync_session`` below, which
# drives the same monkeypatched constructor and asserts a strict superset: the same
# terminal RUN_ERROR code and the same slot return, plus the crewai session the
# turn had already opened being closed.


@pytest.mark.asyncio
async def test_conversational_run_still_abandons_when_the_ceiling_fires():
    """The other half of the predicate: a run that never terminated IS abandoned.

    Guards the completed-run case above from being widened into "never abandon".
    A ceiling expiry ends the response while the worker is still inside the turn,
    which is the state every containment guard exists for.
    """
    from ag_ui_crewai import endpoint
    from ag_ui_crewai._conversation import (
        conversation_worker_stats,
        prepare_conversational_turn,
    )

    # Registered with the shared guard rather than asserted on the worker thread,
    # where the adapter catches the exception and the abandonment gate then
    # discards it, so a bare assert there can never fail its test.
    park = WORKER_GUARD.park("ceiling-abandons parked session")
    unparked = threading.Event()

    class _ParkedSession:
        def __iter__(self):
            park.wait(WORKER_WAIT)
            unparked.set()
            return iter(())

        def close(self):
            pass

    class _ParkedConversationalFlow:
        conversational = True

        def __init__(self):
            self._state = {}
            self.persistence = None

        @property
        def state(self):
            return self._state

        def stream_turn(self, message, *, session_id=None):
            return _ParkedSession()

    input_data = _turn_input("thread-ceiling", "run-ceiling")
    try:
        events = _decode_sse(
            [
                chunk
                async for chunk in endpoint._run_flow_frame_stream(
                    flow_copy=_ParkedConversationalFlow(),
                    encoder=EventEncoder(),
                    input_data=input_data,
                    inputs={"id": input_data.thread_id, "messages": []},
                    timeout=0.2,
                    conversational_turn=prepare_conversational_turn(
                        input_data.messages
                    ),
                )
            ]
        )

        assert events[-1]["code"] == "AGUI_CREWAI_FLOW_TIMEOUT"
        assert conversation_worker_stats().abandoned_active == 1
    finally:
        park.release()

    assert await asyncio.to_thread(
        unparked.wait, WORKER_WAIT
    ), "the worker never unparked"
    assert not park.timed_out.is_set(), "the parked session waited out its release"


def test_fastapi_endpoint_exposes_conversational_mode():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from ag_ui_crewai.endpoint import add_crewai_flow_fastapi_endpoint

    app = FastAPI()
    add_crewai_flow_fastapi_endpoint(
        app,
        _conversational_bridge_flow_type()(),
        path="/conversation",
        conversational=True,
    )
    input_data = RunAgentInput(
        thread_id="thread-http",
        run_id="run-http",
        state={},
        messages=[UserMessage(id="u1", role="user", content="hello")],
        tools=[],
        context=[],
        forwarded_props={},
    )

    response = TestClient(app).post(
        "/conversation",
        json=input_data.model_dump(by_alias=True),
    )

    assert response.status_code == 200
    assert '"type":"RUN_STARTED"' in response.text
    assert '"type":"RUN_FINISHED"' in response.text


def test_bridge_forces_per_request_conversation_trace_finalization():
    from ag_ui_crewai._conversation import force_per_turn_trace_finalization

    flow = _deferred_conversational_flow_type()()
    assert flow._should_defer_trace_finalization() is True

    force_per_turn_trace_finalization(flow)

    assert flow._should_defer_trace_finalization() is False


@pytest.mark.asyncio
async def test_conversational_turn_pauses_and_resumes_human_feedback(
    tmp_path,
    monkeypatch,
):
    from ag_ui_crewai import endpoint
    from ag_ui_crewai._conversation import prepare_conversational_turn

    monkeypatch.chdir(tmp_path)
    captured = capture_stream_sink(monkeypatch)
    flow = _conversational_interrupt_flow_type()()
    input_data = RunAgentInput(
        thread_id="thread-interrupt",
        run_id="run-interrupt",
        state={},
        messages=[UserMessage(id="u1", role="user", content="make a plan")],
        tools=[],
        context=[],
        forwarded_props={},
    )
    paused_chunks = [
        chunk
        async for chunk in endpoint._run_flow_frame_stream(
            flow_copy=flow,
            encoder=EventEncoder(),
            input_data=input_data,
            inputs={"id": input_data.thread_id, "messages": []},
            timeout=30,
            hitl_options=HITLOptions(emit_interrupt_outcome=True),
            conversational_turn=prepare_conversational_turn(input_data.messages),
        )
    ]
    paused = _decode_sse(paused_chunks)

    assert paused[-1]["outcome"]["type"] == "interrupt"
    interrupt_id = paused[-1]["outcome"]["interrupts"][0]["id"]
    # A pause is a terminated run, not an abandoned one; if it were abandoned the
    # same-thread guard would refuse the resume this test goes on to drive.
    #
    # Asserted on the RUN's own signal. The population counter cannot say this:
    # the pause turn's lease is released by the time the response ends, so
    # ``abandoned_active`` reads zero whether or not this run was abandoned, and it
    # stayed green under the mutation that drops ``run_finished`` from the terminal
    # predicate. That is the ordering dependency between the terminal predicate and
    # the resume gate, so it has to be pinned on something that can fail.
    assert run_abandonment_signal(captured).abandoned is False

    resumed_input = RunAgentInput(
        thread_id=input_data.thread_id,
        run_id="run-resume",
        state={},
        messages=input_data.messages,
        tools=[],
        context=[],
        forwarded_props={},
        resume=[
            ResumeEntry(
                interrupt_id=interrupt_id,
                status="resolved",
                payload="approved",
            )
        ],
    )
    resumed_chunks = [
        chunk
        async for chunk in endpoint._run_flow_resume_stream(
            flow=flow,
            encoder=EventEncoder(),
            input_data=resumed_input,
            timeout=30,
            hitl_options=HITLOptions(emit_interrupt_outcome=True),
        )
    ]
    resumed = _decode_sse(resumed_chunks)

    assert resumed[0]["type"] == "RUN_STARTED"
    assert resumed[-1]["type"] == "RUN_FINISHED"
    assert any(
        event.get("snapshot", {}).get("result") == "done: approved"
        for event in resumed
        if event.get("type") == "STATE_SNAPSHOT"
    )


@pytest.mark.asyncio
async def test_resume_is_rejected_while_an_abandoned_run_holds_the_thread():
    """A conversational resume is another run for that conversation, so it is gated.

    The abandoned worker is still writing this conversation's state and finishes
    last as often as not; a resume that reloads the pending state underneath it
    races it on the same persistence. Refusing before ``from_pending`` keeps the
    resume from touching that state at all. Scoped to the SAME flow's conversation:
    the unrelated-flow case is
    ``test_interrupts.test_e2e_resume_of_a_regular_flow_ignores_a_conversational_worker``.
    """
    from ag_ui_crewai import endpoint
    from ag_ui_crewai._conversation import (
        AbandonmentSignal,
        acquire_conversation_worker,
        conversational_flow_key,
    )

    class _UnreachableResumeFlow:
        @classmethod
        def from_pending(cls, thread_id):
            raise AssertionError("resume must be refused before reloading state")

    flow = _UnreachableResumeFlow()
    signal = AbandonmentSignal()
    lease = acquire_conversation_worker(
        flow_key=conversational_flow_key(flow),
        thread_id="thread-resume-busy",
        run_id="run-abandoned",
        signal=signal,
    )
    signal.abandon()

    resumed_input = RunAgentInput(
        thread_id="thread-resume-busy",
        run_id="run-resume-blocked",
        state={},
        messages=[UserMessage(id="u1", role="user", content="make a plan")],
        tools=[],
        context=[],
        forwarded_props={},
        resume=[
            ResumeEntry(
                interrupt_id="interrupt-1",
                status="resolved",
                payload="approved",
            )
        ],
    )
    try:
        body = "".join(
            [
                chunk
                async for chunk in endpoint._run_flow_resume_stream(
                    flow=flow,
                    encoder=EventEncoder(),
                    input_data=resumed_input,
                    timeout=30,
                    conversational=True,
                )
            ]
        )
    finally:
        lease.release()

    assert "AGUI_CREWAI_CONVERSATION_THREAD_BUSY" in body
    assert '"threadId":"thread-resume-busy"' in body
    assert '"runId":"run-resume-blocked"' in body


def test_conversational_endpoint_fails_loudly_for_regular_flow():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from ag_ui_crewai.endpoint import add_crewai_flow_fastapi_endpoint

    app = FastAPI()
    add_crewai_flow_fastapi_endpoint(
        app,
        _RegularOnlyFlow(),
        path="/conversation",
        conversational=True,
    )
    input_data = RunAgentInput(
        thread_id="thread-unsupported",
        run_id="run-unsupported",
        state={},
        messages=[UserMessage(id="u1", role="user", content="hello")],
        tools=[],
        context=[],
        forwarded_props={},
    )

    response = TestClient(app).post(
        "/conversation",
        json=input_data.model_dump(by_alias=True),
    )

    assert response.status_code == 200
    assert "AGUI_CREWAI_CONVERSATIONAL_FLOW_UNSUPPORTED" in response.text
    assert '"threadId":"thread-unsupported"' in response.text
    assert '"runId":"run-unsupported"' in response.text


class _ClosableSyncSession:
    """Sync ``StreamSession`` stand-in that only records its ``close()``."""

    def __init__(self):
        self.closed = False

    def __iter__(self):
        return iter(())

    def close(self):
        self.closed = True


class _OpenedTurnFlow:
    """Conversational flow whose ``stream_turn`` hands back one live session."""

    conversational = True

    def __init__(self, session):
        self._state = {}
        self.persistence = None
        self._session = session

    @property
    def state(self):
        return self._state

    def stream_turn(self, message, *, session_id=None):
        return self._session


@pytest.mark.asyncio
async def test_failed_adapter_construction_closes_the_opened_sync_session(monkeypatch):
    """A raising adapter constructor must not orphan the turn CrewAI already opened.

    ``stream_turn`` has already returned a live ``StreamSession`` by the time the
    adapter is constructed. If the constructor raises, the guarded block gives the
    worker-pool lease back but the driver's ``session`` local is still ``None``, so
    the teardown ``aclose()`` closes nothing and the crewai session (plus the
    thread behind it) leaks for the process lifetime.
    """
    from ag_ui_crewai import endpoint
    from ag_ui_crewai._conversation import (
        conversation_worker_stats,
        prepare_conversational_turn,
    )

    def _raising_adapter(session, **kwargs):
        raise RuntimeError("adapter construction failed")

    monkeypatch.setattr(endpoint, "SyncStreamSessionAdapter", _raising_adapter)

    sync_session = _ClosableSyncSession()
    input_data = RunAgentInput(
        thread_id="thread-adapter-boom",
        run_id="run-adapter-boom",
        state={},
        messages=[UserMessage(id="u1", role="user", content="hello")],
        tools=[],
        context=[],
        forwarded_props={},
    )

    body = "".join(
        [
            chunk
            async for chunk in endpoint._run_flow_frame_stream(
                flow_copy=_OpenedTurnFlow(sync_session),
                encoder=EventEncoder(),
                input_data=input_data,
                inputs={"id": input_data.thread_id, "messages": []},
                timeout=None,
                conversational_turn=prepare_conversational_turn(input_data.messages),
            )
        ]
    )

    # TERMINAL, not merely present: the error has to be the run's last event, or
    # the client is left holding a run that never ended.
    assert _decode_sse([body])[-1]["code"] == "AGUI_CREWAI_FLOW_ERROR_RUNTIMEERROR"
    assert conversation_worker_stats().active == 0
    assert sync_session.closed, (
        "the sync StreamSession stream_turn already returned was never closed"
    )
