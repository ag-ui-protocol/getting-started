# AG-UI .NET SDK Architecture

## What this SDK does

AG-UI (Agent User Interface) is a protocol for streaming events from an AI agent backend to a frontend UI. The .NET SDK gives you two things: a **server-side hosting layer** that turns any `IChatClient` into an AG-UI endpoint, and a **client library** that consumes those endpoints as a standard `IChatClient`. Both sides share a common set of protocol types.

The core design philosophy is: **you should not have to learn a new programming model.** If you already use `Microsoft.Extensions.AI` to talk to a language model, you plug the same `IChatClient` into the AG-UI hosting layer and the SDK handles the translation. The protocol is the transport mechanism, not the application abstraction.

## The packages

```
            AGUI.Abstractions       (protocol types)
            ↑      ↑       ↑
   AGUI.Formatting  |   AGUI.Server
   (wire formats)   |   (server adapter)
        ↑           |
   AGUI.Protobuf    |
   (protobuf codec) |
        ↑   ↑       |
        AGUI.Client (consumer)
```

**`AGUI.Abstractions`** defines the protocol: events, messages, tools, capabilities, and their JSON serialization (`AGUIJsonSerializerContext`). It has no opinion about HTTP, ASP.NET Core, or any hosting framework. Every other package depends on it. It also hosts `AGUIJsonUtilities.RegisterInterruptContentTypes`, the STJ-only registration for interrupt content types.

**`AGUI.Formatting`** defines the wire-format abstraction: `IAGUIEventStreamFormatter` (a bidirectional read/write formatter) and `SseEventStreamFormatter`, the Server-Sent Events wire format. It depends only on Abstractions and `System.Net.ServerSentEvents`.

**`AGUI.Protobuf`** provides the protobuf codec (the `internal` `AGUIProtobuf`), the public `ProtobufEventStreamFormatter`, and a `JsonElement`↔`google.protobuf.Value` bridge. The generated proto types are `internal`; the `.proto` schema is referenced from `sdks/typescript/packages/proto` (it is not copied), keeping the wire format in lockstep with `@ag-ui/proto`. It depends on Abstractions, Formatting, and `Google.Protobuf`.

**`AGUI.Server`** is the **framework-agnostic** server-side adapter (the rename of the former `AGUI.Hosting.AspNetCore`, with all ASP.NET stripped). It provides extension methods that convert a stream of `ChatResponseUpdate` objects (the output of any `IChatClient`) into a stream of AG-UI events: `ToChatRequestContext`/`ChatRequestContext`, `AsAGUIEventStreamAsync`, `AGUIStreamOptions`, and `AGUIConstants`. It references only Abstractions and `Microsoft.Extensions.AI.Abstractions` — **no ASP.NET**.

**`AGUI.Client`** is the package you use when consuming an AG-UI server. It wraps an HTTP connection in an `IChatClient` implementation (`AGUIChatClient`, constructed from `AGUIChatClientOptions`) so calling code doesn't need to know it's talking to an AG-UI endpoint. It also carries the transport layer (`AGUIHttpTransport`/`IAGUITransport`) and the transport-negotiation primitives (`AGUIEventStreamHandler`, a public `DelegatingHandler`, and `ReadAGUIEventStreamAsync`) that callers can wire into their own `HttpClient` to request protobuf. It depends on Formatting (and, through it, Abstractions).

The server and client sides are **kept independent on purpose.** The server package never references the client package; they share only the protocol types and formatters. **No `src/` project references `Microsoft.AspNetCore.App`** — the ASP.NET hosting glue (`AGUIResults`, `AGUIEventStreamResult`, the `MapAGUI` endpoint extension, and the `AddAGUI` DI registration) lives only in the `samples/AGUI.Samples.Shared` project, the single project with a `FrameworkReference` to `Microsoft.AspNetCore.App`.

| Package | Dependencies | Target frameworks |
|---------|-------------|-------------------|
| AGUI.Abstractions | `System.Text.Json`, `M.E.AI.Abstractions` | net10.0, net9.0, net8.0, netstandard2.0, net472 |
| AGUI.Formatting | AGUI.Abstractions, `System.Net.ServerSentEvents` | net10.0, net9.0, net8.0, netstandard2.0, net472 |
| AGUI.Protobuf | AGUI.Abstractions, AGUI.Formatting, `Google.Protobuf` | net10.0, net9.0, net8.0, netstandard2.0, net472 |
| AGUI.Client | AGUI.Abstractions, AGUI.Formatting, `M.E.AI`, `System.Net.ServerSentEvents` | net10.0, net9.0, net8.0, netstandard2.0, net472 |
| AGUI.Server | AGUI.Abstractions, `M.E.AI.Abstractions` | net10.0, net9.0, net8.0 |
| *samples/AGUI.Samples.Shared* | AGUI.Server, AGUI.Protobuf, `Microsoft.AspNetCore.App` | net10.0 |

All `src/` packages are AOT-compatible. Every serializable type is registered in `AGUIJsonSerializerContext`, a source-generated `JsonSerializerContext`, and no serialization path relies on runtime reflection.

---

## How a server endpoint works

The simplest AG-UI server is a single POST endpoint. Look at the Getting Started sample to see the pattern:

1. The endpoint receives a `RunAgentInput` from the request body. This carries the thread ID, the run ID, the conversation messages, client-provided tool definitions, and optional state.
2. You call `input.ToChatRequestContext(jsonSerializerOptions, streamOptions?)`. The returned `ChatRequestContext` carries the adapted `ChatMessage` list (`ctx.Messages`), a configured `ChatOptions` (`ctx.ChatOptions`, with the original input stashed under `AdditionalProperties[AGUIConstants.RunAgentInputKey]` and any client-declared tools already routed through the approval-flow pipeline), and the stream-converter options.
3. You call `chatClient.GetStreamingResponseAsync(ctx.Messages, ctx.ChatOptions, ct)`. This produces an `IAsyncEnumerable<ChatResponseUpdate>`.
4. You pipe that stream through `.AsAGUIEventStreamAsync(ctx, ct)`, which converts it to an `IAsyncEnumerable<BaseEvent>`.
5. You hand the event stream to a negotiating result. In the samples this is `AGUIResults.Events(events, httpContext, ct)` (from `samples/AGUI.Samples.Shared`, mapped via `app.MapAGUI("/")`), which inspects the request `Accept` header and writes the stream as Server-Sent Events (the default) or protobuf.

That's the whole thing. The SDK handles the event lifecycle (emitting `RunStartedEvent` and `RunFinishedEvent`), tracks text message open/close state, maps tool calls and results, and serializes everything to the wire format. The mixed server/client tool invocation pipeline (wrapping client tools in `ApprovalRequiredAIFunction`, injecting synthetic `ToolApprovalResponseContent` items on continuation turns, and unwrapping the wraps on the wire) is internal to `ToChatRequestContext` and `AsAGUIEventStreamAsync` — callers do not configure it explicitly.

The samples build on this pattern incrementally:

- **Step 01 (Getting Started)** shows the minimal endpoint described above.
- **Step 02 (Backend Tools)** adds server-side tools: you define them as regular C# methods, wrap them with `AIFunctionFactory.Create`, and add them to `ctx.ChatOptions.Tools` alongside whatever client tools `ToChatRequestContext` installed. The `IChatClient` pipeline (with `UseFunctionInvocation()`) invokes them automatically. The SDK streams the tool call/result events to the frontend for display.
- **Step 03 (Frontend Tools)** shows the other direction: the *client* defines the tools and sends them with the request. The server passes them through to the LLM, and the SDK streams the tool call events back so the frontend can execute them. Continuations carry the client's tool results back in `RunAgentInput.Messages` and the SDK injects the matching approval responses so the inner `FunctionInvokingChatClient` resumes correctly.
- **Step 05 (State Management)** shows how to push structured state to the frontend using `StateSnapshotEvent` and `StateDeltaEvent`.
- **Step 07 (Thinking Events)** shows that the hosting layer natively converts `TextReasoningContent` (the MEAI content type) into the AG-UI reasoning event chain (`ReasoningStartEvent` → `ReasoningMessageStartEvent` → `ReasoningMessageContentEvent` → `ReasoningMessageEndEvent` → `ReasoningEndEvent`). No `MapContent` configuration is required; the sample is just an `IChatClient` that produces reasoning deltas.
- **Step 09 (Interrupts – Approval)** shows the built-in tool approval mechanism: when the `IChatClient` pipeline produces a `ToolApprovalRequestContent` for a genuinely approval-required server tool, the SDK automatically emits a `RunFinishedEvent` with outcome `"interrupt"`. The client resumes with an `AGUIResume`, and the server picks up where it left off.
- **Step 13 (Protobuf)** opts into the protobuf transport: the server registers `ProtobufEventStreamFormatter` and the client wires `AGUIEventStreamHandler` into its `HttpClient` to advertise the protobuf media type, so the same negotiating endpoint encodes events as length-prefixed protobuf instead of SSE.
- **Step 14 (Telemetry)** wires OpenTelemetry tracing through the same pipeline. Both processes call `UseOpenTelemetry()` on their `IChatClient` and subscribe to the `Experimental.AGUI.Server`/`Experimental.AGUI.Client` and `Experimental.Microsoft.Extensions.AI` sources. The server wraps each produced event stream in an `agui.run` span (the AG-UI protocol layer the GenAI `chat` spans can't see); the client drives the same three tool scenarios as the other steps under one conversation activity, so the client HTTP spans and the server run spans share a single W3C trace. It exports to the console by default, or to OTLP (e.g. the Aspire dashboard or an OpenTelemetry Collector) when `OTEL_EXPORTER_OTLP_ENDPOINT` is set.

### Transport & content negotiation

The event stream is independent of the wire format. A formatter (`IAGUIEventStreamFormatter` in `AGUI.Formatting`) reads and writes one concrete representation:

- **Server-Sent Events** (`SseEventStreamFormatter`, `text/event-stream`) is the default transport and always available.
- **Protobuf** (`ProtobufEventStreamFormatter`, `application/vnd.ag-ui.event+proto`, from `AGUI.Protobuf`) is opt-in. The server enables it by registering the formatter as an `IAGUIEventStreamFormatter`; the client advertises it through the `Accept` header.

On the server, the negotiating `AGUIResults.Events` result picks the formatter from the request `Accept` header (falling back to SSE). On the client, `AGUIChatClient` advertises the formats it accepts and decodes whichever one the server returns. The protobuf schema is referenced directly from `sdks/typescript/packages/proto`, so both transports stay wire-compatible with `@ag-ui/proto`. Because both formats decode to the same `BaseEvent`/`ChatResponseUpdate` stream, application code and tests are transport-agnostic.

### Tool mapping with AGUIStreamOptions

`AGUIStreamOptions` is the configuration object passed to `ToChatRequestContext` and consumed by `AsAGUIEventStreamAsync`. It is method-only — no public getters or setters; everything is configured fluently.

The most common use case is state management. Suppose your agent has a `write_document` tool that writes a markdown document. You want the frontend to update a live preview as the document is written. Without tool mapping, you'd have to intercept the stream manually and inject `StateSnapshotEvent`s. With tool mapping:

```csharp
var streamOptions = new AGUIStreamOptions()
    .MapResultAsStateSnapshot("write_document");

var ctx = input.ToChatRequestContext(jsonSerializerOptions, streamOptions);
```

This tells the SDK: when a `ToolCallResultEvent` for that tool arrives, also emit a `StateSnapshotEvent` with the tool result as the snapshot payload.

For more advanced scenarios, `MapCall` and `MapResult` accept arbitrary callbacks:

- **`MapCall(toolName, mapper)`** fires after the tool call events (start/args/end) are emitted. The callback receives the `FunctionCallContent` and returns any additional events. The Dojo `predictive_state_updates` sample uses this to stream partial state snapshots as the model produces the tool call arguments token by token—giving the frontend a live preview before the tool even finishes executing.
- **`MapResult(toolName, mapper)`** fires after the `ToolCallResultEvent`. The callback receives the `FunctionResultContent`.

Two convenience methods cover the common cases:

- **`MapResultAsStateSnapshot(toolName)`** emits a `StateSnapshotEvent`.
- **`MapResultAsStateDelta(toolName)`** emits a `StateDeltaEvent`.

The Dojo server's `CreateAgenticUIStreamOptions` shows both in action: `create_plan` maps its result as a state snapshot (the full plan), while `update_plan_step` maps as a state delta (an incremental update to one step).

### Custom content and interrupts

Two fluent methods on `AGUIStreamOptions` install fallback chains for content types the converter doesn't handle natively:

- **`MapInterrupt(Func<AIContent, AGUIInterrupt?>)`** registers a callback that receives an `AIContent` and can return an `AGUIInterrupt`. If it does, the SDK emits a `RunFinishedEvent` with outcome `"interrupt"` and stops the run. The client is expected to show the interrupt to the user, collect a response, and resume via `RunAgentInput.Resume`. Multiple registrations chain in order; the first non-null result wins.
- **`MapContent(Func<AIContent, IEnumerable<BaseEvent>?>)`** registers a callback that receives an `AIContent` and can return a sequence of `BaseEvent` instances. This is the extension point for agent frameworks that produce their own content types—for example, mapping `TextReasoningContent` to reasoning events, or mapping workflow step markers to `StepStartedEvent` / `StepFinishedEvent`. Multiple registrations chain the same way.

---

## The event protocol

Every AG-UI interaction follows the same shape: the client POSTs a `RunAgentInput`, and the server streams back a sequence of events as SSE. The event types, all defined in `AGUI.Abstractions`, are:

**Run lifecycle.** Every stream starts with `RunStartedEvent` and ends with `RunFinishedEvent` (or `RunErrorEvent` on failure). `RunFinishedEvent` carries an optional outcome string—`"interrupt"` when the agent needs user input, `"tool_calls"` when the agent invoked frontend tools, or null for a normal completion.

**Text messages.** The agent's text output is streamed as `TextMessageStartEvent` (assigns a message ID and role), one or more `TextMessageContentEvent` (each carrying a text delta), and `TextMessageEndEvent`. This bracket structure lets the client render text incrementally and know when a message is complete.

**Tool calls.** A tool invocation is streamed as `ToolCallStartEvent` (tool name and call ID), `ToolCallArgsEvent` (serialized arguments), `ToolCallEndEvent`, and optionally `ToolCallResultEvent` (if the tool was executed server-side). When the tool is a frontend tool, there is no result event—the client executes the tool and sends the result back in the next `RunAgentInput`.

**State.** `StateSnapshotEvent` replaces the full frontend state with a new `JsonElement` value. `StateDeltaEvent` delivers an incremental patch. The schema of the state is defined by the agent—the protocol just carries it.

**Activities.** `ActivitySnapshotEvent` and `ActivityDeltaEvent` work the same way as state events but are intended for transient UI indicators (progress bars, spinners, status text).

**Reasoning.** When a model exposes chain-of-thought output, the server brackets it with `ReasoningStartEvent` / `ReasoningEndEvent`, with `ReasoningMessageStartEvent` / `ReasoningMessageContentEvent` / `ReasoningMessageEndEvent` inside for the actual text. `ReasoningEncryptedValueEvent` carries opaque reasoning tokens the client can echo back.

**Steps.** `StepStartedEvent` and `StepFinishedEvent` mark named phase boundaries in multi-step agents.

**Messages snapshot.** `MessagesSnapshotEvent` replaces the client's conversation history with the server's view.

**Extensibility.** `CustomEvent` carries a freeform name and value. `RawEvent` wraps a `JsonElement` verbatim—the SDK uses this internally to let agent frameworks inject pre-built protocol events into the `ChatResponseUpdate` stream.

**Interrupts.** `AGUIInterrupt` is a payload attached to a `RunFinishedEvent` with outcome `"interrupt"`. It carries an ID, a reason string, and an arbitrary `JsonElement` payload. The most common interrupt is tool approval: the server fills in an `AGUIToolApprovalPayload` (wrapping an `AGUIToolCallInfo`) so the UI can show the user what the agent wants to do. The client responds with an `AGUIResume` that includes the interrupt ID and a response payload.

---

## Messages and the request payload

`RunAgentInput` is the JSON body the client sends to start a run. It contains:

- `ThreadId` and `RunId` — identifiers the client generates.
- `Messages` — the conversation history as `AGUIMessage` objects.
- `Tools` — the client-provided tool definitions as `AGUITool` objects.
- `State` — optional `JsonElement` carrying the current frontend state.
- `Resume` — optional `AGUIResume` to continue after an interrupt.

The protocol defines its own message types — one per role: `AGUIUserMessage`, `AGUIAssistantMessage`, `AGUISystemMessage`, `AGUIDeveloperMessage`, `AGUIToolMessage`, `AGUIActivityMessage`, and `AGUIReasoningMessage`. They derive from the abstract `AGUIMessage`, which carries only the two fields every role shares — `Id` and `Role`. Following the spec, `content` (and `name`/`encryptedValue`) is **not** on the base: each role declares its own, typed exactly as the spec models it. Most roles carry a plain `string` content (assistant's is optional); `AGUIActivityMessage` carries a structured `JsonElement`; and `AGUIUserMessage.Content` is an `AGUIUserContent` value — a union of either a `string` or a list of `AGUIInputContent` parts (`AGUITextInputContent`, `AGUIBinaryInputContent`, …), mirroring the spec's `string | InputContent[]`. `AGUIUserContent` is a hand-rolled union (`[Union]`-attributed) that supports implicit construction from a string, a list, or a collection expression, and exposes a read-only list view so a plain string surfaces as a single text part. These types are separate from `Microsoft.Extensions.AI`'s `ChatMessage` because the wire format must be stable across all AG-UI implementations regardless of language or framework.

On the server, `input.ToChatRequestContext(jsonSerializerOptions)` produces a `ChatRequestContext` whose `Messages` property is a ready-to-use `List<ChatMessage>` you can pass directly to `IChatClient.GetStreamingResponseAsync`. On the client side, `AGUIChatClient` does the reverse conversion automatically.

`AGUITool` carries a name, description, and a `Parameters` property with the JSON Schema for the tool's input. `ToChatRequestContext` automatically converts client-declared tools to `AITool` instances and installs them on `ctx.ChatOptions.Tools` (routing them through the approval-flow pipeline so the inner `FunctionInvokingChatClient` terminates with the right content).

---

## Capabilities

`AgentCapabilities` is a structured descriptor that a server can choose to expose so clients can discover what the agent supports before starting a run. It aggregates optional facets: execution, human-in-the-loop, identity, multi-agent, multimodal (input and output), output, reasoning, state, tools, and transport capabilities.

The AG-UI specification does not prescribe how capabilities are exposed over the wire, so the SDK does not ship a public endpoint helper for them. Producers are free to expose `AgentCapabilities` however suits their deployment — a static JSON file, an OpenAPI document, a discovery endpoint of their own design, or some out-of-band channel.

---

## The client side

`AGUIChatClient` wraps an AG-UI endpoint as an `IChatClient`. You construct it from an `AGUIChatClientOptions`, which builds the built-in HTTP transport from an `HttpClient` and a URI, or carries a custom `IAGUITransport` for testing. Calling `GetStreamingResponseAsync` causes it to:

1. Convert the `ChatMessage` list, tools, and options into a `RunAgentInput`.
2. POST it to the server and read the SSE response as an `IAsyncEnumerable<BaseEvent>`.
3. Convert the event stream back to `ChatResponseUpdate` objects using `EventStreamConverter`, which reassembles text messages via `TextMessageBuilder` and tool calls via `ToolCallBuilder`.

When the server sends a `RunFinishedEvent` with outcome `"interrupt"` and a tool approval payload, `AGUIChatClient` surfaces it as a `ToolApprovalRequestContent`. For other interrupts, it surfaces an `InterruptRequestContent`. The calling code handles the interrupt and supplies the response, which gets sent as `RunAgentInput.Resume` on the next request.

When the server sends a `RunErrorEvent`, `AGUIChatClient` surfaces it as an `ErrorContent` update. The event's `message` maps to `ErrorContent.Message`, and its optional `code` maps to `ErrorContent.ErrorCode`, so callers can handle protocol error codes without parsing the raw event.

`AGUIChatClient` is **stateless**: it sends the full message history on every turn. It therefore never surfaces a `ConversationId` on returned updates — a non-null `ConversationId` signals a service-managed conversation in MEAI, which would make agent wrappers (e.g. `AsAIAgent`) send only deltas on the next turn and truncate history against a stateless server. Updates are correlated by `ResponseId` (the AG-UI run id), and the AG-UI thread id is available via `ChatResponseUpdate.AdditionalProperties["agui_thread_id"]`. To keep a stable thread across turns, reuse the same `ChatOptions` instance (the client pins the thread id onto it) or set `RunAgentInput.ThreadId`/`ParentRunId` explicitly through `ChatOptions.RawRepresentationFactory` — the AG-UI-native way to drive wire-level fields, as shown in the Step 11 sample.

`IAGUITransport` abstracts the wire protocol. The built-in `AGUIHttpTransport` uses HTTP and negotiates the response format (SSE by default, or protobuf when accepted), but you can implement the interface for in-memory testing or alternative transports.

---

## Service registration

`AddAGUI(IServiceCollection)` registers the AG-UI serialization options into the DI container. It adds `AGUIJsonSerializerContext` to the `JsonSerializerOptions` type info resolver chain so all protocol types serialize correctly. It also calls `AGUIJsonUtilities.RegisterInterruptContentTypes` (which lives in `AGUI.Abstractions`) to register `InterruptRequestContent` and `InterruptResponseContent` for polymorphic `AIContent` deserialization—these are the content types that flow through the `IChatClient` pipeline when interrupts occur.

`AddAGUI` is the ASP.NET wiring (it configures `JsonOptions`), so it ships in the `samples/AGUI.Samples.Shared` project rather than in any `src/` package. The protobuf transport is opted in by registering `ProtobufEventStreamFormatter` as an `IAGUIEventStreamFormatter` (for example, `services.AddSingleton<IAGUIEventStreamFormatter, ProtobufEventStreamFormatter>()`); the negotiating endpoint uses it when a client accepts the protobuf media type.

---

## Architectural constraints

- **AOT compatibility.** No runtime reflection for serialization. All types go through `AGUIJsonSerializerContext`.
- **Package independence.** The server package does not reference the client package. They share only the protocol types in `AGUI.Abstractions`.
- **`IChatClient` is the integration point.** The SDK does not define its own agent abstraction. On the server you pipe an `IChatClient`'s output through `AsAGUIEventStreamAsync`; on the client you consume an AG-UI endpoint through `AGUIChatClient` which *is* an `IChatClient`. This means the entire `Microsoft.Extensions.AI` middleware stack (function invocation, logging, caching, rate limiting) works unchanged on both sides.
- **Events are additive.** New event types can be added to `AGUI.Abstractions` without breaking existing clients. Unknown event types round-trip through `RawEvent`. The `CustomEvent` type provides a typed escape hatch for extensions.
- **Incremental type introduction.** Each protocol feature (text streaming, tool calls, state management, etc.) introduces only the types it needs. Types are not defined speculatively.
