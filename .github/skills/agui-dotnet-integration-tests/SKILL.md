---
name: agui-dotnet-integration-tests
description: 'Write integration tests for the AG-UI .NET SDK. USE FOR: adding a new AG-UI event type and covering it end-to-end, testing SSE or protobuf streaming through the hosting pipeline, verifying AGUIChatClient maps events to ChatResponseUpdate, multi-turn conversation tests, parameterizing a test over Json/Protobuf transports, adding or updating a GettingStarted sample replay/Verify snapshot. Covers: WebApplicationFactory + DelegatingStreamingChatClient setup, IChatClient-based assertions with Assert.Collection, TransportFormat [Theory] (Json/Protobuf), recording/replay capture infrastructure, and the 8-capture-point Verify baselines. DO NOT USE FOR: unit tests of event serialization (use tests/AGUI.Abstractions.UnitTests) or stream-conversion unit tests (use tests/AGUI.Server.UnitTests).'
---

# AG-UI .NET Integration Tests

End-to-end tests for the AG-UI .NET SDK that post `RunAgentInput`, stream events over the wire (SSE **or** protobuf), and assert behavior through the `AGUIChatClient` (`IChatClient`) abstraction.

## Orientation

The canonical project layout, endpoint pattern, and naming live in
`sdks/dotnet/AGENTS.md` (project layout + endpoint pattern) and
`sdks/dotnet/docs/architecture.md` (the server/client pipeline). Read those first;
this skill covers only the integration-test mechanics on top of them.

One durable gotcha: the test **project folder** and csproj are named
`tests/AGUI.Hosting.AspNetCore.IntegrationTests/` (kept after the server package was
renamed to `AGUI.Server`), but all types live in namespace **`AGUI.Server.IntegrationTests`**.
The ASP.NET hosting glue (`AddAGUI`, the negotiating endpoint, `AGUIResults`) lives in
`samples/AGUI.Samples.Shared`, and the protobuf formatter comes from `AGUI.Protobuf`.

## Project Layout

```
tests/AGUI.Hosting.AspNetCore.IntegrationTests/   # namespace AGUI.Server.IntegrationTests
├── Infrastructure/
│   ├── IntegrationTestBase.cs          # Two-tier base: generic <TEntryPoint> + non-generic (uses Program). Emit helpers, CollectUpdates, CreateClient(handler[, TransportFormat]), VerifyCaptures (8 capture points), recording load/save, id scrubbing.
│   ├── TransportFormat.cs              # enum { Json, Protobuf } — selects the wire encoding the test client negotiates
│   ├── DelegatingStreamingChatClient.cs # Func-based IChatClient for inline server behavior
│   ├── CapturingChatClient.cs          # IChatClient decorator that records server-side calls (ServerCallCapture)
│   ├── CapturingAGUITransport.cs       # IAGUITransport decorator that records client-side turns (TurnCapture)
│   ├── ServerCallCapture.cs            # RunAgentInput + ChatMessage[] + ChatOptions + ChatResponseUpdate[] per server call
│   ├── TurnCapture.cs                  # RunAgentInput + BaseEvent[] per client-side turn
│   ├── ChatResponseUpdateCaptureConverter.cs # JsonConverter that renders ChatResponseUpdate (+RawRepresentation) for snapshots
│   ├── AGUIEndpointExtensions.cs       # Test-local MapAGUI: ToChatRequestContext + AsAGUIEventStreamAsync, returns AGUIResults.Events (negotiating)
│   ├── AGUIServerSentEventsResult.cs   # Legacy SSE-only IResult (still present; the live endpoint uses AGUIResults instead)
│   ├── AGUICapabilitiesEndpointRouteBuilderExtensions.cs # Test-only AgentCapabilities publisher (the SDK ships no capabilities endpoint; the spec doesn't define one)
│   ├── Program.cs                      # Minimal host: AddAGUI() + register ProtobufEventStreamFormatter + DelegatingStreamingChatClient + MapAGUI("/agui")
│   └── VerifyConfig.cs                 # ModuleInitializer for Verify settings (DontScrubDateTimes, DiffRunner disabled)
├── RunLifecycleIntegrationTest.cs      # Run lifecycle events            [Theory Json/Protobuf]
├── TextStreamingIntegrationTest.cs     # Text streaming + multi-turn     [Theory Json/Protobuf]
├── ToolCallIntegrationTest.cs          # Tool call events                [Theory + one Json-only ToolCallResult fact]
├── ClientToolIntegrationTest.cs        # Client (frontend) tools          [Theory Json/Protobuf]
├── MixedToolInvocationIntegrationTest.cs # Mixed server+client tool batches (approval-flow) [Json-only, has Verify baselines]
├── FrontendToolReinvocationTest.cs     # Frontend tool re-invocation      [Json-only]
├── StateManagementIntegrationTest.cs   # State snapshot/delta             [Theory Json/Protobuf]
├── ReasoningIntegrationTest.cs         # Thinking/reasoning events        [Json-only]
├── ActivityIntegrationTest.cs          # Activity snapshot/delta          [Json-only]
├── CustomAndRawEventIntegrationTest.cs # Custom/raw events                [Theory Json/Protobuf]
├── RawRepresentationFactoryIntegrationTest.cs # Custom RawRepresentation factory [Theory Json/Protobuf]
├── CapabilitiesEndpointIntegrationTest.cs # Capabilities endpoint (exercises the test-local helper) [Json-only]
├── TransportEquivalenceIntegrationTest.cs # Asserts Json and Protobuf decode to identical ChatResponseUpdate sequences
├── AGUIResultsTest.cs                  # Accept-header negotiation (proto vs SSE vs 406) for AGUIResults.Events
├── Samples/GettingStarted/
│   ├── StepNN_XyzTest.cs               # Replay/snapshot test per sample (Step01..Step12)
│   ├── fixtures/{Sample}/*.recording.json   # Recorded List<List<ChatResponseUpdate>> (one list per turn)
│   └── baselines/{Sample}/*.verified.json   # Verify snapshots, one file per capture point (see below)
└── AGUI.Hosting.AspNetCore.IntegrationTests.csproj  # references AGUI.Client, AGUI.Protobuf, AGUI.Samples.Shared + every Step01..Step12 Client/Server
```

## Architecture

### IChatClient-based design
The server side always works with `ChatResponseUpdate` streams. The AG-UI hosting layer converts these to `BaseEvent` streams on the wire (SSE or protobuf). Tests verify behavior at the `ChatResponseUpdate` level, inspecting the underlying AG-UI event via `update.RawRepresentation`.

### DelegatingStreamingChatClient pattern
Define server behavior inline via a `Func<IEnumerable<ChatMessage>, ChatOptions?, CancellationToken, IAsyncEnumerable<ChatResponseUpdate>>`:

```csharp
var client = CreateClient((messages, options, ct) =>
    EmitTextResponse("Hello!", ct), format);
```

`CreateClient` builds a fresh `AGUIChatClient` over a `WebApplicationFactory<Program>` HTTP pipeline with `DelegatingStreamingChatClient` injected via `ConfigureTestServices`.

### Two-tier base class
- `IntegrationTestBase<TEntryPoint>` — generic base for any `Program`. Provides `CollectUpdates`, `ExtractText`, the `Emit*` helpers, `VerifyCaptures`, recording load/save, and snapshot id scrubbing.
- `IntegrationTestBase` — non-generic subclass of `IntegrationTestBase<Program>`. Sets the `.slnx` content-root env var and exposes the `CreateClient` overloads that inject `DelegatingStreamingChatClient`.

### Host registration
`Infrastructure/Program.cs` registers the protobuf formatter so the server can answer either transport:

```csharp
builder.Services.AddAGUI();                                                       // AGUI.Samples.Shared
builder.Services.AddSingleton<IAGUIEventStreamFormatter, ProtobufEventStreamFormatter>(); // AGUI.Protobuf
```

The test endpoint mirrors the production shape but returns the negotiating result:

```csharp
var events = chatClient.GetStreamingResponseAsync(ctx.Messages, ctx.ChatOptions, ct)
    .AsAGUIEventStreamAsync(ctx, ct);
return AGUIResults.Events(events, httpContext, ct);   // negotiates protobuf vs SSE from Accept
```

### Emit helpers
All `Emit*` helpers yield `ChatResponseUpdate` (never `BaseEvent`); the pipeline converts them. They take a trailing `[EnumeratorCancellation] CancellationToken ct = default`:
- `EmitTextResponse(text, ct)` — assistant `TextContent`
- `EmitToolCallResponse(callId, name, args, ct)` — `FunctionCallContent`, `FinishReason = ToolCalls`
- `EmitToolCallWithResultResponse(callId, name, args, result, ct)` — call update then a `FunctionResultContent` update
- `EmitEmptyResponse(ct)` — yields nothing

## Transport parameterization (Json / Protobuf)

Most event-shape tests are `[Theory]` over `TransportFormat`:

```csharp
[Theory]
[InlineData(TransportFormat.Json)]
[InlineData(TransportFormat.Protobuf)]
public async Task PostRun_TextContent_MapsToTextMessageEvents(TransportFormat format)
{
    var client = CreateClient((messages, options, ct) =>
        EmitTextResponse("Hello world!", ct), format);
    var updates = await CollectUpdates(client, [new ChatMessage(ChatRole.User, "Hi")]);
    // ...assert via update.RawRepresentation...
}
```

How `CreateClient(handler, format)` works:
- **`TransportFormat.Json`** → default SSE transport (`text/event-stream`); no negotiation handler.
- **`TransportFormat.Protobuf`** → inserts an `AGUIEventStreamHandler` advertising `[protobuf, sse]` (`ProtobufEventStreamFormatter` + `SseEventStreamFormatter`) into the client `HttpClient` pipeline, so the request prefers `application/vnd.ag-ui.event+proto` and the response is decoded accordingly.

**Assertions and Verify baselines are reused unchanged across both formats.** Capture happens at the *decoded* event/`ChatResponseUpdate` layer, and the request is always JSON, so only the wire encoding differs. `TransportEquivalenceIntegrationTest` pins this invariant by running the same scenario over both formats and asserting the decoded update sequences are identical.

### Intentionally Json-only tests
A few suites are plain `[Fact]` (Json only) because their events are **not representable in the protobuf subset** — encoding them would throw `NotSupportedException`:
- `ReasoningIntegrationTest` (thinking/reasoning), `ActivityIntegrationTest` (activity snapshot/delta).
- The `ToolCallResult` scenario in `ToolCallIntegrationTest` (`FunctionResultContent` → `TOOL_CALL_RESULT`, a .NET-only event). The rest of that file stays `[Theory]`.
- `MixedToolInvocationIntegrationTest`, `FrontendToolReinvocationTest`, and `CapabilitiesEndpointIntegrationTest` are also Json-only.

When you add a `[Theory]` test, prefer parameterizing over `TransportFormat`. Only fall back to a Json-only `[Fact]` when the scenario emits a .NET-only event with no proto representation — and add a one-line comment saying so.

## Procedure: writing a new integration test

1. **Pick the file** by event category (see layout table). New category → `{Category}IntegrationTest.cs : IntegrationTestBase`.
2. **Declare the class** with the `WebApplicationFactory<Program>` ctor:
   ```csharp
   public sealed class MyFeatureIntegrationTest : IntegrationTestBase
   {
       public MyFeatureIntegrationTest(WebApplicationFactory<Program> factory) : base(factory) { }
   }
   ```
3. **Write a `[Theory]`** over `TransportFormat` (or `[Fact]` if Json-only per above), call `CreateClient(handler, format)`, drive a turn with `CollectUpdates`, and assert the event sequence with `Assert.Collection`, checking `u.RawRepresentation` types/properties.
4. **Multi-turn**: enqueue handlers in a `Queue<Func<...>>` and dequeue per call; pass the full message history (prior user + synthesized assistant messages) on later turns.
5. **Tool calls**: pass tools via `ChatOptions { Tools = [DummyClientTool] }` (`DummyClientTool` is built with `CreateToolDeclaration`).
6. **New reusable emitter** → add it to `IntegrationTestBase.cs`; yield `ChatResponseUpdate`, not `BaseEvent`.

```csharp
[Theory]
[InlineData(TransportFormat.Json)]
[InlineData(TransportFormat.Protobuf)]
public async Task PostRun_FunctionCallContent_MapsToToolCallEvents(TransportFormat format)
{
    var client = CreateClient((messages, options, ct) =>
        EmitToolCallResponse("call-1", "get_weather",
            new Dictionary<string, object?> { ["location"] = "Seattle" }, ct), format);

    var updates = await CollectUpdates(client,
        [new ChatMessage(ChatRole.User, "Hi")],
        new ChatOptions { Tools = [DummyClientTool] });

    Assert.Collection(updates,
        u => Assert.IsType<RunStartedEvent>(u.RawRepresentation),
        u =>
        {
            var fcc = Assert.Single(u.Contents.OfType<FunctionCallContent>());
            Assert.Equal("get_weather", fcc.Name);
            Assert.Equal("call-1", fcc.CallId);
        },
        u => Assert.Equal(ChatFinishReason.ToolCalls, u.FinishReason));
}
```

## Sample recording / replay tests

`Samples/GettingStarted/StepNN_XyzTest.cs` runs each sample as a real host and verifies the full MEAI↔AG-UI round-trip deterministically. Samples exist for **Step01–Step13** (Step12 = parallel tool calls, Step13 = protobuf); replay tests currently cover **Step01–Step12** plus `MixedToolInvocation`.

### Key types
- **`FakeChatClient`** — defined **per sample server project** (e.g. `Step01_GettingStarted.Server`), a `Queue`-of-handlers `IChatClient` used in replay mode.
- **`CapturingChatClient`** — wraps the real/fake server `IChatClient`, records each call as a `ServerCallCapture` (RunAgentInput, messages, options, updates).
- **`CapturingAGUITransport`** — wraps `IAGUITransport`, records each `SendAsync` as a `TurnCapture` (RunAgentInput + emitted `BaseEvent`s).

### Pattern
Each test inherits `IntegrationTestBase<StepNN_Xyz.Server.Program>` and uses a local `CreateCapturingClient`:

```csharp
public sealed class Step01_GettingStartedTest
    : IntegrationTestBase<Step01_GettingStarted.Server.Program>
{
    [Fact]
    public async Task PostRun_MultiTurn_SynthesizesAssistantMessages()
    {
        var (aguiClient, transport, server) = CreateCapturingClient(turnCount: 2);
        var clientMessages = new List<List<ChatMessage>>();
        var clientUpdates = new List<List<ChatResponseUpdate>>();

        await SampleClient.RunAsync(aguiClient, TextWriter.Null, clientMessages, clientUpdates);

        await VerifyAllCaptures(transport, server, clientMessages, clientUpdates);
    }
}
```

- **Replay vs record**: `CreateCapturingClient` calls `LoadRecording(testName)`. If a fixture exists it injects a `FakeChatClient` replaying it; otherwise it wraps the app's real `IChatClient` and `SaveRecording` writes a fresh fixture.
- **Fixtures**: `Samples/GettingStarted/fixtures/{Sample}/{TestMethod}.recording.json` — a serialized `List<List<ChatResponseUpdate>>` (one inner list per turn).

### The 8 capture points (baselines)
`VerifyCaptures` writes **one Verify target per capture point per turn** under `Samples/GettingStarted/baselines/{Sample}/`, named `{TestMethod}#Turn_{NN}.{CC}.{Request|Response}.{Client|Server}.{AGUI|NET}.verified.json`. The eight points trace the full round-trip in order:

| CC | Direction | Side | Format | Field |
|----|-----------|------|--------|-------|
| 01 | Request | Client | NET | client.chatMessages (app → AGUIChatClient) |
| 02 | Request | Client | AGUI | client.runAgentInput (client → wire) |
| 03 | Request | Server | AGUI | server.runAgentInput (wire → endpoint) |
| 04 | Request | Server | NET | server.chatMessages (endpoint → LLM) |
| 05 | Response | Server | NET | server.chatResponseUpdates (LLM → endpoint) |
| 06 | Response | Server | AGUI | server.events (endpoint → wire) |
| 07 | Response | Client | AGUI | client.events (wire → client) |
| 08 | Response | Client | NET | client.chatResponseUpdates (client → app) |

Volatile ids (`call_`, `msg_`, `run_`, GUIDs, …) are scrubbed to stable `*_Id_N` placeholders, and `createdAt`/`totalTokenCount` are stripped, so baselines are deterministic. Because capture is at the decoded layer, the same baselines hold for protobuf runs.

### Updating baselines
When a snapshot changes, review the `.received.json` diff, then accept (e.g. `dotnet test --environment VERIFY_ACCEPT=true`). When adding a sample test, the first record-mode run generates both the fixture and the baselines — review them before committing.

## Key rules

1. **Parameterize over `TransportFormat`** with `[Theory]`/`[InlineData]` unless the events are .NET-only (then `[Fact]` + comment).
2. **`Assert.Collection`** for event sequences — validates count, order, and properties together.
3. **Assert on `u.RawRepresentation`** to inspect the underlying AG-UI event; emit helpers yield `ChatResponseUpdate`, not `BaseEvent`.
4. **`CreateClient` returns `AGUIChatClient`** (not `HttpClient`); drive turns with `CollectUpdates`.
5. **No agent classes** — use `DelegatingStreamingChatClient` + inline handler; multi-turn uses a `Queue<Func<...>>`.
6. **The pipeline wraps RunStarted/RunFinished** — emit helpers don't produce lifecycle events.
7. **One test file per event category**; name `{Category}IntegrationTest.cs`.
8. **Sample tests inherit `IntegrationTestBase<StepNN_Xyz.Server.Program>`**, use `CreateCapturingClient` (record/replay), and verify all 8 capture points via `VerifyCaptures`.
9. **Use current names**: package `AGUI.Server`, namespace `AGUI.Server.IntegrationTests`, ASP.NET glue (`AGUIResults`, `AddAGUI`) from `AGUI.Samples.Shared`.

## Build & run

From `sdks/dotnet/`:

```bash
dotnet test tests/AGUI.Hosting.AspNetCore.IntegrationTests/
```
