Open Agent Spec <> AG‑UI (Python)
=================================

Agent runner that emits AG‑UI events and a small FastAPI/uvicorn server to stream them to Dojo via SSE.

What this is
- Agent runner: `ag_ui_agentspec/agent.py` executes an Agent Spec configuration on a chosen runtime and bridges spans to AG‑UI events.
- Server wiring: `ag_ui_agentspec/endpoint.py` exposes a POST SSE endpoint that streams those events to the Dojo frontend.

Supported agent runtimes and Dojo features
- Wayflow (Oracle's reference agent framework)  (chat, frontend tools, backend tools)
- LangGraph (chat, frontend tools, backend tools, tool call streaming)

## Install

Base library plus optional extras so you can choose runtimes. Routers are lazy-loaded; if you don't install a runtime, its routes will not work.

Before installation, please clone the following GitHub repositories:
- [AG-UI](https://github.com/ag-ui-protocol/ag-ui) and `cd ag-ui/integrations/agent-spec/python`
- [Agent Spec](https://github.com/oracle/agent-spec)
- [WayFlow](https://github.com/oracle/wayflow)
- Please put these 3 repos in the same directory.


```bash
# Wayflow only
uv pip install -e .[wayflow]

# LangGraph only
uv pip install -e .[langgraph]

# Multiple
uv pip install -e .[wayflow,langgraph]
```

Run the example server
```bash
cd ag-ui/integrations/agent-spec/python/examples
uv sync --extra langgraph --extra wayflow && uv run dev   # both runtimes; serves http://localhost:9003
# or pick one runtime:
# uv sync --extra langgraph && uv run dev
# uv sync --extra wayflow && uv run dev
# then run Dojo (in a separate terminal):
# Option A — run everything from repo root (multiple apps):
#   pnpm dev
# Option B — run only Dojo:
#   cd ag-ui/apps/dojo
#   AGENT_SPEC_URL=http://localhost:9003 pnpm dev (make sure to run pnpm build first)
```

Environment
- OpenAI-compatible variables commonly used by the examples (pick your provider):
  - `OPENAI_BASE_URL` (or provider-specific: `OSS_API_URL`, `LLAMA_API_URL`, etc.)
  - `OPENAI_MODEL`  (the model slug, defaults to `gpt-4o` available through OpenAI API)
  - `OPENAI_API_KEY`
- Dojo server URL:
  - `AGENT_SPEC_URL=http://localhost:9003` when running the local example server
