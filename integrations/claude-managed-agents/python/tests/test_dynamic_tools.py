"""Regression coverage for synchronizing dynamic RunAgentInput tools."""

import pytest

from .test_agent import IDLE_END_TURN, base_input, collect, new_agent
from .fake_client import FakeClient
from ag_ui_claude_managed_agents import InMemorySessionStore

BASE_AGENT_TOOL = {
    "type": "agent_toolset_20260401",
    "configs": [],
    "default_config": {},
}


def tool(name, description, properties=None):
    return {
        "name": name,
        "description": description,
        "parameters": {"type": "object", "properties": properties or {}},
    }


def custom_tool(name, description, properties=None):
    return {
        "type": "custom",
        "name": name,
        "description": description,
        "input_schema": {
            "type": "object",
            "properties": properties or {},
        },
    }


async def run_tool_transition(initial_tools, next_tools):
    fake = FakeClient(
        streams=[[IDLE_END_TURN], [IDLE_END_TURN]],
        agent_tools=[BASE_AGENT_TOOL],
    )
    store = InMemorySessionStore()
    agent = new_agent(fake, store)

    await collect(agent, base_input(tools=initial_tools))
    await collect(
        agent,
        base_input(
            run_id="run_2",
            messages=[
                {"id": "u1", "role": "user", "content": "Hello"},
                {"id": "u2", "role": "user", "content": "Follow-up"},
            ],
            tools=next_tools,
        ),
    )
    return fake


@pytest.mark.parametrize(
    ("initial_tools", "next_tools", "expected_custom_tools"),
    [
        (
            [
                tool("show_chart", "Render a chart"),
                tool("export_csv", "Export a CSV"),
            ],
            [tool("show_chart", "Render a chart")],
            [custom_tool("show_chart", "Render a chart")],
        ),
        ([tool("show_chart", "Render a chart")], [], []),
        (
            [
                tool(
                    "show_chart",
                    "Render a chart",
                    {"title": {"type": "string"}},
                )
            ],
            [
                tool(
                    "show_chart",
                    "Render a visualization",
                    {"series": {"type": "array"}},
                )
            ],
            [
                custom_tool(
                    "show_chart",
                    "Render a visualization",
                    {"series": {"type": "array"}},
                )
            ],
        ),
    ],
    ids=["removed", "cleared", "definition-changed"],
)
async def test_updates_session_when_frontend_tools_change(
    initial_tools, next_tools, expected_custom_tools
):
    fake = await run_tool_transition(initial_tools, next_tools)

    assert fake.update_calls == [
        ("sesn_1", {"agent": {"tools": [BASE_AGENT_TOOL, *expected_custom_tools]}})
    ]


async def test_does_not_update_session_when_tool_definitions_are_unchanged():
    tools = [
        tool("show_chart", "Render a chart", {"title": {"type": "string"}})
    ]
    fake = await run_tool_transition(tools, tools)

    assert fake.update_calls == []


async def test_pushes_a_console_edit_to_the_agents_own_tools_into_an_override_session():
    """Regression: an override session's tool list is a full replacement frozen at
    the last update. Fingerprinting only the custom tools called an unchanged
    frontend list a match, so a Console edit to the agent's own tools never
    reached the session and it kept a stale replacement list indefinitely."""
    show_chart = tool("show_chart", "Render a chart")
    edited_base_tool = {
        "type": "agent_toolset_20260401",
        "configs": [{"name": "bash"}],
        "default_config": {},
    }
    fake = FakeClient(
        streams=[[IDLE_END_TURN], [IDLE_END_TURN]], agent_tools=[BASE_AGENT_TOOL]
    )
    store = InMemorySessionStore()
    agent = new_agent(fake, store)

    await collect(agent, base_input(tools=[show_chart]))
    assert fake.update_calls == []

    # The agent's own tools change in the Console; the frontend list does not.
    fake.agent_tools = [edited_base_tool]
    await collect(
        agent,
        base_input(
            run_id="run_2",
            messages=[
                {"id": "u1", "role": "user", "content": "Hello"},
                {"id": "u2", "role": "user", "content": "Follow-up"},
            ],
            tools=[show_chart],
        ),
    )

    assert fake.update_calls == [
        (
            "sesn_1",
            {
                "agent": {
                    "tools": [
                        edited_base_tool,
                        custom_tool("show_chart", "Render a chart"),
                    ]
                }
            },
        )
    ]


async def test_does_not_re_read_the_agents_tools_without_custom_tools():
    """Such a session runs the agent as-is, so there is nothing to keep in step
    and no reason to spend a call per run finding that out."""
    fake = FakeClient(
        streams=[[IDLE_END_TURN], [IDLE_END_TURN]], agent_tools=[BASE_AGENT_TOOL]
    )
    store = InMemorySessionStore()
    agent = new_agent(fake, store)

    await collect(agent, base_input(tools=[]))
    await collect(
        agent,
        base_input(
            run_id="run_2",
            messages=[
                {"id": "u1", "role": "user", "content": "Hello"},
                {"id": "u2", "role": "user", "content": "Follow-up"},
            ],
            tools=[],
        ),
    )

    assert fake.retrieve_calls == []
    assert fake.update_calls == []
