# Swarms AG-UI example server

A minimal FastAPI server that exposes a [Swarms](https://github.com/kyegomez/swarms)
agent over the AG-UI protocol. This is the example the AG-UI dojo runs for the
Swarms integration.

## Run

```bash
uv sync
uv run dev
```

The server binds to `0.0.0.0` and the `PORT` environment variable (default
`8023`), and serves the Agentic Chat feature at `POST /agentic_chat/agui`.

Set `HOST` to override the bind address and `OPENAI_CHAT_MODEL_ID` (plus your
provider credentials, e.g. `OPENAI_API_KEY`) to choose the model.
