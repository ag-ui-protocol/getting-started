"""Subagents — multi-agent via the SDK's agents-as-tools pattern.

Unlike a handoff (control *transfers* to the specialist, triage agent exits
the conversation), the supervisor here stays in charge and *calls*
specialists as tools (``Agent.as_tool()``), possibly several in one turn,
then synthesizes their outputs itself — a call-and-return delegation, not a
handoff. Same shape as the LangGraph "subagents" showcase demo (a supervisor
calling child agents as tools and getting results back), just built with the
SDK's own ``as_tool()`` instead of a routing graph.

On the AG-UI side each specialist invocation is an ordinary
``TOOL_CALL_START/ARGS/END`` + ``TOOL_CALL_RESULT`` sequence — the nested
agent's own model turns stay internal to the SDK and are not streamed as
separate messages, so the client sees one coherent supervisor transcript.
"""

from __future__ import annotations

from agents import Agent
from fastapi import FastAPI

from ag_ui_openai_agents import OpenAIAgentsAgent, add_openai_agents_fastapi_endpoint
from .constants import DEFAULT_MODEL

research_agent = Agent(
    name="research_agent",
    model=DEFAULT_MODEL,
    instructions=(
        "You research a topic and return the key facts as a short bullet "
        "list. Facts only — no fluff, no conclusions."
    ),
)

writer_agent = Agent(
    name="writer_agent",
    model=DEFAULT_MODEL,
    instructions=(
        "You turn bullet-point facts into short, engaging prose. One tight "
        "paragraph unless asked otherwise."
    ),
)

critic_agent = Agent(
    name="critic_agent",
    model=DEFAULT_MODEL,
    instructions=(
        "You review a draft and return concrete improvement suggestions as a "
        "numbered list. Max 3 suggestions, be specific."
    ),
)


def create_subagents_agent() -> Agent:
    return Agent(
        name="orchestrator",
        model=DEFAULT_MODEL,
        instructions=(
            "You orchestrate a small content team. For writing requests: "
            "call research_topic for the facts, then write_prose to draft, "
            "then critique_draft to review, then produce the final version "
            "yourself incorporating the critique. For simple questions, "
            "answer directly without the team."
        ),
        tools=[
            research_agent.as_tool(
                tool_name="research_topic",
                tool_description="Research a topic and return key facts as bullets.",
            ),
            writer_agent.as_tool(
                tool_name="write_prose",
                tool_description="Turn bullet-point facts into short prose.",
            ),
            critic_agent.as_tool(
                tool_name="critique_draft",
                tool_description="Review a draft and suggest up to 3 improvements.",
            ),
        ],
    )


agent = OpenAIAgentsAgent(create_subagents_agent(), name="subagents")
app = FastAPI(title="Subagents AG-UI demo")
add_openai_agents_fastapi_endpoint(app, agent, "/")
