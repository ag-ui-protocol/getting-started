# Agno AG-UI Dojo server

This project serves the Agno examples used by the AG-UI Dojo, including chat,
reasoning, multimodal input, human-in-the-loop tools, shared state, predictive
state, and generative UI.

## Prerequisites

- Python 3.12 through 3.x
- [uv](https://docs.astral.sh/uv/)
- `OPENAI_API_KEY` for the OpenAI examples
- `GOOGLE_API_KEY` for the Gemini multimodal example

## Install and run

Install exactly the versions in the committed lockfile:

```bash
uv sync --frozen
```

Start the server:

```bash
uv run --frozen dev
```

The server listens on `http://localhost:9001` by default. Set `PORT` to use a
different port.

## Test

```bash
uv run --frozen python -m unittest discover -s tests
```

The startup regression imports every existing Dojo route and also builds AGUI
interfaces for both an Agent and a Team.

## Upgrading a durable database

Agno 3 moves persisted runs into a separate table and adds user-isolation
fields. Existing Agno 2 databases must be migrated before the upgraded server
receives traffic. Follow [Migrating a durable database to Agno 3](MIGRATING_TO_AGNO_3.md).
