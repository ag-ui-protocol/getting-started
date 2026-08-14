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

See [ARCHITECTURE.md](ARCHITECTURE.md) for diagrams and a deeper dive.

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

Requests to the AC endpoint must be authenticated. You can configure your agent runtime to accept JWT bearer tokens (via Amazon Cognito) or use SigV4. See [Set up authentication](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-agui.html) in the AgentCore documentation.

For details on how AgentCore handles AG-UI requests, event streaming, and error formatting, see the [AG-UI protocol contract](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-agui-protocol-contract.html).

To deploy, use the [AgentCore Starter Toolkit](https://github.com/awslabs/bedrock-agentcore-starter-toolkit):

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
  `Interrupt` per Strands interrupt. Native interrupts use the AG-UI reason
  `tool_call`; the Strands name and free-form reason are preserved under
  `metadata.strands_name` and `metadata.strands_reason`.
- To resume, the client sends the next `RunAgentInput` on the **same
  `thread_id`** with `resume=[ResumeEntry(interrupt_id=..., status="resolved",
payload=...)]`. Strands' resume gate is truthiness-based (`if
interrupt_.response:`), so a falsy `payload` (`None`, `False`, `""`, `0`,
  `[]`, `{}`) would otherwise re-raise the same interrupt and re-run the tool
  body forever. To prevent that, `interrupt()` does **not** return `payload`
  directly — it returns a truthy envelope: `{"response": payload}` on
  resolve, `{"cancelled": True}` on cancel. Destructure it with
  `.get("response")` / `.get("cancelled")`.
- `status="cancelled"` resumes the tool with the sentinel
  `{"cancelled": True}` (`ag_ui_strands.INTERRUPT_CANCELLED`) so it can
  treat the pause as a denial.
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
open interrupt id; a partial subset of the open native interrupts is allowed.
Invalid batches emit `INTERRUPT_RESUME_ERROR` and leave the checkpoint
retryable. If reconciliation fails while an interrupt checkpoint is active,
the run emits `INTERRUPT_RECONCILIATION_ERROR` without finishing or consuming
the checkpoint.

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
