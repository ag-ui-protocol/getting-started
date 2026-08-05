"""Tests for parallel frontend tool-call handling in StrandsAgent.

Each test is written to FAIL with the current code and PASS after the
corresponding fix is applied.

Scenario A – Only the first parallel frontend tool call is emitted.
              Root cause: halt_event_stream=True fires inside the contentBlockStop
              handler after the first tool, so subsequent contentBlockStop events
              are silently consumed.

Scenario B – New tool calls are suppressed when the client sends a pending tool
              result (continuation turn).
              Root cause: the `if not has_pending_tool_result:` guard blocks all new
              tool-call event emission even though the persistent agent never replays
              previously-seen calls.

Scenario C – Backend tool results leak from a batched message after the halt flag
              is set.
              Root cause: the inner loop over toolResult items uses `continue`
              instead of `break` after setting halt_event_stream=True, allowing
              subsequent items in the same batch to be processed.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from ag_ui.core import (
    AssistantMessage,
    EventType,
    FunctionCall,
    RunAgentInput,
    Tool,
    ToolCall,
    ToolMessage,
    UserMessage,
)
from strands.tools.registry import ToolRegistry

from ag_ui_strands.agent import StrandsAgent, _build_strands_history
from ag_ui_strands.config import StrandsAgentConfig, ToolBehavior


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def _template_agent() -> MagicMock:
    """Minimal mock satisfying StrandsAgent.__init__ attribute access."""
    mock = MagicMock()
    mock.model = MagicMock()
    mock.system_prompt = "You are helpful"
    mock.tool_registry.registry = {}
    mock.record_direct_tool_call = True
    return mock


def _build_agent(
    thread_id: str,
    stream_events: list,
    config: StrandsAgentConfig | None = None,
) -> StrandsAgent:
    """Create a StrandsAgent pre-wired with a mock inner agent for *thread_id*."""
    agent = StrandsAgent(
        _template_agent(), name="test-agent", config=config or StrandsAgentConfig()
    )

    mock_inner = MagicMock()
    mock_inner.tool_registry = ToolRegistry()

    async def _stream(_msg: str):
        for event in stream_events:
            yield event

    mock_inner.stream_async = _stream
    agent._agents_by_thread[thread_id] = mock_inner
    return agent


def _run_input(
    thread_id: str = "t1",
    messages: list | None = None,
    tools: list | None = None,
) -> RunAgentInput:
    return RunAgentInput(
        thread_id=thread_id,
        run_id="r1",
        state={},
        messages=messages or [UserMessage(id="u1", content="hello")],
        tools=tools or [],
        context=[],
        forwarded_props={},
    )


async def _collect(agent: StrandsAgent, inp: RunAgentInput) -> list:
    return [e async for e in agent.run(inp)]


def test_strands_history_bundles_parallel_tool_results():
    messages = [
        UserMessage(id="u1", role="user", content="hi"),
        AssistantMessage(
            id="a1",
            role="assistant",
            content="",
            tool_calls=[
                ToolCall(
                    id="tooluse_1",
                    type="function",
                    function=FunctionCall(name="my_tool", arguments="{}"),
                ),
                ToolCall(
                    id="tooluse_2",
                    type="function",
                    function=FunctionCall(name="my_tool", arguments="{}"),
                ),
                ToolCall(
                    id="tooluse_3",
                    type="function",
                    function=FunctionCall(name="my_tool", arguments="{}"),
                ),
            ],
        ),
        ToolMessage(id="t1", role="tool", tool_call_id="tooluse_1", content='{"ok":1}'),
        ToolMessage(id="t2", role="tool", tool_call_id="tooluse_2", content='{"ok":2}'),
        ToolMessage(id="t3", role="tool", tool_call_id="tooluse_3", content='{"ok":3}'),
    ]

    native = _build_strands_history(messages)

    assert len(native) == 3
    assert native[2]["role"] == "user"
    tool_results = [
        block["toolResult"] for block in native[2]["content"] if "toolResult" in block
    ]
    assert len(tool_results) == 3
    assert {result["toolUseId"] for result in tool_results} == {
        "tooluse_1",
        "tooluse_2",
        "tooluse_3",
    }


# ---------------------------------------------------------------------------
# Scenario A – All parallel frontend tool calls must be emitted
# ---------------------------------------------------------------------------

class TestParallelFrontendToolCallsAllEmitted:
    """
    When the LLM issues multiple frontend tool calls in one turn, Strands
    delivers a separate contentBlockStop event for each tool in sequence.

    Current behaviour: halt_event_stream=True is set after the first
    contentBlockStop, so every subsequent contentBlockStop (and the tool
    calls they would complete) is silently consumed.

    Expected behaviour after fix: every contentBlockStop emits its tool-call
    triple (START / ARGS / END) before the stream is halted.
    """

    THREAD = "parallel-tools-thread"
    TOOLS = [
        Tool(name="frontend_a", description="a", parameters={}),
        Tool(name="frontend_b", description="b", parameters={}),
    ]
    STREAM = [
        {"current_tool_use": {"name": "frontend_a", "toolUseId": "st-a", "input": {}}},
        {"current_tool_use": {"name": "frontend_b", "toolUseId": "st-b", "input": {}}},
        {"event": {"contentBlockStop": {}}},  # completes frontend_a
        {"event": {"contentBlockStop": {}}},  # completes frontend_b – currently dropped
    ]

    async def test_both_tool_calls_emitted(self):
        """Both TOOL_CALL_START events must appear; currently only the first does."""
        agent = _build_agent(self.THREAD, self.STREAM)
        events = await _collect(agent, _run_input(self.THREAD, tools=self.TOOLS))

        starts = [e for e in events if e.type == EventType.TOOL_CALL_START]
        names = {e.tool_call_name for e in starts}

        assert "frontend_a" in names, "frontend_a was not emitted"
        assert "frontend_b" in names, "frontend_b was silently dropped"
        assert len(starts) == 2, f"Expected 2 TOOL_CALL_START events, got {len(starts)}"

    async def test_every_start_has_matching_end(self):
        """Each TOOL_CALL_START must be paired with a TOOL_CALL_END."""
        agent = _build_agent(self.THREAD, self.STREAM)
        events = await _collect(agent, _run_input(self.THREAD, tools=self.TOOLS))

        start_ids = {e.tool_call_id for e in events if e.type == EventType.TOOL_CALL_START}
        end_ids = {e.tool_call_id for e in events if e.type == EventType.TOOL_CALL_END}

        assert start_ids == end_ids, (
            f"Unpaired tool-call events. STARTs: {start_ids}  ENDs: {end_ids}"
        )
        assert len(start_ids) == 2


# ---------------------------------------------------------------------------
# Scenario B – New tool calls must not be suppressed by a pending tool result
# ---------------------------------------------------------------------------

class TestContinuationTurnEmitsNewToolCalls:
    """
    The old boolean guard suppressed ALL tool-call emission on any continuation
    turn.  The correct fix collects only the specific tool_call_ids present in
    the trailing tool messages and suppresses only those.

    A new tool call with a different ID must still be emitted; a call whose ID
    is already in the trailing history must be suppressed.
    """

    THREAD = "continuation-thread"
    TOOLS = [Tool(name="frontend_tool", description="d", parameters={})]

    def _messages(self) -> list:
        """Simulate a continuation: last message is a resolved frontend-tool result."""
        tc = ToolCall(
            id="prev-tc",
            function=FunctionCall(name="frontend_tool", arguments="{}"),
        )
        return [
            UserMessage(id="u1", content="do something"),
            AssistantMessage(id="a1", tool_calls=[tc]),
            ToolMessage(id="t1", content="done", tool_call_id="prev-tc"),
        ]

    async def test_new_tool_call_emitted_on_continuation(self):
        """A new ID (not in pending set) must be forwarded to the client."""
        stream = [
            {"current_tool_use": {"name": "frontend_tool", "toolUseId": "st-new", "input": {"x": 1}}},
            {"event": {"contentBlockStop": {}}},
        ]
        agent = _build_agent(self.THREAD, stream)
        inp = _run_input(self.THREAD, messages=self._messages(), tools=self.TOOLS)
        events = await _collect(agent, inp)

        starts = [e for e in events if e.type == EventType.TOOL_CALL_START]
        assert len(starts) == 1, (
            f"Expected 1 TOOL_CALL_START for new call, got {len(starts)}"
        )
        assert starts[0].tool_call_name == "frontend_tool"

    async def test_already_resolved_backend_tool_suppressed(self):
        """A backend call whose Strands ID matches a trailing tool result must be suppressed.

        Backend tools use the Strands toolUseId directly (no UUID rewrite), so
        the ID in pending_tool_result_ids can match at emit time.
        """
        # Build messages referencing a backend tool (no entry in tools list)
        tc = ToolCall(id="prev-tc", function=FunctionCall(name="backend_tool", arguments="{}"))
        messages = [
            UserMessage(id="u1", content="do something"),
            AssistantMessage(id="a1", tool_calls=[tc]),
            ToolMessage(id="t1", content="result", tool_call_id="prev-tc"),
        ]
        stream = [
            # Backend tool: tool_use_id == strands toolUseId == "prev-tc" → matches pending set
            {"current_tool_use": {"name": "backend_tool", "toolUseId": "prev-tc", "input": {}}},
            {"event": {"contentBlockStop": {}}},
        ]
        agent = _build_agent(self.THREAD + "-suppress", stream)
        # tools=[] → backend_tool is not in frontend_tool_names → uses Strands ID directly
        inp = _run_input(self.THREAD + "-suppress", messages=messages, tools=[])
        events = await _collect(agent, inp)

        starts = [e for e in events if e.type == EventType.TOOL_CALL_START]
        assert len(starts) == 0, (
            f"Expected no TOOL_CALL_START for already-resolved backend call, got {len(starts)}"
        )


# ---------------------------------------------------------------------------
# Scenario C – No backend tool results must leak after halt
# ---------------------------------------------------------------------------

class TestNoBackendResultLeakAfterHalt:
    """
    When a backend tool has stop_streaming_after_result=True, the handler sets
    halt_event_stream=True then `continue`s the *inner* for-loop over the batch
    of toolResult items in the same message.  This allows subsequent results in
    that batch to be processed and emitted even though the stream has halted.

    Expected behaviour after fix: only the result that triggered the halt is
    emitted; all later results in the same batch are suppressed.
    """

    THREAD = "halt-leak-thread"

    def _config(self) -> StrandsAgentConfig:
        return StrandsAgentConfig(
            tool_behaviors={
                "backend_halt_tool": ToolBehavior(stop_streaming_after_result=True),
            }
        )

    STREAM = [
        # Two backend tool calls
        {"current_tool_use": {"name": "backend_halt_tool", "toolUseId": "st1", "input": {}}},
        {"current_tool_use": {"name": "backend_other",     "toolUseId": "st2", "input": {}}},
        # Both complete (no halt for backend tools at this stage)
        {"event": {"contentBlockStop": {}}},
        {"event": {"contentBlockStop": {}}},
        # Results arrive in a single batched message
        {
            "message": {
                "role": "user",
                "content": [
                    {
                        "toolResult": {
                            "toolUseId": "st1",
                            "content": [{"text": '{"value": 1}'}],
                        }
                    },
                    {
                        # This result must be suppressed once halt fires for st1
                        "toolResult": {
                            "toolUseId": "st2",
                            "content": [{"text": '{"value": 2}'}],
                        }
                    },
                ],
            }
        },
    ]

    async def test_only_halting_result_emitted(self):
        """After halt, the second result in the batch must not be emitted."""
        agent = _build_agent(self.THREAD, self.STREAM, config=self._config())
        events = await _collect(agent, _run_input(self.THREAD))

        result_events = [e for e in events if e.type == EventType.TOOL_CALL_RESULT]
        result_ids = [e.tool_call_id for e in result_events]

        assert "st1" in result_ids, "st1 result should have been emitted before halt"
        assert "st2" not in result_ids, (
            f"st2 result leaked after halt. All emitted: {result_ids}"
        )
        assert len(result_events) == 1, (
            f"Expected exactly 1 result event, got {len(result_events)}: {result_ids}"
        )
