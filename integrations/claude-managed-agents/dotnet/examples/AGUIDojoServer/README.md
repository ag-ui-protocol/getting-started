# AG-UI example server (Claude Managed Agents, .NET)

An ASP.NET Core server exposing one AG-UI endpoint per route, each backed by a Claude Managed Agents session through `AGUI.ClaudeManagedAgents`. Every route is mapped with the library's `app.MapManagedAgentsAgent("/route", agent)` extension, the same call you use to add an agent to your own app.

| Route | Feature |
| --- | --- |
| `POST /agentic_chat` | Plain chat. |
| `POST /backend_tool_rendering` | The server-executed `get_weather` tool. |
| `POST /human_in_the_loop` | A frontend tool (`generate_task_steps`) that parks the run. |
| `POST /tool_based_generative_ui` | A frontend tool (`generate_haiku`) rendered by the UI. |
| `GET /health` | Lists the routes being served. |

## Setup

Provision the environment and agents once. The command is idempotent: it finds resources by name and creates only what is missing.

```bash
cd integrations/claude-managed-agents/dotnet/examples/AGUIDojoServer
export ANTHROPIC_API_KEY=sk-ant-...   # or ANTHROPIC_AUTH_TOKEN
dotnet run -- setup
```

Setup creates the `ag-ui-dojo` environment (cloud, unrestricted networking) and four agents on `claude-sonnet-5` (override with `MANAGED_AGENTS_MODEL`) with the built-in toolset disabled, then writes the IDs to `.managed-agents.json` next to the built assembly (under `bin/`, gitignored). Setup and the server both resolve the file against the assembly location, so they agree wherever you run them from. Point both at another file with `MANAGED_AGENTS_IDS_PATH`. Existing agents are reused by name and not modified: to apply prompt changes from `AgentSpecs.cs`, archive the agent and re-run setup.

## Run

```bash
dotnet run                                    # http://0.0.0.0:8026
dotnet run --urls http://0.0.0.0:9000         # another port
```

If `.managed-agents.json` is missing (or has no `environmentId`), the server starts with a warning and serves no agent routes.

## Docker

Build from the repository root so the project can resolve the ag-ui .NET SDK it references, then run with the API key in the environment. The container provisions the agents on start (idempotent), then listens on `$PORT` (default 10000).

```bash
docker build -f integrations/claude-managed-agents/dotnet/examples/AGUIDojoServer/Dockerfile -t agui-cma-dojo .
docker run --rm -e ANTHROPIC_API_KEY=sk-ant-... -e PORT=8026 -p 8026:8026 agui-cma-dojo
```

## Security

This example is for local development. It binds `0.0.0.0`, has no authentication, and drives managed sessions with the server's own API key. Any client that can reach it can use those sessions, so keep it on `localhost` or behind your own auth. Every request is treated as the same single user, and thread IDs are not partitioned per caller.
