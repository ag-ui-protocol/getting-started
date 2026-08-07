# OpenAI Agents (Python) examples

Runnable demos for `ag_ui_openai_agents`, one mounted FastAPI app per agent.
The aggregate server mounts each example application:

- **`ag_ui_docs_copilot`** handles normal conversation directly and reads
  local README sections on demand via `read_ag_ui_openai_agents_docs` and
  `read_ag_ui_protocol_docs` tools.
- The remaining focused feature apps use **`OpenAIAgentsAgent`** and
  `add_openai_agents_fastapi_endpoint` where their run does not require custom
  control.

Model provider is **native OpenAI** (`OPENAI_API_KEY`). These examples exercise
the direct OpenAI path deliberately, since that is the reference setup for the
library.

## Prerequisites

- Python 3.10 or newer
- [`uv`](https://docs.astral.sh/uv/)
- An OpenAI API key

## Setup and configuration

```bash
cd integrations/openai-agents/python/examples
uv sync --no-dev
cp .env.example .env
```

Add your API key to `.env`. The example server recognizes:

| Variable | Required | Purpose |
|---|---:|---|
| `OPENAI_API_KEY` | Yes | Authenticates OpenAI requests. |
| `OPENAI_DEFAULT_MODEL` | No | Overrides the model shared by the examples. |
| `OPENAI_AGENTS_DISABLE_TRACING` | No | Set to `true` to disable OpenAI Agents SDK tracing. |
| `HOST` | No | Bind address; defaults to `0.0.0.0`. |
| `PORT` | No | Server port; defaults to `8027`. |
| `RELOAD` | No | Set to a non-empty value to restart the server after local code changes. |

These examples use the OpenAI provider directly. Provider selection is not an
AG-UI translator setting; applications that use another OpenAI Agents SDK
model provider configure that provider when constructing their agents and
runner.

## Running the server

```bash
uv run --env-file .env --no-dev python server.py
```

Server runs on **http://localhost:8027** (the port the AG-UI Dojo expects;
override with `PORT`). Tracing follows the SDK's own `OPENAI_AGENTS_DISABLE_TRACING`
env var and default (`false` — tracing on); set it to `true` to disable
tracing.

## Available endpoints

| Endpoint | Demonstrates |
|---|---|
| `/ag_ui_docs_copilot/` | Documentation retrieval through backend tools |
| `/agentic_chat/` | Basic streamed conversation |
| `/backend_tool_rendering/` | Backend function tools and rendered results |
| `/human_in_the_loop/` | Frontend-owned tool execution |
| `/human_in_the_loop_approval/` | Approval before a backend tool runs |
| `/tool_based_generative_ui/` | UI rendered from frontend tool arguments |
| `/subagents/` | OpenAI Agents SDK agents-as-tools orchestration |
| `/custom_lifecycle_events/` | Custom events around a run |
| `/dynamic_system_prompt/` | Instructions derived from AG-UI context |
| `/health` | Server status and registered demo names |

All demo endpoints accept AG-UI `RunAgentInput` requests and return an SSE
event stream.

## Testing with Dojo

Start the example server, then run the Dojo from the repository root in a
second terminal:

```bash
cd apps/dojo
pnpm dev
```

Open `http://localhost:3000`, select **OpenAI Agents (Python)**, and choose a
feature. The Dojo uses `http://localhost:8027` by default. Set
`OPENAI_AGENTS_PYTHON_URL` in the Dojo environment if the backend uses another
address.

## Automated tests

The examples have an independent test suite. From this directory, install the
development dependencies and run it with:

```bash
uv sync
uv run pytest
```

Running `uv run pytest` from the main SDK directory tests only the SDK suite;
it does not collect these example tests.

## Manual smoke test

```bash
curl -N -X POST http://localhost:8027/agentic_chat/ \
  -H 'Content-Type: application/json' \
  -d '{
    "thread_id": "t1",
    "run_id":    "r1",
    "messages":  [{"id":"m1","role":"user","content":"Say hi in one sentence."}],
    "tools":     [],
    "state":     {},
    "context":   [],
    "forwarded_props": null
  }'
```

Swap the path to hit a different demo. `GET /health` on the aggregate server
lists every registered agent. Demos map 1:1 onto the AG-UI Dojo feature pages.

## Agents

### `ag_ui_docs_copilot`

One Copilot agent handles normal conversation directly. Its instructions carry
only the heading list (table of contents) for two local READMEs; for a
documentation or code question it picks a heading and calls
`read_ag_ui_openai_agents_docs` or `read_ag_ui_protocol_docs` to read that one
section into context. The retrieval is deterministic and adds no vector
database, embedding request, network dependency, or extra agent hop — the
whole document never enters the prompt, and neither does a second model's
paraphrase of it. The endpoint keeps the direct `to_openai` →
`Runner.run_streamed` → `to_agui` flow visible.

**Try:** `"Explain how to connect my existing OpenAI Agents SDK agent to AG-UI,
then give me the smallest FastAPI streaming endpoint."`

### `agentic_chat`

Plain conversation, no tools. Exercises `TEXT_MESSAGE_START/CONTENT/END`
only — the smallest possible smoke test.

**Try:** `"Say hi in one sentence."`

### `backend_tool_rendering`

A server-side `@function_tool` (`get_weather`) the SDK executes itself.
Exercises `TOOL_CALL_START/ARGS/END` + `TOOL_CALL_RESULT`.

**Try:** `"What's the weather in Berlin?"`

### `human_in_the_loop`

A _frontend_-owned tool (`generate_task_steps`) declared by the client in
`RunAgentInput.tools`, not the server. Uses the SDK's built-in
`tool_use_behavior=StopAtTools(...)` so the run ends the moment the model
calls it — the tool body never executes server-side. The frontend renders
the steps, gets user approval, and sends the result back as an ordinary
`ToolMessage` in the next request; no custom pause/resume state needed.

**Try:** `"Plan a birthday party."` — requires a client that actually sends
a `generate_task_steps` tool definition in `RunAgentInput.tools` (e.g. the
AG-UI Dojo's human-in-the-loop page, which uses the same tool name).

> **vs. `human_in_the_loop_approval` (below):** here the tool has _no server
> implementation_ — only the browser can run it, so there's nothing to gate.
> `human_in_the_loop_approval` is the opposite case: a real backend tool,
> paused by the SDK's own approval API before _its_ body runs. Different
> problem, different mechanism — see the comparison table under
> `human_in_the_loop_approval`.

### `tool_based_generative_ui`

Another frontend-owned tool (`generate_haiku`), but here the tool call _is_
the deliverable: the frontend renders the haiku card straight from the
streamed `TOOL_CALL_ARGS` — no approval round-trip. Same `StopAtTools`
mechanics as `human_in_the_loop`.

**Try:** `"Write me a haiku about the ocean."` — needs a client that sends a
`generate_haiku` tool definition (Dojo's tool-based generative UI page).

### `human_in_the_loop_approval`

A _backend_-owned tool (`issue_refund`) that requires approval before it
runs — the SDK's `needs_approval=True` (`agents.tool.function_tool`), not an
AG-UI concept. Unlike `human_in_the_loop`, the tool has a real server-side
implementation; the SDK itself pauses the run and reports a
`ToolApprovalItem` on `result.interruptions` before the body ever executes.
That's only known once the stream is fully drained, so this demo is
hand-routed in its own application instead of running
through the shared loop:

1. First request runs normally; if `result.interruptions` is non-empty after
   the stream ends, the server serializes the paused run
   (`result.to_state()`), keeps it in memory keyed by `thread_id`, and sends
   a `CustomEvent(name="approval_request")` as `to_agui()`'s
   `end_custom_event` — right before `RUN_FINISHED`, not after (the client
   drops anything that arrives once a run is marked finished).
2. The client's decision comes back on the _next_ request as
   `RunAgentInput.forwarded_props["approval"]` (`{"call_id", "approve"}`).
   `resolve_approval()` claims the stored state, calls `state.approve()` /
   `state.reject()`, and resumes with `Runner.run_streamed(agent, state)`
   instead of starting over from `translated.messages`.

`resolve_approval()` takes the paused run out of the store before deciding
anything, so a double-clicked Approve can't resume the same run twice — the
second request finds nothing to claim. A request that _isn't_ a matching
decision (a plain message, a stale `call_id`, an `approve` that isn't a real
bool — `"false"` is a truthy string) abandons the paused run and answers
normally rather than refusing: the user moved on, and a thread whose approval
card got lost on a page refresh should still be usable.

Both servers drain the SDK stream by hand here, which puts that part outside
`to_agui`'s error handling. A failure mid-drain is kept and re-raised from the
replay instead of reported on the spot, so it lands back inside `to_agui` and
the route behaves like every other one: whatever already streamed still
reaches the client, open sequences close, and `RUN_ERROR` goes out last.

**Try:** `"I'd like a refund for ORD-1001."` — requires a client that renders
`approval_request` custom events and sends the decision back via
`forwarded_props` (the AG-UI Dojo's Human in the Loop (Backend Approval)
page does this).

**`human_in_the_loop_approval` vs. `human_in_the_loop` — same goal, different mechanism:**

|                             | `human_in_the_loop`                                                   | `human_in_the_loop_approval`                                                 |
| --------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Who owns the tool           | Frontend — no server implementation exists                            | Backend — real `@function_tool` code                                         |
| What pauses the run         | `StopAtTools`, the instant the model calls it                         | The SDK's own `needs_approval` gate, before the body runs                    |
| How the pause surfaces      | Normal `TOOL_CALL_*` events, mid-stream                               | `result.interruptions`, only known after the stream ends                     |
| How the decision comes back | An ordinary `ToolMessage` in the next request's `messages`            | `RunAgentInput.forwarded_props["approval"]`, resumed via a stored `RunState` |
| Why                         | The action can _only_ happen client-side (render UI, wait on a click) | The backend _can_ do it, but shouldn't without sign-off first                |

### `subagents`

Multi-agent via the SDK's **agents-as-tools** pattern (`Agent.as_tool()`) —
control never transfers, the supervisor calls `research_agent`,
`writer_agent`, and `critic_agent` as tools and synthesizes the final answer
itself. Each specialist invocation appears to the client as a normal
`TOOL_CALL_*` + `TOOL_CALL_RESULT` sequence; the nested agents' inner turns
stay internal to the SDK.

**Try:** `"Write a short piece about the history of coffee."`

### `custom_lifecycle_events`

Adds application-defined lifecycle events around the normal translated OpenAI
Agents SDK stream. This demonstrates how an application can extend a run with
AG-UI `CUSTOM` events without changing the translator's built-in mappings.

### `dynamic_system_prompt`

Builds OpenAI Agents SDK instructions from AG-UI context supplied with the
request. This demonstrates application-owned prompt construction while the
translator continues to handle messages and streamed events.

## How the examples work

- `server.py` mounts every example FastAPI application under its demo name.
- Each module in `agents_examples/` owns its agent and endpoint behavior.
- Most demos use `OpenAIAgentsAgent` and
  `add_openai_agents_fastapi_endpoint`.
- Demos that need custom lifecycle or pause/resume behavior use
  `AGUITranslator` directly around `Runner.run_streamed(...)`.
- The package dependency points to the parent integration in editable mode, so
  local integration changes are used without publishing a wheel.

## Adding an example

1. Add a module under `agents_examples/` containing the agent and FastAPI app.
2. Register its agent and app in `DEMOS` and `DEMO_APPS` in `server.py`.
3. Add the endpoint and behavior to this README.
4. Add focused tests under `tests/` and, when it is a Dojo feature, its Dojo
   registration and end-to-end test.

## Troubleshooting

| Problem | Check |
|---|---|
| Server exits immediately | Set `OPENAI_API_KEY` in `examples/.env`. |
| Dojo cannot connect | Confirm the server is on port `8027`, or set `OPENAI_AGENTS_PYTHON_URL` for Dojo. |
| Endpoint returns 404 | Include the mounted demo path and its trailing slash, such as `/agentic_chat/`. |
| Changes are not picked up | Set `RELOAD=1` or restart the example server. |
| Example tests are not running | Run `uv run pytest` from the `examples` directory; the package suite does not collect them. |

## References

- [AG-UI Protocol documentation](https://docs.ag-ui.com/)
- [OpenAI Agents SDK documentation](https://openai.github.io/openai-agents-python/)
- [OpenAI Agents integration README](../README.md)
