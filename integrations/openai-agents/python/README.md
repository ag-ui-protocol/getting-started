# AG-UI × OpenAI Agents SDK

Connect an [OpenAI Agents SDK](https://openai.github.io/openai-agents-python/)
agent to any [AG-UI](https://github.com/ag-ui-protocol/ag-ui) client. The package
translates AG-UI requests into OpenAI Agents SDK input and translates the OpenAI Agents SDK's
stream back into ordered AG-UI events.

You keep your existing OpenAI agent, tools, handoffs, guardrails, model settings,
and server architecture. This integration owns only the protocol boundary.

```text
AG-UI RunAgentInput
        │
        ▼
AGUITranslator.to_openai()
        │  OpenAI Agents SDK messages, client-tool proxies, request metadata
        ▼
Runner.run_streamed(...)
        │  OpenAI Agents SDK stream
        ▼
AGUITranslator.to_agui()
        │
        ▼
AG-UI lifecycle, text, tool, reasoning, step, state, and snapshot events
```

## Requirements

- Python 3.10 or newer
- `ag-ui-protocol >= 0.1.19`
- `openai-agents >= 0.8.4`
- An `OPENAI_API_KEY` for live OpenAI runs

## Installation

With [uv](https://docs.astral.sh/uv/):

```bash
uv add ag-ui-openai-agents
```

Or with pip:

```bash
pip install ag-ui-openai-agents
```

## Configuration

Set the OpenAI API key in the environment where your server runs:

```bash
export OPENAI_API_KEY="sk-..."
```

`AGUITranslator` does not read environment variables or change OpenAI Agents
SDK settings. With the recommended translator integration, your application
owns the OpenAI Agents SDK runner and its tracing configuration.

If you use the `OpenAIAgentsAgent` wrapper or
`add_openai_agents_fastapi_endpoint`, you can optionally set
`OPENAI_AGENTS_DISABLE_TRACING=true` to disable OpenAI Agents SDK tracing. It
controls tracing only; it does not override the agent, model, or `RunConfig`.

| OpenAI Agents SDK variable | Required | Purpose |
|---|---:|---|
| `OPENAI_API_KEY` | For the default OpenAI provider | Authenticates OpenAI requests. A custom provider may use different credentials. |
| `OPENAI_AGENTS_DISABLE_TRACING` | No | Optional when using the wrapper; set to `true` to disable OpenAI Agents SDK tracing. |

Model selection, retries, and other run behavior remain OpenAI Agents SDK
settings. Pass a model to `Agent(...)` and, when needed, pass a `RunConfig` to
`OpenAIAgentsAgent` or `Runner.run_streamed(...)`.

The bundled example server additionally reads:

| Variable | Required | Purpose |
|---|---:|---|
| `OPENAI_DEFAULT_MODEL` | No | Overrides the model used by all examples. |
| `HOST` | No | Example server bind address; defaults to `0.0.0.0`. |
| `PORT` | No | Example server port; defaults to `8027`. |

Keep secrets in your deployment secret manager or an uncommitted `.env` file.

## Choose an integration level

| Need | Use |
|---|---|
| Existing agent and custom server logic | `AGUITranslator` (recommended) |
| Fixed agent with less orchestration code | `OpenAIAgentsAgent` |
| Ready-made FastAPI SSE route | `OpenAIAgentsAgent` + `add_openai_agents_fastapi_endpoint` |
| Change one message or event mapping | Custom inbound/outbound engine subclass |

Start with `AGUITranslator`. It leaves the OpenAI run and HTTP transport under
your control. Use the wrapper only when its standard behavior fits your server.

## Quick start: use the translator (recommended)

This is the same small architecture used by the `ag_ui_docs_copilot` example:
the agent owns its instructions and tools, while the endpoint only translates
the request, runs the OpenAI Agents SDK, and encodes the AG-UI stream. It accepts an AG-UI
request, runs a normal streaming OpenAI agent, and returns Server-Sent Events
(SSE).

```python
from agents import Agent, Runner
from ag_ui.core import RunAgentInput
from ag_ui.encoder import EventEncoder
from ag_ui_openai_agents import AGUITranslator
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse

app = FastAPI(title="AG-UI Docs Copilot")

copilot_agent = Agent(
    name="AG-UI Docs Copilot",
    instructions="Answer AG-UI developer questions clearly and concisely.",
)
translator = AGUITranslator()  # Reusable across requests.


@app.post("/")
async def run_ag_ui_docs_copilot(
    body: RunAgentInput, request: Request
) -> StreamingResponse:
    encoder = EventEncoder(accept=request.headers.get("accept"))

    async def stream():
        translated = translator.to_openai(body)

        result = Runner.run_streamed(
            copilot_agent,
            input=translated.messages,
            context=translated.context,
        )

        async for event in translator.to_agui(result, body):
            yield encoder.encode(event)

    return StreamingResponse(stream(), media_type=encoder.get_content_type())
```

The complete implementation adds the two documentation lookup tools to
`copilot_agent`; each tool reads one README section on demand. The full agent
and its endpoint are in
[`examples/agents_examples/ag_ui_docs_copilot.py`](examples/agents_examples/ag_ui_docs_copilot.py).
That file is intentionally linear: `RunAgentInput → to_openai →
Runner.run_streamed → to_agui → EventEncoder`.

Run the app, then send an AG-UI request:

```bash
curl -N -X POST http://localhost:8000/ \
  -H 'Content-Type: application/json' \
  -d '{
    "thread_id": "thread-1",
    "run_id": "run-1",
    "messages": [
      {"id": "user-1", "role": "user", "content": "Say hello in one sentence."}
    ],
    "tools": [],
    "state": {},
    "context": [],
    "forwarded_props": null
  }'
```

A text-only run normally produces:

```text
RUN_STARTED
TEXT_MESSAGE_START
TEXT_MESSAGE_CONTENT ...
TEXT_MESSAGE_END
MESSAGES_SNAPSHOT
RUN_FINISHED
```

## Quick start: use the FastAPI shortcut

`OpenAIAgentsAgent` performs the same `to_openai → run_streamed → to_agui`
flow. The endpoint helper adds an AG-UI POST route, SSE encoding, content
negotiation, and a health route.

```python
from agents import Agent
from ag_ui_openai_agents import (
    OpenAIAgentsAgent,
    add_openai_agents_fastapi_endpoint,
)
from fastapi import FastAPI

app = FastAPI()

agent = OpenAIAgentsAgent(
    Agent(name="assistant", instructions="Be helpful and concise."),
)

add_openai_agents_fastapi_endpoint(app, agent, "/agent")
```

This registers:

- `POST /agent` — accepts `RunAgentInput` and streams encoded AG-UI events.
- `GET /agent/health` — returns the wrapped agent's name and health status.

Pass `include_health=False` if your application already owns health checks.
The helper adds routes; it does not start a server, store sessions, or manage
authentication.

## Public API

```python
from ag_ui_openai_agents import (
    AGUITranslator,
    OpenAIAgentsAgent,
    TranslatedInput,
    add_openai_agents_fastapi_endpoint,
)
```

### `AGUITranslator`

The main, stateless public API. One instance can serve concurrent requests.

```python
translator = AGUITranslator()
```

#### `to_openai(run_input)`

Converts one `RunAgentInput` into `TranslatedInput`:

| Field | Behavior |
|---|---|
| `messages` | Converted to the OpenAI Agents SDK's input format. |
| `tools` | Converted to request-scoped OpenAI Agents SDK `FunctionTool` proxies. |
| `thread_id`, `run_id`, `parent_run_id` | Preserved unchanged. |
| `state`, `context`, `forwarded_props`, `resume` | Preserved for application orchestration. |

`to_openai` does not run the agent. It also does not automatically put `state`,
`context`, or `forwarded_props` into the model prompt.

#### `to_agui(events, run_input, ...)`

Accepts either the OpenAI Agents SDK's `RunResultStreaming` or its `stream_events()` async
iterator and yields AG-UI `BaseEvent` objects.

```python
async for event in translator.to_agui(result, run_input):
    ...
```

| Option | Default | Purpose |
|---|---:|---|
| `start_custom_event` | `None` | Emit a `CustomEvent` after `RUN_STARTED`. |
| `initial_state` | `None` | Emit an initial `STATE_SNAPSHOT`. |
| `final_state` | `None` | Emit a final `STATE_SNAPSHOT` after streaming. |
| `emit_messages_snapshot` | `True` | Emit the complete message history before finishing. |
| `end_custom_event` | `None` | Emit a `CustomEvent` immediately before `RUN_FINISHED`. |
| `emit_run_error` | `True` | Emit `RUN_ERROR` before re-raising ordinary errors. |
| `run_error_message` | `None` | Replace exception text with a client-safe message. |

State sources and custom-event values may be static values, zero-argument
functions, or zero-argument async functions. They are resolved at their
documented lifecycle position. `None` skips a state snapshot; `{}` emits one.

### `OpenAIAgentsAgent`

A convenience wrapper around a fixed OpenAI Agents SDK `Agent`:

```python
wrapped = OpenAIAgentsAgent(
    agent,
    name="public-name",
    description="Optional description",
    run_config=run_config,
    initial_state=lambda: load_state(),
    final_state=lambda: load_state(),
    run_error_message="Agent run failed",
)

async for event in wrapped.run_streamed(run_input):
    ...
```

The wrapper:

- translates the request;
- adds non-conflicting client tools to a per-request agent clone;
- passes `translated.context` to `Runner.run_streamed(context=...)`;
- runs the OpenAI Agents SDK in streaming mode;
- translates the result and emits lifecycle/snapshot events.

The wrapper exposes the same lifecycle controls as `AGUITranslator.to_agui()`:

| Option | Purpose |
|---|---|
| `start_custom_event` | Emit a custom event after `RUN_STARTED`. |
| `initial_state` | Emit the initial `STATE_SNAPSHOT`. |
| `final_state` | Emit the final `STATE_SNAPSHOT`. |
| `emit_messages_snapshot` | Enable or disable `MESSAGES_SNAPSHOT`. |
| `end_custom_event` | Emit a custom event before `RUN_FINISHED`. |
| `emit_run_error` | Enable or disable `RUN_ERROR`. |
| `run_error_message` | Set the client-visible `RUN_ERROR.message`. |

It does not expose the `RunResultStreaming` object. Use the translator directly
when a custom event must inspect the run result, or when you need custom
orchestration.

The shared agent is never mutated. If a client tool has the same name as a
server tool, the server tool wins and the client tool is ignored with a warning.

Use `AGUITranslator` directly when you need the `RunResultStreaming`, custom
branching, resume logic, a different transport, or per-request OpenAI Agents SDK options.

### `add_openai_agents_fastapi_endpoint`

```python
add_openai_agents_fastapi_endpoint(
    app,
    wrapped_agent,
    path="/agent",
    include_health=True,
)
```

The helper respects the request's `Accept` header through AG-UI's
`EventEncoder` and returns the matching streaming content type.

## What happens during a run

1. `to_openai` translates message history and client-declared tools.
2. Your code—or `OpenAIAgentsAgent`—starts `Runner.run_streamed`.
3. A fresh outbound engine is created for that run.
4. `RUN_STARTED` is emitted using the request's IDs.
5. OpenAI Agents SDK events are correlated into AG-UI text, reasoning, tool, and step windows.
6. Any open windows are closed when the OpenAI Agents SDK stream ends.
7. Optional final state and the default `MESSAGES_SNAPSHOT` are emitted.
8. The run ends with `RUN_FINISHED`, or `RUN_ERROR` for an ordinary failure.

Successful lifecycle order:

```text
RUN_STARTED
start_custom_event                 optional
STATE_SNAPSHOT                     optional initial state
... STEP / REASONING / TEXT / TOOL events ...
STATE_SNAPSHOT                     optional final state
MESSAGES_SNAPSHOT                  enabled by default
end_custom_event                   optional
RUN_FINISHED
```

On an ordinary error, open event windows are closed, `RUN_ERROR` is emitted
when enabled, and the original exception is re-raised for server logging.
Final state, messages snapshot, end custom event, and `RUN_FINISHED` are not
emitted on the error path.

The client-visible error text is configurable with `run_error_message`:

```python
async for event in translator.to_agui(
    result,
    run_input,
    run_error_message="The agent could not complete this request.",
):
    yield encoder.encode(event)
```

This changes `RUN_ERROR.message` only. The original exception is still raised
after the event so the server can log the detailed failure. Use
`run_error_message` in production to keep internal exception details out of the
client response while preserving the original exception for server logs.

If a consumer stops reading early and passed a `RunResultStreaming`, the
  translator cancels that owned OpenAI Agents SDK run. If the caller passes only a bare async
iterator, cancellation remains the caller's responsibility.

## Feature support

| Feature | Support | Notes |
|---|---:|---|
| Streaming assistant text and refusals | Yes | Emits one ordered text window per OpenAI Agents SDK message item. |
| Backend function tools | Yes | Tool call arguments and results are streamed. |
| Hosted tools | Yes | OpenAI Agents SDK hosted tools are surfaced as tool calls; some do not expose streamed arguments. |
| Frontend/client-owned tools | Yes | Request tools become OpenAI Agents SDK `FunctionTool` proxies and complete in a later AG-UI request. |
| Handoffs | Yes | Handoff calls/results map to tools; agent changes map to steps. |
| Agents as tools | Yes | Nested specialist calls appear as ordinary tool calls/results. |
| Reasoning | Yes | Summary/text streams; encrypted content supports replay. |
| Guardrails | Yes | OpenAI Agents SDK tripwire exceptions surface through `RUN_ERROR`. |
| State snapshots | Yes | Application supplies initial/final state sources. |
| Messages snapshot | Yes | Enabled by default with stable streamed IDs. |
| Custom lifecycle events | Yes | Start/end `CustomEvent` hooks. |
| Multimodal input | Partial | Text, images, documents, and some audio; see below. |
| Multimodal output | No | AG-UI currently has no matching image/audio output event. |
| Backend approval | Example | Requires application-owned `RunState` persistence and resume logic. |
| MCP approval request | Yes | Emitted as `CUSTOM` named `mcp_approval_request`. |

## Message mapping: AG-UI → OpenAI

`to_openai` keeps message order. One AG-UI message may produce multiple OpenAI Agents SDK
items, especially an assistant message containing tool calls.

| AG-UI input | OpenAI Agents SDK input | ID behavior |
|---|---|---|
| `SystemMessage` | `message`, role `system` | AG-UI message ID is not sent. |
| `DeveloperMessage` | `message`, role `developer` | AG-UI message ID is not sent. |
| `UserMessage` | `message`, role `user`, with translated content parts | AG-UI message ID is not sent. |
| `AssistantMessage.content` | Assistant input message | AG-UI message ID is not sent; empty text is omitted. |
| `AssistantMessage.tool_calls[]` | One `function_call` per tool call | `ToolCall.id → call_id` unchanged. |
| `ToolMessage` | `function_call_output` | `tool_call_id → call_id` unchanged. |
| `ReasoningMessage` | `reasoning` item | `message.id → reasoning.id`; emitted only with `encrypted_value`. |
| `ActivityMessage` | Not mapped | Dropped with a debug log. |
| `RunAgentInput.tools[]` | OpenAI Agents SDK `FunctionTool` proxies | Tool name and JSON Schema are preserved. |

The Responses input format has no `tool` role. Tool history is represented by
`function_call` and `function_call_output` items joined by the same `call_id`.

Unknown message types are skipped rather than failing the entire request.

## Event mapping: OpenAI → AG-UI

| OpenAI Agents SDK source | AG-UI output |
|---|---|
| Message item plus text/refusal deltas | `TEXT_MESSAGE_START → TEXT_MESSAGE_CONTENT* → TEXT_MESSAGE_END` |
| Function, hosted-tool, or handoff call | `TOOL_CALL_START → TOOL_CALL_ARGS* → TOOL_CALL_END` |
| Function/handoff output | `TOOL_CALL_RESULT` |
| Reasoning summary/text | `REASONING_START → REASONING_MESSAGE_START → REASONING_MESSAGE_CONTENT* → REASONING_MESSAGE_END → REASONING_END` |
| Reasoning encrypted content | `REASONING_ENCRYPTED_VALUE` |
| Agent update/handoff target | `STEP_FINISHED` for the previous agent, then `STEP_STARTED` |
| MCP approval request | `CUSTOM` with name `mcp_approval_request` |
| MCP tool listing/approval response | Not emitted; server bookkeeping only. |
| Run start/success/failure | `RUN_STARTED`, `RUN_FINISHED`, or `RUN_ERROR` |

`response.output_text.done` closes one text part, not necessarily the complete
message item. The translator therefore closes a text window on the item-level
done event, the completed run item, or finalization. This keeps multi-part text
under one AG-UI message ID.

## ID mapping and guarantees

| Source | AG-UI ID |
|---|---|
| OpenAI Agents SDK message item `id` | `message_id` |
| Function/hosted tool `call_id` | `tool_call_id` |
| Hosted tool without `call_id` | Item `id`, then generated `call_...` fallback |
| Tool result `call_id` | `tool_call_id`; result `message_id` is `<call_id>-result` |
| Reasoning item `id` | Reasoning phase `message_id` |
| Additional reasoning parts | `<phase_id>-1`, `<phase_id>-2`, ... |
| AG-UI request `thread_id` / `run_id` | Same lifecycle event fields, unchanged |

Rules:

- A real OpenAI Agents SDK ID always wins.
- If the OpenAI Agents SDK omits an ID or uses its placeholder ID, the integration generates
  a stable ID for that item (`msg_...`, `call_...`, or `rs_...`).
- One resolved ID is reused for every start/content/end event in that window.
- The same IDs are reused in `MESSAGES_SNAPSHOT`, preventing duplicate client
  messages when streamed output is reconciled with final history.
- Existing input history keeps its original AG-UI IDs in the snapshot.
- Reasoning is intentionally excluded from `MESSAGES_SNAPSHOT`; encrypted
  reasoning is carried by `REASONING_ENCRYPTED_VALUE` instead.
- Internal output-index correlation keys never appear on AG-UI events.

## Messages and state snapshots

`MESSAGES_SNAPSHOT` is emitted before `RUN_FINISHED` by default. It contains:

1. the original `RunAgentInput.messages` with their existing IDs; and
2. assistant messages, tool calls, and tool results produced during this run,
   using the same IDs already streamed to the client.

Disable it only when your application emits its own authoritative history:

```python
async for event in translator.to_agui(
    result,
    run_input,
    emit_messages_snapshot=False,
):
    ...
```

State remains application-owned. Supply snapshots explicitly:

```python
state = dict(run_input.state or {})
initial_state = dict(state)

result = Runner.run_streamed(
    agent,
    input=translated.messages,
    context=state,
)

async for event in translator.to_agui(
    result,
    run_input,
    initial_state=initial_state,
    final_state=lambda: dict(state),
):
    ...
```

The final factory runs after streaming, so it can observe changes made by tools
or hooks.

## Context and forwarded properties

`state`, `context`, `forwarded_props`, and `resume` pass through on
`TranslatedInput`; their meaning remains application-specific.

Be aware of two uses of “context”:

- `RunAgentInput.context` is the AG-UI list sent by the client.
- `Runner.run_streamed(context=...)` is the OpenAI Agents SDK dependency object
  available through `RunContextWrapper`.

The convenience wrapper passes the AG-UI context list into the OpenAI Agents SDK context
slot. This enables dynamic instructions or tools to read the list, as shown by
the `dynamic_system_prompt` example. With the direct translator, you may pass
that list, transform it into prompt text, or replace it with your own dependency
object.

The inbound engine's `translate_context()` method renders AG-UI context as
`description: value` lines when you want to add it to instructions.

## Tools and human-in-the-loop

### Backend tools

Normal OpenAI Agents SDK `@function_tool` tools stay on the server. Their calls and results
become AG-UI tool events without special integration code.

### Frontend-owned tools

Tools declared in `RunAgentInput.tools` belong to the client. `to_openai`
creates OpenAI Agents SDK `FunctionTool` proxies so the model can call them, but the frontend
must execute them.

Recommended flow:

1. Merge translated client tools onto a per-request agent clone.
2. Configure OpenAI Agents SDK `StopAtTools` for those names when the run should stop as soon
   as the model calls one.
3. Render/execute the tool in the client.
4. Send its result as a `ToolMessage` in the next AG-UI request.
5. `to_openai` converts that result to `function_call_output`, preserving the
   `call_id`, and the agent continues from the conversation history.

```python
from agents import Agent, StopAtTools

agent = Agent(
    name="planner",
    instructions="Use generate_steps when asked to make a plan.",
    tool_use_behavior=StopAtTools(stop_at_tool_names=["generate_steps"]),
)
```

This pattern covers frontend tool rendering, tool-based generative UI, and
client-owned human approval.

### Backend tool approval

OpenAI Agents SDK tools marked `needs_approval=True` are different: real backend
code exists, but the OpenAI Agents SDK must pause before executing it.

```python
from agents import function_tool


@function_tool(needs_approval=True)
def issue_refund(order_id: str) -> str:
    return f"Refund issued for {order_id}"
```

`result.interruptions` is known after draining the OpenAI Agents SDK stream. A production
server must:

1. call the OpenAI Agents SDK's `result.to_state()` method and store the
   returned paused `RunState` in durable storage, keyed by your own thread/run
   identity. This method is provided by the OpenAI Agents SDK; this AG-UI
   integration only calls it.
2. emit an approval request before `RUN_FINISHED` (for example through
   `end_custom_event`);
3. authenticate and validate the next approval decision;
4. claim the stored state exactly once;
5. call the OpenAI Agents SDK's `state.approve(item)` or `state.reject(item)`;
   and
6. resume the OpenAI Agents SDK run with `Runner.run_streamed(agent, state)`.

The AG-UI-specific part is the approval notification and transport:

```python
state = result.to_state()  # OpenAI Agents SDK
store[run_input.thread_id] = state

approval_event = CustomEvent(
    name="approval_request",
    value=[{"call_id": item.raw_item.call_id, "tool_name": item.tool_name}],
)  # AG-UI event, emitted through to_agui(..., end_custom_event=approval_event)

# On the next request, after validating the frontend decision:
state.approve(item)  # or state.reject(item) — OpenAI Agents SDK
resumed = Runner.run_streamed(agent, state)  # OpenAI Agents SDK
```

The included demo uses an in-memory store for clarity. Replace it with durable,
atomic storage before production use. See the complete
[`human_in_the_loop_approval.py`](examples/agents_examples/human_in_the_loop_approval.py)
example for the request routing, state store, custom event, and resume flow.

## Reasoning

Visible reasoning summary/text maps to AG-UI reasoning events. Replay requires
encrypted reasoning content; plaintext reasoning alone cannot restore model
reasoning state.

Request encrypted content through normal OpenAI Agents SDK model settings:

```python
from agents import ModelSettings

settings = ModelSettings(
    response_include=["reasoning.encrypted_content"],
)
```

When present, encrypted content is emitted once as
`REASONING_ENCRYPTED_VALUE` and can return later through an AG-UI
`ReasoningMessage.encrypted_value`.

## Multimodal input

| AG-UI content | OpenAI input | Notes |
|---|---|---|
| Text | `input_text` | Supported. |
| Image URL or data | `input_image` | Data becomes a base64 data URL; detail is `auto`. |
| Document URL or data | `input_file` | Uses `file_url` or base64 `file_data`. |
| Audio data | `input_audio` | WAV/MP3 only; requires a compatible Chat Completions model. |
| Audio URL | Not mapped | Dropped. |
| Video | Not mapped | OpenAI agent model input has no matching video part. |
| Legacy `BinaryInputContent` | Image, audio, or file by MIME type | Best-effort compatibility path. |

Unsupported parts are skipped. If every part of a user message is unsupported,
the complete message is skipped so the OpenAI Agents SDK never receives empty content.

The integration currently emits text/tool/reasoning output only. It does not
translate generated image or audio output into AG-UI events.

## Custom mappings

The public translator delegates to two engine classes:

- `AGUIToOpenAITranslator` — stateless inbound request mapping, reused.
- `OpenAIToAGUITranslator` — stateful outbound stream mapping, created per run.

Their `translate_*` methods are override points. Subclass only the side you
need and inject the class into `AGUITranslator`:

```python
from ag_ui_openai_agents import AGUITranslator
from ag_ui_openai_agents.engine import OpenAIToAGUITranslator


class MyOutboundTranslator(OpenAIToAGUITranslator):
    def translate_mcp_approval_request_item(self, item):
        return []  # Application-specific behavior.


translator = AGUITranslator(outbound_cls=MyOutboundTranslator)
```

Avoid sharing an outbound engine instance: it tracks open text, tool,
reasoning, step, and snapshot state for one run. `AGUITranslator` creates the
correct fresh instance automatically.

## Examples

The [`examples/`](examples/) directory contains one runnable app per supported
Dojo feature:

| Example | Demonstrates |
|---|---|
| `ag_ui_docs_copilot` | Agent using the integration and AG-UI documentation. |
| `agentic_chat` | Basic streaming conversation. |
| `backend_tool_rendering` | Server function call and result rendering. |
| `human_in_the_loop` | Frontend-owned tool plus user interaction. |
| `human_in_the_loop_approval` | OpenAI Agents SDK backend approval, persisted state, and resume. |
| `tool_based_generative_ui` | Frontend renders UI from tool arguments. |
| `subagents` | Agents-as-tools orchestration. |
| `custom_lifecycle_events` | Dynamic custom events using run data. |
| `dynamic_system_prompt` | Instructions derived from AG-UI context. |

Run all examples:

```bash
cd examples
uv sync
cp .env.example .env
# Add OPENAI_API_KEY to .env
uv run python server.py
```

The server listens on `http://localhost:8027` by default. `PORT` and `HOST`
override the defaults. `GET /health` lists the mounted demos. See the
[examples guide](examples/README.md) for routes and suggested prompts.

## Production responsibilities

This package translates the protocol. Your application still owns:

- authentication and authorization;
- API-key and secret management;
- session and message persistence;
- idempotency and concurrency control;
- approval-state storage and expiry;
- rate limits, retries, logging, and observability;
- model choice, guardrails, tools, handoffs, and OpenAI Agents SDK `RunConfig`;
- HTTP/WebSocket deployment and scaling.

## Testing and local development

Clone the AG-UI repository, then work from
`integrations/openai-agents/python`:

```bash
uv sync
uv run python -c "import ag_ui_openai_agents"
uv run pytest
uv build
```

`uv sync` installs the package and its development dependencies. The import
command is a quick installation smoke test, `pytest` runs the package unit
suite, and `uv build` verifies that the source distribution and wheel can be
created. No lint command is documented because this package does not currently
define a package-specific linter.

The test suite covers the public translator, wrapper, FastAPI endpoint,
message/content mapping, event windows, snapshots, IDs, cancellation, tools,
reasoning, and OpenAI Agents SDK discriminator drift. Unit tests do not require a live API
key.

The runnable examples have a separate test environment and test suite:

```bash
cd examples
uv sync
uv run pytest
```

Package tests do not automatically collect example tests. Run both suites
before opening a pull request that changes integration behavior or examples.

After changing `openai-agents` or `openai`, always run the full suite. The drift
tests compare the event and item discriminators used by this integration with
the installed OpenAI Agents SDK so renamed or newly introduced wire types are caught before
release.

## Troubleshooting

| Problem | Check |
|---|---|
| Authentication fails | Confirm `OPENAI_API_KEY` is set in the server process, not only in another terminal or frontend environment. |
| The client receives no stream | Return `StreamingResponse` with `EventEncoder.get_content_type()` and yield every encoded event from `translator.to_agui(...)`. |
| A frontend tool never appears | Include its definition in `RunAgentInput.tools`; frontend-owned tools are created from the request, not from the backend agent. |
| A backend approval cannot resume | Persist the OpenAI Agents SDK `RunState`, return the matching `call_id`, apply `state.approve()` or `state.reject()`, and resume with that state. The example's in-memory store is not production storage. |
| IDs do not match across events | Preserve the incoming AG-UI message and tool-call IDs; see [ID mapping and guarantees](#id-mapping-and-guarantees). |
| A run fails without useful client details | Set `run_error_message` for a safe client-facing message and inspect the original re-raised exception in server logs. |

When reporting a bug, include the package versions, a minimal `RunAgentInput`,
the observed AG-UI event sequence, and a small reproducer. Remove API keys and
sensitive message content first.

## Resources

- [OpenAI Agents SDK documentation](https://openai.github.io/openai-agents-python/)
- [OpenAI Agents guide](https://developers.openai.com/api/docs/guides/agents)
- [AG-UI Protocol](https://github.com/ag-ui-protocol/ag-ui)
- [Integration source](https://github.com/ag-ui-protocol/ag-ui/tree/main/integrations/openai-agents)
- [Examples](examples/)
- [Dojo demos](https://dojo.ag-ui.com/openai-agents-python/feature/agentic_chat)
- [MIT License](LICENSE)
