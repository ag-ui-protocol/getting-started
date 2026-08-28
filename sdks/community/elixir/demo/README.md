# AG-UI Elixir Demo

Phoenix LiveView demo app that exercises the Elixir AG-UI SDK with a mock agent
endpoint that streams AG-UI events over SSE.

## Run the demo

```bash
mix setup
mix phx.server
```

Open the LiveView UI:

- http://localhost:4000/chat

## Mock agent endpoint

The demo exposes a simple SSE endpoint:

- `POST /agent`
- `GET /agent` (for quick manual testing)

Request body accepts:

- `scenario` (string)
- `threadId` (string, optional)
- `runId` (string, optional)

Example:

```bash
curl -N -H "content-type: application/json" \
  -d '{"scenario":"text_streaming"}' \
  http://localhost:4000/agent
```

## Scenarios

Scenarios are implemented in `AgUiDemo.Scenarios` and cover common flows:

- `text_streaming` (default)
- `tool_call`
- `chunks`
- `delayed`
- `error`

Use these to validate client behavior (normalization, reducer updates, and UI rendering).
