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
- **Backend tool rendering** – Tools bound to a CrewAI `Agent`/`Crew` run server-side and surface to the UI as a tool call plus a `TOOL_CALL_RESULT`, so the client can render them without executing the tool (see the `backend_tool_rendering` example). Requires the StreamFrame transport (crewai >= 1.6); on crewai 1.0–1.5 the legacy event-bus path does not surface backend tool calls. A tool that returns structured data should return it as a JSON string (e.g. `json.dumps(...)`), since crewai stringifies tool output before it reaches the bridge.

## Protocol surface

### RAW passthrough (opt-in, default OFF)

`emit_raw_events=True` mirrors the crewai events this bridge does **not** map onto
AG-UI `RAW` events: crewai's llm / agent / task / tool channels (including
`llm_thinking_chunk`), nested-flow lifecycle events, and internals such as `cc_env`.
Events the bridge already maps are never duplicated as RAW.

```python
add_crewai_flow_fastapi_endpoint(app, MyFlow(), "/flow", emit_raw_events=True)
# or, without a code change:  AGUI_CREWAI_EMIT_RAW_EVENTS=1
```

It is off by default deliberately: LangGraph shipped RAW passthrough on and the
payload bloat had to be walked back. RAW payloads are large and can carry prompt and
completion text, so enabling it widens what leaves your process.

Requires the `StreamFrame` transport: the installed crewai must expose it (>= 1.6)
**and** the served flow must expose `astream`, which the driver probes per flow. On
the legacy event-bus fallback the bridge logs one warning per process and emits no
RAW events, because that listener never sees the unmapped events.

RAW mirrors never precede `RUN_STARTED`. crewai raises some events before the flow
opens, and a `RAW` first event makes the reference client reject the whole stream, so
those are held and released once the run has opened. Both RAW buffers are bounded; a
saturated buffer degrades mirroring (logged) rather than the run.

### `get_capabilities()`

Returns a capability declaration (the CrewAI counterpart of
`LangGraphAgent.get_capabilities`). `crewai.__version__` appears only as
informational metadata, never as a gate.

```python
from ag_ui_crewai import get_capabilities

get_capabilities(llm=my_agent.llm, emit_raw_events=True)
```

`transport`, `rawEvents`, `reasoning` and `crewChat` come from runtime probes;
`humanInTheLoop` and `state` are static declarations of what the bridge implements
today. `emit_raw_events` defaults to re-reading the environment, so pass the same
value your endpoint was registered with if you want the declaration to describe
*that* endpoint.

Reasoning surfaces as first-class `REASONING_*` events (`REASONING_START` /
`REASONING_MESSAGE_START` / `REASONING_MESSAGE_CONTENT` / `REASONING_MESSAGE_END` /
`REASONING_END`, plus `REASONING_ENCRYPTED_VALUE` for signature / redacted-thinking
blocks), **provider-agnostic** and on **both** transports. It needs neither
`emit_raw_events` nor the `StreamFrame` transport. Two channels feed it:

- **litellm delta** (`copilotkit_stream`): reads `reasoning_content` /
  `thinking_blocks` for any reasoning-capable model routed through litellm
  (deepseek-reasoner, Anthropic extended thinking, Bedrock, xAI,
  gemini-via-litellm, and reasoning models normalised by litellm). This is the
  provider-agnostic path and drives the crew-serving path in `crews.py` too.
- **native `LLMThinkingChunkEvent`** (crewai's Gemini provider, crewai >= 1.10.1):
  an additional source on the `StreamFrame` path.

`reasoning.supported` is therefore True whenever a reasoning channel is live (the
litellm channel is effectively always live, as litellm is a direct dependency). A
non-reasoning model simply emits nothing (graceful no-op). `requiresEmitRawEvents`
is `False`. The `nativeGeminiProvider` / `resolvedProvider` fields are
informational (the native event is an extra source, not a requirement), and
`thinkingEventAvailable` reports whether the native Gemini event resolved.

## Tuning knobs

The CrewAI integration exposes three environment variables for tuning
timeouts and teardown behaviour. Sensible defaults ship with the
package; override these only if your deployment has specific needs
(long-running crews, disconnect-heavy workloads, flaky LLM providers).

### `AGUI_CREWAI_LLM_TIMEOUT_SECONDS`

Per-read timeout forwarded to `litellm.acompletion` in
`ChatWithCrewFlow.chat`. It applies to all three completion sites: the
initial call, the post-crew-run follow-up (tool-choice=`"none"`) that
lets the assistant speak about the crew result, and the post-`crew_exit`
(tool-choice=`"none"`) call.

> **Limitation — no tool chaining after a crew run.** The post-crew-run
> follow-up uses `tool_choice="none"`, so the assistant summarizes the crew
> result as text but cannot call a frontend action in the same turn. A flow
> like "run the crew, then update the UI" is not reachable on this path
> today; allowing bounded tool re-entry there is future work.

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
