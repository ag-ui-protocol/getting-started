"""Tests for client_proxy_tool module."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from ag_ui.core import Tool as AgUiTool
from strands.tools.registry import ToolRegistry
from strands.tools.tools import PythonAgentTool

from ag_ui_strands.client_proxy_tool import (
    _PROXY_MARKER,
    _is_proxy,
    create_proxy_tool,
    sync_proxy_tools,
)
from ag_ui_strands.config import ToolBehavior


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_ag_ui_tool(name: str, description: str = "desc", parameters: dict | None = None) -> AgUiTool:
    """Create an AG-UI Tool instance."""
    return AgUiTool(name=name, description=description, parameters=parameters or {})


def _make_native_tool(name: str) -> PythonAgentTool:
    """Create a non-proxy PythonAgentTool (simulating a server-side tool)."""

    def _func(tool_use, **kwargs):
        return {"toolUseId": tool_use["toolUseId"], "status": "success", "content": [{"text": "native"}]}

    _func.__name__ = name
    spec = {"name": name, "description": "native", "inputSchema": {"json": {}}}
    return PythonAgentTool(tool_name=name, tool_spec=spec, tool_func=_func)


async def _stream_tool(proxy, tool_use):
    agent = SimpleNamespace(
        _interrupt_state=SimpleNamespace(interrupts={}),
    )
    invocation_state = {"agent": agent}
    return [event async for event in proxy.stream(tool_use, invocation_state)]


# ---------------------------------------------------------------------------
# Tests: create_proxy_tool
# ---------------------------------------------------------------------------

class TestCreateProxyTool:
    def test_returns_python_agent_tool(self):
        ag_tool = _make_ag_ui_tool("my_tool", "A tool", {"type": "object", "properties": {"x": {"type": "string"}}})
        proxy = create_proxy_tool(ag_tool)

        assert isinstance(proxy, PythonAgentTool)
        assert proxy.tool_name == "my_tool"
        assert proxy.tool_spec["name"] == "my_tool"
        assert proxy.tool_spec["description"] == "A tool"
        assert proxy.tool_spec["inputSchema"] == {
            "json": {"type": "object", "properties": {"x": {"type": "string"}}}
        }

    def test_marked_dynamic(self):
        proxy = create_proxy_tool(_make_ag_ui_tool("t"))
        assert proxy.is_dynamic is True

    def test_marked_as_proxy(self):
        proxy = create_proxy_tool(_make_ag_ui_tool("t"))
        assert getattr(proxy, _PROXY_MARKER) is True
        assert _is_proxy(proxy) is True

    def test_supports_hot_reload(self):
        proxy = create_proxy_tool(_make_ag_ui_tool("t"))
        assert proxy.supports_hot_reload is True


class TestProxyToolResult:
    def test_returns_success_with_placeholder(self):
        proxy = create_proxy_tool(_make_ag_ui_tool("bg"))
        tool_use = {"toolUseId": "abc-123", "name": "bg", "input": {"color": "red"}}
        result = proxy._tool_func(tool_use)

        assert result["toolUseId"] == "abc-123"
        assert result["status"] == "success"
        assert result["content"] == [{"text": "Forwarded to client"}]

    @pytest.mark.asyncio
    async def test_explicit_false_raises_tagged_native_interrupt(self):
        proxy = create_proxy_tool(
            _make_ag_ui_tool("wait_for_client"),
            continue_after_frontend_call=False,
        )
        tool_use = {
            "toolUseId": "native-wait-id",
            "name": "wait_for_client",
            "input": {"value": "requested"},
        }

        events = await _stream_tool(proxy, tool_use)

        assert len(events) == 1
        interrupt_event = events[0]["tool_interrupt_event"]
        assert interrupt_event["tool_use"] == tool_use
        [interrupt] = interrupt_event["interrupts"]
        assert interrupt.name == "ag_ui_frontend_tool_wait"
        assert interrupt.reason == {
            "name": "ag_ui_frontend_tool_wait",
            "tool_use_id": "native-wait-id",
        }


# ---------------------------------------------------------------------------
# Tests: sync_proxy_tools
# ---------------------------------------------------------------------------

class TestSyncProxyTools:
    def _fresh_registry(self) -> ToolRegistry:
        return ToolRegistry()

    def test_adds_new_tools(self):
        registry = self._fresh_registry()
        tools = [_make_ag_ui_tool("tool_a"), _make_ag_ui_tool("tool_b")]

        result = sync_proxy_tools(registry, tools, set())

        assert result == {"tool_a", "tool_b"}
        assert "tool_a" in registry.registry
        assert "tool_b" in registry.registry
        assert _is_proxy(registry.registry["tool_a"])
        assert _is_proxy(registry.registry["tool_b"])

    def test_removes_stale_tools(self):
        registry = self._fresh_registry()
        # First, register two proxy tools
        proxy_a = create_proxy_tool(_make_ag_ui_tool("tool_a"))
        proxy_b = create_proxy_tool(_make_ag_ui_tool("tool_b"))
        registry.register_tool(proxy_a)
        registry.register_tool(proxy_b)

        # Now sync with only tool_a — tool_b should be removed
        result = sync_proxy_tools(registry, [_make_ag_ui_tool("tool_a")], {"tool_a", "tool_b"})

        assert result == {"tool_a"}
        assert "tool_a" in registry.registry
        assert "tool_b" not in registry.registry

    def test_preserves_native_tools(self):
        registry = self._fresh_registry()
        native = _make_native_tool("my_native")
        registry.register_tool(native)

        # Try to register a proxy with the same name — should be skipped
        tools = [_make_ag_ui_tool("my_native")]
        result = sync_proxy_tools(registry, tools, set())

        assert result == set()  # not tracked as proxy
        assert "my_native" in registry.registry
        assert _is_proxy(registry.registry["my_native"]) is False

    def test_removes_all_when_empty_list(self):
        registry = self._fresh_registry()
        proxy = create_proxy_tool(_make_ag_ui_tool("tool_x"))
        registry.register_tool(proxy)

        result = sync_proxy_tools(registry, [], {"tool_x"})

        assert result == set()
        assert "tool_x" not in registry.registry

    def test_idempotent_re_registration(self):
        """Re-syncing the same tools should work (hot reload)."""
        registry = self._fresh_registry()
        tools = [_make_ag_ui_tool("t1")]

        r1 = sync_proxy_tools(registry, tools, set())
        r2 = sync_proxy_tools(registry, tools, r1)

        assert r1 == r2 == {"t1"}
        assert "t1" in registry.registry

    @pytest.mark.asyncio
    async def test_only_explicit_false_selects_native_interrupt_mode(self):
        registry = self._fresh_registry()
        tools = [
            _make_ag_ui_tool("unconfigured"),
            _make_ag_ui_tool("waiting"),
        ]

        sync_proxy_tools(
            registry,
            tools,
            set(),
            tool_behaviors={
                "waiting": ToolBehavior(continue_after_frontend_call=False),
            },
        )

        unconfigured_result = registry.registry["unconfigured"]._tool_func(
            {"toolUseId": "legacy-id", "name": "unconfigured", "input": {}}
        )
        waiting_events = await _stream_tool(
            registry.registry["waiting"],
            {"toolUseId": "waiting-id", "name": "waiting", "input": {}},
        )

        assert unconfigured_result["content"] == [{"text": "Forwarded to client"}]
        assert "tool_interrupt_event" in waiting_events[0]
