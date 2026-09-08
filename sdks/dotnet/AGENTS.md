# AG-UI .NET SDK - Coding Instructions

Refer to `docs/architecture.md` for the design philosophy, package structure, and how the subsystems fit together.

## Prerequisites

- .NET 10 SDK (see `global.json` for the exact version; `rollForward: minor` is configured).
- All commands below run from the `sdks/dotnet/` directory.

### Provisioning a repo-local SDK (optional, hermetic)

To build against the exact pinned SDK without touching the machine-wide install, use the
provisioning scripts. They download the SDK from `global.json` into a gitignored `.dotnet/`
folder and build/test against it only (`DOTNET_MULTILEVEL_LOOKUP=0`):

```bash
./build.cmd            # Windows: provision + build
./build.sh             # Linux/macOS: provision + build
./build.sh --test      # provision + test
```

`eng/install-dotnet.ps1` / `eng/install-dotnet.sh` perform just the provisioning step and
accept `-ExtraChannel`/`--extra-channel` (or `-ExtraVersion`/`--extra-version`) to install an
additional SDK (e.g. a .NET 11 preview) side-by-side.

## Build

```bash
dotnet build
```

The solution file is `AGUI.slnx`. `Directory.Build.props` sets `LangVersion` to `latest`, enables nullable, and treats warnings as errors. `Directory.Packages.props` centralizes all NuGet versions (Central Package Management). `Directory.Build.targets` conditionally enables `PublicApiAnalyzers` when a `PublicAPI.Shipped.txt` exists in the project.

## Running tests

```bash
dotnet test
```

This runs every unit test and integration test project in the solution. For faster feedback during development you can target individual projects as described below.

### Unit tests

One unit-test project per `src/` package:

| Project | Covers | Key patterns |
|---|---|---|
| `tests/AGUI.Abstractions.UnitTests/` | Event serialization round-trips, backward compatibility against TypeScript JSON fixtures | `JsonDocument` property assertions, `FixtureLoader` for cross-SDK fixtures in `Compatibility/` |
| `tests/AGUI.Client.UnitTests/` | Client builders, protocol rules, transport negotiation | Standard xunit assertions |
| `tests/AGUI.Formatting.UnitTests/` | `SseEventStreamFormatter` read/write round-trips, the SSE wire format | Standard xunit assertions |
| `tests/AGUI.Protobuf.UnitTests/` | Protobuf codec, `ProtobufEventStreamFormatter`, `JsonElement`↔`google.protobuf.Value` bridge | Standard xunit assertions |
| `tests/AGUI.Server.UnitTests/` | `ChatResponseUpdate` → AG-UI event conversion, mixed tool invocation, interrupt content | Standard xunit assertions |

Run a single unit test project:

```bash
dotnet test tests/AGUI.Abstractions.UnitTests/
```

Test files live directly under the test project root (not mirrored into `Events/` subfolders). The standard pattern for an event test:

```csharp
[Fact]
public void Serialization_RoundTrips()
{
    var evt = new RunStartedEvent { ThreadId = "t1", RunId = "r1", Timestamp = 1234567890 };

    var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.RunStartedEvent);
    using var doc = JsonDocument.Parse(json);

    Assert.Equal("RUN_STARTED", doc.RootElement.GetProperty("type").GetString());
    Assert.Equal("t1", doc.RootElement.GetProperty("threadId").GetString());
}
```

Verify concrete JSON property names by parsing with `JsonDocument`. Don't just assert on the deserialized object—that doesn't catch naming bugs.

#### Backward compatibility tests

`tests/AGUI.Abstractions.UnitTests/Compatibility/` contains JSON fixture files produced by the TypeScript reference implementation. Tests deserialize these fixtures into .NET types and verify the values match. This catches wire-format drift between implementations. Use `FixtureLoader` to load fixture arrays. Each test method covers one event shape.

### Integration tests

`tests/AGUI.Hosting.AspNetCore.IntegrationTests/` exercises the full HTTP pipeline — posting `RunAgentInput`, streaming events over the wire, and verifying the results through both the raw event stream and the `AGUIChatClient` (`IChatClient`) abstraction. (The project name is intentionally kept even though the server package was renamed to `AGUI.Server`.) Tests use `WebApplicationFactory<TProgram>` and `ConfigureTestServices` to inject `DelegatingStreamingChatClient` (a `Func`-based `IChatClient`). The test infrastructure supports recording and replaying `ChatResponseUpdate` sequences so tests run deterministically without calling a real LLM. Each test is a `[Theory]` parameterized over a `TransportFormat` (`Json` and `Protobuf`); both transports decode to identical streams, so the same Verify baselines are reused across formats.

Run integration tests:

```bash
dotnet test tests/AGUI.Hosting.AspNetCore.IntegrationTests/
```

The integration test project references every `samples/GettingStarted/Step*` project. The `Samples/GettingStarted/` subfolder contains tests that spin up each sample as a real host, replay pre-recorded `ChatResponseUpdate` sequences via `FakeChatClient`, and verify the output using `Verify.Xunit` snapshot files (`.verified.txt`). When a snapshot test fails, run with `--environment VERIFY_ACCEPT=true` or review the `.received.txt` diff.

### What not to do in tests

- Don't use reflection to enumerate types or verify membership.
- Don't assert behavior by comparing full JSON strings (fragile). Parse with `JsonDocument` and check individual properties.

## Running samples

Each sample under `samples/GettingStarted/` (Step01 through Step14) is a Server/Client pair. The server hosts an AG-UI endpoint as an ASP.NET Core app (the ASP.NET glue comes from the shared `samples/AGUI.Samples.Shared` project); the client drives it through `AGUIChatClient`. To run a sample server manually:

```bash
dotnet run --project samples/GettingStarted/Step01_GettingStarted/Step01_GettingStarted.Server/
```

The `samples/AGUIClientServer/` directory contains a full Dojo server with multiple agent scenarios.

## Project layout

- `src/AGUI.Abstractions/` — Protocol types: events, messages, tools, capabilities, serialization context (`AGUIJsonSerializerContext`), and `AGUIJsonUtilities.RegisterInterruptContentTypes`.
- `src/AGUI.Formatting/` — Wire-format formatters: `IAGUIEventStreamFormatter` (bidirectional read/write) and `SseEventStreamFormatter` (the SSE wire format). Depends on Abstractions + `System.Net.ServerSentEvents`.
- `src/AGUI.Protobuf/` — Protobuf codec (the `internal` `AGUIProtobuf`), the public `ProtobufEventStreamFormatter`, and the `JsonElement`↔`google.protobuf.Value` bridge. The generated proto types are `internal`; the `.proto` schema is referenced from `sdks/typescript/packages/proto` (not copied). Depends on Abstractions + Formatting + `Google.Protobuf`.
- `src/AGUI.Client/` — `AGUIChatClient` (`IChatClient`, constructed from `AGUIChatClientOptions`), `AGUIHttpTransport`/`IAGUITransport`, and the public negotiation primitives (`AGUIEventStreamHandler` `DelegatingHandler` + `ReadAGUIEventStreamAsync`) callers can wire into their own `HttpClient` to request protobuf. Depends on Formatting.
- `src/AGUI.Server/` — Framework-agnostic server-side adapter (no ASP.NET): `RunAgentInputExtensions.ToChatRequestContext`, `ChatRequestContext`, `ChatResponseUpdateAGUIExtensions.AsAGUIEventStreamAsync`, fluent `AGUIStreamOptions`, `AGUIConstants`. Depends on Abstractions + `M.E.AI.Abstractions`.
- `samples/AGUI.Samples.Shared/` — The only ASP.NET project (`FrameworkReference Microsoft.AspNetCore.App`). Hosts the ASP.NET glue: `AGUIResults` (negotiating `IResult`), `AGUIEventStreamResult`, the `MapAGUI` endpoint extension, and `AddAGUI` DI registration.
- `tests/AGUI.Abstractions.UnitTests/` — Serialization round-trip and backward compatibility tests.
- `tests/AGUI.Client.UnitTests/` — Client builder, protocol, and transport-negotiation tests.
- `tests/AGUI.Formatting.UnitTests/` — SSE formatter round-trip tests.
- `tests/AGUI.Protobuf.UnitTests/` — Protobuf codec and formatter tests.
- `tests/AGUI.Server.UnitTests/` — Stream conversion unit tests.
- `tests/AGUI.Hosting.AspNetCore.IntegrationTests/` — End-to-end tests with `WebApplicationFactory`, parameterized over `TransportFormat`, including sample replay tests (name kept after the `AGUI.Server` rename).
- `samples/GettingStarted/` — Progressive Server/Client sample pairs (Step01–Step14; Step12 = parallel tool calls, Step13 = protobuf, Step14 = OpenTelemetry tracing).
- `samples/AGUIClientServer/` — Full Dojo server with multiple agent scenarios.

## Endpoint pattern

Every AG-UI endpoint follows this shape (the GettingStarted samples map it via the shared `app.MapAGUI("/")` helper from `samples/AGUI.Samples.Shared`):

1. `MapPost(pattern, handler)` — receives `[FromBody] RunAgentInput`.
2. Adapt to MEAI with `var ctx = input.ToChatRequestContext(jsonSerializerOptions, streamOptions?)`. The returned `ChatRequestContext` carries the converted `ChatMessage` list and a configured `ChatOptions` (with the input stashed under `AdditionalProperties[AGUIConstants.RunAgentInputKey]` and client tools already routed through the approval-flow pipeline).
3. Call `chatClient.GetStreamingResponseAsync(ctx.Messages, ctx.ChatOptions, cancellationToken)`.
4. Pipe through `.AsAGUIEventStreamAsync(ctx, cancellationToken)` to get the AG-UI event stream.
5. Return `AGUIResults.Events(events, httpContext, cancellationToken)` (from `AGUI.Samples.Shared`). This negotiating `IResult` inspects the request `Accept` header and encodes the stream as Server-Sent Events (the default) or protobuf when the server registers `ProtobufEventStreamFormatter` as an `IAGUIEventStreamFormatter` and the client accepts it. Endpoints no longer hand-write `TypedResults.ServerSentEvents(...)`.

If the endpoint needs framework-specific content mapping (e.g. reasoning, custom workflow events) or a custom interrupt classifier, configure them on the `AGUIStreamOptions` instance passed to `ToChatRequestContext` via fluent `MapContent(...)` / `MapInterrupt(...)` / `MapCall(...)` / `MapResult(...)` calls.

## Public API surface

Each `src/` project has `PublicAPI.Shipped.txt` and `PublicAPI.Unshipped.txt` managed by `Microsoft.CodeAnalysis.PublicApiAnalyzers`. When you add or change a public member, update `PublicAPI.Unshipped.txt`. The build will fail if you forget.

## JSON serialization

Every protocol type must be AOT-compatible. The rules:

- Add `[JsonSerializable(typeof(T))]` to `AGUIJsonSerializerContext` for each new type.
- Use `[JsonPropertyName("camelCase")]` on every serialized property. The context also sets `PropertyNamingPolicy = CamelCase`, but explicit attributes are still required for clarity and PublicAPI analyzer compatibility.
- Do **not** put `[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]` on optional (nullable)
  properties. A field with no value is left out of the JSON by two mechanisms that cover every type at
  once: `DefaultIgnoreCondition = WhenWritingNull` on `AGUIJsonSerializerContext`, and
  `AGUIJsonUtilities.DefaultTypeInfoResolver`, which carries the same rule into caller-owned
  `JsonSerializerOptions` (the context's own setting does not follow it there). Per-property attributes
  are how three `null`s reached the wire and had to be tolerated by receiving SDKs; `NullOmissionTest`
  now fails if the global mechanism stops doing the work, and a re-added attribute masks that.
- A non-nullable `JsonElement` that the contract lets a producer omit needs
  `[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]` instead — it is never `null`, so
  the null rule cannot reach it, and an unset `JsonElement` cannot be written at all. See
  `AGUITool.Parameters` and `RunAgentInput`.
- When composing AG-UI types into your own `JsonSerializerOptions`, insert
  `AGUIJsonUtilities.DefaultTypeInfoResolver` (at the front of the chain, before any resolver that
  answers for arbitrary types) rather than `AGUIJsonSerializerContext.Default`.
- Initialize required string properties to `string.Empty`. Initialize collections to `[]`.
- Polymorphic types use a hand-written `JsonConverter<T>` keyed on a discriminator property (see `BaseEventJsonConverter`, `AGUIMessageJsonConverter`, `AGUIInputContentJsonConverter`).
- Serialize via the source-generated context: `AGUIJsonSerializerContext.Default.{TypeName}`.
- Never use `JsonSerializer.Serialize<object>(...)` or pass raw strings through without parsing.

### Adding a new event type

1. Create the class in `src/AGUI.Abstractions/Events/`, deriving from `BaseEvent`.
2. Override `Type` to return the constant from `AGUIEventTypes`.
3. Add the constant to `AGUIEventTypes`.
4. Add `[JsonSerializable(typeof(T))]` to `AGUIJsonSerializerContext`.
5. Add a read/write case to `BaseEventJsonConverter`.
6. Add the type signature to `PublicAPI.Unshipped.txt`.
7. Write a serialization round-trip test in `tests/AGUI.Abstractions.UnitTests/`.

## Code style

- One class per file. File name matches type name.
- `sealed` on every non-abstract class.
- No `record` types. Use `sealed class` with properties.
- No tuples in public APIs. Define a named type.
- Always use braces for `if`, `for`, `foreach`, `while`, etc.
- No XML docs (`///`) on `internal` or `private` members.
- `ConfigureAwait(false)` on all `await` calls in library code.
- `[EnumeratorCancellation]` on `CancellationToken` parameters in `IAsyncEnumerable` methods.
- Use `ArgumentNullThrowHelper.ThrowIfNull(...)` for public API argument validation. It maps to the BCL `ArgumentNullException.ThrowIfNull` on modern targets and to a manual throw on `netstandard2.0`/`net472`. It and the C# compiler-feature polyfills (`init`, `required`) live in `src/Shared/`, linked into each multi-targeted project (the down-level polyfills are conditionally compiled for `netstandard2.0`/`net472` only).

## Naming

- Event classes: `{Name}Event` (`RunStartedEvent`, `TextMessageContentEvent`).
- Event type discriminators: `SCREAMING_SNAKE_CASE` string constants in `AGUIEventTypes` (`"RUN_STARTED"`, `"TEXT_MESSAGE_START"`). The C# member name uses PascalCase (`AGUIEventTypes.RunStarted`).
- Outcome and role constants: lowercase string constants in dedicated static classes (`RunFinishedOutcome.Interrupt = "interrupt"`, `AGUIRoles.Assistant = "assistant"`). Never enums.
- Options classes: `AGUI{Purpose}Options` (`AGUIStreamOptions`).
- Extension classes: `{Target}Extensions` (`ChatResponseUpdateAGUIExtensions`, `AGUIToolExtensions`).
- Test classes: `{TypeUnderTest}Test` (`RunStartedEventTest`, `ChatResponseUpdateAGUIExtensionsTest`).
- Compatibility test classes: `{Category}CompatibilityTest` in the `Compatibility/` subfolder.
- Namespace for DI extensions: `Microsoft.Extensions.DependencyInjection`.
- Namespace for all other types: matches the `<RootNamespace>` in the `.csproj` (e.g. `AGUI.Abstractions`, `AGUI.Server`). No sub-namespaces—`Events/`, `Messages/`, `Capabilities/` are folders, not namespace segments.
