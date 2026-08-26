# AWS Strands Integration Architecture

This document explains how the AWS Strands integration inside `integrations/aws-strands/` is implemented today. It covers the Python adapter (FastAPI) and the TypeScript adapter (Express), which share the same AG-UI event contract; the Python implementation is the reference, and the TypeScript adapter documents only what it does differently.

---

## System Overview

```
┌─────────────┐      RunAgentInput        ┌────────────────────────────┐
│  AG-UI UI   │ ────────────────────────► │ AG-UI HttpAgent (standard) │
└─────────────┘   (messages,              │  e.g., @ag-ui/client       │
                   tools, state)          └──────────────────┬─────────┘
                                                             │ HTTP(S) POST + SSE
                                                             ▼
                                                ┌────────────────────────────┐
                                                │ Transport endpoint         │
                                                │ Python:     FastAPI        │
                                                │ TypeScript: Express        │
                                                └─────────────┬──────────────┘
                                                              │
                                                              ▼
                                                 ┌─────────────────────────┐
                                                 │ StrandsAgent adapter    │
                                                 │ python/src/ag_ui_strands│
                                                 │ typescript/src          │
                                                 └─────────────┬───────────┘
                                                              │
                                                              ▼
                                        Python:     strands.Agent.stream_async()
                                        TypeScript: Agent.stream() (async iterator)
```

1. The browser (or any AG-UI client) instantiates the standard AG-UI `HttpAgent` (or equivalent) and targets the Strands endpoint URL; there is no Strands-specific SDK on the client.
2. The client sends a `RunAgentInput` payload that contains the current thread state, previously executed tools, shared UI state, and the latest user message(s).
3. The transport layer (`add_strands_fastapi_endpoint` in Python, `addStrandsExpressEndpoint` in TypeScript) registers a POST route that deserializes `RunAgentInput`, instantiates an `EventEncoder`, and streams whatever the `StrandsAgent` yields.
4. `StrandsAgent.run` wraps a concrete Strands `Agent` instance, forwards the derived user prompt into the streaming call, and translates every event into AG-UI protocol events (text deltas, tool invocations, snapshots, etc.).
5. The encoded stream is delivered back to the client over `text/event-stream` (or binary protobuf) and rendered by AG-UI without any Strands-specific code on the frontend.

---

## Python Adapter Components

### `StrandsAgent` (`src/ag_ui_strands/agent.py`)

`StrandsAgent` is the heart of the integration. It encapsulates a Strands SDK agent and implements the AG-UI event contract:

- **Lifecycle framing**
  - Emits `RunStartedEvent` before touching Strands.
  - Emits `RunFinishedEvent` when the stream ends normally.
  - Emits `RunErrorEvent` with `code="STRANDS_FORCE_STOP"` when Strands reported a forced stop, and `code="STRANDS_ERROR"` from the outer exception handler for any other failure that escapes the run loop. The forced-stop error is emitted after the reasoning-message and text-message closeout and is the run's last event: a failed run emits no final `StateSnapshotEvent` and no `RunFinishedEvent` at all, so it never advertises a final state or a finish. It is not emitted after a tool-call closeout, because Python has none on this path: the `deferred_frontend_tool_ends` flush sits inside the `try` that consumes the stream, so the raise that ends the run skips it and a frontend tool call left open never gets its `ToolCallEndEvent`. TypeScript deliberately diverges there; see the tool-call bullet under SDK-Shape Differences.
  - Those two are the codes the run loop itself produces; they are not the whole set a client can receive. The request and interrupt preflight emit their own before the loop is entered (`INVALID_PAYLOAD`, `UNKNOWN_INTERRUPT_ID`, `PARTIAL_RESUME`, `INTERRUPT_EXPIRED`, `INTERRUPT_SESSION_REQUIRED`, `INTERRUPT_SESSION_CAPABILITY_ERROR`, `INTERRUPT_RECONCILIATION_ERROR`, `INTERRUPT_RESUME_ERROR`), and the transport emits `ENCODING_ERROR` when a payload cannot be encoded. Treat any list of codes in this document as the codes that clause is about, not as a closed enumeration.
- **Forced stops (`STRANDS_FORCE_STOP`)**
  - Strands reports a mid-cycle failure with a `force_stop` stream event (`ForceStopEvent`, payload `{"force_stop": True, "force_stop_reason": str(reason)}`). The adapter records the reason and keeps consuming the generator so Strands can raise the underlying exception and unwind cleanly, then emits `RunErrorEvent(code="STRANDS_FORCE_STOP")` carrying that reason, or `The Strands agent stopped unexpectedly.` when it is empty.
  - Which SDK failures arrive this way depends on where the exception is raised, not on its type (`strands/event_loop/event_loop.py`):
    - Model-call failures the retry strategy declines to retry (throttling exhausted, provider 5xx, a provider-raised `ContextWindowOverflowException`) are caught inside `_handle_model_execution`, which yields `ForceStopEvent` before re-raising. These report as `STRANDS_FORCE_STOP`.
    - `MaxTokensReachedException` and `StructuredOutputException` are raised in `event_loop_cycle` after the model call already returned, and the cycle re-raises them without a `ForceStopEvent`. These reach the adapter's outer handler and report as `STRANDS_ERROR`.
    - Anything else failing inside the cycle (tool execution, post-stream message bookkeeping) hits the cycle's generic handler, which yields `ForceStopEvent` and then raises `EventLoopException`. These report as `STRANDS_FORCE_STOP`.
  - The recorded reason is never cleared, so a forced stop the SDK later recovers from still ends the run as `STRANDS_FORCE_STOP`: `Agent._execute_event_loop_cycle` forwards the `ForceStopEvent` before catching `ContextWindowOverflowException`, reducing the context, and retrying the cycle.
- **Abnormal stop reasons (`AgentStopped`)**
  - A terminal `AgentResult` whose `stop_reason` is `max_tokens`, `guardrail_intervened` or `content_filtered` produces a `CustomEvent(name="AgentStopped", value={"stop_reason": <reason>})` so a UI can explain a short, empty or filtered answer. `end_turn` and `tool_use` are the normal stops and emit nothing. The run still finishes: the hint precedes the ordinary `RunFinishedEvent`.
  - The `max_tokens` arm is unreachable in a real run. The SDK raises `MaxTokensReachedException` as soon as the model reports that stop reason, so no `AgentResult` is produced and the run reports `STRANDS_ERROR` instead.
  - Whether a hint can arrive at all depends on the provider, because the hint is only as good as the provider's own stop-reason mapping. Read against the Python SDK's own providers (`strands/models`, `strands-agents` 1.52.0); the TypeScript providers map differently and are surveyed separately under the TypeScript adapter, so neither survey answers for the other:
    - Bedrock forwards the Converse API's `stopReason` untouched (`bedrock.py`), so `content_filtered` and `guardrail_intervened` both reach the adapter and both hints are reachable.
    - OpenAI's chat-completions provider maps `tool_calls` to `tool_use` and `length` to `max_tokens` and defaults everything else, `content_filter` included, to `end_turn` (`openai.py`). No hint can ever fire on it. Its Responses provider derives the same three (`openai_responses.py`) and produces no hint either.
    - Gemini maps `SAFETY` to `guardrail_intervened` and `MAX_TOKENS` to `max_tokens`, defaulting the rest to `end_turn` (`gemini.py`), so the guardrail hint is reachable and the filtered one is not. The `SAFETY` arm is recent: it is absent as late as 1.23.0, where every finish reason other than `TOOL_USE` and `MAX_TOKENS` becomes `end_turn` and no hint can fire at all.
    - Anthropic forwards the provider's own `stop_reason` untouched (`anthropic.py`), so a `refusal` arrives unkeyed and carries no hint.
    - There is no Vercel provider in the Python SDK.
- **Messages snapshot emission**
  - Emits `MessagesSnapshotEvent` at four lifecycle boundaries so frontends (notably CopilotKit v2) can rebuild canonical message history rather than reconstructing it from streaming `TOOL_CALL_*` events alone:
    1. After the initial `StateSnapshotEvent`, seeded from `RunAgentInput.messages`.
    2. After each `ToolCallEndEvent`, with the new `AssistantMessage(tool_calls=[…])` appended.
    3. After each `ToolCallResultEvent`, with the new `ToolMessage` appended.
    4. After each terminal `TextMessageEndEvent`, with the new `AssistantMessage(content=…)` appended.
  - Each snapshot carries the _complete_ thread state as known so far. Toggle globally via `StrandsAgentConfig.emit_messages_snapshot` (default `True`); suppress per-tool with `ToolBehavior.skip_messages_snapshot=True`.
- **State priming**
  - If `RunAgentInput.state` is provided, it immediately publishes a `StateSnapshotEvent`, filtering out any `messages` field so the frontend remains the source of truth for the timeline.
  - Optionally rewrites the outgoing user prompt via `StrandsAgentConfig.state_context_builder`.
- **History reconciliation**
  - When the cached per-thread `StrandsAgentCore` has no `session_manager`, the adapter rebuilds Strands' internal `messages` list from `RunAgentInput.messages` before each `stream_async` call. Tool calls are rendered as `toolUse` ContentBlocks on assistant turns and tool results as `toolResult` blocks on user turns, matching Strands' native shape.
  - This fixes the "frontend tool loops forever" symptom: without reconciliation, Strands re-fires the same tool every turn because the result the frontend produced never reaches the LLM context.
  - With a `session_manager`, the adapter trusts the manager and falls back to passing only the latest user prompt as a string.
  - Toggle via `StrandsAgentConfig.replay_history_into_strands` (default `True`).
- **Streaming text**
  - When Strands yields events with a `"data"` field, the adapter opens a new `TextMessageStartEvent` (once per turn), forwards every chunk as `TextMessageContentEvent`, and closes with `TextMessageEndEvent` when the Strands stream completes or is halted.
  - `stop_text_streaming` is toggled when certain tool behaviors demand ending narration as soon as a backend tool result arrives.
- **Tool call fan-out**
  - Strands emits tool usage metadata via `event["current_tool_use"]`. The adapter:
    - Records `tool_use_id`, arguments, and normalized JSON for replay.
    - Emits optional `StateSnapshotEvent` via `ToolBehavior.state_from_args`.
    - Translates declarative `PredictStateMapping` entries into a `CustomEvent(name="PredictState")`.
    - Streams arguments through an optional async generator (`args_streamer`) so large payloads can be revealed progressively.
    - Emits `ToolCallStartEvent`, zero or more `ToolCallArgsEvent`, and `ToolCallEndEvent`.
    - Automatically halts streaming when the call corresponds to a frontend-only tool (identified by matching `RunAgentInput.tools`) unless the configured behavior flips `continue_after_frontend_call`.
- **Tool result handling**
  - Strands encodes tool results inside `"message"` events whose role is `"user"` and whose contents include `toolResult`. The adapter:
    - Parses the blob into Python objects, tolerating single quotes or malformed JSON.
    - Emits a `ToolCallResultEvent` (without a `role` field) so the frontend closes the tool-call card without inserting a duplicate `tool` message into its history, then immediately publishes a `MessagesSnapshotEvent` containing the corresponding `ToolMessage` (skipped when the per-tool `skip_messages_snapshot=True` is set).
    - Executes `ToolBehavior.state_from_result` to hydrate shared state and `custom_result_handler` to emit additional AG-UI events (e.g., simulated progress via `StateDeltaEvent` in the generative UI example).
    - Honors `stop_streaming_after_result` by closing any active text message and halting the Strands stream early.
- **Frontend tool awareness**
  - `input_data.tools` supplies the frontend tool registry. Their names are used to (a) avoid double-invoking tool results that were literally produced by the UI, and (b) stop the Strands run after the LLM has issued a UI-only instruction.
- **Reasoning streaming**
  - When Strands yields events with `reasoningText` and `reasoning=true`, the adapter emits REASONING\_\* events.
  - Emits `ReasoningStartEvent`, `ReasoningMessageStartEvent`, content events, then `ReasoningMessageEndEvent` and `ReasoningEndEvent`.
  - For encrypted/redacted reasoning content (`reasoningRedactedContent`), emits `ReasoningEncryptedValueEvent` with base64-encoded payload.
  - Reasoning events are automatically closed when a `contentBlockStop` event is received.
- **Multi-agent step tracking**
  - Maps Strands `multiagent_node_start` events to `StepStartedEvent` with `step_name` formatted as `{node_type}:{node_id}`.
  - Maps Strands `multiagent_node_stop` events to `StepFinishedEvent`.
  - Emits `CustomEvent(name="MultiAgentHandoff")` for `multiagent_handoff` events, including `from_nodes`, `to_nodes`, and `message` in the value.
- **Multimodal content**
  - When `UserMessage.content` is a `List[InputContent]` containing media (image, document, video), the adapter converts it to Strands `ContentBlock` format.
  - `ImageInputContent` -> `ContentBlock(image=ImageContent(...))` with base64-decoded bytes.
  - `DocumentInputContent` -> `ContentBlock(document=DocumentContent(...))`.
  - `VideoInputContent` -> `ContentBlock(video=VideoContent(...))`.
  - `AudioInputContent` is logged and skipped (Strands SDK has no audio support).
  - Text-only content lists are flattened to a plain string for backward compatibility.
  - Conversion logic lives in `src/ag_ui_strands/utils.py`.

### Configuration Layer (`src/ag_ui_strands/config.py`)

`StrandsAgentConfig` allows each tool to define bespoke behavior without editing the adapter:

| Primitive                                 | Purpose                                                                                                                      |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `tool_behaviors: Dict[str, ToolBehavior]` | Per-tool overrides keyed by the Strands tool name.                                                                           |
| `state_context_builder`                   | Callable that enriches the outgoing prompt with the current shared state (useful for reiterating plan steps, recipes, etc.). |
| `session_manager_provider`                | Factory invoked once per thread to produce a per-thread `SessionManager`.                                                    |
| `emit_messages_snapshot`                  | Global opt-out of the four-point `MESSAGES_SNAPSHOT` emission. Default `True`.                                               |
| `replay_history_into_strands`             | Global opt-out of the per-run Strands history reconciliation. Default `True`.                                                |

`ToolBehavior` captures how the adapter should react:

- `skip_messages_snapshot`: Suppresses the `MessagesSnapshotEvent` that would normally follow this tool's `TOOL_CALL_END` / `TOOL_CALL_RESULT` events. Use when `custom_result_handler` already emits its own snapshot and you want to avoid duplicates.
- `continue_after_frontend_call`: Keeps the stream alive after emitting a frontend tool call.
- `stop_streaming_after_result`: Cuts off text streaming when the backend produced a decisive result.
- `predict_state`: Iterable of `PredictStateMapping` objects that inform the UI how to project tool arguments into shared state before results arrive.
- `args_streamer`: Async generator that controls how tool arguments are leaked into the transcript (e.g., chunk large JSON payloads).
- `state_from_args` / `state_from_result`: Hooks that build `StateSnapshotEvent`s from tool inputs or outputs, enabling instant UI updates.
- `custom_result_handler`: Async iterator that can emit arbitrary AG-UI events (state deltas, confirmation messages, etc.).

Helper utilities:

- `ToolCallContext` / `ToolResultContext` expose the `RunAgentInput`, tool identifiers, arguments, and parsed results to hook functions.
- `maybe_await` awaits either coroutines or plain values, simplifying user-defined hooks.
- `normalize_predict_state` ensures the adapter can iterate predictably over mappings.

### Transport Helpers (`src/ag_ui_strands/endpoint.py` & `utils.py`)

The transport layer is intentionally lightweight:

- `add_strands_fastapi_endpoint(app, agent, path, auth=None)` registers a POST route that:
  - Accepts a `RunAgentInput` body.
  - Evaluates the optional authentication dependency before parsing and validating that body.
  - Instantiates `EventEncoder` using the requester's `Accept` header to choose between SSE (`text/event-stream`) and newline-delimited JSON.
  - Streams whatever `StrandsAgent.run` yields, automatically encoding every AG-UI event.
  - Sends a `RunErrorEvent` with `code="ENCODING_ERROR"` if serialization fails mid-stream.
- `create_strands_app(agent, path="/", ping_path="/ping", origins=None, auth=None, allow_methods=None, allow_headers=None, cors_enabled=None)` bootstraps a FastAPI application and mounts the agent route. For backward compatibility, an implicit wildcard CORS configuration remains available with a `FutureWarning`; callers can pass an exact `origins` allowlist, explicitly acknowledge wildcard access, or disable CORS with `cors_enabled=False`. An optional `auth` dependency guards the agent route (the ping route stays open for health probes).

### Packaging Surface (`src/ag_ui_strands/__init__.py`)

The package exposes only what downstream callers need:

```
StrandsAgent
create_strands_app / add_strands_fastapi_endpoint
StrandsAgentConfig / ToolBehavior / ToolCallContext / ToolResultContext / PredictStateMapping
```

This mirrors other AG-UI integrations (Agno, LangGraph, etc.), so documentation and examples can follow the same mental model.

---

## TypeScript Adapter (`typescript/src/`)

The TypeScript adapter is a line-by-line port of the Python adapter — same splice points, same config primitives, same event emission order. Only the differences below matter; everything else in the Python section above applies unchanged (with camelCase substituted for snake_case, e.g. `stateFromArgs` ↔ `state_from_args`).

### Module Layout

```
typescript/src/
├── agent.ts              ← StrandsAgent (port of agent.py)
├── client-proxy-tool.ts  ← sync of RunAgentInput.tools into Strands registry
├── config.ts             ← StrandsAgentConfig, ToolBehavior, helpers
├── endpoint.ts           ← Express route registration + capabilities endpoint
├── logger.ts             ← injectable Logger interface + internal default
├── types.ts              ← internal SeenToolCall bookkeeping
├── utils.ts              ← content conversion + createStrandsApp factory
└── index.ts              ← public exports
```

### SDK-Shape Differences

These are forced by the upstream SDK and do not reflect behavioral divergence:

- **Event dispatch**: Python matches on dict keys (`event.get("current_tool_use")`, `event.get("data")`, `"message" in event`); TypeScript matches on the typed event `.type` (`modelContentBlockDeltaEvent`, `toolUseInputDelta`, `afterToolCallEvent`). Outcomes map 1:1; each dispatch branch carries a `// Maps to Python's X branch` comment.
- **Tool proxy**: Python uses `PythonAgentTool` + `tool.mark_dynamic()` + raw `tool_registry.registry[…]` dict access. TypeScript uses a plain object implementing the `Tool` interface + `toolRegistry.add()` / `remove()` / `get()`.
- **Content blocks**: Python returns plain dicts from `convert_agui_content_to_strands`; TypeScript returns SDK class instances (`TextBlock`, `ImageBlock`, etc.) which the history replay path unwraps via `toJSON()`.
- **History seeding**: Python mutates `strands_agent.messages` in place after construction. TypeScript consumes `AgentConfig.messages` at construction time, so `buildStrandsSeed` / `convertMessagesForStrandsSeed` produce the seed outside the per-thread init lock (to avoid serialising cold-cache starts behind one slow replay).
- **Template agent cloning**: Python introspects `StrandsAgentCore.__init__` via `inspect.signature` to forward every caller-set kwarg into per-thread clones. TypeScript hardcodes the forwardable fields (`TemplateAgentCloneFields`) because the TS SDK doesn't expose a comparable introspection hook.
- **The Python forced-stop taxonomy below was verified against `strands-agents` 1.52.0, not the declared floor**: everything this section says about which Python failures become a `ForceStopEvent` holds on 1.52.0, where `_handle_model_execution` yields one for any exception escaping the model call once no hook asked for a retry. It does not hold at the `pyproject.toml` floor of `strands-agents>=1.15.0`, nor at the 1.18.0 the `uv.lock` pins. On 1.15.0, 1.18.0 and 1.20.0 the same `except Exception` is gated behind `isinstance(e, ModelThrottledException)` with attempts exhausted, and every other exception is re-raised with no `ForceStopEvent` at all, so on those releases a provider 5xx reports `STRANDS_ERROR` and only exhausted throttling reports `STRANDS_FORCE_STOP`. Confirmed by driving a `Model` that raises a plain `RuntimeError` through `Agent.stream_async` on 1.15.0, 1.18.0, 1.20.0 (no `force_stop` event) and 1.52.0 (one `force_stop` event); the release that introduced the change lies somewhere in (1.20.0, 1.52.0] and was not bisected. The TypeScript adapter carries no version branching for this and is not going to: it mirrors the current Python behaviour, and a deployment pinned to an older `strands-agents` will see the two bridges classify a provider failure differently.
- **Forced-stop signal**: the TS SDK has no `ForceStopEvent` analogue, so a failed cycle simply throws out of `agent.stream()`. The adapter treats that throw as the forced stop: it records the message, breaks out of the loop so stream teardown and the message/tool-call closeout still run, and emits the same `STRANDS_FORCE_STOP` code and the same `The Strands agent stopped unexpectedly.` fallback as Python, last on the wire and after the closeout, as in Python. The failures that bypass the forced stop and reach the outer handler instead (`MaxTokensError`, `StructuredOutputError`, and adapter code defects, the last under `ADAPTER_BUG`) skip that closeout, so an open text or reasoning message stays open ahead of `RUN_ERROR`. That is not an oversight: Python's bare `raise` leaves its own closeout the same way. All of this is the single-agent path only. The orchestrator path reports no forced stop at all, because the failures that reach it are not model stop reasons; see Multi-agent orchestrator mode below.
- **Tool-call ends on a forced stop diverge, deliberately**: the closeout is the same event position for messages, but not for tool calls. Python's `deferred_frontend_tool_ends` flush sits inside the `try` that consumes the stream, so a throw skips it and the closeout it falls through to closes messages only: no `ToolCallEndEvent` reaches the client for a call left open. TypeScript's `_drainPendingToolCalls` sits in the same closeout as the message ends, after the `try`/`finally` that consumes the stream rather than inside its `finally`, so a recorded forced stop reaches it and emits `TOOL_CALL_END` events Python does not. The divergence is kept rather than fixed toward Python: a client that saw `TOOL_CALL_START` and never sees an end holds the call open, and the AG-UI client verifier rejects the run under `INCOMPLETE_STREAM`. Closing an open call before a terminal error is the correct behaviour; matching Python's omission would be worse. The drain is not unconditional, though, and the bypass rethrow path skips it exactly as it skips the message ends: a `MaxTokensError` thrown after `TOOL_CALL_START` leaves the loop through the outer handler and puts `RUN_ERROR` on the wire with no `TOOL_CALL_END` before it. Verified on both branches: the forced stop yields `TOOL_CALL_START`, `TOOL_CALL_ARGS`, `TOOL_CALL_END`, `RUN_ERROR`, and the bypass yields `TOOL_CALL_START`, `TOOL_CALL_ARGS`, `RUN_ERROR`. That gap is pre-existing and not addressed here.
- **Recovered failures are invisible**: Python can see a `ForceStopEvent` for a failure its SDK then recovers from and latches it into the terminal error. Here the throw has already escaped the SDK, so a failure the SDK handled internally never reaches the adapter at all.
- **Stop-reason spelling**: the TS SDK canonicalises provider stop reasons to camelCase (`dist/src/models/bedrock.js` maps Bedrock's `content_filtered` to `contentFiltered`) while Python forwards the provider spelling untouched. `AgentStopped` carries Python's spelling from both bridges so a client matches one value rather than one per language, and `ABNORMAL_STOP_REASONS` accepts both spellings because the SDK's `StopReason` widens to `string`.
- **Provider stop-reason mapping decides whether a hint can arrive at all**: the `AgentStopped` hint is only as good as the provider's own mapping, and the TypeScript providers do not map the way the Python ones do, so this survey answers only for TypeScript (`dist/src/models`, `@strands-agents/sdk` 1.1.0). Bedrock maps `content_filtered` and `guardrail_intervened` (`bedrock.js` `STOP_REASON_MAP`), so both hints are reachable. OpenAI's chat-completions adapter maps `content_filter` to `contentFiltered` (`openai/chat-adapter.js`) and the Vercel provider maps `content-filter` the same way (`vercel.js`), so those two produce the filtered hint but never the guardrail one; OpenAI's Responses adapter derives only `maxTokens`, `toolUse` and `endTurn`, so it produces no hint at all. Gemini maps only `MAX_TOKENS` and defaults every other finish reason to `endTurn` (`google/adapters.js` `FINISH_REASON_MAP`), and `maxTokens` never reaches a terminal result, so a Gemini run never emits `AgentStopped` whatever the model did. Anthropic maps `end_turn`, `max_tokens`, `stop_sequence` and `tool_use` and forwards anything else verbatim (`anthropic.js` `_mapStopReason`), so a `refusal` arrives unkeyed and carries no hint. Two of these disagree with their Python namesakes outright: Python's OpenAI provider collapses `content_filter` to `end_turn` and can never produce the filtered hint, Python's Gemini provider maps `SAFETY` to `guardrail_intervened` and can produce the guardrail one, and Python has no Vercel provider. The same run against the same model can therefore be hinted on one bridge and silent on the other.
- **`maxTokens` never reaches a terminal `AgentResult`**: `dist/src/models/model.js` throws `MaxTokensError` as soon as the aggregated stop reason is `maxTokens`, and no provider overrides `streamAggregated`, so truncation reaches this bridge as a throw rather than as a result. The adapter treats that throw the way Python treats its own: `MaxTokensError` is in `STREAM_ERROR_BYPASS_NAMES`, so it reaches the outer handler and reports `STRANDS_ERROR` with no hint, exactly as Python's `MaxTokensReachedException` does after `event_loop_cycle` re-raises it without a `ForceStopEvent`. Both bridges therefore report truncation identically and neither announces it, which is why the `maxTokens` entry in `ABNORMAL_STOP_REASONS` is a dead mirror of Python's tuple rather than a live branch.
- **Stop reasons with no Python counterpart**: the TS `StopReason` union carries `modelContextWindowExceeded`, which is absent from Python's `StopReason` `Literal` in both `strands-agents` releases checked (1.18.0 and 1.35.0); `cancelled` is in the TS union and in Python 1.35.0 but not 1.18.0. Mirroring runs one way only (TypeScript mirrors Python's spellings), so neither value is surfaced as `AgentStopped`. Neither adapter emits a hint for `stop_sequence` / `stopSequence` either, although both SDKs define it.

### Additions Beyond the Python Adapter

Behaviors the Python adapter does not currently implement, added to match TypeScript-ecosystem expectations or to close conformance gaps. Two entries have since gained Python counterparts and stay listed here because their TypeScript details still diverge: the CORS off switch with its narrowing options, and the route-level auth guard. Each of those bullets says what Python has and where the two differ:

- **Multi-agent orchestrator mode** (`_runOrchestrator`): accepts a Strands `Graph` or `Swarm` in place of a single `Agent` and drives its `.stream()` directly. Per-thread caching, session managers, and proxy-tool sync are bypassed because orchestrators are stateless per invocation. The two paths are at parity on the abnormal-stop hint and nowhere else. `AgentStopped` is emitted from the per-node `agentResultEvent` nested inside `nodeStreamUpdateEvent`, since `MultiAgentResult` and `NodeResult` carry no stop reason of their own, and it does reach the wire on a real `Graph`: a node whose model returns `contentFiltered` or `guardrailIntervened` produces the same `CustomEvent(name="AgentStopped")` with Python's spelling that a lone `Agent` produces, inside the node's own message and step envelopes, and the run still finishes. `orchestrator-real-graph.test.ts` drives that against a real `Graph`, a real `Agent` node and a `Model` subclass, rather than against a stub. Terminal FAILURE is not at parity, and reporting it as if it were would misdescribe it. A provider or model failure inside a Graph node never reaches the adapter at all: `Node.stream()` (`multiagent/nodes.js`) wraps `handle()` in a try/catch and turns any throw into a FAILED `NodeResult`, then returns normally. A real `Graph` whose node model throws emits exactly `RUN_STARTED`, `STATE_SNAPSHOT`, `STEP_STARTED`, `STEP_FINISHED`, `STATE_SNAPSHOT`, `RUN_FINISHED`, with no `RUN_ERROR`, no `CUSTOM` and no `RAW`, while the single-agent path reports the identical failure as `STRANDS_FORCE_STOP`. So a Graph run that failed reports as a run that finished. That is a real gap and this adapter does not close it. What DOES escape `Graph.stream()` / `Swarm.stream()` as a throw is orchestration budgets only: `maxSteps` ("max steps reached"), the wall-clock `timeout`, and the per-node `nodeTimeout`. Those are not model stop reasons, so they are reported by the outer handler as `STRANDS_ERROR` and never under the forced-stop code. Closing the gap needs a policy decision rather than new SDK plumbing, because the signals already arrive here and are discarded: `nodeResultEvent` carries `result.error` for the node that failed, the already-handled `afterNodeCallEvent` carries `.error` when the failure escaped the node (a `nodeTimeout`, say), and the aggregate `MultiAgentResult` returned on `{ done: true }` is dropped too. The aggregate STATUS is the one signal that cannot simply be acted on: `_resolveStatus` (`multiagent/state.js`) marks the aggregate FAILED when ANY node failed, so a Graph that lost one parallel branch and answered from another is FAILED as well, and failing that run would be wrong. What a partially successful Graph owes a client is the unanswered question. Today a node failure leaves no trace anywhere: no AG-UI event, and no adapter log either. `Swarm` is worse off still on the hint, for a reason of its own: it forces a structured-output handoff schema onto every node (`multiagent/swarm.js`), so a node whose model does not invoke that tool fails with "The model failed to invoke the structured output tool even after it was forced." before yielding any `agentResultEvent`, and no hint is emitted at all. Driving the same `contentFiltered` model through a real `Swarm` that a real `Graph` hints on produces no `AgentStopped`. Step envelopes are paired from the SDK's own node brackets and the adapter closes none of its own, so a `STEP_STARTED` whose `afterNodeCallEvent` never arrived stays open whether the run failed or finished. On a failed run that is harmless, because the client verifier checks nothing on `RUN_ERROR`. On a run that finishes it is a protocol violation: the verifier's `RUN_FINISHED` handler rejects an unfinished step first, ahead of its message and tool-call checks, with `Cannot send 'RUN_FINISHED' while steps are still active` (`sdks/typescript/packages/client/src/verify/verify.ts`). Only this path can produce it. Both run loops carry a `beforeNodeCallEvent` / `afterNodeCallEvent` branch, but `AgentStreamEvent`, the union `Agent.stream()` yields, does not include either event (`types/agent.d.ts`): the node brackets live only in `MultiAgentStreamEvent`, so no single-agent run can open a step at all and the single-agent branches are defensive rather than reachable. It is a known pre-existing gap rather than intended behaviour, unchanged by anything in this area and left alone deliberately: draining open steps conflicts with a test that pins the current shape, and deciding what a run owes a step the SDK abandoned is its own question. The orchestrator still has no `cancelSignal` wiring and relies on `.return()` for teardown, unlike the single-agent path's `AbortController`.
- **The one carve-out in the forced-stop guarantee**: a failure raised inside the frontend-tool halt window is swallowed rather than reported, so that run still finishes. Strands signals a frontend-tool halt by throwing a bare `ModelError` with no `cause`, and `_isFrontendHaltSentinel` identifies it by that shape rather than by its message text, because matching the text is what a test explicitly forbids. A real provider failure of the same shape, a plain `Error` with no `cause`, is therefore indistinguishable from the sentinel and is swallowed too. Narrowing the check to the SDK's error subclasses would report healthy halted runs as failures, which is worse, so the exemption stands. It is the only place where a failed turn can still report as a success, and it is stated here rather than left in a docstring because everything else in this section exists to prevent exactly that.
- **`THREAD_BUSY` guard**: `_activeRunsByThread` rejects concurrent runs on the same thread with `RUN_ERROR { code: "THREAD_BUSY" }`. The TS SDK throws `"Agent is already processing an invocation"` if this isn't caught up front; Python's SDK has no equivalent collision.
- **Terminal codes with no Python counterpart**: beyond `THREAD_BUSY`, the TypeScript adapter emits `ADAPTER_BUG` (a `TypeError` or `ReferenceError` escaping either run loop, which is an adapter code defect rather than a provider or SDK failure), plus `SEED_BUILD_ERROR` and `MEDIA_RESOLUTION_FAILED` from its own preflight. Those four are the whole TypeScript-only set. It shares `STRANDS_FORCE_STOP`, `STRANDS_ERROR`, `INVALID_PAYLOAD`, `UNKNOWN_INTERRUPT_ID`, `PARTIAL_RESUME`, `INTERRUPT_EXPIRED`, `ENCODING_ERROR`, `SESSION_MANAGER_ERROR`, `SESSION_MANAGER_INVALID_TYPE` and `PENDING_INTERRUPTS` with Python, which emits the last three from `agent.py` at its session-manager provider boundary and its pending-interrupt gate.
- **`AbortController` wiring**: the Strands `.stream()` call receives a `cancelSignal`; the transport's disconnect listener fires it so Bedrock stops streaming when the HTTP client drops.
- **Request-boundary validation** (`addStrandsExpressEndpoint`): returns `415` for non-JSON `Content-Type`, `400` for bodies that fail the shared Zod `RunAgentInputSchema`, and normalizes snake_case top-level keys (`thread_id`, `run_id`, `parent_run_id`, `forwarded_props`) into camelCase before validating. Python mirrors the media-type boundary in FastAPI: `_require_json_content_type` rejects missing or non-JSON-compatible `Content-Type` values with HTTP `415` before body/model validation, while Pydantic still handles the request body shape validation.
- **Client-disconnect handling**: HTTP/1.1 `res.close` and HTTP/2 `req.aborted` both trigger `iterator.return()`, firing the agent generator's `finally` so the `_activeRunsByThread` slot releases and the Bedrock stream aborts.
- **Protobuf content negotiation**: only selected when `Accept` explicitly contains `application/vnd.ag-ui.event+proto`; `*/*` or omitted Accept falls back to SSE.
- **Capabilities endpoint** (`addCapabilities`, `DEFAULT_CAPABILITIES`, `capabilitiesFor`): optional `GET /capabilities` returning a static matrix of supported event families, transports, and protocol features so frontends don't have to probe empirically.
- **Chunk-event emission** (`emitChunkEvents`): optional flag that collapses explicit `*_START` / `*_CONTENT` / `*_END` triples into `TEXT_MESSAGE_CHUNK` / `TOOL_CALL_CHUNK` / `REASONING_MESSAGE_CHUNK` self-expanding chunks per `concepts/events.mdx`. Halves the event count on high-frequency deltas.
- **`ToolCallContextExtras`** (`buildContextExtras`): `context` + `forwardedProps` are flattened onto every `ToolCallContext` / `ToolResultContext` and passed as a 3rd argument to `stateContextBuilder`, so hooks can read per-request auth tokens / locale without re-parsing `inputData`. Python passes `input_data` directly and callers pull these fields off themselves.
- **Injectable logger** (`StrandsAgentConfig.logger`): matches Python's `logging.getLogger(__name__)` surface. Any `{ debug, warn, error }` record works — wire in pino / winston / bunyan / a silent stub directly. Debug message strings match the Python adapter field-for-field (modulo camelCase) so cross-SDK log diffs are straightforward.
- **`AWSStrandsAgent extends HttpAgent`**: thin client-side shim re-export so AG-UI TypeScript clients can `new AWSStrandsAgent({ url })` instead of constructing a bare `HttpAgent`.
- **Opt-in cross-origin access** (`createStrandsApp`): omitting `corsOrigin` installs no CORS middleware at all, so cross-origin access is a deliberate choice rather than the starting position. This is a live divergence, not a port gap, and the default is the whole of it: Python's `create_strands_app` still defaults to wildcard-open. Unless `cors_enabled=False` is passed it adds `CORSMiddleware` with `allow_origins=origins or ["*"]`, so it falls back to the wildcard even for `origins=[]` (an empty list is falsy, so `origins or ["*"]` selects the wildcard), and it warns about that implicit fallback with a `FutureWarning` rather than refusing it. The two adapters agree on credentials: Python computes `allow_credentials=bool(origins) and not is_wildcard`, and TypeScript's `allowsCredentials` derives the same rule from the resolved origin, so neither pairs credentials with a wildcard and neither offers a way to override the derivation. TypeScript reaches that rule through `normalizeCorsOrigin` first, which collapses any array containing `"*"` to the bare string, so `["*"]` and `["*", "https://app.tld"]` are allow-all rather than allowlists.
- **CORS off switch and narrowing** (`corsEnabled`, `allowMethods`, `allowHeaders`): `corsEnabled` is a veto evaluated before anything is installed, so a caller computing `corsOrigin` elsewhere has one independent kill switch; `corsEnabled: false` also silences `allowMethods` / `allowHeaders` without complaint. `corsEnabled: true` with no origin policy throws at construction rather than installing `cors()` with no `origin`, whose own default is `'*'` and would restore the wildcard by the back door. `allowMethods` / `allowHeaders` reach `cors` as `methods` / `allowedHeaders`, spread in conditionally because `cors` merges options over its defaults with `Object.assign` and an explicit `undefined` clobbers the default. Omitting them keeps the `cors` defaults (`GET,HEAD,PUT,PATCH,POST,DELETE`; request headers reflected from the preflight) rather than Python's `allow_methods=["*"]` / `allow_headers=["*"]`: the `cors` defaults are already narrower, no TypeScript back-compatibility exists to preserve, and widening them would be a security regression rather than parity. Two narrowing hazards are documented rather than defended against, because both are the option doing what it was asked: an empty array is truthy, so `allowMethods: []` / `allowHeaders: []` reach `cors` and make it withhold the header entirely (a deny-all parallel to `corsOrigin: []`, with the preflight still answering `204`, so `createStrandsApp` warns at startup when it installs a policy carrying either), and a narrowed `allowHeaders` that omits `Content-Type` blocks every cross-origin agent call, since the route answers `415` without a JSON `Content-Type` and `application/json` is not CORS-safelisted. Python's `create_strands_app` takes `allow_methods` / `allow_headers` too, defaulting each to `["*"]` when it is `None` and treating `[]` as "allow none" the same way.
- **Route-level auth guard** (`auth` on both `createStrandsApp` and `addStrandsExpressEndpoint`): plain Express middleware (`StrandsAuthMiddleware`), registered as `app.post(path, authGuard(auth), runAgent)` so only `next()` advances to the agent. Express middleware rather than a transliteration of FastAPI's dependency-returns-means-allowed inversion, because middleware is Express's own extension point and the guards users reach for (`express-jwt`, `passport.authenticate(...)`) are already `(req, res, next)`. `authGuard` owns four failure paths so none can hang the request or leak a stack trace: a synchronous throw, a rejected promise (awaited here because Express 4 is in the accepted peer range and does not await handlers), `next(error)` (intercepted rather than forwarded, since Express's default handler serialises the stack into the body outside production), and a middleware that answered the request and then called `next()` anyway. The first three answer `500 {"error":"Internal Server Error"}` and log through the adapter logger. The guard sits ahead of the handler that owns the `415` / `400` boundaries, so an unauthenticated request with a bad `Content-Type` gets `401`; ping and capabilities routes stay open for health probes and capability discovery. Python has the same capability by a different mechanism: `create_strands_app` and `add_strands_fastapi_endpoint` both take an optional `auth` FastAPI dependency that rejects by raising `HTTPException`, with the ping route left open. The divergence is the shape of the hook (Express middleware versus a FastAPI dependency), not whether the agent route can be guarded.

### Transport Helpers

- `addStrandsExpressEndpoint(app, agent, { path, auth })`: Express analogue of `add_strands_fastapi_endpoint`, plus the optional route guard.
- `createStrandsApp(agent, { path, pingPath, capabilitiesPath, capabilities, corsOrigin, corsEnabled, allowMethods, allowHeaders, auth })`: bootstraps an Express app with optional ping / capabilities routes. Cross-origin access is opt-in: omitting `corsOrigin` installs no CORS middleware and emits no `Access-Control-Allow-Origin` header. Passing a value opts in, with `"*"` for local development, a single origin or an exact-match array for production, and `[]` denying every origin. `corsEnabled: false` vetoes all of it; `allowMethods` / `allowHeaders` narrow the installed policy, and either of those or `corsEnabled: true` passed with no origin policy throws.
- `addPing(app, path)` — `GET /ping` returning `{ status: "healthy" }`.
- `addCapabilities(app, path, { agent, overrides })` — `GET /capabilities` returning the advertised matrix; derives chunk flags from the live agent's `emitChunkEvents`.

---

## Example Entry Points

### Python (`python/examples/server/api/*.py`)

The repository includes seven runnable FastAPI apps that showcase different features. Each example builds a Strands SDK agent, wraps it with `StrandsAgent`, and exposes it via `create_strands_app`:

| Module                       | Focus                                                                   | Relevant Configuration                                                                                                               |
| ---------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `agentic_chat.py`            | Baseline text generation with a frontend-only `change_background` tool. | No custom config; demonstrates automatic text streaming and frontend tool short-circuiting.                                          |
| `agentic_chat_reasoning.py`  | Reasoning/thinking event streaming with extended thinking models.       | No custom config; demonstrates REASONING\_\* event emission.                                                                         |
| `backend_tool_rendering.py`  | Backend-executed tools (`render_chart`, `get_weather`).                 | Shows how tool results become `ToolCallResultEvent`s and can be rendered directly in the UI.                                         |
| `shared_state.py`            | Collaborative recipe editor that streams server-side state.             | Uses `state_context_builder`, `state_from_args`, and `state_from_result` to keep the UI's recipe object synchronized.                |
| `agentic_generative_ui.py`   | Predictive and reactive state updates for generative UI surfaces.       | Demonstrates `PredictStateMapping`, `custom_result_handler` emitting `StateDeltaEvent`s, and the `stop_streaming_after_result` flag. |
| `agentic_chat_multimodal.py` | Multimodal image/document analysis with vision-capable model.           | No custom config; demonstrates automatic multimodal content conversion.                                                              |
| `human_in_the_loop.py`       | Human-in-the-loop confirmation flow with frontend tools.                | Demonstrates frontend tool invocation and confirmation actions.                                                                      |

### TypeScript (`typescript/examples/server/api/*.ts`)

The TypeScript package ships the same seven Python examples under the matching filenames (`agentic-chat.ts`, `agentic-chat-reasoning.ts`, `agentic-chat-multimodal.ts`, `backend-tool-rendering.ts`, `shared-state.ts`, `agentic-generative-ui.ts`, `human-in-the-loop.ts`) plus one TypeScript-only addition:

| Module                        | Focus                                                                                                                                                                               |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tool-based-generative-ui.ts` | Frontend-rendered tool (haiku card) auto-registered as a proxy tool — exercises the `TOOL_CALL_*` stream the dojo's `tool_based_generative_ui` page consumes. No Python equivalent. |

Each file is self-contained and can be run standalone (`pnpm <name>` from `examples/`). `examples/server/server.ts` is a "dojo" that mounts all eight at the paths the Python reference server uses, so both implementations can be driven by the same curl payloads.

Both example sets double as integration tests: they exercise every built-in hook so regressions surface quickly during manual QA.

---

## Event Semantics Recap

| Strands Signal                                                    | Adapter Reaction                                                                           | AG-UI Consumer Impact                                                                        |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `stream_async` yields `{"data": ...}`                             | Emit text start/content/end                                                                | Updates conversational transcript incrementally.                                             |
| `stream_async` yields `{"reasoningText": ..., "reasoning": true}` | Emit REASONING\_\* events                                                                  | Displays model's reasoning/thinking process in UI.                                           |
| `stream_async` yields `{"reasoningRedactedContent": ...}`         | Emit `ReasoningEncryptedValueEvent` with base64 payload                                    | Handles encrypted reasoning content for models that redact thinking.                         |
| `current_tool_use` announced                                      | Emit tool call events, optional PredictState/state snapshots                               | Shows tool invocation cards and, when configured, optimistic UI updates.                     |
| `toolResult` packaged within `message.content[].toolResult`       | Emit `ToolCallResultEvent`, tool result hooks, optional halt                               | Renders backend tool outputs and state changes without additional frontend logic.            |
| `multiagent_node_start` / `multiagent_node_stop`                  | Emit `StepStartedEvent` / `StepFinishedEvent`                                              | Shows multi-agent workflow progress with node identification.                                |
| `multiagent_handoff`                                              | Emit `CustomEvent(name="MultiAgentHandoff")`                                               | Notifies UI of agent-to-agent handoffs with routing metadata.                                |
| Terminal result whose `stop_reason` is abnormal                   | Emit `CustomEvent(name="AgentStopped")`, then finish normally                              | UI can explain a truncated, filtered or guardrailed answer instead of reading it as success. |
| Stream sends `complete` or adapter decides to halt                | Close text/reasoning envelopes and emit `RunFinishedEvent`                                 | Signals the UI that the run ended; frontends may start follow-up runs or show idle states.   |
| `stream_async` yields `{"force_stop": True, ...}`                 | Record the reason, drain the stream, emit `RunErrorEvent` with `code="STRANDS_FORCE_STOP"` | Frontend sees a failed run rather than a short success; no final state or finish arrives.    |
| Exceptions anywhere in the stack                                  | Emit `RunErrorEvent` with the exception message and `code="STRANDS_ERROR"`                 | Frontend surfaces the failure and can offer retries.                                         |

The table above covers the run loop, not every terminal code: preflight and transport failures carry their own, listed under Lifecycle framing and under Additions Beyond the Python Adapter.

The TypeScript adapter maps the equivalent SDK-typed events (`modelContentBlockDeltaEvent`, `toolUseBlock`, `afterToolCallEvent`, `beforeNodeCallEvent`, `afterNodeCallEvent`, `multiAgentHandoffEvent`) to the same AG-UI events. It reads the abnormal stop reason off `agentResultEvent`, and reaches the forced stop through a throw out of `agent.stream()` rather than through a `force_stop` event. Its last row differs in TypeScript: a `TypeError` or `ReferenceError` escaping either run loop is an adapter code defect, and reports `ADAPTER_BUG` rather than `STRANDS_ERROR`.

---

## Deployment & Runtime Characteristics

- **HTTP/SSE transport**: Both adapters support HTTP POST plus streaming responses. Longer-lived transports (WebSockets, queues) are not part of the implemented surface.
- **Per-thread agent caching**: The transport layer is stateless (plain HTTP POST), but `StrandsAgent` caches Strands `Agent` instances per thread to preserve conversation context across requests.
- **Model compatibility**: The examples use `strands.models.gemini.GeminiModel` (Python) and Bedrock (TypeScript), but `StrandsAgent` works with any Strands-compatible model because it only relies on the streaming interface.
- **Error isolation**: Failures inside tool hooks (`state_from_args`, etc.) are swallowed so the main run can continue. A terminal `RunErrorEvent` from the run loop comes from an uncaught exception (`STRANDS_ERROR`, or `ADAPTER_BUG` in TypeScript when that exception is a `TypeError` or `ReferenceError`) or from a forced stop Strands reported mid-cycle (`STRANDS_FORCE_STOP`). Preflight and transport failures carry their own codes, listed under Lifecycle framing above.
- **Amazon Bedrock AgentCore**: Both adapters support the AgentCore contract (`/invocations` POST + `/ping` GET on port 8080).

---

## Summary

The AWS Strands integration adapts the Strands SDK to the AG-UI protocol by:

1. Wrapping the Strands `Agent` streaming interface with `StrandsAgent`, which understands AG-UI events, tool semantics, and shared-state conventions.
2. Exposing a trivial transport layer (FastAPI for Python, Express for TypeScript) that handles encoding and CORS while remaining stateless.
3. Letting any existing AG-UI HTTP client connect directly to the endpoint—no Strands-specific frontend package is required.

All behavior lives in `integrations/aws-strands/python/src/ag_ui_strands` and `integrations/aws-strands/typescript/src`. There are no hidden services or background workers; what is described above is the complete, production-ready implementation that powers today's Strands integration.
