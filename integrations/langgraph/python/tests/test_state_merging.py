"""Tests for langgraph_default_merge_state.

Covers basic merging, tool deduplication, and the orphaned-tools fix for #1412.
"""
import unittest
import pytest
from unittest.mock import MagicMock

from langchain_core.messages import HumanMessage, AIMessage, SystemMessage, ToolMessage

from ag_ui.core import RunAgentInput, Tool, Context


def make_agent():
    """Create a minimal LangGraphAgent with a mock graph for testing merge_state."""
    from ag_ui_langgraph.agent import LangGraphAgent

    mock_graph = MagicMock()
    agent = LangGraphAgent(name="test", graph=mock_graph)
    # Set up minimal active_run so get_state_snapshot works
    agent.active_run = {
        "id": "run-1",
        "schema_keys": {"input": ["messages", "tools"], "output": ["messages", "tools"], "config": [], "context": []},
    }
    return agent


def make_tool(name, description="desc"):
    """Create a Tool instance."""
    return Tool(
        name=name,
        description=description,
        parameters={"type": "object", "properties": {}},
    )


def make_input(**kwargs):
    """Create a RunAgentInput with sensible defaults."""
    defaults = {
        "thread_id": "t1",
        "run_id": "r1",
        "state": {},
        "messages": [],
        "tools": [],
        "context": [],
        "forwarded_props": {},
    }
    defaults.update(kwargs)
    return RunAgentInput(**defaults)


def tool_name(t):
    """Extract name from a tool dict or object."""
    return t.get("name") if isinstance(t, dict) else getattr(t, "name", None)


class TestLanggraphDefaultMergeState(unittest.TestCase):

    def test_basic_merge_messages_appended(self):
        agent = make_agent()
        state = {"messages": [HumanMessage(id="m1", content="Hi")]}
        new_msgs = [AIMessage(id="m2", content="Hello")]
        result = agent.langgraph_default_merge_state(state, new_msgs, make_input())
        # m2 is new so it should be in result messages
        assert any(m.id == "m2" for m in result["messages"])

    def test_duplicate_messages_excluded(self):
        agent = make_agent()
        msg = HumanMessage(id="m1", content="Hi")
        state = {"messages": [msg]}
        result = agent.langgraph_default_merge_state(state, [msg], make_input())
        # m1 already exists in state, so new_messages should be empty
        assert len(result["messages"]) == 0

    def test_system_message_stripped(self):
        agent = make_agent()
        state = {"messages": []}
        msgs = [SystemMessage(id="s1", content="sys"), HumanMessage(id="h1", content="Hi")]
        result = agent.langgraph_default_merge_state(state, msgs, make_input())
        # System message should be stripped, only human message remains
        assert len(result["messages"]) == 1
        assert result["messages"][0].id == "h1"

    def test_tools_deduplication_input_wins(self):
        """When same-named tool is in both state and input, input version should win."""
        agent = make_agent()
        state_tool = {"name": "search", "description": "old", "parameters": {}}
        state = {"messages": [], "tools": [state_tool]}
        input_tool = make_tool("search", description="new and improved")
        result = agent.langgraph_default_merge_state(state, [], make_input(tools=[input_tool]))
        search_tools = [t for t in result["tools"] if tool_name(t) == "search"]
        assert len(search_tools) == 1
        # The input (newer) version should win
        tool = search_tools[0]
        desc = tool.get("description") if isinstance(tool, dict) else getattr(tool, "description", None)
        assert desc == "new and improved"

    def test_orphaned_tools_preserved(self):
        """Bug #1412: tools in state but NOT in input should be preserved."""
        agent = make_agent()
        tool_a = {"name": "tool_a", "description": "A", "parameters": {}}
        tool_b = {"name": "tool_b", "description": "B", "parameters": {}}
        state = {"messages": [], "tools": [tool_a, tool_b]}
        input_tool_a = make_tool("tool_a", description="A updated")
        result = agent.langgraph_default_merge_state(state, [], make_input(tools=[input_tool_a]))
        tool_names = [tool_name(t) for t in result["tools"]]
        assert "tool_a" in tool_names, "tool_a should be present"
        assert "tool_b" in tool_names, "tool_b (orphaned) should be preserved (issue #1412)"

    def test_empty_input_tools_preserves_state_tools(self):
        agent = make_agent()
        tool_a = {"name": "tool_a", "description": "A", "parameters": {}}
        state = {"messages": [], "tools": [tool_a]}
        result = agent.langgraph_default_merge_state(state, [], make_input())
        assert len(result["tools"]) == 1

    def test_empty_state_tools_uses_input(self):
        agent = make_agent()
        state = {"messages": [], "tools": []}
        input_tool = make_tool("new_tool")
        result = agent.langgraph_default_merge_state(state, [], make_input(tools=[input_tool]))
        tool_names = [tool_name(t) for t in result["tools"]]
        assert "new_tool" in tool_names

    def test_neither_has_tools(self):
        agent = make_agent()
        state = {"messages": []}
        result = agent.langgraph_default_merge_state(state, [], make_input())
        assert result["tools"] == []

    def test_input_tools_appear_before_state_orphan_tools(self):
        """Tools from input should appear before orphaned state tools in result (stable ordering)."""
        agent = make_agent()
        orphan = {"name": "orphan", "description": "orphaned", "parameters": {}}
        state = {"messages": [], "tools": [orphan]}
        input_tool = make_tool("input_tool")
        result = agent.langgraph_default_merge_state(state, [], make_input(tools=[input_tool]))
        names = [tool_name(t) for t in result["tools"]]
        assert names.index("input_tool") < names.index("orphan"), \
            "Input tool should come before orphaned state tool"

    def test_same_tool_name_different_parameters_input_wins(self):
        """When the same tool name appears in both, input's parameters schema should win."""
        agent = make_agent()
        state_tool = {
            "name": "my_tool",
            "description": "old",
            "parameters": {"type": "object", "properties": {"old_field": {"type": "string"}}},
        }
        state = {"messages": [], "tools": [state_tool]}
        new_params = {"type": "object", "properties": {"new_field": {"type": "integer"}}}
        input_tool = Tool(
            name="my_tool",
            description="new",
            parameters=new_params,
        )
        result = agent.langgraph_default_merge_state(state, [], make_input(tools=[input_tool]))
        my_tools = [t for t in result["tools"] if tool_name(t) == "my_tool"]
        assert len(my_tools) == 1
        tool = my_tools[0]
        params = tool.get("parameters") if isinstance(tool, dict) else getattr(tool, "parameters", None)
        assert params == new_params, "Input tool's parameters should win over state tool's"

    def test_state_tools_key_none_treated_as_empty(self):
        """State with tools=None should not crash and should use input tools."""
        agent = make_agent()
        state = {"messages": [], "tools": None}
        input_tool = make_tool("only_input_tool")
        result = agent.langgraph_default_merge_state(state, [], make_input(tools=[input_tool]))
        tool_names_in_result = [tool_name(t) for t in result["tools"]]
        assert "only_input_tool" in tool_names_in_result

    def test_ag_ui_key_set(self):
        agent = make_agent()
        state = {"messages": []}
        input_tool = make_tool("my_tool")
        ctx = [Context(description="test ctx", value="val")]
        result = agent.langgraph_default_merge_state(state, [], make_input(tools=[input_tool], context=ctx))
        assert "ag-ui" in result
        assert result["ag-ui"]["tools"] == result["tools"]
        assert result["ag-ui"]["context"] == ctx

    # Forwarded props that must be surfaced into ag-ui state, keyed by the
    # forwarded_props key (as it arrives after run()'s camel->snake conversion)
    # mapped to (the ag-ui state key it lands under, a sample value).
    # To wire a new forwarded prop into ag-ui state, add it here AND in
    # langgraph_default_merge_state — both the test and the absence check below
    # then cover it automatically.
    FORWARDED_PROPS_TO_AGUI = {
        # injectA2UITool -> camel_to_snake -> inject_a2_u_i_tool (A2UI middleware)
        "inject_a2_u_i_tool": ("inject_a2ui_tool", "render_a2ui"),
    }

    def test_camel_to_snake_key_contract(self):
        """Pin the load-bearing wire-key conversion. run() snake-cases forwarded_props
        keys, so the merge step keys off the CONVERTED name. The tests below feed the
        converted key directly; this test guarantees the conversion actually produces
        that key from the real camelCase wire name. If camel_to_snake ever changed
        (e.g. collapsing the capital run to "inject_a2ui_tool"), the feature would break
        silently while the table-driven tests still passed — this assertion catches it."""
        from ag_ui_langgraph.utils import camel_to_snake
        assert camel_to_snake("injectA2UITool") == "inject_a2_u_i_tool"

    def test_forwarded_props_surface_into_ag_ui_state(self):
        """Each configured forwarded prop lands under its ag-ui state key."""
        agent = make_agent()
        forwarded = {fp: sample for fp, (_, sample) in self.FORWARDED_PROPS_TO_AGUI.items()}
        result = agent.langgraph_default_merge_state(
            {"messages": []}, [], make_input(forwarded_props=forwarded)
        )
        for _, (agui_key, sample) in self.FORWARDED_PROPS_TO_AGUI.items():
            assert result["ag-ui"][agui_key] == sample

    def test_forwarded_props_absent_by_default(self):
        """With no forwarded props, none of the ag-ui state keys are present."""
        agent = make_agent()
        result = agent.langgraph_default_merge_state({"messages": []}, [], make_input())
        for _, (agui_key, _sample) in self.FORWARDED_PROPS_TO_AGUI.items():
            assert agui_key not in result["ag-ui"]

    # Must stay byte-identical to the A2UI middleware's exported
    # A2UI_SCHEMA_CONTEXT_DESCRIPTION (middlewares/a2ui-middleware/src/index.ts).
    # The connector matches the schema context entry by exact string equality, so
    # any drift silently routes the schema into the system prompt instead of state.
    A2UI_SCHEMA_CONTEXT_DESCRIPTION = (
        "A2UI Component Schema — available components for generating UI surfaces. "
        "Use these component names and properties when creating A2UI operations."
    )

    def test_a2ui_schema_context_routed_into_ag_ui_state(self):
        """A context entry carrying the middleware's schema description is lifted into
        ag-ui.a2ui_schema and removed from the regular context list."""
        agent = make_agent()
        schema_value = '{"components": ["Card", "Button"]}'
        ctx = [
            Context(description="unrelated", value="keep me"),
            Context(description=self.A2UI_SCHEMA_CONTEXT_DESCRIPTION, value=schema_value),
        ]
        result = agent.langgraph_default_merge_state({"messages": []}, [], make_input(context=ctx))
        assert result["ag-ui"]["a2ui_schema"] == schema_value
        # The schema entry must NOT remain in regular context.
        descriptions = [
            c.description if hasattr(c, "description") else c.get("description")
            for c in result["ag-ui"]["context"]
        ]
        assert self.A2UI_SCHEMA_CONTEXT_DESCRIPTION not in descriptions
        assert "unrelated" in descriptions
