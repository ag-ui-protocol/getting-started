# CrewAI Example Server

Demo FastAPI server that wires CrewAI into the AG-UI protocol. Each route mounts a
flow showcasing one dojo feature: chat, backend tool rendering, human in the loop,
shared state, predictive state updates, generative UI, interrupts, reasoning,
multimodal input, and the A2UI modes. The conversational variants of those flows are
mounted under `/conversational_flows/`.

This is a separate project from the published `ag-ui-crewai` library next door, and it
depends on that library by path, so the server always runs against the bridge in this
checkout rather than a release.

## How to run

```bash
cd integrations/crew-ai/python/examples
uv sync
uv run dev
```

The server listens on `PORT` if set, otherwise 8000. The dojo runner sets `PORT=8003`,
which is where the dojo UI expects to find CrewAI.

## Environment variables

- `OPENAI_API_KEY` for the flows that call an OpenAI model through litellm.
- `CREWAI_DISABLE_TELEMETRY` is set to `true` by the server before it starts, because
  crewai's telemetry chains a SIGINT handler that blocks on a network flush and stops
  Ctrl-C from shutting the server down. Set it explicitly to opt back in.
