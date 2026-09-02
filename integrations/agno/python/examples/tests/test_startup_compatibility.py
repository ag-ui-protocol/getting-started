from __future__ import annotations

import unittest

from agno.agent import Agent
from agno.os import AgentOS
from agno.os.interfaces.agui import AGUI
from agno.team import Team
from starlette.routing import Mount

from server import app as dojo_app
from server.api.agentic_chat import agent as agentic_chat_agent
from server.api.agentic_generative_ui import agent as agentic_generative_ui_agent
from server.api.agentic_chat_reasoning import agent as reasoning_agent
from server.api.human_in_the_loop import agent as human_in_the_loop_agent
from server.api.tool_based_generative_ui import agent as tool_based_generative_ui_agent


EXPECTED_DOJO_MOUNTS = {
    "/agentic_chat",
    "/agentic_chat_reasoning",
    "/agentic_chat_multimodal",
    "/agentic_generative_ui",
    "/backend_tool_rendering",
    "/human_in_the_loop",
    "/predictive_state_updates",
    "/shared_state",
    "/tool_based_generative_ui",
}


class StartupCompatibilityTests(unittest.TestCase):
    def test_dojo_imports_and_mounts_every_existing_demo(self) -> None:
        mounts = {
            route.path for route in dojo_app.routes if isinstance(route, Mount)
        }

        self.assertEqual(mounts, EXPECTED_DOJO_MOUNTS)

    def test_public_agent_and_team_interfaces_build_an_agent_os_app(self) -> None:
        member = Agent(id="startup-agent")
        team = Team(id="startup-team", members=[member])
        agent_os = AgentOS(
            agents=[member],
            teams=[team],
            interfaces=[
                AGUI(agent=member),
                AGUI(team=team, prefix="/team"),
            ],
        )

        paths = agent_os.get_app().openapi()["paths"]

        self.assertIn("post", paths["/agui"])
        self.assertIn("get", paths["/status"])
        self.assertIn("post", paths["/team/agui"])
        self.assertIn("get", paths["/team/status"])

    def test_reasoning_demo_uses_agno_reasoning_event_pipeline(self) -> None:
        self.assertIsNotNone(reasoning_agent.reasoning_model)

    def test_frontend_tool_demos_persist_runs_for_agno_resume(self) -> None:
        frontend_tool_agents = (
            agentic_chat_agent,
            agentic_generative_ui_agent,
            human_in_the_loop_agent,
            tool_based_generative_ui_agent,
        )

        for agent in frontend_tool_agents:
            with self.subTest(agent=agent.name):
                self.assertIsNotNone(agent.db)


if __name__ == "__main__":
    unittest.main()
