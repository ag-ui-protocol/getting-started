# Google Antigravity Examples

A FastAPI server exposing one Antigravity agent per dojo feature, used by
[`apps/dojo`](../../../../apps/dojo). The integration itself lives in
[`../`](../).

## Setup

Install dependencies:

```bash
uv sync
```

Then run against **Gemini** (the SDK's native path):

```bash
export GEMINI_API_KEY=...
uv run dev
```

…or against **hosted OpenAI**, via the auth-injecting shim in this package:

```bash
export OPENAI_API_KEY=...
export ANTIGRAVITY_USE_OPENAI=1
uv run dev
```

The SDK's OpenAI-compatible path targets unauthenticated local servers and has
no API-key field, so `openai_proxy.py` injects the `Authorization` header and
normalizes the Gemini-shaped tool schemas OpenAI rejects. Point `base_url` at
Ollama or LM Studio and you need neither.

The server listens on `PORT` (default **8027**), which is what the dojo expects
as `ANTIGRAVITY_URL`.

## Endpoints

| Endpoint | Demonstrates |
|---|---|
| `/agentic_chat` | Streaming chat plus frontend tools the client executes |
| `/human_in_the_loop` | An AG-UI interrupt answered on a later run |
| `/tool_based_generative_ui` | A tool call rendered as UI (haiku generator) |
| `/backend_tool_rendering` | A server-side `get_weather` tool, streamed to the client |
| `/{agent}/info` | Advertised capabilities for one agent |
| `/docs` | FastAPI's generated API docs |

## Notes

- **The agent runs real code.** Antigravity drives a Go subprocess with genuine
  filesystem and shell access, so every demo is scoped to a scratch workspace
  (`ANTIGRAVITY_WORKSPACE`, default `$TMPDIR/ag-ui-antigravity`) rather than the
  server's working directory.
- **One harness process, not one per demo.** All four agents share a
  `HarnessPool` and a `save_dir` — see `api/_common.py`, and
  [Harness pooling](../README.md#harness-pooling) for why both are needed.
- **`get_weather` calls open-meteo**, which needs no API key but does need the
  network. Set `AG_UI_MOCK_WEATHER=1` for deterministic offline data; a failed
  lookup falls back to it automatically.
- **Chat-only demos disable the built-in toolset.** `search_web` returns an
  empty summary without Google credentials and the model then retries it
  forever, so the demos allowlist only what they need.
