# AWS Strands Integration for AG-UI

This package exposes a lightweight wrapper that lets any `strands.Agent` speak the AG-UI protocol. It mirrors the developer experience of the other integrations: give us a Strands agent instance, plug it into `StrandsAgent`, and wire it to FastAPI via `create_strands_app` (or `add_strands_fastapi_endpoint`).

## Prerequisites

- Python 3.10 to 3.14. `pyproject.toml` declares `requires-python = ">=3.10, <3.15"`,
  so the upper bound is enforced at install time, not just documented.
- `strands-agents>=1.15.0`, which is the declared floor. Some behaviour described
  below is release-dependent: the SDK's own concurrency lock arrives in 1.22.0 and
  the citations demo needs 1.35.0, while the Gemini guardrail hint and the release
  that turned a provider failure from `STRANDS_ERROR` into `STRANDS_FORCE_STOP`
  were never bisected. [ARCHITECTURE.md](../ARCHITECTURE.md) records which
  releases each observation was made against.
- `uv` (the package is built with hatchling and locked by `uv.lock`) or `pip`. The example server under `examples/` is a separate Poetry project and is installed with `poetry install`.
- A model key for the provider `MODEL_PROVIDER` selects. It defaults to
  `openai`, which requires `OPENAI_API_KEY`; `anthropic` and `gemini` need
  `ANTHROPIC_API_KEY` and `GOOGLE_API_KEY` instead.

## Quick Start

The `examples/server` package mounts all demo routes behind a single FastAPI app. Run:

```bash
cd integrations/aws-strands/python/examples
poetry install
poetry run python -m server
```

`PORT` selects the port and defaults to 8000. It must be written in plain
decimal digits with no leading zero and no sign, giving a number between 1 and 65535. Anything else is refused at startup, naming the variable and the value,
rather than silently binding somewhere unreachable: `0` binds an arbitrary free
port, and Python would otherwise read `0100` as 100 and `1_0` as 10.

`CORS_ALLOW_ORIGINS` is a comma-separated list of browser origins to allow. It
is applied to the dojo app and to every demo mounted inside it, because both
install CORS middleware and the mounted one answers first.

Entries are matched against the `Origin` header exactly. A trailing slash and
letter case are repaired, since a browser sends neither, but nothing else is
validated: an entry that is not an origin stays in the list and simply matches
nothing. `null`, which a sandboxed iframe or a `file://` page sends, is matched
like any other entry, but it names no site, so its presence disables
credentials for the whole list, exactly as `*` does.

Only an unset or blank value allows every origin. That is the local-development
default, and the server says so once at startup. A value that was written but
holds nothing a browser could send, `/` or `*/` for instance, refuses every
cross-origin request instead of widening to allow all of them, and is reported
separately at startup. Setting the variable is a request to restrict, so a typo
in it must never grant more than was asked for.

It exposes:

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

This is the easiest way to test multiple flows locally. Each route still follows the pattern described below (Strands agent → wrapper → FastAPI).

## Architecture Overview

The integration has three main layers:

- **StrandsAgent** – wraps `strands.Agent.stream_async`. It translates Strands events into AG-UI events (text chunks, tool calls, PredictState, snapshots, reasoning/thinking, multi-agent steps, etc.).
- **Configuration** – `StrandsAgentConfig` + `ToolBehavior` + `PredictStateMapping` let you describe tool-specific quirks declaratively. `ToolBehavior`'s fields are `skip_messages_snapshot`, `continue_after_frontend_call`, `stop_streaming_after_result`, `interrupt_on_call`, `predict_state`, `args_streamer`, `state_from_args`, `state_from_result`, `custom_result_handler` and `tool_stream_event_handler`; `StrandsAgentConfig` adds `tool_behaviors`, `state_context_builder`, `thread_agent_kwargs`, `session_manager_provider`, `emit_messages_snapshot`, `replay_history_into_strands`, `a2ui` and `url_fetch_policy`.
- **Transport helpers** – `create_strands_app` and `add_strands_fastapi_endpoint` expose the agent via SSE. They are thin shells over the shared `ag_ui.encoder.EventEncoder`.

See [ARCHITECTURE.md](../ARCHITECTURE.md) for diagrams and a deeper dive.

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

## Key Files

| File                                           | Description                                                                     |
| ---------------------------------------------- | ------------------------------------------------------------------------------- |
| `src/ag_ui_strands/agent.py`                   | Core wrapper translating Strands streams into AG-UI events                      |
| `src/ag_ui_strands/config.py`                  | Config primitives (`StrandsAgentConfig`, `ToolBehavior`, `PredictStateMapping`) |
| `src/ag_ui_strands/endpoint.py`                | FastAPI endpoint helper                                                         |
| `src/ag_ui_strands/utils.py`                   | `create_strands_app`, multimodal conversion, and `UrlFetchPolicy`               |
| `src/ag_ui_strands/citations.py`               | Provider citations normalised onto the message they annotate                    |
| `src/ag_ui_strands/a2ui_tool.py`               | A2UI tool injection and the validate-and-retry recovery loop                    |
| `src/ag_ui_strands/session_reconcile.py`       | Frontend-result reconciliation against a persisted session                      |
| `src/ag_ui_strands/client_proxy_tool.py`       | Frontend tools registered into the Strands tool registry                        |
| `src/ag_ui_strands/template_tools.py`          | Per-request filter over the template agent's own tools                          |
| `src/ag_ui_strands/frontend_tool_interrupt.py` | The native checkpoint a waiting frontend tool parks in                          |
| `examples/server/api/*.py`                     | Ready-to-run demo apps                                                          |

## Amazon Bedrock AgentCore considerations

If you are planning to deploy your agent into Amazon Bedrock AgentCore (AC), please note that AC expects the following:

- The server is running on port 8080.
- The path `/invocations - POST` is implemented and can be used for interacting with the agent.
- The path `/ping - GET` is implemented and can be used for verifying that the agent is operational and ready to handle requests.

To implement the path mentioned above, you can use the helper function `create_strands_app` and pass the agent interaction path and the ping path as shown below. Pass `origins` too: omitting every CORS option selects the deprecated implicit wildcard and emits a `FutureWarning`.

```python
create_strands_app(agui_agent, "/invocations", "/ping", origins=["https://app.example"])
```

You can also use the helper functions `add_strands_fastapi_endpoint` and `add_ping` for adding the mentioned paths to a FastAPI app that you are creating separately:

```python
add_strands_fastapi_endpoint(app, agui_agent, "/invocations")
add_ping(app, "/ping")
```

## Securing the endpoint

`create_strands_app` remains backward-compatible with earlier releases: when no
CORS option is supplied it installs permissive wildcard CORS and emits a
`FutureWarning`. Choose the intended policy explicitly to silence the warning:

- Prefer an exact browser allowlist, e.g. `create_strands_app(agui_agent, origins=["http://localhost:3000"])`.
- Pass `cors_enabled=False` for same-origin or server-to-server deployments that need no CORS middleware.
- Pass `origins=["*"]` (or `cors_enabled=True`) to explicitly retain wildcard CORS for local development.
- The implicit wildcard fallback will be removed in a future release.
- The agent route has no authentication unless you pass an `auth` dependency:

```python
import os
from fastapi import Header, HTTPException

def require_token(authorization: str | None = Header(default=None)) -> None:
    if authorization != f"Bearer {os.environ['AGENT_TOKEN']}":
        raise HTTPException(status_code=401, detail="Unauthorized")

app = create_strands_app(
    agui_agent,
    origins=["https://app.example"],
    auth=require_token,
)
```

Pass `origins` to every app you mount as well as to the parent. A mounted app
installs its own CORS middleware and answers first, so one left on the wildcard
default replies `Access-Control-Allow-Origin: *` to an origin the parent would
have refused, and the parent's middleware then adds
`Access-Control-Allow-Credentials: true` on the way out. Preflighted requests
are still refused by the parent, but any route reachable as a simple request,
including `/ping`, is readable by any origin.

The same `auth` argument is accepted by `add_strands_fastapi_endpoint` and is
evaluated before JSON decoding or model validation. The ping endpoint is left
unauthenticated so load balancer and AgentCore health probes keep working.

Agent POST requests must send a JSON-compatible `Content-Type`: either
`application/json` or an `application/*+json` media type. Requests with a
missing or non-JSON `Content-Type` are rejected with HTTP 415 before the agent
runs.

Requests to the AC endpoint must be authenticated. You can configure your agent runtime to accept JWT bearer tokens (via Amazon Cognito) or use SigV4. See [Set up authentication](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-agui.html) in the AgentCore documentation.

For details on how AgentCore handles AG-UI requests, event streaming, and error formatting, see the [AG-UI protocol contract](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-agui-protocol-contract.html).

To deploy, use the [AgentCore Starter Toolkit](https://github.com/aws/bedrock-agentcore-starter-toolkit):

```bash
pip install bedrock-agentcore-starter-toolkit
agentcore configure -e my_agui_server.py --protocol AGUI
agentcore deploy
```

The starter toolkit's repository says its CLI is superseded by `@aws/agentcore`,
which carries the same `--protocol AGUI` value under its own command names, while
the AG-UI deployment guide linked below still gives the starter-toolkit commands.
Where the two disagree, that guide is the one to follow: it is AWS's own
instructions for this protocol.

For the complete deployment walkthrough, see [Deploy AG-UI servers in AgentCore Runtime](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-agui.html).

## Request-scoped invocation state

Use `invocation_state_provider` to make trusted server context available to
Strands hooks and tools for one request. The provider may be synchronous or
asynchronous and receives both the FastAPI `Request` and the validated
`RunAgentInput`:

```python
from fastapi import Request
from ag_ui.core import RunAgentInput
from ag_ui_strands import create_strands_app

async def invocation_state(
    request: Request,
    input_data: RunAgentInput,
) -> dict[str, object]:
    return {
        "tenant_id": request.state.tenant_id,
        "run_id": input_data.run_id,
    }

app = create_strands_app(
    agui_agent,
    auth=require_token,
    invocation_state_provider=invocation_state,
)
```

The adapter shallow-copies the returned dictionary before each invocation,
because Strands adds its own runtime entries to that dictionary. Do not source
trusted values from client-controlled `forwarded_props`; derive them from
authenticated request context instead. Custom routes can pass the same state
directly with `agent.run(input_data, invocation_state={...})`.

## Per-request tool filtering

`StrandsAgentConfig.template_tools_provider` decides which of the template
agent's tools one request may see. It is called once per request with that
request's `RunAgentInput`, so the answer can vary turn by turn on a single
thread:

```python
from ag_ui.core import RunAgentInput
from ag_ui_strands import StrandsAgent, StrandsAgentConfig

READ_ONLY = ["search_docs", "get_order"]

def tools_for(input_data: RunAgentInput):
    # Derive the role from authenticated request context in production;
    # forwarded_props is client-controlled.
    if (input_data.forwarded_props or {}).get("role") == "admin":
        return None  # no filtering: every template tool stays available
    return READ_ONLY

agui_agent = StrandsAgent(
    strands_agent,
    name="assistant",
    config=StrandsAgentConfig(template_tools_provider=tools_for),
)
```

Return the tools themselves or their names. `None` declines to filter; an empty
list is a real answer and withholds all of them. A name the template does not
contribute is dropped with a warning, because the hook narrows the wrapped
agent's tools and cannot add one. The provider may be async.

Two boundary rules follow from that:

- **The return value is checked, not merely iterated.** A string and a mapping
  are both iterable and both mean something other than what iterating them
  produces: a bare name would come apart into characters, and a permission map
  would have its keys read as an allow-list while its values went unread, so a
  name mapped to `False` would still be allowed. Both are refused with
  `TEMPLATE_TOOLS_PROVIDER_ERROR`. Lists, tuples, sets and generators are all
  accepted, and a generator that raises partway through iteration reports the
  same code, because the answer is read inside the same guarded step that calls
  the provider.
- **The filter reaches the registry, not only the advertised tool specs.** A
  model that calls a withheld name anyway, primed by a stale turn or by the
  visible history, is refused by the dispatcher rather than served.

The filter is applied to the tool registry the thread's live Strands `Agent`
already owns, the same way client-declared tools are synchronised, and never by
rebuilding that agent. The per-thread instance holds the thread's
`SessionManager`, its native interrupt checkpoint and its history, so replacing
it to change a tool list would discard a conversation and any approval waiting
inside it.

Three consequences follow from that:

- **A parked call is never orphaned.** A tool in the batch a live interrupt
  checkpoint would resume stays registered whatever the provider returns: the
  human's answer is about to be routed back into that batch, and an absent tool
  turns it into a "tool not found" the model re-fires. Filtering resumes once
  the pause closes. This is the rule `sync_proxy_tools` already applies to a
  proxy parked in a frontend-tool interrupt.
- **History is never rewritten.** A filtered-out tool's earlier calls and
  results stay in the thread's messages, so the model can still read what it
  did with a tool it can no longer call.
- **A failure is terminal.** If the provider raises, the run yields `RUN_ERROR`
  with code `TEMPLATE_TOOLS_PROVIDER_ERROR` and stops, matching
  `thread_agent_kwargs`. A filter that failed open would hand the model exactly
  the tools the caller meant to withhold.

The narrowing is also re-applied inside the run, once a tool batch has been
dispatched. The exemption above keeps a denied tool registered so a human's
answer can reach it, and Strands then carries on in the same run: it
re-dispatches the batch and makes its next model call from the same registry,
which would otherwise still be advertising what the request denied. The two
bridges hook different SDK events for this, because the SDKs read the tool
specs at different points relative to the events they dispatch; the effect is
the same on both.

Scope is the template's own tools. Client-declared tools on
`RunAgentInput.tools` are re-synchronised from the request every turn already,
so a caller that wants fewer of those sends fewer. The hook is not applied on
the multi-agent orchestrator path, which has no template registry to filter.

One deployment note. With an external per-thread agent map, a request-scoped
wrapper is rebuilt per request while the cached thread agent keeps the registry
it already had. If the template's tools are built per request too, the adapter
is handed equivalent but not identical objects, so which registry entry belongs
to the template is decided by name plus "not one of the adapter's other
producers" rather than by object identity alone. Stable tool objects are still
the simpler thing to hand it.

## Human-in-the-loop (native Strands interrupts)

Python frontend tools configured with
`ToolBehavior(continue_after_frontend_call=False)` wait in Strands' native
interrupt checkpoint. Note that `False` is that field's default, so a frontend
tool given a `ToolBehavior` for any other reason waits too. Only
`continue_after_frontend_call=True`, or no `ToolBehavior` at all, keeps the
legacy placeholder path. This is an internal implementation detail; the AG-UI
client contract remains `TOOL_CALL_*` -> successful `RUN_FINISHED` -> an
ordinary `ToolMessage` on the next request. The client does not receive a
frontend-tool interrupt outcome, does not send `resume[]`, and does not receive
a duplicate `TOOL_CALL_RESULT` for its own result.

A waiting frontend tool is not an AG-UI interrupt. An interrupt means the agent
itself paused and is waiting on `resume[]`; a waiting frontend tool is the
ordinary tool-call round trip, and the run still finishes successfully so a
generic interrupt handler does not fire on a tool card it does not own. Native
waiting is only how the adapter parks the call.

Retries are idempotent. Re-sending an answer the checkpoint already holds
verbatim neither resumes Strands nor re-invokes the model, including when a
client replays its full history and repeats an answer alongside a new one. A
_different_ answer for the same call fails with
`FRONTEND_TOOL_RESULT_CONFLICT`.

Strands is the source of truth for active calls, answered calls, partial
responses, mixed checkpoints, and restart recovery. The adapter reads that
checkpoint only to correlate the client's `ToolMessage` by the native Strands
`toolUseId`, which is also the AG-UI `tool_call_id`. Missing, blank, duplicate,
or reused native IDs fail loudly; affected model providers should upgrade to a
Strands/provider version that supplies stable IDs or avoid parallel frontend
calls. A tool with no `ToolBehavior`, and one whose
`continue_after_frontend_call` is `True`, retain the legacy placeholder path. This native frontend-wait bridge is currently Python-specific; it does
not claim TypeScript parity.

Tools that pause with `tool_context.interrupt(...)` are bridged to the AG-UI
interrupt round-trip:

- When a run pauses, it finishes with `RUN_FINISHED` carrying a
  `RunFinishedInterruptOutcome` (`outcome.type == "interrupt"`) and one AG-UI
  `Interrupt` per Strands interrupt. Generic native interrupts preserve the
  Strands name as the AG-UI reason, falling back to `"interrupt"` when the
  interrupt carries no name, and the free-form Strands reason under
  `metadata.reason`. The fallback is not quite the same on the two bridges: this
  one reads a blank name as no name and substitutes `"interrupt"`, while
  TypeScript substitutes only for a genuinely absent one and passes a blank
  through. Tools configured with `ToolBehavior(interrupt_on_call=True)`
  instead emit a `tool_call` approval interrupt, which always carries a
  `message`, an `approved` `response_schema`, and
  `tool_name` / `tool_input` / `strandsName` in `metadata`, the same keys the
  TypeScript package publishes. Two keys are conditional: `tool_call_id`, which
  an approval raised without a native tool use has none of, and `reason`, which
  is published only when the native reason carried nothing the other keys could
  hold. Published `tool_input` is
  a detached copy, so inspecting it cannot reach into the SDK's live checkpoint.
  The `ag_ui:tool_call:` name prefix is **reserved** for this adapter's approval
  hook; an interrupt raised anywhere else under that prefix is classified,
  schema-checked and answered as an approval.
  Applies to server-executed tools only. For client-provided tools, gate
  execution in the client — define the tool with a `render` that calls `respond`,
  not a `handler` — since the tool runs in the browser and the adapter has already
  finished the public AG-UI run.
- To resume, the client sends the next `RunAgentInput` on the **same
  `thread_id`** with `resume=[ResumeEntry(interrupt_id=..., status="resolved",
payload=...)]`. The minimum supported Strands release gates its resume on
  truthiness (`if interrupt_.response:`), so a falsy `payload` (`None`,
  `False`, `""`, `0`, `[]`, `{}`) would otherwise re-raise the same interrupt
  and re-run the tool body forever, and every release reads an absent answer
  the same way. To prevent that, `interrupt()` does **not** return `payload`
  directly. It returns an envelope, which is always present and always truthy:

  | `resume` entry                     | what the paused `interrupt()` returns                              |
  | ---------------------------------- | ------------------------------------------------------------------ |
  | `status="resolved"`, any `payload` | `{"response": payload}`                                            |
  | `status="resolved"`, no `payload`  | `{"response": None}`                                               |
  | `status="cancelled"`               | `{"cancelled": True}`, matching the exported `INTERRUPT_CANCELLED` |

  Destructure it with `.get("response")` / `.get("cancelled")`, and do not
  truthiness-check the envelope itself, since it is always truthy on resolve.
  Compare a cancellation by value rather than by identity: `INTERRUPT_CANCELLED`
  is exported so you can match its shape, and every answer is built fresh rather
  than copied from the export, so mutating the export cannot change what a tool
  receives. Treat what you receive as read-only: it is the
  same object Strands records as the answer, so mutating it changes what a later
  replay is compared against. This is the same contract the
  `@ag-ui/aws-strands` TypeScript package applies, so a tool body ports between
  the two unchanged.

- Adapter-managed `interrupt_on_call` approvals are the exception in both
  languages: a resolved approval's `{"approved": bool}` payload is passed through
  raw, because the approval hook reads `approved` off it directly, and anything
  else is answered `{"approved": False}` rather than with the sentinel.
- A frontend tool parked in a native interrupt is a third, Python-only shape. It
  is answered under a reserved key,
  `{"__ag_ui_frontend_tool_response__": {"content": str, "is_error": bool}}`,
  translated from the client's ordinary `ToolMessage`. It has no TypeScript
  counterpart, because that adapter halts the stream for frontend tools instead
  of parking one, so this is not part of the cross-language contract above.
- **Re-execution on resume:** resuming a paused tool re-runs its body from
  the top — any code before the `interrupt()` call executes again. Guard
  side effects that must not repeat:

  ```python
  @tool(context=True)
  def charge_card(tool_context: ToolContext, amount: float) -> str:
      # Unsafe: re-runs (and re-charges) on every resume.
      charge(amount)
      envelope = tool_context.interrupt("confirm_charge", reason={"amount": amount})
      return "cancelled" if envelope.get("cancelled") or not envelope.get("response") else "charged"


  @tool(context=True)
  def charge_card(tool_context: ToolContext, amount: float) -> str:
      # Safe: side effect happens only after the pause resolves.
      envelope = tool_context.interrupt("confirm_charge", reason={"amount": amount})
      if envelope.get("cancelled") or not envelope.get("response"):
          return "cancelled"
      charge(amount)
      return "charged"
  ```

### Persistence and proxy-tool boundaries

| Scenario                                                                        | Support boundary                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native-only pause and resume on the same live wrapper, process, and `thread_id` | Supported without a `SessionManager`; the cached per-thread Strands agent is the checkpoint.                                                                                                                                                                                                                                                                                                 |
| Wrapper recreation or cross-process resume                                      | Requires a compatible durable `SessionManager` that restores the same session and stable Strands `agent_id`.                                                                                                                                                                                                                                                                                 |
| Legacy placeholder proxy and native interrupt in the same checkpoint            | Requires `session_id`, a stable `agent_id`, and a `session_repository` exposing `list_messages()` and `update_message()`, which is what the `INTERRUPT_SESSION_CAPABILITY_ERROR` message itself names. Without a manager the run emits `INTERRUPT_SESSION_REQUIRED`; without those capabilities it emits `INTERRUPT_SESSION_CAPABILITY_ERROR`. The checkpoint is not advertised or consumed. |
| Explicitly waiting frontend tools, alone or mixed with ordinary interrupts      | Uses the native Strands checkpoint. Frontend answers arrive as `ToolMessage`s; ordinary interrupt answers retain `resume[]`. Partial batches are passed through and remain paused until Strands reports the checkpoint complete.                                                                                                                                                             |

Submitted resume batches are validated before streaming or reconciliation.
They must contain unique, non-blank, currently open interrupt ids. An
ordinary-only checkpoint still requires every open interrupt in one batch. A
checkpoint containing explicitly waiting frontend tools may be answered
partially; Strands records the supplied responses and remains paused on its
unanswered siblings. Malformed or unopened entries emit
`INTERRUPT_RESUME_ERROR`; incomplete ordinary-only batches emit
`PARTIAL_RESUME`. These failures leave the checkpoint retryable. If
reconciliation fails while a legacy proxy/native interrupt checkpoint is
active, the run emits `INTERRUPT_RECONCILIATION_ERROR` without finishing or
consuming the checkpoint.

When using a `SessionManager`, keep interrupt payloads and tool results
JSON-safe (no raw `bytes`): Strands' `SessionAgent.to_dict()` — unlike
`SessionMessage.to_dict()` — does not base64-encode `bytes` values, so a
`bytes`-bearing interrupt `reason`/`response`/resume `payload`, or a sibling
`ToolResult` in the same turn, raises `TypeError: Object of type bytes is not
JSON serializable` from `FileSessionManager`/`S3SessionManager` and aborts the
run.

## Fetching URL content sources

A user message may carry an image, document or video as a URL rather than
inline data. The adapter fetches those server-side, so every fetch runs under
a `UrlFetchPolicy`. The default refuses everything but `http`/`https`, refuses
any host that resolves outside the public internet (loopback, private,
link-local, including the cloud metadata endpoints), pins the connection to
the address it validated so a second DNS answer cannot redirect it, re-checks
every redirect hop, refuses a redirect that drops TLS, and bounds both one
attachment and everything a single run fetches.

A deployment whose attachments live on a private CDN or behind split DNS opts
in explicitly:

```python
from ag_ui_strands import StrandsAgent, StrandsAgentConfig, UrlFetchPolicy

agent = StrandsAgent(
    strands_agent,
    name="my-agent",
    config=StrandsAgentConfig(
        url_fetch_policy=UrlFetchPolicy(
            allow_private_networks=True,
            max_attachments=20,
            max_total_bytes=100 * 1024 * 1024,
            max_total_seconds=120.0,
        ),
    ),
)
```

Link-local addresses stay blocked under `allow_private_networks`, and
`allowed_schemes` can only be narrowed, never widened: a scheme with no pinned
transport would resolve the host again at connection time.

A run whose media all fail conversion with no text fallback ends with
`RUN_ERROR` under `MEDIA_RESOLUTION_FAILED`.

## Supported AG-UI Events

The integration supports the following AG-UI event families:

- **Lifecycle**: `RUN_STARTED`, `RUN_FINISHED`, `RUN_ERROR`
- **Text streaming**: `TEXT_MESSAGE_START`, `TEXT_MESSAGE_CONTENT`, `TEXT_MESSAGE_END`
- **Reasoning**: `REASONING_*` events for models with extended thinking
- **Tool calls**: `TOOL_CALL_START`, `TOOL_CALL_ARGS`, `TOOL_CALL_END`, `TOOL_CALL_RESULT`
- **State management**: `STATE_SNAPSHOT`, and `STATE_DELTA` where a
  `custom_result_handler` emits one; the adapter produces no delta of its own
- **Multi-agent**: `STEP_STARTED`, `STEP_FINISHED`, and `MultiAgentHandoff` custom events
- **Generative UI**: `PredictState` custom events for optimistic UI updates
- **Message history**: `MESSAGES_SNAPSHOT` after the opening state snapshot and
  after each `TOOL_CALL_END`, `TOOL_CALL_RESULT` and terminal `TEXT_MESSAGE_END`,
  each carrying the complete thread as known so far. On by default; turn it off
  globally with `StrandsAgentConfig.emit_messages_snapshot`, or per tool with
  `ToolBehavior.skip_messages_snapshot`. The multi-agent orchestrator path emits
  none whatever those say.
- **Multimodal**: Image, document, and video content in user messages (converted to Strands ContentBlock format)
- **Citations**: source passages attached to the assistant message's `metadata` (see below)
- **Custom**: `PredictState`, `MultiAgentHandoff`, `AgentStopped` (an abnormal
  model stop reason) and `hook_error` (a developer callback that threw), all as
  `CUSTOM` events keyed by `name`
- **Interrupts**: `RUN_FINISHED` carries an interrupt outcome when a backend tool
  or hook paused the run (see above)
- **Raw passthrough**: `RAW` for Strands events this adapter does not map (see
  below)

## Unmapped Strands events reach the client as `RAW`

A Strands stream event with no AG-UI translation is forwarded rather than
dropped, as `RawEvent(event=<payload>, source="strands")`. Bedrock's per-turn
`metadata` (token usage, latency, trace ids) arrives this way, and so does
anything a future SDK release starts emitting before this adapter learns to map
it.

> **`event` is a framework-shaped payload, not an AG-UI one.** Its contents are
> whatever `strands-agents` put on the wire for that event, and the SDK is free
> to change that shape in any release without it being a break in this package.
> Read it defensively, and do not build a required UI path on a field you found
> in it. Anything this adapter promises to keep stable is a mapped event with a
> name, not a `RAW` one.

Forwarding is filtered rather than coerced. Keys belonging to the per-run
invocation state are stripped, since Strands merges them into otherwise public
model events, and a payload that will not survive a strict `json.dumps` /
`json.loads` round trip is dropped with a warning rather than stringified.
Coercing it, with `default=str` for instance, would ship the `repr` of the live
`Agent`, system prompt and conversation history included, to every connected
client.

## Multi-agent orchestration

Pass a Strands `Graph` or `Swarm` where `StrandsAgent(agent=...)` would normally
take an `Agent`. The adapter detects the orchestrator structurally (it has no
`model`) and drives its `stream_async()` directly instead of cloning a
per-thread agent, so per-thread caching, session managers and proxy-tool sync do
not apply: the orchestrator owns its own nodes. Both bridges do this; see
Strands' [Graph](https://strandsagents.com/docs/user-guide/concepts/multi-agent/graph/)
and [Swarm](https://strandsagents.com/docs/user-guide/concepts/multi-agent/swarm/)
guides for what each pattern is for. `/multi-agent` in the demo server is a live
example.

Each node opens a `STEP_STARTED` named `{node_type}:{node_id}` and closes it with
`STEP_FINISHED`, a handoff becomes `CUSTOM` `MultiAgentHandoff` carrying
`from_nodes` / `to_nodes` / `message`, and each node's text and tool calls stream
inside its own message envelope, kept per node so a Graph running a batch
concurrently cannot interleave two nodes into one.

What this path does **not** do, deliberately or otherwise:

- No `MESSAGES_SNAPSHOT`, whatever `emit_messages_snapshot` says. A node's
  `TEXT_MESSAGE_END` is the final carrier for anything riding message metadata,
  citations included.
- No `AgentStopped`. The abnormal-stop hint is emitted from the single-agent
  path only here, where the TypeScript bridge reads it off each node's result
  and does emit one.
- None of the per-tool or per-prompt hooks run, `state_context_builder`
  included, so a hook configured on a `Graph` or `Swarm` is silently inert and
  produces no `hook_error` either.

A node failure is not swallowed. A Python `Graph` fails fast: the first node
exception cancels its siblings and re-raises, so the adapter closes whatever
message and step envelopes are open and ends the run with `RUN_ERROR`. The
TypeScript bridge differs, because its SDK turns a node throw into a FAILED node
result and returns normally there. The orchestration budgets a `Graph` or
`Swarm` is built with escape as ordinary exceptions and report
`STRANDS_ERROR`, since they are not model stop reasons.

Native interrupts work on this path: an orchestrator that pauses reports the
interrupt outcome on `RUN_FINISHED` and is parked for its thread until the
resume arrives.

## One run at a time per thread

A second run starting on a thread that already has one in flight is refused
before the body is entered, with `RUN_ERROR` under `THREAD_BUSY` and the message
`Another run is already in progress on thread "<id>". Wait for RUN_FINISHED
before starting another.` One Strands `Agent` is cached per thread and cannot be
multiplexed, and an unguarded overlap corrupts the cached history rather than
merely racing: the second run's history reconciliation overwrites the first
run's user turn before reaching the model, so the first run answers a question
the transcript no longer contains.

The guard matters more here than on the TypeScript side, not less. The TS SDK
raises `ConcurrentInvocationError` on a second `stream()` against one instance,
so an unguarded overlap there is at least loud. `Agent.stream_async` grew the
same protection only in `strands-agents` 1.22.0. At the declared floor of 1.15.0
nothing is raised and the overlap is silent.

The orchestrator path carries its own arm of the guard, because a shared
orchestrator instance cannot be multiplexed at all: any overlapping run is
refused whatever its thread, and an instance parked at an interrupt is refused
to everyone except the resume for the thread that parked it, under its own
sentence. Passing a callable in place of the orchestrator builds a fresh
instance per run, which narrows the key back to the thread.

The slot is released when the run generator's teardown completes. A caller
driving `agent.run(...)` directly rather than through the transport owes that
generator a `close()`: breaking out of the loop, or pulling one event and
dropping it, leaves the slot held until the event loop finalizes the abandoned
generator, and the thread refuses runs for as long as that takes. The FastAPI
transport closes it explicitly, including on client disconnect. From
`strands-agents` 1.22.0 onward that close is load-bearing for a second reason:
an abandoned invocation holding the SDK's own concurrency lock would block the
thread's next run however promptly this guard released its slot.

The refusal is per adapter instance and no wider. Two instances sharing one
`agents_by_thread` map, which is exactly what request-scoped serverless wrappers
do, each start with an empty busy set and can both accept a run on the same
thread. TypeScript has the same limit.

## Abnormal model stop reasons

A terminal `AgentResult` whose `stop_reason` is `guardrail_intervened` or
`content_filtered` emits `CUSTOM` `AgentStopped` with
`value={"stop_reason": <reason>}` ahead of an ordinary `RUN_FINISHED`, so a UI
can explain a short, empty or filtered answer instead of reading it as success.
`end_turn` and `tool_use` are the normal stops and emit nothing.

The `max_tokens` arm exists in the table but is unreachable in a real run: the
SDK raises `MaxTokensReachedException` as soon as the model reports that stop
reason, so no `AgentResult` is produced and the run reports `STRANDS_ERROR`
instead. TypeScript behaves identically.

Whether a hint can arrive at all is the provider's choice, because the hint is
only as good as the provider's own stop-reason mapping. Read against the Python
SDK's own providers: Bedrock forwards the Converse API's stop reason untouched
and produces both hints; Gemini maps `SAFETY` to `guardrail_intervened` and
produces that one only, and only on releases that carry the `SAFETY` arm at all;
OpenAI's chat-completions and Responses providers collapse everything else to
`end_turn` and produce none; Anthropic forwards its own stop reason untouched, so
a refusal arrives unkeyed and carries no hint. The TypeScript providers map
differently, so that survey does not answer for this one; both are in
[ARCHITECTURE.md](../ARCHITECTURE.md).

## Terminal error codes

Every `RUN_ERROR` code either bridge can emit, and the message text that goes
with each one, is enumerated in
[`../error-codes.json`](../error-codes.json). That file is a wire contract
rather than documentation: clients and mock harnesses match both the code and
the message literally, and both test suites drive their bridge to each terminal
path and assert the emitted frame against it, so a reworded message fails a test
instead of reaching a client.

Most codes are shared with the TypeScript bridge. Where a shared code has a
template at all, it is byte-identical on both sides; two shared codes have none,
carrying a per-side sentence instead, and are discussed below. Two others share a
template and add a sentence one side alone can produce: `THREAD_BUSY` has a
Python-only one for an orchestrator parked at an interrupt, and
`UNKNOWN_INTERRUPT_ID` a TypeScript-only one.

That second one is worth reading before writing a client. Both bridges emit
`UNKNOWN_INTERRUPT_ID` with `No pending interrupts for this thread.` when a
resume arrives on a thread holding none. They diverge only when the thread does
hold open interrupts and the resume names one that is not among them: TypeScript
answers that under `UNKNOWN_INTERRUPT_ID` too, with its own second sentence,
while this bridge rejects it earlier, in the resume preflight, under
`INTERRUPT_RESUME_ERROR`. The one-sided ones are recorded there with the reason: the four
`FRONTEND_TOOL_*` codes of the durable frontend-result recovery path
(`FRONTEND_TOOL_NOT_REGISTERED`, `FRONTEND_TOOL_RESULT_CONFLICT`,
`FRONTEND_TOOL_RESULT_DUPLICATE`, `FRONTEND_TOOL_WAIT_STATE_ERROR`, but not the
shared `FRONTEND_TOOL_IDENTITY_ERROR`) and
`INTERRUPT_RESUME_ERROR` are Python-only, `SEED_BUILD_ERROR` is TypeScript-only,
`THREAD_AGENT_KWARGS_ERROR` is this bridge's half of a failure TypeScript reports
as `THREAD_AGENT_CONFIG_ERROR`, and two shared codes deliberately carry a
different sentence on each side for reasons of their own:
`INTERRUPT_SESSION_CAPABILITY_ERROR` because the capability each side names is a
different SDK API, and `SESSION_MANAGER_INVALID_TYPE` only because the
configuration option it names is spelled `session_manager_provider` here and
`sessionManagerProvider` there.

## Citations

When you give a model documents and turn citations on, its answer comes back
with the passages it drew from: which document, where in that document, and the
text of the passage itself. That is what lets an interface show "according to
quarterly-report.pdf" next to a claim instead of asking the reader to take the
answer on trust. Bedrock calls these citations. Strands documents them only as
an API reference, and only for its TypeScript SDK, at
[`CitationsBlock`](https://strandsagents.com/docs/api/typescript/CitationsBlock/).
The Python SDK models the same concept in `strands.types.citations`, though
narrowly: at the 1.18.0 this project locks, that module declares the three
document location kinds and nothing else, no search-result or web kind and no
`source` field. The wider shape below is what this adapter normalises to, not
what that module declares. The `Bedrock` column says which fields Bedrock
actually sends; it is not a Python-versus-TypeScript column, and the paragraphs
after it are where the two bridges are compared.

The model emits them between the text deltas of the answer, so a citation
arrives in the middle of the message it belongs to. This adapter attaches them
to that message rather than emitting them separately, which is what keeps a
citation joined to the thing it annotates.

### Where they arrive

Under the `citations` key of the assistant message's `metadata`, as a list:

```json
{
  "citations": [
    {
      "title": "quarterly-report.pdf",
      "sourceContent": [{ "text": "revenue grew 12%" }],
      "location": {
        "type": "documentChar",
        "documentIndex": 0,
        "start": 10,
        "end": 26
      },
      "textOffset": 17
    }
  ]
}
```

| Field           | Meaning                                                           | Bedrock |
| --------------- | ----------------------------------------------------------------- | ------- |
| `title`         | Title of the cited source                                         | yes     |
| `sourceContent` | The passage in the source document that supports the answer       | yes     |
| `location`      | Where that passage sits in the source, discriminated by `type`    | yes     |
| `source`        | Source identifier, typically a URL                                | no      |
| `content`       | The generated text the citation supports                          | no      |
| `textOffset`    | UTF-16 code units of this message's text streamed when it arrived | derived |

The `Bedrock` column matters because Strands passes the provider's own citation
through. Bedrock's streaming citation carries `title`, `sourceContent` and
`location` and nothing else, so `source` and `content` are simply absent on that
path. They are in the shape because a provider that does supply them reaches
this key by the same route, and because the TypeScript adapter emits them where
its SDK produces them.

`location` is `{ "type": "documentChar" \| "documentPage" \| "documentChunk",
"documentIndex", "start", "end" }` for document sources,
`{ "type": "searchResult", "searchResultIndex", "start", "end" }` for search
results, and `{ "type": "web", "url", "domain" }` for web ones, where `domain`
is omitted when the provider did not supply one.

A location must arrive in one of two tagged forms: Bedrock's single-key
wrapper (`{"documentChar": {...}}`) or a discriminated object carrying a string
`type`. Anything else cannot be placed, so the location is omitted and a warning
names what was dropped; the citation itself is kept, since a provider that sent
an unreadable location still named a source.

Bedrock names the search-result kind `searchResultLocation` and the Strands
TypeScript SDK renames it to `searchResult`; this adapter applies the same
rename so both bridges agree on it. A kind neither SDK names yet is passed
through here with its own name, and does **not** reach a TypeScript client at
all: that SDK's Bedrock mapper logs an unknown location and drops the citation
with it. The asymmetry is upstream and cannot be normalised away.

A field the provider did not supply is absent rather than empty, and a citation
that names no source is dropped rather than emitted as a bare `textOffset`. The
generated span does not count as naming one, since it is the text being
annotated rather than the thing annotating it. One that will not survive JSON encoding is dropped too, with a
warning: metadata rides an event that is encoded for the stream, and a value
that fails to encode would end the run early.

The key is a plain metadata key, not AG-UI's reserved `ag-ui` one. Metadata is
open by key and user space is yours, so an application already storing something
under `citations` should rename it.

### Where the two adapters agree, and where they do not

For a Bedrock response the Python and TypeScript adapters emit equal citation
objects. That is what the normalisation is for: the TypeScript Strands
SDK coalesces a missing `source` or `title` to `""` and wraps nothing, Python
receives Bedrock's key-wrapped `location` and omits absent fields, and both
adapters converge on the same discriminated, empty-free shape.

They do not agree for every provider. Strands reports the generated span on the
delta rather than on the citation, and only some providers fill it: the
TypeScript SDK's OpenAI Responses adapter supplies `content` and `source`, and
the Python SDK's stream shape has no equivalent field. A provider that supplies
a generated span therefore reaches a TypeScript client with `content` and a
Python client without it.

### How precisely they can be placed

**Message level is the ceiling, and it bounds what a frontend can render.** A
citation locates a span in the _source_ document. It carries no offset into the
answer, and AG-UI has no anchor for a span inside a message, so nothing here can
promise "these words came from that passage".

`textOffset` is the adapter's best effort at closing that gap: it records how
much of the message had been streamed when the citation arrived. Bedrock emits a
citation after the text it supports, which makes the offset the end of the
annotated span in practice, but that is the provider's ordering rather than a
guarantee, so treat a marker placed with it as approximate.

Where a provider reports `content`, that is the generated span itself and is
exact, but no provider reaches this adapter with one: Strands' Python stream
shape has no field for it. A TypeScript client can get it; a Python one cannot.

`textOffset` is counted in **UTF-16 code units**, not characters. The number is
an index into the message text a client holds, and the clients that will slice
with it are browsers, where string indices are UTF-16 units. Both adapters count
the same units, so an answer containing an emoji does not shift the marker on
one side and not the other.

### What a client sees while streaming

The list is republished as it grows, so a client holds a whole prefix at every
point rather than a fragment:

1. A citation arrives and is attached to the next `TEXT_MESSAGE_CONTENT`, so it
   is visible while the answer is still being written.
2. Each publish carries every citation seen so far for that message. Metadata
   merging replaces a key's value rather than appending to it, so the complete
   list is the only correct thing to send.
3. `TEXT_MESSAGE_END` carries the final list, which is how a citation with no
   text after it reaches the client at all.
4. The assistant message inside the following `MESSAGES_SNAPSHOT` carries the
   same list. A snapshot replaces the message a client assembled, so without it
   the citations would vanish the moment one arrived. That also applies to the
   snapshot seeded from `RunAgentInput.messages` at the start of a later turn,
   which is why the rebuild preserves a message's existing metadata.

Citations belong to the message that was open when they arrived. A tool call
closes that message and rotates its id, and the next message starts with none. A
citation that arrives when no message is open has nothing to annotate, so it is
dropped rather than carried onto whatever message comes next, and every drop is
logged: at warning level when it was orphaned, at debug when it arrived after a
tool result already stopped the text stream.

On the multi-agent orchestrator path, each node's citations ride that node's own
message, and there is no `MESSAGES_SNAPSHOT` at all: point 4 above does not
apply there, so the node's `TEXT_MESSAGE_END` is the final carrier. The
TypeScript adapter, which additionally offers a chunked event mode with no
`TEXT_MESSAGE_END`, re-emits that metadata on a final metadata-only chunk for
the same reason. This adapter has no chunked mode, so the question does not
arise here.

## Next Steps

- Add an event queue layer (like the ADK middleware) for resumable streams and non-HTTP transports.
- Expand the test suite as new behaviors land.
