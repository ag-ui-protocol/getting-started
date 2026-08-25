---
name: agui-dotnet-unit-tests
description: >
  Author unit tests for the AG-UI .NET SDK (the *.UnitTests projects), following the
  SDK's serialization and compatibility conventions. USE FOR: adding unit-test coverage
  for a new type/method in AGUI.Abstractions/Formatting/Protobuf/Client/Server, event
  serialization round-trips, JsonDocument property-name assertions, backward-compatibility
  fixtures against TypeScript JSON, protobuf codec round-trips, client builder/handler
  tests, server ChatResponseUpdate conversion tests, SSE formatter tests.
  DO NOT USE FOR: HTTP pipeline / WebApplicationFactory end-to-end tests (use the
  agui-dotnet-integration-tests skill), cross-language TS↔C# server-parity tests (use
  the cross-language test skill).
---

# AG-UI .NET Unit Tests

Conventions for the `tests/*.UnitTests` projects. Mined from `sdks/dotnet/AGENTS.md`
and existing tests. An agent gets these wrong by default: asserting on deserialized
objects (misses naming bugs), comparing full JSON strings (fragile), using reflection,
or skipping the `FixtureLoader` compatibility pattern.

All commands run from `sdks/dotnet/`.

## Unit-test projects

| Project | Focus |
|---|---|
| `tests/AGUI.Abstractions.UnitTests/` | Event serialization round-trips; backward compat vs TypeScript fixtures (`Compatibility/`) |
| `tests/AGUI.Protobuf.UnitTests/` | Protobuf codec round-trips; `JsonElement`↔protobuf `Value` conversion |
| `tests/AGUI.Client.UnitTests/` | Client builders, content-negotiation handler, transport, protocol rules |
| `tests/AGUI.Server.UnitTests/` | `ChatResponseUpdate` → AG-UI event conversion |
| `tests/AGUI.Formatting.UnitTests/` | SSE event-stream formatter (read/write, media type) |

Run one project: `dotnet test tests/AGUI.Abstractions.UnitTests/`

## Conventions

- Test files live **directly under the project root** (not mirrored into `Events/` subfolders).
  Compatibility tests go in the `Compatibility/` subfolder.
- Test class name: `{TypeUnderTest}Test` (`RunStartedEventTest`, `ToolCallBuilderTest`).
  Compatibility class: `{Category}CompatibilityTest` (`RunEventsCompatibilityTest`).
- `public sealed class`, one class per file, file name matches type.
- `[Fact]` for single cases, `[Theory]` + `[InlineData]` for parameterized cases.
- Serialize via the source-generated context: `AGUIJsonSerializerContext.Default.{Type}` —
  never `JsonSerializer.Serialize<object>(...)` or hand-rolled options.

## Pattern 1 — Event serialization round-trip (Abstractions)

Serialize via the source-gen context, parse with `JsonDocument`, assert each **camelCase**
property name AND the `type` discriminator. This is what catches `[JsonPropertyName]` bugs.

```csharp
[Fact]
public void Serialization_RoundTrips()
{
    var evt = new RunStartedEvent { ThreadId = "t1", RunId = "r1", Timestamp = 1234567890 };

    var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.RunStartedEvent);
    using var doc = JsonDocument.Parse(json);

    Assert.Equal("RUN_STARTED", doc.RootElement.GetProperty("type").GetString());
    Assert.Equal("t1", doc.RootElement.GetProperty("threadId").GetString());
    Assert.Equal("r1", doc.RootElement.GetProperty("runId").GetString());
    Assert.Equal(1234567890, doc.RootElement.GetProperty("timestamp").GetInt64());
}
```

## Pattern 2 — Backward-compatibility fixtures (Abstractions/Compatibility)

`Compatibility/Fixtures/*.json` are produced by the TypeScript reference implementation.
Deserialize them into .NET types and assert the values — this catches wire-format drift.
Load arrays with `FixtureLoader`; write **one test method per event shape**.

```csharp
public sealed class RunEventsCompatibilityTest
{
    private readonly JsonElement[] _fixtures = FixtureLoader.LoadFixture("run-events.json");

    [Fact]
    public void RunStartedEvent_DeserializesFromTypeScriptPayload()
    {
        var evt = FixtureLoader.DeserializeAsBaseEvent(_fixtures[0]);

        var typed = Assert.IsType<RunStartedEvent>(evt);
        Assert.Equal("thread-1234", typed.ThreadId);
        Assert.Equal("run-5678", typed.RunId);
    }
}
```

Adding a fixture: place the TS-produced JSON array under `Compatibility/Fixtures/`
(embedded resource), then index into the loaded array per shape.

## Pattern 3 — Protobuf codec round-trip (Protobuf)

Encode→decode and assert typed values. Compare `JsonElement` payloads with
`JsonTestHelpers.AssertEqual` (deep-equals), not string compare. `ProtoValueConverter`
tests verify `JsonElement`↔`Value` for each `ValueKind`.

```csharp
var result = RoundTrip(new RunStartedEvent { ThreadId = "thread-1", RunId = "run-1" });
Assert.Equal("thread-1", result.ThreadId);
JsonTestHelpers.AssertEqual(expectedElement, result.RawEvent!.Value);
```

## Pattern 4 — Client builders / handler (Client)

Drive the builder/handler through its real API and assert the produced MEAI types.
`ToolCallBuilder`/`TextMessageBuilder`: feed events, flush, assert `FunctionCallContent`,
`ConversationId`, `ResponseId`. `AGUIEventStreamHandler`: assert content-negotiation
`Accept` header ordering via a test inner handler. Standard xunit assertions.

## Pattern 5 — Server conversion (Server)

Convert a `ChatResponseUpdate` stream to AG-UI events and assert the sequence with
`Assert.Collection`, type-checking each event and its fields (e.g. run lifecycle wraps
content with `RunStartedEvent`/`RunFinishedEvent`).

## Pattern 6 — SSE formatter (Formatting)

Assert `MediaType`, `CanRead(contentType)` (use `[Theory]`/`[InlineData]` for case and
null/empty handling), and that `WriteAsync` produces the `data: {json}` shape per event.

## ❌ Critical anti-patterns

1. **Never assert only on the deserialized object for serialization tests.** Round-trip
   through your own type hides `[JsonPropertyName]` mistakes. Parse the JSON with
   `JsonDocument` and assert the literal camelCase property names + `type` discriminator.
2. **Never compare full JSON strings** — fragile against property ordering/whitespace.
   Parse and check individual properties (or `JsonTestHelpers.AssertEqual` for payloads).
3. **Never use reflection** to enumerate types or verify membership. Write explicit
   per-type / per-shape tests.
4. **Never use ad-hoc serializer options.** Serialize through
   `AGUIJsonSerializerContext.Default.{Type}` so tests exercise the real AOT context.
5. **Never collapse compatibility shapes into one loop-only assertion.** Keep one test
   method per event shape so a drift failure names the exact event.
