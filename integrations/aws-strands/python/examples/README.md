# AWS Strands Example Server

Demo FastAPI server that wires the Strands Agents SDK into the AG-UI protocol
with support for multiple model providers (OpenAI, Anthropic, Gemini). Each route
mounts a ready-made agent that showcases different UI patterns (vanilla chat,
backend tool rendering, shared state, and generative UI).

## Requirements

- Python 3.10 – 3.14 (the project is pinned to `<3.15`)
- Poetry 1.8+ (install with `curl -sSL https://install.python-poetry.org | python3 -`)
- An API key for your chosen model provider (see Environment Variables below)
- (Optional) AG-UI repo running locally so you can point the Dojo at these routes

## Quick start

```bash
cd integrations/aws-strands/python/examples

poetry install
```

Create a `.env` file in this folder (same dir as `pyproject.toml`) so every
example can load credentials automatically:

```bash
# Choose your provider: openai (default), anthropic, or gemini
MODEL_PROVIDER=openai

# Provider API keys (only the one for your chosen provider is required)
OPENAI_API_KEY=your-openai-key
ANTHROPIC_API_KEY=your-anthropic-key
GOOGLE_API_KEY=your-google-key

# Optional overrides
PORT=8000                 # FastAPI listen port

# Override the default model for your provider. Leave it commented out rather
# than blank with a trailing comment: python-dotenv reads `KEY=  # note` as the
# literal comment text, not as an empty value.
# MODEL_ID=

# Comma-separated browser origins to allow. Unset allows every origin; a value
# that names none refuses them all rather than widening.
# CORS_ALLOW_ORIGINS=https://app.example,https://admin.example
```

> Default models per provider: `gpt-5.4` (OpenAI), `claude-sonnet-4-6`
> (Anthropic), `gemini-2.5-flash` (Gemini). Set `MODEL_ID` to override.

## Running the demo server

Either command exposes all mounted apps on `http://localhost:${PORT:-8000}`:

```bash
poetry run dev          # uses the Poetry script entry point (server:main)
# or
poetry run python -m server
```

The root route lists the available demos:

| Route                       | Description                                                     |
| --------------------------- | --------------------------------------------------------------- |
| `/a2ui-dynamic-schema`      | A2UI surfaces composed on the fly                               |
| `/a2ui-fixed-schema`        | A2UI from fixed-layout backend tools                            |
| `/a2ui-recovery`            | A2UI validate-and-retry recovery loop                           |
| `/agentic-chat`             | Simple chat agent with a frontend-only `change_background` tool |
| `/agentic-chat-reasoning`   | Reasoning / thinking event streaming                            |
| `/agentic-chat-multimodal`  | Multimodal image / document analysis                            |
| `/backend-tool-rendering`   | Backend-executed tools (charts, faux weather) rendered in AG-UI |
| `/agentic-generative-ui`    | Demonstrates `PredictState` + delta streaming for plan tracking |
| `/shared-state`             | Recipe builder showing shared JSON state + tool arguments       |
| `/human-in-the-loop`        | Frontend proxy tool with halt-after-call                        |
| `/interrupt`                | Tool pauses to ask the user for a meeting time                  |
| `/predictive-state-updates` | Document editor driven by streaming tool args                   |
| `/tool-based-generative-ui` | Frontend-rendered tool (`generate_haiku`)                       |
| `/multi-agent`              | Strands graph of agents, streamed as steps                      |

Point the AG-UI Dojo (or any AG-UI client) at these SSE endpoints to see the
Strands wrapper translate provider events into protocol-native messages.

## Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `MODEL_PROVIDER` | No | Model provider: `openai` (default), `anthropic`, or `gemini` |
| `MODEL_ID` | No | Override the default model ID for the chosen provider |
| `OPENAI_API_KEY` | If using OpenAI | OpenAI API key |
| `ANTHROPIC_API_KEY` | If using Anthropic | Anthropic API key |
| `GOOGLE_API_KEY` | If using Gemini | Google Gemini API key |
| `PORT` | No | Listen port, default 8000. Plain decimal digits, no leading zero or sign, giving 1 to 65535. Anything else is refused at startup naming the variable and the value |
| `CORS_ALLOW_ORIGINS` | No | Comma-separated browser origins to allow, applied to the dojo app and to every mounted demo. Matched against the `Origin` header exactly; a trailing slash and letter case are repaired, nothing else is validated. Unset or blank allows every origin, the local-development default. A value that was written but names no usable origin refuses every cross-origin request rather than widening. Both cases are reported once at startup |

All OpenTelemetry exporters are disabled by default in code (`OTEL_SDK_DISABLED`
and `OTEL_PYTHON_DISABLED_INSTRUMENTATIONS`), so you do not need to set those
manually.

## How it works

- Each `server/api/*.py` file constructs a Strands `Agent`, or a `Graph` of them
  in the multi-agent demo, registers any tools, and wraps it with
  `ag_ui_strands.StrandsAgent`.
- `server/__init__.py` mounts every demo app listed in `server/settings.py`
  as its own sub-application and exposes the `main()` entrypoint that
  `poetry run dev` calls.
- `server/settings.py` holds the demo route table, the `PORT` contract, and the
  CORS allowlist that the dojo app and each mounted demo are both given.
- The project depends on `ag_ui_strands` via a path dependency (`..`) so you can
  develop the integration and server side-by-side without publishing a wheel.
- `server/model_factory.py` centralises model construction. Set `MODEL_PROVIDER`
  and optionally `MODEL_ID` to switch between OpenAI, Anthropic, and Gemini
  without editing any example file.
