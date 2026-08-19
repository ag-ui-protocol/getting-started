"""The managed agents behind each Dojo feature.

`setup.py` provisions them; `server.py` serves them. Add a feature by adding
an entry here.
"""

import os
from dataclasses import dataclass


@dataclass
class FeatureAgentSpec:
    feature: str
    """Route name and Dojo feature id."""
    agent_name: str
    """Managed agent name (used to find or create it idempotently)."""
    system: str


MODEL = os.getenv("MANAGED_AGENTS_MODEL", "claude-sonnet-5")
ENVIRONMENT_NAME = "ag-ui-dojo"

FEATURE_AGENTS: list[FeatureAgentSpec] = [
    FeatureAgentSpec(
        feature="agentic_chat",
        agent_name="ag-ui-dojo-agentic-chat",
        system="You are a helpful assistant. Keep replies concise.",
    ),
    FeatureAgentSpec(
        feature="backend_tool_rendering",
        agent_name="ag-ui-dojo-backend-tool-rendering",
        system=(
            "You are a helpful assistant. When the user asks about the weather, call the "
            "get_weather tool and then summarize the result in a sentence."
        ),
    ),
    FeatureAgentSpec(
        feature="human_in_the_loop",
        agent_name="ag-ui-dojo-human-in-the-loop",
        system=(
            "You are a task planning assistant. For every request, IMMEDIATELY call the "
            "generate_task_steps tool with about 10 steps, each an object with `description` "
            '(brief imperative) and `status` set to "enabled". Do not repeat the steps as text; '
            "the UI shows them. After the user approves steps via the tool result, confirm briefly."
        ),
    ),
    FeatureAgentSpec(
        feature="tool_based_generative_ui",
        agent_name="ag-ui-dojo-tool-based-generative-ui",
        system=(
            "You are a haiku assistant. When asked, call the generate_haiku tool with the "
            "haiku's lines in Japanese and English. Keep any other text short."
        ),
    ),
]
