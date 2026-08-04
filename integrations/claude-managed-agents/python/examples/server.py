"""Dojo example server: one AG-UI endpoint per feature, each backed by a
managed agent. Provision the agents first with `uv run python setup.py`.

Usage:
    ANTHROPIC_API_KEY=sk-ant-xxx uv run dev
"""

import json
import os
from typing import Any

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from ag_ui_claude_managed_agents import (
    BackendTool,
    ManagedAgentsAgent,
    add_managed_agents_fastapi_endpoint,
)

from agents import FEATURE_AGENTS
from setup import IDS_PATH


def load_ids() -> dict[str, Any] | None:
    try:
        return json.loads(IDS_PATH.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        print(
            f"No provisioned agents ({IDS_PATH} missing); run `uv run python setup.py`. Serving no routes."
        )
        return None


def get_weather(tool_input: Any) -> str:
    location = (
        tool_input.get("location", "somewhere")
        if isinstance(tool_input, dict)
        else "somewhere"
    )
    return json.dumps(
        {
            "location": location,
            "temperature": 21,
            "conditions": "sunny",
            "humidity": 48,
            "windSpeed": 12,
        }
    )


GET_WEATHER = BackendTool(
    name="get_weather",
    description="Get the current weather for a location.",
    parameters={
        "type": "object",
        "properties": {"location": {"type": "string", "description": "City name"}},
        "required": ["location"],
    },
    handler=get_weather,
)

BACKEND_TOOLS: dict[str, list[BackendTool]] = {
    "backend_tool_rendering": [GET_WEATHER],
}


def build_agents() -> dict[str, ManagedAgentsAgent]:
    ids = load_ids()
    agents: dict[str, ManagedAgentsAgent] = {}
    if not ids:
        return agents
    environment_id = ids["environmentId"]
    agent_ids: dict[str, str] = ids.get("agents", {})
    for spec in FEATURE_AGENTS:
        agent_id = agent_ids.get(spec.feature)
        if not agent_id:
            print(f"No agent provisioned for {spec.feature}; skipping. Re-run setup.")
            continue
        agents[spec.feature] = ManagedAgentsAgent(
            managed_agent_id=agent_id,
            environment_id=environment_id,
            backend_tools=BACKEND_TOOLS.get(spec.feature),
        )
    return agents


app = FastAPI(title="Claude Managed Agents Server")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

agents = build_agents()
for name, agent in agents.items():
    add_managed_agents_fastapi_endpoint(app=app, agent=agent, path=f"/{name}")


@app.get("/health")
async def health():
    return {"status": "healthy", "agents": list(agents)}


def main() -> None:
    if not os.getenv("ANTHROPIC_API_KEY") and not os.getenv("ANTHROPIC_AUTH_TOKEN"):
        print("Error: set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN)")
        raise SystemExit(1)
    port = int(os.getenv("PORT", "8025"))
    print(f"Claude Managed Agents server running on http://localhost:{port}")
    for name in agents:
        print(f"  POST http://localhost:{port}/{name}")
    print(f"  GET  http://localhost:{port}/health")
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")


if __name__ == "__main__":
    main()
