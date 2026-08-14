"""Native CrewAI Conversational Flow bridge behavior."""

import asyncio
import importlib
import threading
from types import SimpleNamespace

import pytest

from ag_ui.core import (
    AssistantMessage,
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
from crewai.experimental.conversational import ConversationConfig
from crewai.flow import human_feedback
from crewai.flow.flow import Flow, listen, start

from ag_ui_crewai import _capabilities as capabilities
from ag_ui_crewai.sdk import CopilotKitState
from ag_ui_crewai.context import flow_context
from ag_ui_crewai.events import BridgedTextMessageChunkEvent
from ag_ui_crewai._hitl import (
    HITLOptions,
    agui_feedback_provider,
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


@ConversationConfig()
class _DeferredConversationalFlow(_ConversationalBridgeFlow):
    conversational = True


class _RegularOnlyFlow(Flow[CopilotKitState]):
    @start()
    def run_regular(self):
        raise AssertionError("regular execution must not be used as fallback")


class _ConversationalInterruptState(CopilotKitState):
    result: str = ""


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


def _decode_sse(chunks):
    import json

    return [
        json.loads(line.removeprefix("data:").strip())
        for chunk in chunks
        for line in chunk.splitlines()
        if line.startswith("data:")
    ]


@pytest.mark.asyncio
async def test_frame_driver_opens_public_conversational_turn():
    from ag_ui_crewai import endpoint
    from ag_ui_crewai._conversation import prepare_conversational_turn

    flow = _ConversationalBridgeFlow()
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


def test_fastapi_endpoint_exposes_conversational_mode():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from ag_ui_crewai.endpoint import add_crewai_flow_fastapi_endpoint

    app = FastAPI()
    add_crewai_flow_fastapi_endpoint(
        app,
        _ConversationalBridgeFlow(),
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

    flow = _DeferredConversationalFlow()
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
    flow = _ConversationalInterruptFlow()
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
