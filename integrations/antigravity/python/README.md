# AG-UI ⚡ Google Antigravity

Implementation of the [AG-UI protocol](https://github.com/ag-ui-protocol/ag-ui)
for [Google Antigravity](https://github.com/google-antigravity/antigravity-sdk-python).

Antigravity is not a Python agent loop. The SDK drives a bundled Go
`localharness` subprocess over a WebSocket, and that subprocess does real file
and shell work on the host. So this is an **ADK-class integration** — stateful
and session-based — not a stateless LangGraph-class one. The stream translation
is small; the session lifecycle is the substance.

Sessions share those subprocesses rather than owning one each — see
[Harness pooling](#harness-pooling).

## Why the HITL story is unusually clean

Antigravity's hooks and custom tools are **async, awaited, and carry no
timeout**. When the model needs a human, the Go harness calls into Python and
blocks on the returned coroutine. That awaited coroutine is a *native suspension
primitive*: the integration emits AG-UI events, parks an `asyncio.Future`, lets
the SSE response for run *N* close, and resolves the future from run *N+1*. The
model's tool result is the tool's actual return value — no proxy tool, no
fire-and-forget long-running-tool workaround.

This depends on the Go side not abandoning a pending hook while the stream is
closed, which the SDK source could not answer. It was verified empirically
(`tests/test_parking_gate.py`, and the live gate described below): the harness
survived **45 s and 180 s** parks with the consumer detached and resumed
correctly in both cases.

## Install

```bash
pip install ag-ui-antigravity
```

`google-antigravity` ships platform-specific wheels (~32 MB) that bundle the
`localharness` binary; no separate download step is needed.

## Usage

```python
from ag_ui_antigravity import AntigravityAgent, create_antigravity_app

agent = AntigravityAgent(
    model="gemini-3.6-flash",
    api_key="...",                       # or GEMINI_API_KEY in the environment
    system_instructions="You are a helpful assistant.",
    workspaces=["/path/to/a/sandbox"],
)

app = create_antigravity_app(agent, path="/")
```

Serve several demo agents from one process by passing a mapping:

```python
app = create_antigravity_app({
    "agentic_chat": chat_agent,
    "human_in_the_loop": hitl_agent,
})
```

### OpenAI-compatible endpoints

```python
agent = AntigravityAgent(model="gpt-4.1-mini", base_url="http://localhost:11434")
```

Pass the **root** URL, not `.../v1` — the harness appends
`/v1/chat/completions` itself. (The SDK's own docstring example is misleading
on this point.)

## Event mapping

| Antigravity `Step` / signal | AG-UI event(s) |
|---|---|
| `run()` entry | `RUN_STARTED` |
| first `content_delta` on a step | `TEXT_MESSAGE_START` |
| subsequent `content_delta` | `TEXT_MESSAGE_CONTENT` (the delta, not `content`) |
| same step reaches `DONE` | `TEXT_MESSAGE_END` |
| `thinking_delta` | `THINKING_TEXT_MESSAGE_*` |
| `TOOL_CALL` (built-in / MCP) | `TOOL_CALL_START` / `ARGS` / `END` / `RESULT` |
| `start_subagent` | `STEP_STARTED` / `STEP_FINISHED` around the delegated work |
| `FINISH.structured_output` | `STATE_SNAPSHOT` (or `CUSTOM`) |
| iterator exhaustion | `RUN_FINISHED` |
| raised `Antigravity*Error` | `RUN_ERROR` (except a mid-stream cancel, which ends `RUN_FINISHED`) |
| parked hook (question / approval) | `RUN_FINISHED` with an interrupt outcome |
| parked frontend tool | `RUN_FINISHED`, no outcome — the client replies with a `ToolMessage` |
| step with `status=ERROR` | `RUN_ERROR` |

Two details that only show up against a live harness:

* Steps whose `source` is `USER` are the harness echoing the prompt back. They
  are never translated — doing so would replay the user's own message as
  assistant output.
* **Failures usually arrive as a step, not an exception.** `receive_steps()`
  raises only for `source=SYSTEM` errors carrying HTTP 400/401/403. Rate limits,
  5xx and model-side failures are *yielded* with `status=ERROR`, so a loop that
  only catches exceptions reports them to the client as an empty success. The
  run loop inspects `status` for exactly this reason.
* **Built-in tool results have no fixed key.** The harness reports a tool's
  outcome by *growing* the `args` dict at DONE, under a tool-specific name
  (`list_directory` adds `results`). Some tools — `view_file` — add nothing at
  all, because their output goes to the model out of band. The translator
  therefore takes whatever keys appeared after the call was first seen. A
  failure is reported in words (`TOOL_CALL_RESULT` has no error channel), and
  so is "completed with no output" — an empty string would make the two
  indistinguishable and render a failed call as a successful one.
* **`TOOL_CALL_ARGS` deltas are concatenated by the client**
  (`function.arguments += delta`), so everything sent for one call must join
  into a single JSON document. Antigravity hands over the whole args dict each
  time rather than streaming fragments, and *grows* it with the result at DONE
  — and a grown JSON object is not a string extension of the smaller one. The
  args are therefore sent once; the result travels on `TOOL_CALL_RESULT`.

## Human-in-the-loop

Three cases, one primitive (emit → park a Future → resolve from the next run):

* **Frontend tools** — every `RunAgentInput.tools` entry becomes a custom async
  Antigravity tool built from its JSON Schema. The client answers with a
  `ToolMessage` carrying the `tool_call_id`.
* **Model questions** — `OnInteractionHook` maps `AskQuestionInteractionSpec`
  onto a `RunFinishedInterruptOutcome`; the client answers via
  `RunAgentInput.resume`.
* **Tool approval** (`tool_approval=True`) — `PreToolCallDecideHook` round-trips
  an approval interrupt. Registering it also satisfies the SDK's mandatory
  safety guard, so write and MCP tools stop raising without a separate policy.
  It needs a client that implements the interrupt protocol — the dojo answers
  `ToolMessage`s, not `resume` entries, so the demos leave it off.

### One turn, several runs

An Antigravity *turn* that parks on a human spans several AG-UI *runs*, and on
each later run the harness re-delivers the steps of that turn it has already
sent. Three pieces of state are therefore scoped to the turn, not the run, and
are retired together by `AntigravitySession.reset_stream()`:

* the `receive_steps()` iterator (and any in-flight `__anext__()`, which is
  parked rather than cancelled — cancelling discards the step being delivered),
* the `EventTranslator`, which records which steps and tool calls it has
  already finished,
* the bridge's per-turn frontend-tool results.

Without this, every run re-translates the same tool call, the client re-executes
it, and the conversation never converges.

### Repeated tool calls

The harness escalates a slow custom tool to a **background task** and lets the
model continue without waiting for it. The model then commonly re-issues the
call — sometimes with slightly different arguments — which would make the client
run a side-effecting action a second time.

So a frontend tool is dispatched to the client **at most once per turn**. An
identical repeat gets the cached result; a repeat with different arguments gets
a plain statement of what already ran, so the model reports the result instead
of retrying. Set `deduplicate_tool_calls=False` if a tool is genuinely meant to
run repeatedly within one turn.

### Server-side tools

Pass your own Python callables as `tools=[...]` and they run in this process,
with the call and its result streamed to the client — that is what the dojo's
`backend_tool_rendering` demo draws its weather card from.

The adapter emits those events itself rather than reading them off the step
stream, because the harness reports a custom tool as a **single**
`TOOL_CALL`/`ACTIVE` step: there is no DONE step, and `Step` carries no result
field at all, since the return value goes back over the WebSocket straight to
the model. A client waiting for a `TOOL_CALL_RESULT` from the step stream would
wait forever. Built-in tools are different — the harness re-reports those at
DONE with their output folded into the call arguments.

The wrapper preserves each function's signature and docstring, so the SDK still
derives the same tool schema. Return a JSON-serializable value (or a string);
a raised exception is reported to the client as
`There was an error executing <tool>: ...` and re-raised.

### Built-in tools worth disabling

The harness exposes its whole built-in toolset by default. `search_web` returns
an *empty* summary unless the harness has Google credentials — the model then
retries it indefinitely and the conversation never settles. Pass a
`CapabilitiesConfig(enabled_tools=[...])` naming only what the agent needs;
`BuiltinTools.FINISH` must stay, since the harness uses it to end a turn. The
chat demos in `examples/` enable nothing else.

## Sessions

`SessionManager` keys a live `Conversation` by `thread_id`.

* **Hot resume** — a session with a parked coroutine stays in memory, because a
  suspended coroutine cannot be serialized. It gets a longer grace period than
  an idle session rather than an exemption: `parked_timeout_seconds` (2 h)
  instead of `session_timeout_seconds` (30 min). A run in flight holds the
  session lock and is never reclaimed.

  A session occupies memory for its whole life, not only while parked — from
  the first message on a `thread_id` until it times out, is evicted at
  `max_sessions`, or is rebuilt because the client's tool set changed. Parking
  does not allocate anything; it extends how long the allocation is held.
* **Cold resume** — a recycled session with nothing parked is rebuilt from
  `conversation_id` + `session_continuation_mode` + `save_dir`.

Because Antigravity fixes the tool list in the harness config at connect time,
a client that changes its `tools` between runs forces a cold-resume rebuild
rather than running against a stale list.

## Harness pooling

Sessions do **not** get a subprocess each. A `HarnessPool` shares one
`localharness` process between up to `max_conversations_per_process` (default 8)
conversations, because Antigravity configures a harness twice:

| sent | when | contains |
|---|---|---|
| `InputConfig` | process stdin at startup | `save_dir`, `env` |
| `HarnessConfig` | WebSocket, **per conversation** | tools, model, system instructions, capabilities, MCP servers, hooks, subagents, `response_schema`, `conversation_id`, **`workspaces`** |

Almost everything varying per thread — including `workspaces`, so per-thread
filesystem isolation is unaffected — is per-conversation. Only `save_dir` and
`env` are process-wide, and they form the pool's partition key.

Measured with 8 concurrent conversations (`gpt-4.1-mini`, one turn each):

| | pooled (1 process) | one process each |
|---|---|---|
| idle | **101 MB** | 752 MB |
| mid-turn | **154 MB** | 1040 MB |
| wall clock | 12.7 s | 12.3 s |

So an extra idle conversation costs ~1 MB rather than ~95 MB. Throughput is
unchanged; per-turn p50 rises ~1.3× only when all 8 turn simultaneously. A
20-second tool call in one conversation was measured **not** to delay its
neighbours (median inflation 0.95× against a control).

Set `max_conversations_per_process=1` to go back to one process per thread.

### Several agents in one server

Each `AntigravityAgent` owns a pool, so a server hosting four agents gets four
harness processes — a ~95 MB floor per agent, independent of traffic. It does
not affect scaling (threads of one agent still share), and it affects nothing
about correctness, but it is silent: you find out by counting processes.

Sharing needs **both** a pool and a `save_dir`. Passing only `harness_pool=`
changes nothing, because each agent otherwise mints its own `tempfile.mkdtemp()`
save directory and `save_dir` is half the pool's partition key:

```python
from ag_ui_antigravity.harness_pool import HarnessPool

pool = HarnessPool()
save_dir = "/var/lib/myapp/antigravity"      # both, or you still get a process each

chat = AntigravityAgent(model=..., harness_pool=pool, save_dir=save_dir)
research = AntigravityAgent(model=..., harness_pool=pool, save_dir=save_dir)
```

Agents that must not share process-level storage should keep separate
`save_dir` values — they will land on separate processes by design. See
`examples/server/api/_common.py`.

* **Blast radius.** One dead process fails every conversation on it. They raise
  promptly rather than hanging (`test_process_death_raises_rather_than_hangs`),
  but this is the tradeoff pooling buys — hence the modest default.
* **Parked sessions.** Parking and pooling compose: a conversation parked on a
  human does not block its co-tenants
  (`test_a_parked_conversation_does_not_block_its_siblings`). But a parked
  session pins its process, and the pool cannot know in advance which
  conversations will park, so under park-heavy load the saving is bounded by
  fragmentation rather than by the ~1 MB marginal figure.
* **Not a tenancy boundary.** `save_dir` is shared by every conversation on a
  process. Use `workspaces` for isolation, and give tenants separate `save_dir`
  values (which partitions them onto separate processes) if storage must be
  isolated too.

## Operational notes

* **Sandboxing.** Real filesystem and shell access, scoped per conversation by
  `workspaces`. Multi-tenant hosting needs per-thread workspace isolation,
  resource caps, and reliable cleanup. Always set `workspaces=[...]`.
* **SDK churn.** `google-antigravity` is young; the dependency is pinned to
  `<0.2.0` deliberately.

### Keep workspace paths short

A long workspace path makes runs fail intermittently, and the failure looks
nothing like its cause.

If a prompt leads the model to write an absolute path into a tool call — "read
`/var/folders/0t/pq2_7rn97834lcsvc_qy4t8r0000gn/T/ag-ui-antigravity-wz_4xjbd/notes.txt`"
— it sometimes reproduces that path wrongly, truncating it or repeating a chunk
of it. macOS temp directories are ~75 characters of high-entropy text, which is
about the worst case. Measured on `gpt-4.1-mini`: **0/14 runs failed with a
9-character workspace path, 2/14 with a 75-character one.**

The harness treats the resulting bad path as a fatal
`AntigravityExecutionError` rather than returning the error for the model to
retry, so the whole run dies mid-tool-call with
`RUN_ERROR: The model produced an invalid tool call`. Nothing in that message
points at path length.

Set `ANTIGRAVITY_WORKSPACE` (or `workspaces=[...]`) to something short and
stable — `/srv/agents/w1`, not a generated temp directory. This is a model
limitation rather than an integration bug: it reproduces identically on older
commits.

### Known gaps in `google-antigravity` 0.1.8–0.1.9 (OpenAI-compatible path)

These are upstream, not integration bugs. They affect only `base_url` usage:

1. **No API-key field.** `GemmaEndpoint` carries only `base_url`, and the Go
   harness reads no `OPENAI_API_KEY`. The path targets unauthenticated local
   servers (Ollama, LM Studio). Authenticated endpoints need a proxy that
   injects the header — see `examples/server/openai_proxy.py`.
2. **Gemini-shaped tool schemas.** Custom-tool schemas are generated with
   `api_option="GEMINI_API"`, emitting proto-style uppercase types (`"STRING"`)
   that OpenAI rejects. The example proxy normalizes them. Tools registered via
   `ToolWithSchema` — which is how this integration builds *frontend* tools —
   pass their schema through untouched and are unaffected.
3. **`session_continuation_mode` dropped.** `LocalOpenAIAgentConfig.create_strategy`
   does not forward it, disabling cold resume. Worked around by
   `_ResumableOpenAIConfig` in `agent.py`.

### Tool calls do not stream their arguments

Not specific to the OpenAI path, and not workable around: the harness hands over
a tool call **fully formed, in a single step**. Measured with a custom tool
whose argument was 1850 characters — still one `TOOL_CALL` step carrying the
complete arguments. Presumably the Go side parses the model's tool-call JSON
before dispatching, since it needs valid JSON to invoke anything, and surfaces
the parsed call rather than the token stream.

So `TOOL_CALL_ARGS` arrives as one delta rather than filling in progressively.
There are no fragments to forward; this would need the harness to expose partial
tool-call deltas. What *does* stream is the call lifecycle: the call is emitted
as soon as the harness dispatches it, so a client renders its pending state
while the tool runs and swaps in the result when it returns.

## Not implemented yet

Deliberate gaps, so the surface above is not mistaken for more than it is:

* **Triggers** (async inbound messages) and **multimodal input** — the SDK
  supports both; nothing here maps them to AG-UI yet.
* **`STATE_DELTA`** — structured output is emitted as whole snapshots only.
* **MCP servers** — passed through to the SDK config and covered by the
  approval hook, but not exercised by a live test.
* **`predictive_state_updates` / `shared_state`** dojo features — the state
  plumbing exists (`STATE_SNAPSHOT` from `structured_output`) but no demo agent
  is wired for them, so they are not listed in the dojo menu.
* Subagent bracketing is unit-tested against recorded step shapes, not against
  a live multi-agent run.

## Development

```bash
uv sync
uv run pytest          # 239 unit tests; live tests are deselected by default
```

The live checks start a real harness subprocess and call a real model:

```bash
export OPENAI_API_KEY=...
uv run pytest tests/ -m live
```

`tests/test_parking_gate.py` is the important one — it re-verifies the Go-side
no-timeout property the whole HITL design depends on. Raise the park duration
to reproduce the long soak:

```bash
PARK_SECONDS=180 uv run pytest tests/test_parking_gate.py -m live
```

### Dojo

```bash
# terminal 1
cd examples
ANTIGRAVITY_USE_OPENAI=1 OPENAI_API_KEY=... uv run dev     # serves on :8027

# terminal 2
cd apps/dojo && pnpm dev
```

`pnpm run-dojo-everything` starts it alongside the other integrations.

Then open `/antigravity/feature/agentic_chat`.

## Verification status

Verified against `google-antigravity` 0.1.8 and `gpt-4.1-mini` via the example
shim:

| Check | Result |
|---|---|
| 239 unit tests (translator, bridge, sessions, endpoint) | pass |
| 6 live tests (streaming, multi-turn, frontend-tool park/resume, built-in tools, SSE, parking gate) | pass |
| 15 TypeScript tests + typecheck + build | pass |
| Harness parked with the stream closed, then resumed (manual soak at 45 s and 180 s; the committed default is 30 s) | pass |
| Dojo `agentic_chat`, `human_in_the_loop`, `tool_based_generative_ui`, `backend_tool_rendering` | pass, in-browser |
| Multi-tool turn (`"weather in Tokyo? then set the background…"`) converges in 2 runs, 8/8 trials | pass |
| `/capabilities` payload against `AgentCapabilitiesSchema` (zod) | valid |
