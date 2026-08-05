# Claude Managed Agents examples

A FastAPI server with one AG-UI endpoint per Dojo feature, each backed by a managed agent.

## Setup

```bash
cd integrations/claude-managed-agents/python/examples
uv sync
export ANTHROPIC_API_KEY=sk-ant-...   # or ANTHROPIC_AUTH_TOKEN
uv run python setup.py               # provisions an environment plus one agent per feature (idempotent)
uv run dev                           # http://localhost:8025
```

Setup writes the provisioned IDs to `.managed-agents.json` (gitignored). It reuses existing agents by name and does not modify them. To apply prompt changes from `agents.py`, archive the agent and re-run setup.

## Routes

| Route | Feature |
| --- | --- |
| `/agentic_chat` | Simple chat |
| `/backend_tool_rendering` | `get_weather` backend tool |
| `/human_in_the_loop` | Frontend `generate_task_steps` tool |
| `/tool_based_generative_ui` | Frontend `generate_haiku` tool |
