# AG-UI × Swarms

Expose any [Swarms](https://github.com/kyegomez/swarms) agent as an
[AG-UI](https://github.com/ag-ui-protocol/ag-ui)-compatible SSE endpoint with a
single function call.

## Installation

```bash
pip install ag-ui-swarms
```

## Quick start

```python
from fastapi import FastAPI
from swarms import Agent
from swarms_agui import add_swarms_fastapi_endpoint

agent = Agent(
    agent_name="Assistant",
    system_prompt="You are a helpful assistant.",
    model_name="gpt-4o",
)

app = FastAPI()
add_swarms_fastapi_endpoint(app, agent, path="/")
```

Run it:

```bash
uvicorn main:app --reload
```

Your agent is now available at `POST /` and streams AG-UI SSE events that any
AG-UI-compatible frontend can consume.

## How it works

`add_swarms_fastapi_endpoint` registers a POST route on your FastAPI app.
On each request it:

1. Emits `RUN_STARTED`
2. Replays the AG-UI conversation history into the agent and runs
   `agent.run(task)`, where `task` is the latest user message. The call is
   blocking, so it is offloaded to a worker thread (`asyncio.to_thread`) to keep
   the event loop responsive.
3. Emits `TEXT_MESSAGE_START`
4. Emits `TEXT_MESSAGE_CONTENT` for each token as the agent streams it
5. Emits `TEXT_MESSAGE_END`
6. Emits `MESSAGES_SNAPSHOT` with the updated message list
7. Emits `RUN_FINISHED`

If `agent.run` raises, a `RUN_ERROR` event is emitted instead. The message is
only opened on the first token, so an error before any output never leaves an
unterminated message on the wire.

## Streaming

If the agent is created with `streaming_on=True`, the adapter bridges Swarms'
`streaming_callback` into incremental `TEXT_MESSAGE_CONTENT` events, so tokens
appear in the UI as they are generated. If streaming is disabled (the default),
the full response is emitted as a single `TEXT_MESSAGE_CONTENT` event instead —
no configuration change is required either way. The example server enables
streaming.

## Conversation history

The adapter forwards the **full conversation** to the agent, so it has
multi-turn context. Because the AG-UI client sends the complete message list on
every request, the endpoint is kept stateless: before each run the agent's
short-term memory is reset to the state it had when the endpoint was registered
(its system prompt and any construction-time seeding) and the incoming messages
are replayed into it. The latest user message becomes the task for `agent.run`;
everything before it is restored as prior context. This keeps the client as the
source of truth for history and prevents turns from leaking between threads on a
shared agent instance. Concurrent requests to the same agent are serialized,
since a single agent instance has a single mutable memory.

## Running the tests

```bash
pip install -e ".[dev]"
pytest tests/
```
