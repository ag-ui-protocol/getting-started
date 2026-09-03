# ag_ui_watsonx

Python AG-UI adapter for IBM watsonx orchestrate agents.

## Installation

```bash
pip install ag_ui_watsonx
```

## Quick Start

```python
from ag_ui_watsonx import WatsonxAgent, create_watsonx_app

agent = WatsonxAgent(
    region="au-syd",
    instance_id="your-instance-id",
    agent_id="your-watsonx-agent-id",
    api_key="YOUR_API_KEY",
)

app = create_watsonx_app(agent)
```

Run with:

```bash
uvicorn main:app --port 8000
```

## Conversation Continuity

watsonx orchestrate stores conversation history server-side, keyed by a
`thread_id` it issues in the SSE stream. The adapter captures that ID, maps it
to the AG-UI `thread_id`, and sends it back as the `X-IBM-THREAD-ID` header on
subsequent turns (the header is omitted on the first turn so watsonx creates
the thread).

The mapping lives in an in-memory store by default, which works as long as the
`WatsonxAgent` instance outlives the conversation. When agent instances are
created per-request, pass a custom store (any object with `get(thread_id)` and
`set(thread_id, watsonx_thread_id)`, sync or async):

```python
agent = WatsonxAgent(
    region="au-syd",
    instance_id="your-instance-id",
    agent_id="your-watsonx-agent-id",
    api_key="YOUR_API_KEY",
    thread_id_store=MyDatabaseThreadIdStore(),
)
```
