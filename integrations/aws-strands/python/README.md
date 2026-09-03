# AWS Strands Integration for AG-UI

Lets any `strands.Agent` speak the AG-UI protocol. Pass the Strands agent to
`StrandsAgent`, then serve it over FastAPI with `create_strands_app` or
`add_strands_fastapi_endpoint`.

## Features

- **Native Strands integration**: wraps `strands.Agent.stream_async`, and drives a `Graph` or `Swarm` orchestrator where one is passed instead of an agent
- **FastAPI transport**: SSE endpoint helpers with an optional auth dependency, a CORS allowlist, and a ping route for health probes
- **Native interrupts**: a backend tool pauses with `tool_context.interrupt(...)` and resumes over AG-UI `resume[]`, including approval interrupts and frontend tools parked in a native wait
- **Declarative tool behaviour**: `ToolBehavior` and `PredictStateMapping` describe per-tool quirks such as predictive state, streamed arguments and custom result handling
- **Broad event coverage**: text, reasoning, tool calls, state snapshots, message history, multimodal input, provider citations and multi-agent steps
- **A2UI**: auto-injected generative-UI tools with a validate-and-retry recovery loop

## Prerequisites

- Python 3.10 to 3.14, enforced at install time by `requires-python`.
- `strands-agents>=1.15.0`.
- `uv` or `pip` for this package. The demo server under `examples/` is a separate Poetry project.
- A model key for the provider `MODEL_PROVIDER` selects. It defaults to `openai`, which needs `OPENAI_API_KEY`; `anthropic` and `gemini` need `ANTHROPIC_API_KEY` and `GOOGLE_API_KEY` instead.

## Quick Start

```bash
cd integrations/aws-strands/python/examples
poetry install
poetry run python -m server
```

`PORT` selects the port and defaults to 8000. `CORS_ALLOW_ORIGINS` is a
comma-separated allowlist of browser origins, applied to the demo app and to
every demo mounted inside it; only an unset or blank value allows every origin,
which is the local-development default.

The demo server mounts every route below into one app, which is the easiest way
to try several flows locally. Each route is also a readable example of the
pattern it demonstrates, under [`examples/server/api/`](examples/server/api/).

| Route                       | Description                                    |
| --------------------------- | ---------------------------------------------- |
| `/agentic-chat`             | Frontend tool demo                             |
| `/agentic-chat-reasoning`   | Reasoning / thinking event streaming           |
| `/agentic-chat-citations`   | Answers carrying the sources they came from    |
| `/agentic-chat-multimodal`  | Multimodal image / document analysis           |
| `/backend-tool-rendering`   | Backend tool rendering demo                    |
| `/shared-state`             | Shared recipe state                            |
| `/agentic-generative-ui`    | Agentic UI with PredictState                   |
| `/human-in-the-loop`        | Frontend tool parked in a native Strands wait  |
| `/interrupt`                | Tool pauses to ask the user for a meeting time |
| `/predictive-state-updates` | Document editor driven by streaming tool args  |
| `/tool-based-generative-ui` | Frontend-rendered tool (`generate_haiku`)      |
| `/multi-agent`              | Strands graph of agents, streamed as steps     |
| `/a2ui-dynamic-schema`      | A2UI surfaces composed on the fly              |
| `/a2ui-fixed-schema`        | A2UI from fixed-layout backend tools           |
| `/a2ui-recovery`            | A2UI validate-and-retry recovery loop          |

## Transport helpers

Both helpers are thin shells over the shared `ag_ui.encoder.EventEncoder` and
serve the run as SSE:

- `add_strands_fastapi_endpoint(app, agent, path, *, auth=None, invocation_state_provider=None, **kwargs)` registers a POST route that accepts a `RunAgentInput` body and streams whatever `StrandsAgent.run` yields.
- `create_strands_app(agent, path="/", ping_path="/ping", origins=None, auth=None, allow_methods=None, allow_headers=None, cors_enabled=None, invocation_state_provider=None)` bootstraps a FastAPI application, mounts that route, and adds an unauthenticated ping route. `add_ping` adds the ping route to an app you build yourself.


`invocation_state_provider` makes trusted server context available to Strands
hooks and tools for one request. It may be synchronous or asynchronous and
receives both the FastAPI `Request` and the validated `RunAgentInput`. Derive
its values from authenticated request context, never from client-controlled
`forwarded_props`.

## Per-thread agents: hooks and plugins

The wrapper does not run the agent you hand it. That one is a template: the
adapter reads its constructor settings back off the instance and builds a fresh
`strands.Agent` per `thread_id`, so one conversation cannot see another's
history. Most settings survive that rebuild automatically.

Two do not, because Strands consumes them during construction rather than
keeping the list you passed. Hooks become a `HookRegistry`, and plugins are run
against the agent that received them and recorded in a registry bound to it.
Neither can be read back or handed to a second agent, so a template is the one
place they will not work. Pass them to the wrapper instead and every per-thread
agent gets its own:

```python
agui_agent = StrandsAgent(
    agent=strands_agent,
    name="my_agent",
    hooks=[MyHookProvider()],
    plugins=[AgentSkills(skills="./skills/")],
)
```

Set either on the template and the adapter logs a warning naming the setting
the first time a thread is built, rather than dropping it in silence. For a
value that has to differ per thread, build it in
`StrandsAgentConfig.thread_agent_kwargs`, which runs per request and wins over
both routes above.

| Scenario                                                | Support boundary                                                                                                                                                        |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `hooks=[...]`                                           | Supported on every release this package supports.                                                                                                                        |
| `plugins=[...]`                                         | Requires `strands-agents >= 1.28.0`, the release that added `plugins` to `Agent`. On an older release the wrapper raises `TypeError` when it is constructed, not on the first request. |
| `hooks` / `plugins` with a multi-agent orchestrator     | Ignored. An orchestrator is invoked directly, so there is no per-thread agent to attach them to.                                                                          |


## Securing the endpoint

- Prefer an exact browser allowlist: pass `origins=["https://app.example"]`. Omitting every CORS option selects a deprecated implicit wildcard and emits a `FutureWarning`, `cors_enabled=False` installs no CORS middleware, and `origins=["*"]` retains the wildcard explicitly.
- Pass `origins` to every app you mount as well as to the parent. A mounted app installs its own CORS middleware and answers first, so one left on the wildcard default answers an origin the parent would have refused.
- The agent route has no authentication unless you pass an `auth` dependency. Both helpers accept one and evaluate it before JSON decoding or model validation. The ping route is left open so load balancer and AgentCore health probes keep working.
- Agent POST requests must send a JSON-compatible `Content-Type`, either `application/json` or an `application/*+json` media type. Anything else is rejected with HTTP 415 before the agent runs.
- Deploying into Amazon Bedrock AgentCore, see [Deploy AG-UI servers in AgentCore Runtime](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-agui.html) and the [AG-UI protocol contract](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-agui-protocol-contract.html).

## Human-in-the-loop (native Strands interrupts)

A backend tool that pauses with `tool_context.interrupt(...)` is bridged to the
AG-UI interrupt round trip. The run finishes with `RUN_FINISHED` carrying a
`RunFinishedInterruptOutcome` (`outcome.type == "interrupt"`) and one AG-UI
`Interrupt` per Strands interrupt, preserving the Strands name as the AG-UI
reason (falling back to `"interrupt"` when there is none) and the free-form
Strands reason under `metadata.reason`.

A tool configured with `ToolBehavior(interrupt_on_call=True)` raises an approval
interrupt instead, which always carries a `message`, an `approved`
`response_schema`, and `tool_name` / `tool_input` / `strandsName` in `metadata`,
the same keys the TypeScript package publishes. Two more are conditional:
`tool_call_id`, which an approval raised without a native tool use has none of,
and `reason`, published only when the native reason carried something the other
keys could not hold.

The `ag_ui:tool_call:` name prefix is **reserved** for that approval hook. An
interrupt raised anywhere else under it is classified, schema-checked and
answered as an approval. Approvals cover server-executed tools only. Gate a
client-provided tool in the client instead, defining it with a `render` that
calls `respond` rather than a `handler`, since it runs in the browser after the
public run has already finished.

To resume, the client sends the next `RunAgentInput` on the **same `thread_id`**
with `resume=[ResumeEntry(interrupt_id=..., status="resolved", payload=...)]`.
`interrupt()` does not return the payload directly: Strands gates its resume on
truthiness, so a falsy payload would re-raise the same interrupt and re-run the
tool body forever. It returns an envelope, always present and always truthy:

| `resume` entry                     | what the paused `interrupt()` returns                              |
| ---------------------------------- | ------------------------------------------------------------------ |
| `status="resolved"`, any `payload` | `{"response": payload}`                                            |
| `status="resolved"`, no `payload`  | `{"response": None}`                                               |
| `status="cancelled"`               | `{"cancelled": True}`, matching the exported `INTERRUPT_CANCELLED` |

Destructure it with `.get("response")` / `.get("cancelled")` rather than
truthiness-checking the envelope, compare a cancellation by value rather than by
identity, and treat what you receive as read-only, since it is the same object
Strands records as the answer. The `@ag-ui/aws-strands` TypeScript package
applies the same contract, so a tool body ports between the two unchanged.

Two shapes sit outside that contract. An `interrupt_on_call` approval is
answered with its raw `{"approved": bool}` payload, because the approval hook
reads `approved` off it directly. A frontend tool parked in a native wait is
answered under a reserved key,
`{"__ag_ui_frontend_tool_response__": {"content": str, "is_error": bool}}`,
translated from the client's ordinary `ToolMessage`; that one is Python-only.

**Resuming re-runs the paused tool body from the top**, so any code before the
`interrupt()` call executes again. Do the side effect after the pause resolves,
never before it.

A frontend tool given `ToolBehavior(continue_after_frontend_call=False)`, which
is that field's default, parks in the same native checkpoint. That is an
implementation detail rather than an AG-UI interrupt: the client contract stays
`TOOL_CALL_*`, then a successful `RUN_FINISHED`, then an ordinary `ToolMessage`
on the next request, with no interrupt outcome and no `resume[]`. Re-sending an
answer the checkpoint already holds verbatim is idempotent.

Pause and resume on one live wrapper, process and `thread_id` need no
`SessionManager`. Resuming after a wrapper recreation or in another process
needs a durable one that restores the same session and a stable Strands
`agent_id`, and interrupt payloads and tool results must then stay JSON-safe
(no raw `bytes`).

`/interrupt` and `/human-in-the-loop` in the demo server are live examples, and
the dojo renders both.

## Supported AG-UI Events

- **Lifecycle**: `RUN_STARTED`, `RUN_FINISHED`, `RUN_ERROR`
- **Text and reasoning**: `TEXT_MESSAGE_START`, `TEXT_MESSAGE_CONTENT`, `TEXT_MESSAGE_END`, and `REASONING_*` for models with extended thinking
- **Tool calls**: `TOOL_CALL_START`, `TOOL_CALL_ARGS`, `TOOL_CALL_END`, `TOOL_CALL_RESULT`
- **State**: `STATE_SNAPSHOT`, and `STATE_DELTA` where a `custom_result_handler` emits one; the adapter produces no delta of its own
- **Message history**: `MESSAGES_SNAPSHOT` carrying the complete thread as known so far. On by default; turn it off globally with `StrandsAgentConfig.emit_messages_snapshot` or per tool with `ToolBehavior.skip_messages_snapshot`, and note that the multi-agent orchestrator path emits none whatever those say
- **Multi-agent**: `STEP_STARTED` and `STEP_FINISHED` per node, with `MultiAgentHandoff` custom events for handoffs
- **Custom**: `PredictState`, `MultiAgentHandoff`, `AgentStopped` (an abnormal model stop reason) and `hook_error` (a developer callback that threw), all as `CUSTOM` events keyed by `name`
- **Multimodal and citations**: image, document and video content in user messages, converted to Strands ContentBlocks; provider citations normalised onto the `citations` key of the assistant message's `metadata`
- **Interrupts**: `RUN_FINISHED` carries an interrupt outcome when a backend tool or hook paused the run
- **Raw passthrough**: `RAW` for Strands events this adapter does not map. That payload is framework-shaped rather than AG-UI-shaped and the SDK may change it in any release, so read it defensively

## Terminal error codes

Every `RUN_ERROR` code either bridge can emit, and the message text that goes
with each one, is enumerated in
[`../error-codes.json`](../error-codes.json). That file is a wire contract
rather than documentation: clients and mock harnesses match both the code and
the message literally, and both test suites drive their bridge to each terminal
path and assert the emitted frame against it, so a reworded message fails a test
instead of reaching a client.

## Packaging surface

`__all__` is the exact surface and currently carries 32 names, in these groups:

```
adapter        StrandsAgent
transport      create_strands_app / add_strands_fastapi_endpoint / add_ping
config         StrandsAgentConfig / ToolBehavior / ToolCallContext / ToolResultContext /
               ToolStreamEventContext / PredictStateMapping / SessionManagerProvider /
               ToolStreamEventHandler / InvocationStateProvider
interrupts     Interrupt / ResumeEntry / INTERRUPT_CANCELLED /
               RunFinishedInterruptOutcome / RunFinishedSuccessOutcome
proxy tools    create_proxy_tool / sync_proxy_tools
url fetching   UrlFetchPolicy / UrlFetchPolicyError / DEFAULT_URL_FETCH_POLICY
citations      CITATIONS_METADATA_KEY
a2ui           get_a2ui_tools / plan_a2ui_injection / is_auto_injected_a2ui_tool /
               A2UIToolParams / A2UIGuidelines / A2UI_STREAM_KEY / A2UI_OPERATIONS_KEY /
               BASIC_CATALOG_ID
```

The adapter, transport and config groups mirror the other AG-UI
integrations, so examples can follow the same mental model. Read
`__init__.py` rather than this list when the exact set matters.
