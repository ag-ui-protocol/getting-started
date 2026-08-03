"""Provision the environment and one managed agent per Dojo feature.

Idempotent: finds resources by name and only creates what is missing.
Writes the resulting IDs to examples/.managed-agents.json for the server.

Usage:
    ANTHROPIC_API_KEY=sk-ant-xxx uv run python setup.py
"""

import asyncio
import json
from pathlib import Path

from anthropic import AsyncAnthropic

from agents import ENVIRONMENT_NAME, FEATURE_AGENTS, MODEL

IDS_PATH = Path(__file__).parent / ".managed-agents.json"


async def ensure_environment(client: AsyncAnthropic) -> str:
    async for environment in client.beta.environments.list():
        if environment.name == ENVIRONMENT_NAME:
            return environment.id
    environment = await client.beta.environments.create(
        name=ENVIRONMENT_NAME,
        config={"type": "cloud", "networking": {"type": "unrestricted"}},
    )
    return environment.id


async def existing_agents_by_name(client: AsyncAnthropic) -> dict[str, str]:
    by_name: dict[str, str] = {}
    async for agent in client.beta.agents.list():
        by_name[agent.name] = agent.id
    return by_name


async def ensure_agent(
    client: AsyncAnthropic, existing: dict[str, str], name: str, system: str
) -> str:
    # Reuse by name. Existing agents are not modified: to apply prompt or model
    # changes from agents.py, archive the agent and re-run setup.
    found = existing.get(name)
    if found:
        return found
    agent = await client.beta.agents.create(
        name=name,
        model=MODEL,
        system=system,
        # The Dojo features drive tools from the frontend or the server, so the
        # agent's built-in toolset (bash, file editing, web) stays off.
        tools=[
            {"type": "agent_toolset_20260401", "default_config": {"enabled": False}}
        ],
    )
    return agent.id


async def main() -> None:
    client = AsyncAnthropic()
    environment_id = await ensure_environment(client)
    existing = await existing_agents_by_name(client)
    agents: dict[str, str] = {}
    for spec in FEATURE_AGENTS:
        agents[spec.feature] = await ensure_agent(
            client, existing, spec.agent_name, spec.system
        )
        print(f"  {spec.feature}: {agents[spec.feature]}")
    IDS_PATH.write_text(
        json.dumps({"environmentId": environment_id, "agents": agents}, indent=2) + "\n"
    )
    print(f"Environment: {environment_id}")
    print(f"Wrote {IDS_PATH}")


if __name__ == "__main__":
    asyncio.run(main())
