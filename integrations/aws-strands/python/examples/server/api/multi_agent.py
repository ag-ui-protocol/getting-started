"""Multi-agent example for AWS Strands.

A Strands ``Graph`` of three specialist agents wired in sequence. The adapter
drives the orchestrator directly and translates its node lifecycle into AG-UI
STEP_STARTED / STEP_FINISHED plus ``MultiAgentHandoff`` CUSTOM events, so the
dojo page can show which node is running and how control moved between them.

Node ids are the strings the UI and the end-to-end specs match on, so they must
stay in sync with the dojo page.
"""
import os
from pathlib import Path
from dotenv import load_dotenv

# Suppress OpenTelemetry context warnings
os.environ["OTEL_SDK_DISABLED"] = "true"
os.environ["OTEL_PYTHON_DISABLED_INSTRUMENTATIONS"] = "all"

from strands import Agent
from strands.multiagent import GraphBuilder
from ag_ui_strands import StrandsAgent, create_strands_app
from server.model_factory import create_model

env_path = Path(__file__).parent.parent.parent / '.env'
load_dotenv(dotenv_path=env_path)

model = create_model()

RESEARCHER_PROMPT = """
    You are the RESEARCHER in a three-agent pipeline.
    Gather the key facts for the user's topic.
    Reply with 2-3 short bullet points of findings and nothing else.
    Begin every bullet with the exact prefix "Research:".
    """

ANALYST_PROMPT = """
    You are the ANALYST in a three-agent pipeline.
    You receive the researcher's findings. Draw out what they imply.
    Reply with 2-3 short bullet points of analysis and nothing else.
    Begin every bullet with the exact prefix "Analysis:".
    """

WRITER_PROMPT = """
    You are the WRITER in a three-agent pipeline.
    You receive the analyst's conclusions. Write the final answer for the user.
    Reply with one short paragraph and nothing else.
    Begin your reply with the exact prefix "Summary:".
    """


def _build_graph():
    """Build a fresh Graph with fresh node agents.

    Passed to the adapter as a factory rather than as a built instance. A
    Python Strands Graph does not snapshot and restore its node agents around
    an execution, and it holds execution state on the instance, so one graph
    shared across runs would carry a previous run's messages into the next and
    would make two concurrent visitors interfere.
    """
    researcher = Agent(
        model=model,
        name="researcher",
        callback_handler=None,
        system_prompt=RESEARCHER_PROMPT,
    )
    analyst = Agent(
        model=model,
        name="analyst",
        callback_handler=None,
        system_prompt=ANALYST_PROMPT,
    )
    writer = Agent(
        model=model,
        name="writer",
        callback_handler=None,
        system_prompt=WRITER_PROMPT,
    )

    builder = GraphBuilder()
    builder.add_node(researcher, "researcher")
    builder.add_node(analyst, "analyst")
    builder.add_node(writer, "writer")
    builder.add_edge("researcher", "analyst")
    builder.add_edge("analyst", "writer")
    builder.set_entry_point("researcher")
    return builder.build()


agui_agent = StrandsAgent(
    # A callable, not an instance: the adapter invokes it per run, so no run
    # can see another's conversation and two visitors never share a graph.
    agent=_build_graph,
    name="multi_agent",
    description="Strands Graph of researcher, analyst and writer agents",
)

app = create_strands_app(agui_agent, "/")
