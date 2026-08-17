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

### Conversational Flows

CrewAI 1.15.11's Conversational Flows use the same AG-UI event translation,
state synchronization, tools, reasoning, multimodal content, interrupts, and
generative UI support as regular Flows. Opt the Flow into CrewAI's public
conversation API and register the endpoint with `conversational=True`.

> **Important:** CrewAI builds a Flow's graph from the subclass's own
> `__dict__`, so a subclass that only sets `conversational = True` inherits
> **none** of the base Flow's `@start`/`@listen` methods and runs an empty graph
> (your steps silently never fire). Re-copy the base's flow methods onto the
> conversational type — this is exactly what the dojo's
> `examples/conversational.py::_conversational_type` helper does:

```python
from crewai.experimental.conversational import ConversationConfig

_flow_methods = {
    name: value
    for name, value in MyFlow.__dict__.items()
    if not name.startswith("_") and hasattr(value, "__flow_method_definition__")
}

MyConversationalFlow = type(
    "MyConversationalFlow",
    (MyFlow,),
    {
        **_flow_methods,
        "conversational": True,
        "conversational_config": ConversationConfig(defer_trace_finalization=False),
    },
)

add_crewai_flow_fastapi_endpoint(
    app,
    MyConversationalFlow(),
    "/conversational-flow",
    conversational=True,
)
```

The bridge invokes `flow.stream_turn(message, session_id=thread_id)`: AG-UI's
`threadId` is the CrewAI conversation session ID. It hydrates prior messages into
the Flow state before the current turn, then passes only the latest user message's
text to `stream_turn`, which takes a string. Any media blocks on that message are
therefore not carried on it: they are hydrated as a **separate user message placed
immediately before** the current turn, so the model still sees them in order. Each
HTTP request finalizes its own CrewAI trace even if the Flow's conversation config
would normally defer finalization across turns.

Two things follow from hydration writing onto the Flow's own state. The state has
to be able to hold `messages`, either as a declared field (as `CopilotKitState`
has) or through `extra="allow"`; one that can do neither is refused with a
correlated `RUN_ERROR` rather than served a turn with no history at all. And a
history message whose role CrewAI's conversational `ConversationMessage` cannot
hold is dropped, because one such role anywhere in the history fails validation for
the whole turn. `system` is dropped as well, since CrewAI resolves its own system
prompt for a conversational turn. The accepted role set is read off the installed
CrewAI, never off a version string.

Conversational mode requires CrewAI's ordered `StreamFrame` transport and a Flow
that both sets `conversational=True` and exposes `stream_turn`. If any part of
that contract is unavailable, the endpoint emits a correlated `RUN_ERROR` with
code `AGUI_CREWAI_CONVERSATIONAL_FLOW_UNSUPPORTED`; it never silently falls back
to a regular Flow kickoff. `get_capabilities()["conversationalFlows"]` declares
whether the installed runtime exposes both the required transport and public
turn API.

#### Cancellation is containment, not termination

CrewAI exposes no async turn stream, so conversational mode drives its
**synchronous** `StreamSession` on a background thread. Python cannot safely kill
a running thread, so a client disconnect, an AG-UI timeout, or an outer
cancellation does **not** end the CrewAI turn: it runs until its provider call
and remaining Flow work finish. What the bridge contains, precisely:

- it publishes nothing: no frames, no errors, no completion reach the wire;
- it parks nothing into the request's raw-event buffers, which are dropped on
  teardown;
- **most** of its writes through CrewAI's persistence are refused: once a turn is
  abandoned, its state saves and pause checkpoints are dropped and each drop is
  logged, so a late save cannot land over a newer turn's state. The gate covers
  two of the three ways CrewAI reaches a backend: one you constructed and handed
  to the Flow, and one CrewAI creates lazily when a turn pauses. It does **not**
  cover decorator-level `@persist` **when CrewAI resolves that backend from the
  decorator itself**, through a private per-definition cache the bridge does not
  intercept; such a Flow logs a runtime warning naming the gap, once per Flow class.
  If you passed `persistence=` to the Flow constructor, CrewAI routes `@persist`
  through that same attribute (verified in crewai 1.15.11 at
  `flow/runtime/__init__.py:2942-2946`), so those writes **are** gated and no
  warning is logged. Nothing here extends to writes a flow issues itself (a
  database call inside a task, an outbound API request); those are the flow's own
  to guard;
- it keeps draining its session to natural exhaustion, so CrewAI's own producer
  thread reaches its end sentinel and the `thread.join()` in its frame generator
  returns promptly instead of blocking for the rest of the turn, and the unbounded
  queue behind it stops growing with nobody reading. The frames CrewAI already
  recorded stay on the session either way: `subscribe()` appends every one of them
  to the session (crewai `types/streaming.py:172`), so draining bounds the queue
  and the join, not the memory the turn already holds;
- it holds a slot in a bounded, process-wide worker pool
  (`AGUI_CREWAI_MAX_CONVERSATION_WORKERS`) until it really terminates.

Two refusals follow from that pool. When every slot is in use, a new turn gets a
correlated `RUN_ERROR` with code `AGUI_CREWAI_CONVERSATION_CAPACITY` rather than
another unkillable thread. When an **abandoned** turn for a `threadId` is still
running, a new turn for that same conversation gets
`AGUI_CREWAI_CONVERSATION_THREAD_BUSY`, because two turns writing one
conversation's state, with the abandoned one finishing last, is a correctness
problem and not only a resource one. Both messages carry the pool occupancy and the
oldest abandoned turn's age; the capacity refusal names the knob that lifts it, and
the thread-busy refusal says plainly that the same knob does not.

A conversation here is one **Flow's** `threadId`, not the id on its own. One process
serves many endpoints (the Dojo serves about fifteen) and the client chooses the id,
so an abandoned turn refuses further turns only on the Flow whose state it is still
writing. A paused **regular** Flow's HITL resume is never refused by it either: a
resume is the only way to complete that run, so refusing one strands it.

**Known limitation: the refusal is scoped to abandoned turns, so one persistence
race stays open.** A turn that finished normally is deliberately never marked
abandoned, and its tail keeps running (assistant append, terminal turn handlers,
thread join). Send the next message on that conversation during the tail and it is
accepted, so the older turn's write can still land after the newer turn's. Refusing
instead would block every ordinary back-to-back message for up to a full tail, which
is the worse failure. If your flow's terminal work is slow and order-sensitive, make
its writes idempotent or key them by turn.

#### What actually bounds an abandoned worker

The request-side ceiling (`AGUI_CREWAI_FLOW_TIMEOUT_SECONDS`) bounds the HTTP
response, not the thread. So the question is what ends the turn, and **a provider
timeout is not the answer for a crew-backed flow.**

`AGUI_CREWAI_LLM_TIMEOUT_SECONDS` is a **per-read** timeout on one provider call.
CrewAI then composes it, using defaults you did not choose (values below verified
against crewai 1.15.11):

- the provider client retries a failed call: crewai's native OpenAI completion
  provider hands the client `max_retries = 2`, so one call is up to three
  attempts;
- the agent loops over its own tool results: `Agent.max_iter = 25`, and each
  iteration can make a fresh call;
- the agent re-executes the whole task after a non-litellm error:
  `Agent.max_retry_limit = 2`.

Multiply those out and a 120s per-read timeout permits a single turn of **many
hours**. Shortening the per-read timeout does not fix the shape of that product,
it only changes one factor in it.

**The closest thing to a per-turn bound is `Agent(max_execution_time=...)`, and it
defaults to `None` (no ceiling).** Set it on every agent a Conversational Flow
drives, sized under `AGUI_CREWAI_FLOW_TIMEOUT_SECONDS`; the shipped crew-backed
examples set it. The bridge cannot set it for you: it does not own your agents, and
a ceiling it guessed would cancel legitimate long work.

Be precise about what it buys, because it is weaker than its name suggests. On
crewai 1.15.11 it does **not** cap wall clock: the timed execution runs inside a
`ThreadPoolExecutor` context manager, and once the work is running `future.cancel()`
is a no-op while the block's exit joins the thread (`crewai/agent/core.py:911-921`).
Measured against the installed version, a 1s ceiling around 3s of work returned
after 3.0s, not 1s, and a 0.5s ceiling likewise. What the ceiling does remove is
the task-level retry factor, so the worst case per turn drops
from roughly `225 x T` to roughly `75 x T` for a per-read timeout `T`. With
`T = 120s` that is 9,000s rather than 27,000s.

So there is no hard wall-clock bound on a CrewAI turn today, with or without the
ceiling. Setting it, giving every provider an explicit timeout, and capping your own
model loops shrink the product; they do not close it. Sizing the worker pool
(`AGUI_CREWAI_MAX_CONVERSATION_WORKERS`) is what keeps that residual unboundedness
from consuming the process.

Two smaller things are still worth getting right:

- **Give every provider an explicit timeout anyway.** It is the floor of the
  product above, and without it there is no floor: a crewai
  `Agent(llm="openai/...")` or `Crew(chat_llm="openai/...")` built from a bare
  model id leaves `timeout` unset and inherits the client default (600s on the
  OpenAI SDK and on LiteLLM), which makes each factor 600s instead of 120s. Build
  those with `LLM(model=..., timeout=...)`.
- **Cap your own model loops.** A flow that re-prompts the model over its own
  tool results adds another multiplier that no crewai setting covers. The A2UI
  examples cap it with `MAX_MODEL_TURNS`; a router cycle with no cap yields an
  unbounded turn however short each call is.

`conversation_worker_stats()` reports the live population (active turns, abandoned
turns still running, the oldest abandoned turn's age, and both rejection counters)
for a metrics scrape or a health endpoint. The same numbers are logged on every
abandonment, rejection, and abandoned-worker termination.

The AG-UI dojo presents these as two separate framework choices:

- `crewai`: **CrewAI Flows**, preserving the existing `/crewai/...` URLs and
  including the legacy `crew_chat` example.
- `crewai-conversational-flows`: **CrewAI Conversational Flows**, with the same
  Flow feature matrix under `/crewai-conversational-flows/...`; `crew_chat` is
  intentionally excluded because it is not a Flow.

## Features

- **Native CrewAI integration** – Direct support for CrewAI flows, crews, and multi-agent systems
- **FastAPI endpoint creation** – Automatic HTTP endpoint generation with proper event streaming
- **Predictive state updates** – Real-time state synchronization between backend and frontend
- **Streaming tool calls** – Live streaming of LLM responses and tool execution to the UI
- **Backend tool rendering** – Tools bound to a CrewAI `Agent`/`Crew` run server-side and surface to the UI as a tool call plus a `TOOL_CALL_RESULT`, so the client can render them without executing the tool (see the `backend_tool_rendering` example). Requires the StreamFrame transport (crewai >= 1.6); on crewai 1.0–1.5 the legacy event-bus path does not surface backend tool calls. A tool that returns structured data should return it as a JSON string (e.g. `json.dumps(...)`), since crewai stringifies tool output before it reaches the bridge.

## Protocol surface

### Wire shape: START / CONTENT / END triples (default)

Text and tool-call output is emitted as `TEXT_MESSAGE_START` / `TEXT_MESSAGE_CONTENT`
/ `TEXT_MESSAGE_END` and `TOOL_CALL_START` / `TOOL_CALL_ARGS` / `TOOL_CALL_END`, the
protocol's canonical discrete form. `emission_shape="chunks"` (or
`AGUI_CREWAI_EMISSION_SHAPE=chunks`) opts back into the previous
`TEXT_MESSAGE_CHUNK` / `TOOL_CALL_CHUNK` form.

```python
add_crewai_flow_fastapi_endpoint(app, MyFlow(), "/flow")                     # triples
add_crewai_flow_fastapi_endpoint(app, MyFlow(), "/flow", emission_shape="chunks")
```

The two shapes are **not** equivalent. In `chunks` mode a `copilotkit_emit_state` /
`copilotkit_predict_state` call that lands between two tool-call argument deltas makes
`@ag-ui/client`'s chunk transform close the call and then throw on the next delta;
triples keep the call open server-side, because the server knows more deltas are
coming and the client does not. Triples are also the form any consumer can apply
directly (`apply/default.ts` throws if a chunk reaches it untransformed), so a raw
SSE reader (the Python SDK, conformance tooling, custom clients) needs no
chunk-transform stage.

Both transports (the crewai >= 1.6 `StreamFrame` path and the legacy
event-bus-listener fallback) route through one `EmissionShaper`, so the event shape
and payload never depend on the installed crewai version. A run never ends with an
open sequence: any open message, tool call, or step is closed before `RUN_FINISHED`.
MCP tool executions always use triples regardless of this setting: their name, args
and result arrive together rather than streamed.

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

### Memory is isolated per `threadId` (default ON)

A crew served with `Crew(memory=True)` keeps its memories in one on-disk store,
namespaced by the _crew name_. Nothing in that namespace derives from the AG-UI
`threadId`, so without help every chat served by an endpoint reads and writes the
same namespace and one user's remembered facts surface in another user's chat.
(Setting `inputs["id"] = thread_id` does not help: that scopes crewai's flow-state
persistence, a different subsystem.) `Agent(memory=True)` has the same shape one
level down: the agent builds its _own_ memory, which crewai prefers over the
crew's.

The bridge closes that by giving each request a `MemoryScope` view of the crew's
memory — and of each agent's own memory — rooted at a path derived from the
request's `threadId`. Threads are mutually invisible; each still sees its own
history across sequential runs. One physical store, no directory-per-thread
sprawl.

Because crewai picks the executing agent off `task.agent` (or `manager_agent`
under the hierarchical process) and reaches the crew's memory through
`agent.crew`, the request gets shallow _views_ of the crew, its agents and its
tasks, wired to each other. Nothing shared between concurrent requests is
mutated, and everything below the views (tools, LLMs, knowledge, the store
itself) stays shared.

```bash
# Opt out: restore the pre-fix behaviour of one memory namespace per crew,
# shared by every chat. Useful when the crew is a durable knowledge base
# rather than a per-conversation memory.
AGUI_CREWAI_THREAD_SCOPED_MEMORY=false
```

Limitations, in order of how likely you are to hit them:

- **Only crews and agents the bridge can reach are scoped.** That means the crew
  you passed to `add_crewai_crew_fastapi_endpoint`, plus any crew or standalone
  agent your `Flow` holds as an attribute (a crew's own agents and tasks come
  with it). A crew or agent _constructed inside_ a flow method is created after
  this point and is not scoped; construct it as a flow attribute, or pass it a
  `Memory` you scope yourself.
- **Per-request views are shallow.** Each request runs against copies of the
  crew, its agents and its tasks, so `crew.tasks[0].output` on the object you
  built is not filled in by a bridge-served run; read the run's result off the
  AG-UI event stream instead.
- **Isolation is logical, not physical.** All threads share one store and one
  embedder; a scope keeps reads and writes inside a namespace, it is not a
  security boundary against code that queries the store directly.
- **Older crewai degrades rather than crashing.** The bridge probes for crewai's
  unified memory view API at runtime. On a build without it, isolation is not
  active and the bridge logs one warning saying exactly that.

### `get_capabilities()`

Returns a capability declaration (the CrewAI counterpart of
`LangGraphAgent.get_capabilities`). `crewai.__version__` appears only as
informational metadata, never as a gate.

```python
from ag_ui_crewai import get_capabilities

get_capabilities(llm=my_agent.llm, emit_raw_events=True)
```

`transport`, `rawEvents`, `reasoning`, `conversationalFlows`, and `crewChat` come
from runtime probes; `humanInTheLoop` and `state` are static declarations of what
the bridge implements today. `emit_raw_events` defaults to re-reading the
environment, so pass the same value your endpoint was registered with if you want
the declaration to describe _that_ endpoint.

Reasoning surfaces as first-class `REASONING_*` events (`REASONING_START` /
`REASONING_MESSAGE_START` / `REASONING_MESSAGE_CONTENT` / `REASONING_MESSAGE_END` /
`REASONING_END`, plus `REASONING_ENCRYPTED_VALUE` for signature / redacted-thinking
blocks), **provider-agnostic** and on **both** transports. It needs neither
`emit_raw_events` nor the `StreamFrame` transport. Three channels feed it:

- **litellm delta** (`copilotkit_stream`): reads `reasoning_content` /
  `thinking_blocks` for any reasoning-capable model routed through litellm
  (deepseek-reasoner, Anthropic extended thinking, Bedrock, xAI,
  gemini-via-litellm, and reasoning models normalised by litellm). This is the
  provider-agnostic path and drives the crew-serving path in `crews.py` too.
- **native `LLMThinkingChunkEvent`** (crewai's Gemini provider, crewai >= 1.10.1):
  an additional source on the `StreamFrame` path.
- **OpenAI Responses API** (`copilotkit_responses`): OpenAI's reasoning models
  expose their reasoning **summaries** only here, and carry none at all on
  chat-completions, so an OpenAI trace needs this channel. Open the stream with
  `copilotkit_responses(...)` and hand it to the same `copilotkit_stream(...)`,
  which returns the same chat-shaped `ModelResponse` either way. Pass
  `reasoning={"effort": ..., "summary": "auto"}`: without a `summary` OpenAI
  streams no summary deltas and the run succeeds with no trace. Probe
  `responses_channel_available()` first to degrade to chat-completions on a
  litellm without the `aresponses` entrypoint. See
  `examples/agentic_chat_reasoning.py`.

crewai capabilities are probed at runtime, never version-gated. litellm is the one
deliberate exception: it is a direct dependency whose version this package
controls, so the Responses event vocabulary is covered by the declared
`litellm>=1.70.4,<2` range instead of by probing litellm internals. Below that
floor, litellm raises on the reasoning-summary delta types this channel reads
(1.60.2 through 1.67), or pins `openai<1.76`, which cannot co-exist with the
`openai>=2.30` crewai 1.15 needs (1.68.0 through 1.70.2). `pyproject.toml` carries
the full measurement, including the two 1.70.x versions that were never published. **This raises the previous `litellm>=1.60.2` floor**, so a
consumer pinned below 1.70.4 must upgrade litellm. Both ends of the range run the
full suite in CI: the floor leg is pinned and gating, the ceiling leg resolves the
newest 1.x at install time and reports as a warning, since its input moves whenever
litellm publishes. Neither leg gates a merge until its job name is added to the
branch's required status checks.

`reasoning.supported` is therefore True whenever a reasoning channel is live (the
litellm channel is effectively always live, as litellm is a direct dependency). A
non-reasoning model simply emits nothing (graceful no-op). `requiresEmitRawEvents`
is `False`. `responsesApiChannel` reports whether the OpenAI Responses channel
resolved; it and `responses_channel_available()` both read the same probe. The
`nativeGeminiProvider` / `resolvedProvider` fields are informational (the native
event is an extra source, not a requirement), and `thinkingEventAvailable` reports
whether the native Gemini event resolved.

## Tuning knobs

The integration reads seven `AGUI_CREWAI_*` environment variables in total. The
four documented in this section tune timeouts, teardown behaviour, and
conversational worker capacity. The other three are feature switches, each
documented with the feature it controls: `AGUI_CREWAI_EMISSION_SHAPE`
([wire shape](#wire-shape-start--content--end-triples-default)),
`AGUI_CREWAI_EMIT_RAW_EVENTS` ([RAW passthrough](#raw-passthrough-opt-in-default-off)),
and `AGUI_CREWAI_THREAD_SCOPED_MEMORY`
([memory isolation](#memory-is-isolated-per-threadid-default-on)).
Checkpointing adds its own `CREWAI_CHECKPOINT*` variables, which follow crewai's
naming rather than this package's.

Sensible defaults ship with the package; override the four below only if your
deployment has specific needs (long-running crews, disconnect-heavy workloads,
flaky LLM providers).

### `AGUI_CREWAI_LLM_TIMEOUT_SECONDS`

Per-read timeout forwarded to `litellm.acompletion` in
`ChatWithCrewFlow.chat`. It applies to all three completion sites: the
initial call, the post-crew-run follow-up (tool-choice=`"none"`) that
lets the assistant speak about the crew result, and the post-`crew_exit`
(tool-choice=`"none"`) call.

Every shipped example flow reads the same variable for its own provider calls
(`_config.resolve_provider_timeout_seconds()`). That includes the calls that do
not go through `litellm` directly: the two examples that drive a real crewai
`Agent` / `Crew` build their `LLM` with the resolved timeout, and the A2UI
auto-injection examples hand the render sub-agent a model dict carrying it, so no
shipped example leaves an individual provider call unbounded. Bounding each call
is not the same as bounding a turn: see
[What actually bounds an abandoned worker](#what-actually-bounds-an-abandoned-worker).

Your own flows do not inherit any of this. Pass `timeout=` to your provider calls,
and give crewai `LLM` objects an explicit `timeout=` rather than handing
`Agent(llm=...)` / `Crew(chat_llm=...)` a bare model id. Build one instance per
owner, too: a streaming kickoff calls `enable_agent_streaming`, which sets
`stream = True` on whichever `LLM` the agent holds and never restores it (crewai
`crews/utils.py:54`), so a single object behind both an `Agent` and a
`Crew(chat_llm=...)` carries that setting across.

> **Limitation — no tool chaining after a crew run.** The post-crew-run
> follow-up uses `tool_choice="none"`, so the assistant summarizes the crew
> result as text but cannot call a frontend action in the same turn. A flow
> like "run the crew, then update the UI" is not reachable on this path
> today; allowing bounded tool re-entry there is future work.

- **Default:** `120` seconds.
- **Non-positive** (e.g. `0`, `-1`): stops the integration from passing a timeout
  of its own. This does **not** mean "no timeout". The provider client
  substitutes its own default: LiteLLM turns an absent timeout into 600s
  (`litellm/main.py:1059`), and the OpenAI SDK client defaults to a 600s read
  timeout. So disabling the knob raises the per-call floor to roughly 10 minutes
  rather than removing it, and since 600s is also the default flow ceiling, the
  integration logs a warning saying so. Only use it when you are setting a shorter
  timeout yourself.
- **Non-finite** (`nan`, `inf`): falls back to the default.
- **Should be shorter than `AGUI_CREWAI_FLOW_TIMEOUT_SECONDS`.** A per-read timeout
  that is not shorter than the request ceiling guarantees a worker that outlives
  the request it serves, and the integration warns when it is not, including when
  the knob is disabled, which leaves the client's own 600s meeting a 600s ceiling.
  Keeping it shorter does not by itself bound the turn, because crewai multiplies it
  by its retry and iteration defaults: see
  [What actually bounds an abandoned worker](#what-actually-bounds-an-abandoned-worker).
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
- **Conversational mode:** the ceiling bounds the AG-UI HTTP response, not
  the CrewAI worker. Conversational Flows drive a synchronous `StreamSession`
  on a background thread that cannot be closed from the request loop, so a
  hung upstream call keeps that worker alive until it emits or returns. What ends
  the worker is a per-agent execution ceiling, not this knob and not the provider
  timeout: see
  [What actually bounds an abandoned worker](#what-actually-bounds-an-abandoned-worker).
- **The async StreamFrame path is bounded, not free of pinned work.** It cancels
  the CrewAI kickoff task, which unwinds the async machinery promptly. Sync Flow
  methods CrewAI has delegated to a worker thread (via `asyncio.to_thread`) keep
  running until their own timeout, because cancelling the awaiting task does not
  interrupt the thread. A flow whose sync method blocks on an unbounded provider
  call pins that thread on either path.

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

### `AGUI_CREWAI_MAX_CONVERSATION_WORKERS`

Process-wide ceiling on concurrently-active **sync conversational workers**
(conversational mode only; regular and crew endpoints are unaffected). Bounds
the population of threads an abandoned turn can leave behind.

- **Default:** `16`.
- **Non-positive or unparseable**: falls back to the default and warns once.
  Deliberately not disable-able, because an abandoned worker cannot be killed, so
  an unbounded population is a guaranteed leak rather than a tuning choice. The two
  cases warn differently: a value that parsed but was refused by policy (`0`,
  `-1`) says so, rather than being reported as an unrecognised value.
- On exhaustion a new turn gets a correlated `RUN_ERROR` with code
  `AGUI_CREWAI_CONVERSATION_CAPACITY`; no additional thread is started.
- A slot is reserved before the turn opens and released only when the worker
  actually terminates, so `conversation_worker_stats()` never reports capacity
  a thread still holds. The slot is keyed by (Flow, `threadId`), so raising this
  ceiling never affects the per-conversation refusal and vice versa.
- Size it against your worst-case turn duration, not your request rate, and note
  that a per-read provider timeout is a poor proxy for that duration:
  [What actually bounds an abandoned worker](#what-actually-bounds-an-abandoned-worker).

## To run the dojo examples

The dojo server and its demo flows are a separate project next door, so they are not
part of this package. It needs a checkout of the
[ag-ui repository](https://github.com/ag-ui-protocol/ag-ui) and does not work from an
installed release.

```bash
cd integrations/crew-ai/python/examples
uv sync
uv run dev
```

See [`examples/README.md`](examples/README.md) for the routes it mounts and the
environment variables it reads.
