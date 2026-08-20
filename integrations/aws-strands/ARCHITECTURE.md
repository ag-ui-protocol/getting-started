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
  - Always emits `RunFinishedEvent` unless an exception occurs, in which case it emits `RunErrorEvent` with `code="STRANDS_ERROR"`.
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

- `add_strands_fastapi_endpoint(app, agent, path)` registers a POST route that:
  - Accepts a `RunAgentInput` body.
  - Instantiates `EventEncoder` using the requester's `Accept` header to choose between SSE (`text/event-stream`) and newline-delimited JSON.
  - Streams whatever `StrandsAgent.run` yields, automatically encoding every AG-UI event.
  - Sends a `RunErrorEvent` with `code="ENCODING_ERROR"` if serialization fails mid-stream.
- `create_strands_app(agent, path="/")` bootstraps a FastAPI application, adds permissive CORS middleware (allowing any origin/method/header so AG-UI localhost builds can connect), and mounts the agent route.

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

### Additions Beyond the Python Adapter

Behaviors the Python adapter does not currently implement, added to match TypeScript-ecosystem expectations or to close conformance gaps:

- **Multi-agent orchestrator mode** (`_runOrchestrator`): accepts a Strands `Graph` or `Swarm` in place of a single `Agent` and drives its `.stream()` directly. Per-thread caching, session managers, and proxy-tool sync are bypassed because orchestrators are stateless per invocation.
- **`THREAD_BUSY` guard**: `_activeRunsByThread` rejects concurrent runs on the same thread with `RUN_ERROR { code: "THREAD_BUSY" }`. The TS SDK throws `"Agent is already processing an invocation"` if this isn't caught up front; Python's SDK has no equivalent collision.
- **`AbortController` wiring**: the Strands `.stream()` call receives a `cancelSignal`; the transport's disconnect listener fires it so Bedrock stops streaming when the HTTP client drops.
- **Request-boundary validation** (`addStrandsExpressEndpoint`): returns `415` for non-JSON `Content-Type`, `400` for bodies that fail the shared Zod `RunAgentInputSchema`, and normalizes snake_case top-level keys (`thread_id`, `run_id`, `parent_run_id`, `forwarded_props`) into camelCase before validating. FastAPI's Pydantic layer handles the equivalent on the Python side.
- **Client-disconnect handling**: HTTP/1.1 `res.close` and HTTP/2 `req.aborted` both trigger `iterator.return()`, firing the agent generator's `finally` so the `_activeRunsByThread` slot releases and the Bedrock stream aborts.
- **Protobuf content negotiation**: only selected when `Accept` explicitly contains `application/vnd.ag-ui.event+proto`; `*/*` or omitted Accept falls back to SSE.
- **Capabilities endpoint** (`addCapabilities`, `DEFAULT_CAPABILITIES`, `capabilitiesFor`): optional `GET /capabilities` returning a static matrix of supported event families, transports, and protocol features so frontends don't have to probe empirically.
- **Chunk-event emission** (`emitChunkEvents`): optional flag that collapses explicit `*_START` / `*_CONTENT` / `*_END` triples into `TEXT_MESSAGE_CHUNK` / `TOOL_CALL_CHUNK` / `REASONING_MESSAGE_CHUNK` self-expanding chunks per `concepts/events.mdx`. Halves the event count on high-frequency deltas.
- **`ToolCallContextExtras`** (`buildContextExtras`): `context` + `forwardedProps` are flattened onto every `ToolCallContext` / `ToolResultContext` and passed as a 3rd argument to `stateContextBuilder`, so hooks can read per-request auth tokens / locale without re-parsing `inputData`. Python passes `input_data` directly and callers pull these fields off themselves.
- **Injectable logger** (`StrandsAgentConfig.logger`): matches Python's `logging.getLogger(__name__)` surface. Any `{ debug, warn, error }` record works — wire in pino / winston / bunyan / a silent stub directly. Debug message strings match the Python adapter field-for-field (modulo camelCase) so cross-SDK log diffs are straightforward.
- **`AWSStrandsAgent extends HttpAgent`**: thin client-side shim re-export so AG-UI TypeScript clients can `new AWSStrandsAgent({ url })` instead of constructing a bare `HttpAgent`.

### Transport Helpers

- `addStrandsExpressEndpoint(app, agent, { path })` — Express analogue of `add_strands_fastapi_endpoint`.
- `createStrandsApp(agent, { path, pingPath, capabilitiesPath, capabilities, corsOrigin })` — bootstraps an Express app with permissive CORS and optional ping / capabilities routes.
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

| Module                          | Focus                                                              |
| ------------------------------- | ------------------------------------------------------------------ |
| `tool-based-generative-ui.ts`   | Frontend-rendered tool (haiku card) auto-registered as a proxy tool — exercises the `TOOL_CALL_*` stream the dojo's `tool_based_generative_ui` page consumes. No Python equivalent. |

Each file is self-contained and can be run standalone (`pnpm <name>` from `examples/`). `examples/server/server.ts` is a "dojo" that mounts all eight at the paths the Python reference server uses, so both implementations can be driven by the same curl payloads.

Both example sets double as integration tests: they exercise every built-in hook so regressions surface quickly during manual QA.

---

## Event Semantics Recap

| Strands Signal                                                    | Adapter Reaction                                             | AG-UI Consumer Impact                                                                      |
| ----------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `stream_async` yields `{"data": ...}`                             | Emit text start/content/end                                  | Updates conversational transcript incrementally.                                           |
| `stream_async` yields `{"reasoningText": ..., "reasoning": true}` | Emit REASONING\_\* events                                    | Displays model's reasoning/thinking process in UI.                                         |
| `stream_async` yields `{"reasoningRedactedContent": ...}`         | Emit `ReasoningEncryptedValueEvent` with base64 payload      | Handles encrypted reasoning content for models that redact thinking.                       |
| `current_tool_use` announced                                      | Emit tool call events, optional PredictState/state snapshots | Shows tool invocation cards and, when configured, optimistic UI updates.                   |
| `toolResult` packaged within `message.content[].toolResult`       | Emit `ToolCallResultEvent`, tool result hooks, optional halt | Renders backend tool outputs and state changes without additional frontend logic.          |
| `multiagent_node_start` / `multiagent_node_stop`                  | Emit `StepStartedEvent` / `StepFinishedEvent`                | Shows multi-agent workflow progress with node identification.                              |
| `multiagent_handoff`                                              | Emit `CustomEvent(name="MultiAgentHandoff")`                 | Notifies UI of agent-to-agent handoffs with routing metadata.                              |
| Stream sends `complete` or adapter decides to halt                | Close text/reasoning envelopes and emit `RunFinishedEvent`   | Signals the UI that the run ended; frontends may start follow-up runs or show idle states. |
| Exceptions anywhere in the stack                                  | Emit `RunErrorEvent` with the exception message              | Frontend surfaces the failure and can offer retries.                                       |

The TypeScript adapter maps the equivalent SDK-typed events (`modelContentBlockDeltaEvent`, `toolUseBlock`, `afterToolCallEvent`, `beforeNodeCallEvent`, `afterNodeCallEvent`, `multiAgentHandoffEvent`) to the same AG-UI events.

---

## Deployment & Runtime Characteristics

- **HTTP/SSE transport**: Both adapters support HTTP POST plus streaming responses. Longer-lived transports (WebSockets, queues) are not part of the implemented surface.
- **Per-thread agent caching**: The transport layer is stateless (plain HTTP POST), but `StrandsAgent` caches Strands `Agent` instances per thread to preserve conversation context across requests.
- **Model compatibility**: The examples use `strands.models.gemini.GeminiModel` (Python) and Bedrock (TypeScript), but `StrandsAgent` works with any Strands-compatible model because it only relies on the streaming interface.
- **Error isolation**: Failures inside tool hooks (`state_from_args`, etc.) are swallowed so the main run can continue. Only uncaught exceptions in the core loop trigger `RunErrorEvent`.
- **Amazon Bedrock AgentCore**: Both adapters support the AgentCore contract (`/invocations` POST + `/ping` GET on port 8080).

---

## Summary

The AWS Strands integration adapts the Strands SDK to the AG-UI protocol by:

1. Wrapping the Strands `Agent` streaming interface with `StrandsAgent`, which understands AG-UI events, tool semantics, and shared-state conventions.
2. Exposing a trivial transport layer (FastAPI for Python, Express for TypeScript) that handles encoding and CORS while remaining stateless.
3. Letting any existing AG-UI HTTP client connect directly to the endpoint—no Strands-specific frontend package is required.

All behavior lives in `integrations/aws-strands/python/src/ag_ui_strands` and `integrations/aws-strands/typescript/src`. There are no hidden services or background workers; what is described above is the complete, production-ready implementation that powers today's Strands integration.
