# AWS Strands Integration for AG-UI

This package exposes a lightweight wrapper that lets any `strands.Agent` speak the AG-UI protocol. It mirrors the developer experience of the other integrations: give us a Strands agent instance, plug it into `StrandsAgent`, and wire it to FastAPI via `create_strands_app` (or `add_strands_fastapi_endpoint`).

## Prerequisites

- Python 3.10+
- `poetry` (recommended) or `pip`
- A Strands-compatible model key (e.g., `GOOGLE_API_KEY` for Gemini)

## Quick Start

The `examples/server/__main__.py` module mounts all demo routes behind a single FastAPI app. Run:

```bash
cd integrations/aws-strands/python/examples
poetry install
poetry run python -m server
```

It exposes:

| Route                     | Description                  |
| ------------------------- | ---------------------------- |
| `/agentic-chat`           | Frontend tool demo           |
| `/backend-tool-rendering` | Backend tool rendering demo  |
| `/shared-state`           | Shared recipe state          |
| `/agentic-generative-ui`  | Agentic UI with PredictState |

This is the easiest way to test multiple flows locally. Each route still follows the pattern described below (Strands agent → wrapper → FastAPI).

## Architecture Overview

The integration has three main layers:

- **StrandsAgent** – wraps `strands.Agent.stream_async`. It translates Strands events into AG-UI events (text chunks, tool calls, PredictState, snapshots, reasoning/thinking, multi-agent steps, etc.).
- **Configuration** – `StrandsAgentConfig` + `ToolBehavior` + `PredictStateMapping` let you describe tool-specific quirks declaratively (skip message snapshots, emit state, stream args, send confirm actions, etc.).
- **Transport helpers** – `create_strands_app` and `add_strands_fastapi_endpoint` expose the agent via SSE. They are thin shells over the shared `ag_ui.encoder.EventEncoder`.

See [ARCHITECTURE.md](../ARCHITECTURE.md) for diagrams and a deeper dive.

## Key Files

| File                            | Description                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------- |
| `src/ag_ui_strands/agent.py`    | Core wrapper translating Strands streams into AG-UI events                      |
| `src/ag_ui_strands/config.py`   | Config primitives (`StrandsAgentConfig`, `ToolBehavior`, `PredictStateMapping`) |
| `src/ag_ui_strands/endpoint.py` | FastAPI endpoint helper                                                         |
| `examples/server/api/*.py`      | Ready-to-run demo apps                                                          |

## Amazon Bedrock AgentCore considerations

If you are planning to deploy your agent into Amazon Bedrock AgentCore (AC), please note that AC expects the following:

- The server is running on port 8080.
- The path `/invocations - POST` is implemented and can be used for interacting with the agent.
- The path `/ping - GET` is implemented and can be used for verifying that the agent is operational and ready to handle requests.

To implement the path mentioned above, you can use the helper function `create_strands_app` and pass the agent interaction path and the ping path as shown below:

```python
    create_strands_app(agui_agent, "/invocations", "/ping")
```

You can also use the helper functions `add_strands_fastapi_endpoint` and `add_ping` for adding the mentioned paths to a FastAPI app that you are creating separately:

```python
    add_strands_fastapi_endpoint(app, agent, "/invocations")
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

For the complete deployment walkthrough, see [Deploy AG-UI servers in AgentCore Runtime](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-agui.html).

## Human-in-the-loop (native Strands interrupts)

Tools that pause with `tool_context.interrupt(...)` are bridged to the AG-UI
interrupt round-trip:

- When a run pauses, it finishes with `RUN_FINISHED` carrying a
  `RunFinishedInterruptOutcome` (`outcome.type == "interrupt"`) and one AG-UI
  `Interrupt` per Strands interrupt. Generic native interrupts preserve the
  Strands name as the AG-UI reason and the free-form Strands reason under
  `metadata.reason`. Tools configured with `ToolBehavior(interrupt_on_call=True)`
  instead emit a `tool_call` approval interrupt with an `approved` response
  schema. Applies to server-executed tools only. For client-provided tools, gate
  execution in the client — define the tool with a `render` that calls `respond`,
  not a `handler` — since the tool runs in the browser and the adapter has already
  halted the run.
- To resume, the client sends the next `RunAgentInput` on the **same
  `thread_id`** with `resume=[ResumeEntry(interrupt_id=..., status="resolved",
payload=...)]`. Strands' resume gate is truthiness-based (`if
interrupt_.response:`), so a falsy `payload` (`None`, `False`, `""`, `0`,
  `[]`, `{}`) would otherwise re-raise the same interrupt and re-run the tool
  body forever. To prevent that, `interrupt()` does **not** return `payload`
  directly — it returns a truthy envelope: `{"response": payload}` on
  resolve, `{"cancelled": True}` on cancel. Destructure it with
  `.get("response")` / `.get("cancelled")`. Adapter-managed
  `interrupt_on_call` approvals are the exception: their
  `{"approved": bool}` payload is passed through directly.
- For generic native interrupts, `status="cancelled"` resumes the tool with
  the sentinel `{"cancelled": True}` (`ag_ui_strands.INTERRUPT_CANCELLED`)
  so it can treat the pause as a denial. An adapter-managed approval receives
  `{"approved": False}` instead.
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

| Scenario                                                                        | Support boundary                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Native-only pause and resume on the same live wrapper, process, and `thread_id` | Supported without a `SessionManager`; the cached per-thread Strands agent is the checkpoint.                                                                                                                                                                                                     |
| Wrapper recreation or cross-process resume                                      | Requires a compatible durable `SessionManager` that restores the same session and stable Strands `agent_id`.                                                                                                                                                                                     |
| Frontend proxy and native interrupt in the same checkpoint                      | Requires `session_id` plus `session_repository.list_messages()` and `session_repository.update_message()`. Without a manager the run emits `INTERRUPT_SESSION_REQUIRED`; without those capabilities it emits `INTERRUPT_SESSION_CAPABILITY_ERROR`. The checkpoint is not advertised or consumed. |

Submitted resume batches are validated atomically before streaming or
reconciliation. They must contain at least one unique, non-blank, currently
open interrupt id, and every open interrupt must be addressed in the batch.
Malformed or unopened entries emit `INTERRUPT_RESUME_ERROR`; incomplete batches
emit `PARTIAL_RESUME`. These failures leave the checkpoint retryable. If
reconciliation fails while an interrupt checkpoint is active, the run emits
`INTERRUPT_RECONCILIATION_ERROR` without finishing or consuming the checkpoint.

When using a `SessionManager`, keep interrupt payloads and tool results
JSON-safe (no raw `bytes`): Strands' `SessionAgent.to_dict()` — unlike
`SessionMessage.to_dict()` — does not base64-encode `bytes` values, so a
`bytes`-bearing interrupt `reason`/`response`/resume `payload`, or a sibling
`ToolResult` in the same turn, raises `TypeError: Object of type bytes is not
JSON serializable` from `FileSessionManager`/`S3SessionManager` and aborts the
run.

## Supported AG-UI Events

The integration supports the following AG-UI event families:

- **Lifecycle**: `RUN_STARTED`, `RUN_FINISHED`, `RUN_ERROR`
- **Text streaming**: `TEXT_MESSAGE_START`, `TEXT_MESSAGE_CONTENT`, `TEXT_MESSAGE_END`
- **Reasoning**: `REASONING_*` events for models with extended thinking
- **Tool calls**: `TOOL_CALL_START`, `TOOL_CALL_ARGS`, `TOOL_CALL_END`, `TOOL_CALL_RESULT`
- **State management**: `STATE_SNAPSHOT`
- **Multi-agent**: `STEP_STARTED`, `STEP_FINISHED`, and `MultiAgentHandoff` custom events
- **Generative UI**: `PredictState` custom events for optimistic UI updates
- **Multimodal**: Image, document, and video content in user messages (converted to Strands ContentBlock format)

## Next Steps

- Add an event queue layer (like the ADK middleware) for resumable streams and non-HTTP transports.
- Expand the test suite as new behaviors land.
