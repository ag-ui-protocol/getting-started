# ag-ui-crewai

Implementation of the AG-UI protocol for CrewAI.

Provides a complete Python integration for CrewAI flows and crews with the AG-UI protocol, including FastAPI endpoint creation and comprehensive event streaming.

## Installation

```bash
pip install ag-ui-crewai
```

## Usage

```python
from crewai.flow.flow import Flow, start
from litellm import acompletion
from ag_ui_crewai import (
    add_crewai_flow_fastapi_endpoint,
    copilotkit_stream,
    CopilotKitState
)
from fastapi import FastAPI

class MyFlow(Flow[CopilotKitState]):
    @start()
    async def chat(self):
        response = await copilotkit_stream(
            await acompletion(
                model="openai/gpt-4o",
                messages=[
                    {"role": "system", "content": "You are a helpful assistant."},
                    *self.state.messages
                ],
                tools=self.state.copilotkit.actions,
                stream=True
            )
        )
        self.state.messages.append(response.choices[0].message)

# Add to FastAPI
app = FastAPI()
add_crewai_flow_fastapi_endpoint(app, MyFlow(), "/flow")
```

## Features

- **Native CrewAI integration** – Direct support for CrewAI flows, crews, and multi-agent systems
- **FastAPI endpoint creation** – Automatic HTTP endpoint generation with proper event streaming
- **Predictive state updates** – Real-time state synchronization between backend and frontend
- **Streaming tool calls** – Live streaming of LLM responses and tool execution to the UI

## Tuning knobs

The CrewAI integration exposes three environment variables for tuning
timeouts and teardown behaviour. Sensible defaults ship with the
package; override these only if your deployment has specific needs
(long-running crews, disconnect-heavy workloads, flaky LLM providers).

### `AGUI_CREWAI_LLM_TIMEOUT_SECONDS`

Per-read timeout forwarded to `litellm.acompletion` in
`ChatWithCrewFlow.chat` (both the initial call and the post-`crew_exit`
tool-choice=`"none"` call).

- **Default:** `120` seconds.
- **Non-positive** (e.g. `0`, `-1`): disables the per-read timeout —
  the underlying HTTP client's default applies instead.
- **Non-finite** (`nan`, `inf`): falls back to the default.
- **Note:** LiteLLM forwards this as a **per-read** timeout to the
  underlying HTTP client, not a session-level ceiling. A trickle-feeding
  server can keep the coroutine alive indefinitely at this layer; use
  `AGUI_CREWAI_FLOW_TIMEOUT_SECONDS` for the session-level cap.

### `AGUI_CREWAI_FLOW_TIMEOUT_SECONDS`

Hard wall-clock ceiling on a single flow run. Guards against a runaway
flow (hung LiteLLM stream, infinite loop in a user task) pinning the
process indefinitely.

- **Default:** `600` seconds (10 minutes).
- **Non-positive**: disables the ceiling. Only use this for
  deployments with legitimately long-running crews where the wall-clock
  ceiling is handled at a higher layer.
- **Non-finite** (`nan`, `inf`): falls back to the default.
- When the ceiling fires, the stream yields a `RUN_ERROR` event with
  code `AGUI_CREWAI_FLOW_TIMEOUT` and a message carrying the configured
  ceiling plus thread/run correlation IDs.

### `AGUI_CREWAI_CANCEL_JOIN_TIMEOUT_SECONDS`

Teardown ceiling: the total wall-clock budget for `_cancel_and_join` to
unwind the kickoff task after a client disconnect, timeout, or error.
Covers the grace window, force-cancel join, AND outer-cancel recovery
— one shared monotonic deadline, not three.

- **Default:** `10` seconds.
- **Non-positive** or **non-finite**: falls back to the default
  (deliberately not disable-able — a cancel that cannot be bounded is a
  resource leak).
- Tune upward if your deployment sees disconnect-heavy load and a
  consistently-stuck cancel warning is logged.

## To run the dojo examples

```bash
cd integrations/crew-ai/python
uv sync
uv run dev
```
