"""Regression: a frontend-tool continuation must not feed the model an empty prompt.

When ``replay_history_into_strands`` is False the reconcile path is disabled, so the
continuation runs solely off ``stream_async(user_message)``. ``user_message`` is derived by
looking the trailing tool result's ``tool_call_id`` up in ``_tool_call_id_to_name`` — which is
keyed by the NATIVE ``tooluse_...`` id. A frontend tool's result arrives keyed by the fresh wire
uuid handed to the client, and on a delta-only continuation payload (no naming assistant message)
that wire id is only resolvable through the wire->native map. Without translating the wire id
first, the lookup misses, ``user_message`` stays "" -> ``stream_async("")`` -> the model gets no
input and re-asks the same question.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from ag_ui.core import RunAgentInput, Tool, ToolMessage
from strands.tools.registry import ToolRegistry

from ag_ui_strands.agent import StrandsAgent
from ag_ui_strands.config import StrandsAgentConfig
from ag_ui_strands.session_reconcile import AG_UI_WIRE_MAP_STATE_KEY

WIRE_ID = "wire-1"
NATIVE_ID = "native-1"


class _FakeState:
    """Dict-backed stand-in for the Strands agent state (get/set)."""

    def __init__(self, initial: dict):
        self._d = dict(initial)

    def get(self, key, default=None):
        return self._d.get(key, default)

    def set(self, key, value):
        self._d[key] = value


def _template_agent() -> MagicMock:
    mock = MagicMock()
    mock.model = MagicMock()
    mock.system_prompt = "You are helpful"
    mock.tool_registry.registry = {}
    mock.record_direct_tool_call = True
    # No template-level session manager (avoids the spurious "will be ignored" __init__ warning).
    mock.session_manager = None
    mock._session_manager = None
    return mock


def _native_history() -> list:
    """Restored session history: the assistant toolUse (native id + name) is here, NOT in the
    delta-only continuation payload — so the tool name is only resolvable via wire->native."""
    return [
        {"role": "user", "content": [{"text": "should I proceed?"}]},
        {
            "role": "assistant",
            "content": [{"toolUse": {"toolUseId": NATIVE_ID, "name": "ask_user", "input": {}}}],
        },
        {
            "role": "user",
            "content": [
                {"toolResult": {"toolUseId": NATIVE_ID, "content": [{"text": "Forwarded to client"}]}}
            ],
        },
    ]


@pytest.mark.asyncio
async def test_continuation_message_resolves_frontend_tool_via_wire_map():
    thread_id = "t-continuation"
    captured: dict = {}

    async def _stream(msg=None):
        captured["msg"] = msg
        for _event in []:  # empty stream; we only assert on the derived prompt
            yield _event

    mock_inner = MagicMock()
    mock_inner.tool_registry = ToolRegistry()
    mock_inner.messages = _native_history()
    mock_inner.state = _FakeState({AG_UI_WIRE_MAP_STATE_KEY: {WIRE_ID: NATIVE_ID}})
    mock_inner.stream_async = _stream

    agent = StrandsAgent(
        _template_agent(),
        name="test-agent",
        config=StrandsAgentConfig(replay_history_into_strands=False),
    )
    agent._agents_by_thread[thread_id] = mock_inner

    # Delta-only continuation: ONLY the frontend tool result, keyed by the wire id.
    inp = RunAgentInput(
        thread_id=thread_id,
        run_id="r1",
        state={},
        messages=[ToolMessage(id="t1", role="tool", tool_call_id=WIRE_ID, content='{"answered": true}')],
        tools=[Tool(name="ask_user", description="ask the human", parameters={})],
        context=[],
        forwarded_props={},
    )

    async for _ in agent.run(inp):
        pass

    # Without the wire->native fallback this is "" (the wire id misses in the native-keyed map).
    assert captured.get("msg") == 'ask_user returned: {"answered": true}'
