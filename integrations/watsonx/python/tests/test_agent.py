"""Tests for WatsonxAgent SSE translation and token management."""

import json
import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from ag_ui.core import (
    AssistantMessage,
    EventType,
    FunctionCall,
    RunAgentInput,
    ToolCall,
    ToolMessage as AGUIToolMessage,
    UserMessage,
)
from ag_ui_watsonx.agent import InMemoryThreadIdStore, WatsonxAgent, _IAM_TOKEN_URL


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_input(content="Hello", thread_id="t-1", run_id="r-1", messages=None):
    if messages is None:
        messages = [UserMessage(id="m-1", role="user", content=content)]
    return RunAgentInput(
        thread_id=thread_id,
        run_id=run_id,
        messages=messages,
        state=None,
        tools=[],
        context=[],
        forwarded_props={},
    )


def _sse_lines(*chunks: dict | str) -> list[str]:
    """Build a list of SSE lines from OpenAI-style chunk dicts."""
    lines = []
    for c in chunks:
        if isinstance(c, str):
            lines.append(c)
        else:
            lines.append(f"data: {json.dumps(c)}")
    lines.append("data: [DONE]")
    return lines


def _text_chunk(content: str, finish_reason: str | None = None) -> dict:
    return {
        "choices": [{
            "delta": {"content": content},
            "finish_reason": finish_reason,
        }]
    }


def _tool_call_start_chunk(index: int, tool_id: str, name: str) -> dict:
    return {
        "choices": [{
            "delta": {
                "tool_calls": [{
                    "index": index,
                    "id": tool_id,
                    "function": {"name": name},
                }]
            },
            "finish_reason": None,
        }]
    }


def _tool_call_args_chunk(index: int, args_fragment: str) -> dict:
    return {
        "choices": [{
            "delta": {
                "tool_calls": [{
                    "index": index,
                    "function": {"arguments": args_fragment},
                }]
            },
            "finish_reason": None,
        }]
    }


def _tool_call_finish_chunk() -> dict:
    return {
        "choices": [{
            "delta": {},
            "finish_reason": "tool_calls",
        }]
    }


def _make_agent(**overrides):
    defaults = dict(
        region="au-syd",
        instance_id="inst-1",
        agent_id="agent-1",
        bearer_token="pre-exchanged-token",
    )
    defaults.update(overrides)
    return WatsonxAgent(**defaults)


class _AsyncContextManager:
    """Generic async context manager that returns a fixed value."""
    def __init__(self, value):
        self._value = value
    async def __aenter__(self):
        return self._value
    async def __aexit__(self, *args):
        pass


def _mock_stream_response(sse_lines: list[str], status_code: int = 200):
    """Create a mock httpx streaming response that yields SSE lines."""
    response = MagicMock()
    response.status_code = status_code
    response.raise_for_status = MagicMock()
    if status_code >= 400:
        response.raise_for_status.side_effect = Exception(f"HTTP {status_code}")

    async def _aiter_lines():
        for line in sse_lines:
            yield line

    response.aiter_lines = _aiter_lines
    return response


def _mock_httpx_client(response):
    """Create a mock httpx.AsyncClient that returns the given response from stream()."""
    mock_client = MagicMock()
    mock_client.stream = MagicMock(return_value=_AsyncContextManager(response))
    return _AsyncContextManager(mock_client)


async def _collect_events(agent, input_data):
    events = []
    async for event in agent.run(input_data):
        events.append(event)
    return events


# ---------------------------------------------------------------------------
# Constructor
# ---------------------------------------------------------------------------

class TestWatsonxAgentInit:
    def test_requires_auth(self):
        with pytest.raises(ValueError, match="requires either"):
            WatsonxAgent(region="us-south", instance_id="i", agent_id="a")

    def test_accepts_api_key(self):
        agent = _make_agent(api_key="key123", bearer_token=None)
        assert agent.api_key == "key123"

    def test_accepts_bearer_token(self):
        agent = _make_agent(bearer_token="tok")
        assert agent._cached_token == "tok"

    def test_base_url(self):
        agent = _make_agent(region="eu-de")
        assert agent.base_url == (
            "https://api.eu-de.watson-orchestrate.cloud.ibm.com/instances/inst-1"
        )


# ---------------------------------------------------------------------------
# clone()
# ---------------------------------------------------------------------------

class TestClone:
    def test_clone_returns_new_instance(self):
        agent = _make_agent(api_key="my-key", bearer_token="tok", name="custom")
        cloned = agent.clone()
        assert cloned is not agent
        assert isinstance(cloned, WatsonxAgent)

    def test_clone_preserves_config(self):
        agent = _make_agent(
            region="eu-de",
            instance_id="inst-2",
            agent_id="agent-2",
            api_key="key-1",
            bearer_token="tok-1",
            name="my-agent",
        )
        agent._token_expires_at = 999999
        cloned = agent.clone()
        assert cloned.region == "eu-de"
        assert cloned.instance_id == "inst-2"
        assert cloned.agent_id == "agent-2"
        assert cloned.api_key == "key-1"
        assert cloned._cached_token == "tok-1"
        assert cloned.name == "my-agent"
        assert cloned._token_expires_at == 999999

    def test_clone_has_fresh_lock(self):
        agent = _make_agent()
        cloned = agent.clone()
        assert cloned._token_lock is not agent._token_lock


# ---------------------------------------------------------------------------
# Token management
# ---------------------------------------------------------------------------

class TestTokenManagement:
    @pytest.mark.asyncio
    async def test_returns_cached_token_when_valid(self):
        agent = _make_agent(bearer_token="cached-tok")
        token = await agent._get_token()
        assert token == "cached-tok"

    @pytest.mark.asyncio
    async def test_raises_when_token_expired_and_no_api_key(self):
        agent = _make_agent(bearer_token="old-tok")
        agent._token_expires_at = 0
        with pytest.raises(RuntimeError, match="no api_key provided"):
            await agent._get_token()

    @pytest.mark.asyncio
    async def test_refreshes_token_via_iam(self):
        agent = _make_agent(api_key="my-key", bearer_token=None)

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.raise_for_status = MagicMock()
        mock_response.json.return_value = {
            "access_token": "fresh-token",
            "expiration": int(time.time()) + 3600,
        }

        mock_client = MagicMock()
        mock_client.post = AsyncMock(return_value=mock_response)

        with patch("ag_ui_watsonx.agent.httpx.AsyncClient", return_value=_AsyncContextManager(mock_client)):
            token = await agent._get_token()

        assert token == "fresh-token"
        assert agent._cached_token == "fresh-token"
        mock_client.post.assert_called_once()
        call_args = mock_client.post.call_args
        assert call_args[0][0] == _IAM_TOKEN_URL
        assert call_args[1]["data"]["apikey"] == "my-key"


# ---------------------------------------------------------------------------
# SSE → AG-UI event translation: text messages
# ---------------------------------------------------------------------------

class TestTextMessageTranslation:
    @pytest.mark.asyncio
    async def test_run_lifecycle(self):
        """RUN_STARTED is first, RUN_FINISHED is last."""
        agent = _make_agent()
        response = _mock_stream_response(_sse_lines(_text_chunk("Hi")))

        with patch("ag_ui_watsonx.agent.httpx.AsyncClient", return_value=_mock_httpx_client(response)):
            events = await _collect_events(agent, _make_input())

        types = [e.type for e in events]
        assert types[0] == EventType.RUN_STARTED
        assert types[-1] == EventType.RUN_FINISHED

    @pytest.mark.asyncio
    async def test_text_message_events(self):
        """Content deltas produce START → CONTENT → END."""
        agent = _make_agent()
        response = _mock_stream_response(_sse_lines(
            _text_chunk("Hello"),
            _text_chunk(" world"),
            _text_chunk("!", "stop"),
        ))

        with patch("ag_ui_watsonx.agent.httpx.AsyncClient", return_value=_mock_httpx_client(response)):
            events = await _collect_events(agent, _make_input())

        types = [e.type for e in events]
        assert EventType.TEXT_MESSAGE_START in types
        assert EventType.TEXT_MESSAGE_END in types

        content_events = [e for e in events if e.type == EventType.TEXT_MESSAGE_CONTENT]
        full_text = "".join(e.delta for e in content_events)
        assert full_text == "Hello world!"

    @pytest.mark.asyncio
    async def test_text_message_start_has_assistant_role(self):
        agent = _make_agent()
        response = _mock_stream_response(_sse_lines(_text_chunk("Hi")))

        with patch("ag_ui_watsonx.agent.httpx.AsyncClient", return_value=_mock_httpx_client(response)):
            events = await _collect_events(agent, _make_input())

        start = next(e for e in events if e.type == EventType.TEXT_MESSAGE_START)
        assert start.role == "assistant"

    @pytest.mark.asyncio
    async def test_empty_stream_no_text_events(self):
        """A stream with only [DONE] should not emit text message events."""
        agent = _make_agent()
        response = _mock_stream_response(_sse_lines())

        with patch("ag_ui_watsonx.agent.httpx.AsyncClient", return_value=_mock_httpx_client(response)):
            events = await _collect_events(agent, _make_input())

        types = [e.type for e in events]
        assert EventType.TEXT_MESSAGE_START not in types
        assert EventType.TEXT_MESSAGE_CONTENT not in types
        assert EventType.TEXT_MESSAGE_END not in types
        assert types[0] == EventType.RUN_STARTED
        assert types[-1] == EventType.RUN_FINISHED


# ---------------------------------------------------------------------------
# SSE → AG-UI event translation: tool calls
# ---------------------------------------------------------------------------

class TestToolCallTranslation:
    @pytest.mark.asyncio
    async def test_single_tool_call(self):
        agent = _make_agent()
        response = _mock_stream_response(_sse_lines(
            _tool_call_start_chunk(0, "tc-1", "get_weather"),
            _tool_call_args_chunk(0, '{"city":'),
            _tool_call_args_chunk(0, '"NYC"}'),
            _tool_call_finish_chunk(),
        ))

        with patch("ag_ui_watsonx.agent.httpx.AsyncClient", return_value=_mock_httpx_client(response)):
            events = await _collect_events(agent, _make_input())

        types = [e.type for e in events]
        assert EventType.TOOL_CALL_START in types
        assert EventType.TOOL_CALL_ARGS in types
        assert EventType.TOOL_CALL_END in types

        start = next(e for e in events if e.type == EventType.TOOL_CALL_START)
        assert start.tool_call_id == "tc-1"
        assert start.tool_call_name == "get_weather"

        args_events = [e for e in events if e.type == EventType.TOOL_CALL_ARGS]
        full_args = "".join(e.delta for e in args_events)
        assert json.loads(full_args) == {"city": "NYC"}

        end = next(e for e in events if e.type == EventType.TOOL_CALL_END)
        assert end.tool_call_id == "tc-1"

    @pytest.mark.asyncio
    async def test_parallel_tool_calls(self):
        """Two tool calls with different indices are tracked independently."""
        agent = _make_agent()
        response = _mock_stream_response(_sse_lines(
            _tool_call_start_chunk(0, "tc-1", "get_weather"),
            _tool_call_start_chunk(1, "tc-2", "get_time"),
            _tool_call_args_chunk(0, '{"city":"NYC"}'),
            _tool_call_args_chunk(1, '{"tz":"EST"}'),
            _tool_call_finish_chunk(),
        ))

        with patch("ag_ui_watsonx.agent.httpx.AsyncClient", return_value=_mock_httpx_client(response)):
            events = await _collect_events(agent, _make_input())

        starts = [e for e in events if e.type == EventType.TOOL_CALL_START]
        ends = [e for e in events if e.type == EventType.TOOL_CALL_END]
        assert len(starts) == 2
        assert len(ends) == 2
        assert {s.tool_call_name for s in starts} == {"get_weather", "get_time"}

    @pytest.mark.asyncio
    async def test_tool_calls_ended_on_stream_close(self):
        """Tool calls without a finish_reason chunk still get TOOL_CALL_END."""
        agent = _make_agent()
        response = _mock_stream_response(_sse_lines(
            _tool_call_start_chunk(0, "tc-1", "search"),
            _tool_call_args_chunk(0, '{"q":"test"}'),
        ))

        with patch("ag_ui_watsonx.agent.httpx.AsyncClient", return_value=_mock_httpx_client(response)):
            events = await _collect_events(agent, _make_input())

        ends = [e for e in events if e.type == EventType.TOOL_CALL_END]
        assert len(ends) == 1
        assert ends[0].tool_call_id == "tc-1"


# ---------------------------------------------------------------------------
# Error handling
# ---------------------------------------------------------------------------

class TestErrorHandling:
    @pytest.mark.asyncio
    async def test_http_error_emits_run_error(self):
        agent = _make_agent()
        response = _mock_stream_response([], status_code=500)

        with patch("ag_ui_watsonx.agent.httpx.AsyncClient", return_value=_mock_httpx_client(response)):
            events = await _collect_events(agent, _make_input())

        types = [e.type for e in events]
        assert types[0] == EventType.RUN_STARTED
        assert EventType.RUN_ERROR in types
        error = next(e for e in events if e.type == EventType.RUN_ERROR)
        assert error.code == "WATSONX_ERROR"

    @pytest.mark.asyncio
    async def test_malformed_json_skipped(self):
        """Lines with invalid JSON are silently skipped."""
        agent = _make_agent()
        response = _mock_stream_response([
            "data: not-json",
            f"data: {json.dumps(_text_chunk('works'))}",
            "data: [DONE]",
        ])

        with patch("ag_ui_watsonx.agent.httpx.AsyncClient", return_value=_mock_httpx_client(response)):
            events = await _collect_events(agent, _make_input())

        content = [e for e in events if e.type == EventType.TEXT_MESSAGE_CONTENT]
        assert len(content) == 1
        assert content[0].delta == "works"

    @pytest.mark.asyncio
    async def test_non_data_lines_ignored(self):
        """Lines not starting with 'data: ' (comments, blank) are ignored."""
        agent = _make_agent()
        response = _mock_stream_response([
            ": this is a comment",
            "",
            f"data: {json.dumps(_text_chunk('ok'))}",
            "event: ping",
            "data: [DONE]",
        ])

        with patch("ag_ui_watsonx.agent.httpx.AsyncClient", return_value=_mock_httpx_client(response)):
            events = await _collect_events(agent, _make_input())

        content = [e for e in events if e.type == EventType.TEXT_MESSAGE_CONTENT]
        assert len(content) == 1

    @pytest.mark.asyncio
    async def test_error_path_emits_step_finished(self):
        """Error path should still emit STEP_FINISHED to close the step."""
        agent = _make_agent()
        response = _mock_stream_response([], status_code=500)

        with patch("ag_ui_watsonx.agent.httpx.AsyncClient", return_value=_mock_httpx_client(response)):
            events = await _collect_events(agent, _make_input())

        types = [e.type for e in events]
        assert EventType.STEP_FINISHED in types


# ---------------------------------------------------------------------------
# Request construction
# ---------------------------------------------------------------------------

class TestRequestConstruction:
    @pytest.mark.asyncio
    async def test_omits_thread_id_header_on_first_turn(self):
        """watsonx ignores client-invented thread IDs; the header is omitted
        so watsonx creates the thread, and the returned thread_id is reused
        later (see TestThreadPersistence)."""
        agent = _make_agent()
        response = _mock_stream_response(_sse_lines(_text_chunk("Hi")))
        client_ctx = _mock_httpx_client(response)

        with patch("ag_ui_watsonx.agent.httpx.AsyncClient", return_value=client_ctx):
            await _collect_events(agent, _make_input(thread_id="my-thread"))

        mock_client = client_ctx._value
        call_kwargs = mock_client.stream.call_args[1]
        assert "X-IBM-THREAD-ID" not in call_kwargs["headers"]
        assert "Bearer " in call_kwargs["headers"]["Authorization"]

    @pytest.mark.asyncio
    async def test_sends_messages_with_stream_true(self):
        agent = _make_agent()
        response = _mock_stream_response(_sse_lines(_text_chunk("Hi")))
        client_ctx = _mock_httpx_client(response)

        with patch("ag_ui_watsonx.agent.httpx.AsyncClient", return_value=client_ctx):
            await _collect_events(agent, _make_input(content="Test msg"))

        mock_client = client_ctx._value
        call_kwargs = mock_client.stream.call_args[1]
        body = call_kwargs["json"]
        assert body["stream"] is True
        assert body["messages"][0]["role"] == "user"
        assert body["messages"][0]["content"] == "Test msg"

    @pytest.mark.asyncio
    async def test_correct_endpoint_url(self):
        agent = _make_agent(region="us-south", instance_id="my-inst", agent_id="my-agent")
        response = _mock_stream_response(_sse_lines(_text_chunk("Hi")))
        client_ctx = _mock_httpx_client(response)

        with patch("ag_ui_watsonx.agent.httpx.AsyncClient", return_value=client_ctx):
            await _collect_events(agent, _make_input())

        mock_client = client_ctx._value
        call_args = mock_client.stream.call_args
        assert call_args[0][0] == "POST"
        assert call_args[0][1] == (
            "https://api.us-south.watson-orchestrate.cloud.ibm.com"
            "/instances/my-inst/v1/orchestrate/my-agent/chat/completions"
        )


# ---------------------------------------------------------------------------
# STEP_STARTED / STEP_FINISHED lifecycle
# ---------------------------------------------------------------------------

class TestStepLifecycle:
    @pytest.mark.asyncio
    async def test_step_started_after_run_started(self):
        """STEP_STARTED appears after RUN_STARTED."""
        agent = _make_agent()
        response = _mock_stream_response(_sse_lines(_text_chunk("Hi")))

        with patch("ag_ui_watsonx.agent.httpx.AsyncClient", return_value=_mock_httpx_client(response)):
            events = await _collect_events(agent, _make_input())

        types = [e.type for e in events]
        run_started_idx = types.index(EventType.RUN_STARTED)
        step_started_idx = types.index(EventType.STEP_STARTED)
        assert step_started_idx > run_started_idx

    @pytest.mark.asyncio
    async def test_step_finished_before_run_finished(self):
        """STEP_FINISHED appears before RUN_FINISHED."""
        agent = _make_agent()
        response = _mock_stream_response(_sse_lines(_text_chunk("Hi")))

        with patch("ag_ui_watsonx.agent.httpx.AsyncClient", return_value=_mock_httpx_client(response)):
            events = await _collect_events(agent, _make_input())

        types = [e.type for e in events]
        step_finished_idx = types.index(EventType.STEP_FINISHED)
        run_finished_idx = types.index(EventType.RUN_FINISHED)
        assert step_finished_idx < run_finished_idx

    @pytest.mark.asyncio
    async def test_step_name_is_watsonx_chat(self):
        """Step events use 'watsonx_chat' as the step name."""
        agent = _make_agent()
        response = _mock_stream_response(_sse_lines(_text_chunk("Hi")))

        with patch("ag_ui_watsonx.agent.httpx.AsyncClient", return_value=_mock_httpx_client(response)):
            events = await _collect_events(agent, _make_input())

        step_started = next(e for e in events if e.type == EventType.STEP_STARTED)
        step_finished = next(e for e in events if e.type == EventType.STEP_FINISHED)
        assert step_started.step_name == "watsonx_chat"
        assert step_finished.step_name == "watsonx_chat"


# ---------------------------------------------------------------------------
# MESSAGES_SNAPSHOT
# ---------------------------------------------------------------------------

class TestMessagesSnapshot:
    @pytest.mark.asyncio
    async def test_messages_snapshot_before_run_finished(self):
        """MESSAGES_SNAPSHOT appears before RUN_FINISHED."""
        agent = _make_agent()
        response = _mock_stream_response(_sse_lines(_text_chunk("Hi")))

        with patch("ag_ui_watsonx.agent.httpx.AsyncClient", return_value=_mock_httpx_client(response)):
            events = await _collect_events(agent, _make_input())

        types = [e.type for e in events]
        snapshot_idx = types.index(EventType.MESSAGES_SNAPSHOT)
        run_finished_idx = types.index(EventType.RUN_FINISHED)
        assert snapshot_idx < run_finished_idx

    @pytest.mark.asyncio
    async def test_messages_snapshot_contains_input_and_assistant(self):
        """MESSAGES_SNAPSHOT includes input messages plus the assistant response."""
        agent = _make_agent()
        response = _mock_stream_response(_sse_lines(
            _text_chunk("Hello"),
            _text_chunk(" world"),
        ))

        with patch("ag_ui_watsonx.agent.httpx.AsyncClient", return_value=_mock_httpx_client(response)):
            events = await _collect_events(agent, _make_input(content="Hi there"))

        snapshot = next(e for e in events if e.type == EventType.MESSAGES_SNAPSHOT)
        assert len(snapshot.messages) >= 2
        # First message is the user input
        assert snapshot.messages[0].role == "user"
        # Last message is the assistant response
        assert snapshot.messages[-1].role == "assistant"
        assert snapshot.messages[-1].content == "Hello world"

    @pytest.mark.asyncio
    async def test_messages_snapshot_includes_tool_calls(self):
        """MESSAGES_SNAPSHOT includes tool calls in the assistant message."""
        agent = _make_agent()
        response = _mock_stream_response(_sse_lines(
            _tool_call_start_chunk(0, "tc-1", "get_weather"),
            _tool_call_args_chunk(0, '{"city":"NYC"}'),
            _tool_call_finish_chunk(),
        ))

        with patch("ag_ui_watsonx.agent.httpx.AsyncClient", return_value=_mock_httpx_client(response)):
            events = await _collect_events(agent, _make_input())

        snapshot = next(e for e in events if e.type == EventType.MESSAGES_SNAPSHOT)
        assistant_msg = snapshot.messages[-1]
        assert assistant_msg.role == "assistant"
        assert assistant_msg.tool_calls is not None
        assert len(assistant_msg.tool_calls) == 1
        assert assistant_msg.tool_calls[0].id == "tc-1"
        assert assistant_msg.tool_calls[0].function.name == "get_weather"
        assert assistant_msg.tool_calls[0].function.arguments == '{"city":"NYC"}'


# ---------------------------------------------------------------------------
# RAW events
# ---------------------------------------------------------------------------

class TestRawEvents:
    @pytest.mark.asyncio
    async def test_raw_event_per_chunk(self):
        """A RAW event is emitted for each parsed SSE chunk."""
        agent = _make_agent()
        response = _mock_stream_response(_sse_lines(
            _text_chunk("Hello"),
            _text_chunk(" world"),
        ))

        with patch("ag_ui_watsonx.agent.httpx.AsyncClient", return_value=_mock_httpx_client(response)):
            events = await _collect_events(agent, _make_input())

        raw_events = [e for e in events if e.type == EventType.RAW]
        assert len(raw_events) == 2

    @pytest.mark.asyncio
    async def test_raw_event_contains_chunk_data(self):
        """RAW events contain the original SSE chunk data."""
        agent = _make_agent()
        chunk = _text_chunk("Hi")
        response = _mock_stream_response(_sse_lines(chunk))

        with patch("ag_ui_watsonx.agent.httpx.AsyncClient", return_value=_mock_httpx_client(response)):
            events = await _collect_events(agent, _make_input())

        raw_events = [e for e in events if e.type == EventType.RAW]
        assert len(raw_events) == 1
        assert raw_events[0].event == chunk
        assert raw_events[0].source == "watsonx"

    @pytest.mark.asyncio
    async def test_raw_events_not_emitted_for_malformed_json(self):
        """Malformed JSON lines do not produce RAW events."""
        agent = _make_agent()
        response = _mock_stream_response([
            "data: not-json",
            f"data: {json.dumps(_text_chunk('ok'))}",
            "data: [DONE]",
        ])

        with patch("ag_ui_watsonx.agent.httpx.AsyncClient", return_value=_mock_httpx_client(response)):
            events = await _collect_events(agent, _make_input())

        raw_events = [e for e in events if e.type == EventType.RAW]
        assert len(raw_events) == 1


# ---------------------------------------------------------------------------
# TOOL_CALL_RESULT for input tool messages
# ---------------------------------------------------------------------------

class TestToolCallResult:
    @pytest.mark.asyncio
    async def test_tool_call_result_emitted_for_tool_messages(self):
        """TOOL_CALL_RESULT is emitted for ToolMessage in input after RUN_STARTED."""
        agent = _make_agent()
        input_messages = [
            UserMessage(id="m-1", role="user", content="What's the weather?"),
            AGUIToolMessage(id="m-2", role="tool", content="Sunny, 72F", tool_call_id="tc-1"),
        ]
        response = _mock_stream_response(_sse_lines(_text_chunk("It's sunny!")))

        with patch("ag_ui_watsonx.agent.httpx.AsyncClient", return_value=_mock_httpx_client(response)):
            events = await _collect_events(agent, _make_input(messages=input_messages))

        types = [e.type for e in events]
        assert EventType.TOOL_CALL_RESULT in types
        # TOOL_CALL_RESULT comes after RUN_STARTED
        run_started_idx = types.index(EventType.RUN_STARTED)
        tcr_idx = types.index(EventType.TOOL_CALL_RESULT)
        assert tcr_idx > run_started_idx

        tcr = next(e for e in events if e.type == EventType.TOOL_CALL_RESULT)
        assert tcr.tool_call_id == "tc-1"
        assert tcr.content == "Sunny, 72F"
        assert tcr.role == "tool"

    @pytest.mark.asyncio
    async def test_no_tool_call_result_without_tool_messages(self):
        """No TOOL_CALL_RESULT when input has no tool messages."""
        agent = _make_agent()
        response = _mock_stream_response(_sse_lines(_text_chunk("Hi")))

        with patch("ag_ui_watsonx.agent.httpx.AsyncClient", return_value=_mock_httpx_client(response)):
            events = await _collect_events(agent, _make_input())

        types = [e.type for e in events]
        assert EventType.TOOL_CALL_RESULT not in types


# ---------------------------------------------------------------------------
# watsonx thread persistence
# ---------------------------------------------------------------------------

def _text_chunk_with_thread(content: str, watsonx_thread_id: str) -> dict:
    chunk = _text_chunk(content)
    chunk["thread_id"] = watsonx_thread_id
    return chunk


class TestThreadPersistence:
    async def _run(self, agent, input_data, chunks):
        """Run the agent against a fresh mocked stream, returning call kwargs."""
        response = _mock_stream_response(_sse_lines(*chunks))
        client_ctx = _mock_httpx_client(response)
        with patch("ag_ui_watsonx.agent.httpx.AsyncClient", return_value=client_ctx):
            await _collect_events(agent, input_data)
        return client_ctx._value.stream.call_args[1]

    @pytest.mark.asyncio
    async def test_reuses_watsonx_thread_id_on_next_run(self):
        agent = _make_agent()

        first = await self._run(
            agent, _make_input(run_id="r-1"), [_text_chunk_with_thread("Hi", "wx-abc")]
        )
        second = await self._run(
            agent, _make_input(run_id="r-2"), [_text_chunk_with_thread("More", "wx-abc")]
        )

        assert "X-IBM-THREAD-ID" not in first["headers"]
        assert second["headers"]["X-IBM-THREAD-ID"] == "wx-abc"

    @pytest.mark.asyncio
    async def test_tracks_watsonx_thread_ids_per_agui_thread(self):
        agent = _make_agent()

        await self._run(
            agent,
            _make_input(thread_id="t-1"),
            [_text_chunk_with_thread("Hi", "wx-1")],
        )
        second = await self._run(
            agent, _make_input(thread_id="t-2"), [_text_chunk("Hi")]
        )

        # Second AG-UI thread is new to watsonx, so no header yet.
        assert "X-IBM-THREAD-ID" not in second["headers"]

    @pytest.mark.asyncio
    async def test_captures_thread_id_from_chunk_without_choices(self):
        agent = _make_agent()

        await self._run(
            agent,
            _make_input(run_id="r-1"),
            [{"thread_id": "wx-only"}, _text_chunk("Hi")],
        )
        second = await self._run(agent, _make_input(run_id="r-2"), [_text_chunk("Hi")])

        assert second["headers"]["X-IBM-THREAD-ID"] == "wx-only"

    @pytest.mark.asyncio
    async def test_sends_only_messages_since_last_user_when_continuing(self):
        agent = _make_agent()

        first = await self._run(
            agent, _make_input(run_id="r-1"), [_text_chunk_with_thread("Hi", "wx-1")]
        )

        history = [
            UserMessage(id="m-1", role="user", content="Hello"),
            AssistantMessage(id="a-1", role="assistant", content="Hi"),
            UserMessage(id="m-2", role="user", content="Follow-up"),
        ]
        second = await self._run(
            agent,
            _make_input(run_id="r-2", messages=history),
            [_text_chunk("More")],
        )

        assert len(first["json"]["messages"]) == 1
        assert len(second["json"]["messages"]) == 1
        assert second["json"]["messages"][0]["content"] == "Follow-up"

    @pytest.mark.asyncio
    async def test_keeps_trailing_tool_messages_when_continuing(self):
        agent = _make_agent()

        await self._run(
            agent, _make_input(run_id="r-1"), [_text_chunk_with_thread("Hi", "wx-1")]
        )

        history = [
            UserMessage(id="m-1", role="user", content="Weather?"),
            AssistantMessage(
                id="a-1",
                role="assistant",
                tool_calls=[
                    ToolCall(
                        id="tc-1",
                        type="function",
                        function=FunctionCall(name="get_weather", arguments="{}"),
                    )
                ],
            ),
            AGUIToolMessage(id="t-1", role="tool", content="Sunny", tool_call_id="tc-1"),
        ]
        second = await self._run(
            agent,
            _make_input(run_id="r-2", messages=history),
            [_text_chunk("It's sunny")],
        )

        roles = [m["role"] for m in second["json"]["messages"]]
        assert roles == ["user", "assistant", "tool"]

    @pytest.mark.asyncio
    async def test_custom_thread_id_store(self):
        store = InMemoryThreadIdStore()
        store.set("t-1", "wx-stored")
        agent = _make_agent(thread_id_store=store)

        first = await self._run(
            agent, _make_input(), [_text_chunk_with_thread("Hi", "wx-new")]
        )

        assert first["headers"]["X-IBM-THREAD-ID"] == "wx-stored"
        assert store.get("t-1") == "wx-new"

    @pytest.mark.asyncio
    async def test_async_thread_id_store(self):
        class AsyncStore:
            def __init__(self):
                self.data = {"t-1": "wx-async"}

            async def get(self, thread_id):
                return self.data.get(thread_id)

            async def set(self, thread_id, watsonx_thread_id):
                self.data[thread_id] = watsonx_thread_id

        store = AsyncStore()
        agent = _make_agent(thread_id_store=store)

        first = await self._run(
            agent, _make_input(), [_text_chunk_with_thread("Hi", "wx-updated")]
        )

        assert first["headers"]["X-IBM-THREAD-ID"] == "wx-async"
        assert store.data["t-1"] == "wx-updated"

    def test_clone_shares_thread_id_store(self):
        agent = _make_agent()
        cloned = agent.clone()
        assert cloned._thread_id_store is agent._thread_id_store
