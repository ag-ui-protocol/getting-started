"""Repro for CopilotKit/CopilotKit#3030.

Reported symptom (react-core/react-ui 1.51.0): the agent emitted text, called
a frontend tool, then emitted more text -- but the UI rendered

    pre text -> post text -> tool call component

instead of

    pre text -> tool call component -> post text

The reporter's own event trace showed a single assistant text message
spanning the tool call: TEXT_MESSAGE_END never fired before TOOL_CALL_START,
and no new TEXT_MESSAGE_START opened afterwards, so the client received one
text message plus a trailing tool call.

These tests assert the wire ordering the reporter asked for.
"""

from __future__ import annotations

from unittest.mock import MagicMock

from ag_ui.core import EventType, RunAgentInput, Tool, UserMessage
from strands.tools.registry import ToolRegistry

from ag_ui_strands.agent import StrandsAgent
from ag_ui_strands.config import StrandsAgentConfig


def _template_agent() -> MagicMock:
    mock = MagicMock()
    mock.model = MagicMock()
    mock.system_prompt = "You are helpful"
    mock.tool_registry.registry = {}
    mock.record_direct_tool_call = True
    mock._session_manager = None
    return mock


def _build_agent(thread_id: str, stream_events: list) -> StrandsAgent:
    agent = StrandsAgent(
        _template_agent(), name="test-agent", config=StrandsAgentConfig()
    )
    mock_inner = MagicMock()
    mock_inner.tool_registry = ToolRegistry()
    mock_inner.session_manager = None

    async def _stream(_msg):
        for event in stream_events:
            yield event

    mock_inner.stream_async = _stream
    agent._agents_by_thread[thread_id] = mock_inner
    return agent


def _input(thread_id: str, tools: list[Tool]) -> RunAgentInput:
    return RunAgentInput(
        thread_id=thread_id,
        run_id=f"{thread_id}-run",
        messages=[UserMessage(id="u1", role="user", content="weather in SA?")],
        tools=tools,
        context=[],
        state={},
        forwarded_props={},
    )


async def _collect(agent: StrandsAgent, inp: RunAgentInput) -> list:
    return [e async for e in agent.run(inp)]


def _ordered_events(events: list) -> list:
    """Wire events relevant to the text/tool ordering contract."""
    relevant = {
        EventType.TEXT_MESSAGE_START,
        EventType.TEXT_MESSAGE_CONTENT,
        EventType.TEXT_MESSAGE_END,
        EventType.TOOL_CALL_START,
        EventType.TOOL_CALL_END,
    }
    return [event for event in events if event.type in relevant]


class TestBackendToolTextOrdering:
    """text -> backend tool -> text, all within one run."""

    THREAD = "issue-3030-backend"
    STREAM = [
        {"data": "The weather in SA is "},
        {
            "current_tool_use": {
                "name": "backend_tool",
                "toolUseId": "st-backend",
                "input": {},
            }
        },
        {"event": {"contentBlockStop": {}}},
        {
            "message": {
                "role": "user",
                "content": [
                    {
                        "toolResult": {
                            "toolUseId": "st-backend",
                            "content": [{"text": '{"tempC": 21}'}],
                        }
                    }
                ],
            }
        },
        {"data": "currently 21 degrees."},
    ]

    async def test_text_tool_text_order_and_message_ids(self):
        agent = _build_agent(self.THREAD, self.STREAM)
        events = await _collect(agent, _input(self.THREAD, []))
        ordered = _ordered_events(events)

        assert [event.type for event in ordered] == [
            EventType.TEXT_MESSAGE_START,
            EventType.TEXT_MESSAGE_CONTENT,
            EventType.TEXT_MESSAGE_END,
            EventType.TOOL_CALL_START,
            EventType.TOOL_CALL_END,
            EventType.TEXT_MESSAGE_START,
            EventType.TEXT_MESSAGE_CONTENT,
            EventType.TEXT_MESSAGE_END,
        ]
        pre_start, pre_content, pre_end = ordered[:3]
        post_start, post_content, post_end = ordered[5:]
        assert (
            pre_start.message_id == pre_content.message_id == pre_end.message_id
        )
        assert (
            post_start.message_id
            == post_content.message_id
            == post_end.message_id
        )
        assert pre_start.message_id != post_start.message_id


class TestFrontendToolTextOrdering:
    """text -> frontend tool. The loop halts for the client to execute the
    tool, so only the pre-text and the tool call appear in this run -- but the
    text must still be closed before TOOL_CALL_START."""

    THREAD = "issue-3030-frontend"
    TOOLS = [Tool(name="get_weather", description="w", parameters={})]
    STREAM = [
        {"data": "Let me check that for you. "},
        {
            "current_tool_use": {
                "name": "get_weather",
                "toolUseId": "st-fe",
                "input": {},
            }
        },
        {"event": {"contentBlockStop": {}}},
    ]

    async def test_text_message_end_precedes_tool_call_start(self):
        agent = _build_agent(self.THREAD, self.STREAM)
        events = await _collect(agent, _input(self.THREAD, self.TOOLS))
        ordered = _ordered_events(events)

        assert [event.type for event in ordered] == [
            EventType.TEXT_MESSAGE_START,
            EventType.TEXT_MESSAGE_CONTENT,
            EventType.TEXT_MESSAGE_END,
            EventType.TOOL_CALL_START,
            EventType.TOOL_CALL_END,
        ]
        text_start, text_content, text_end = ordered[:3]
        assert (
            text_start.message_id == text_content.message_id == text_end.message_id
        )
