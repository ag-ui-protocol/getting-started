---
name: agui-dotnet-wire-types
description: 'Add or modify a wire/protocol type in the AG-UI .NET SDK AGUI.Abstractions package — a new event, message, or content-part type, the AOT source-gen serializer context, or a polymorphic JSON converter, keeping it AOT-safe, JSON-wire-compatible with the TypeScript reference, and PublicAPI-clean. USE FOR: adding an AG-UI event type, adding a message role or input-content type, editing AGUIJsonSerializerContext, editing BaseEventJsonConverter / AGUIMessageJsonConverter / AGUIInputContentJsonConverter, fixing PublicAPI.Unshipped analyzer build failures on protocol types, wire-format round-trip serialization. DO NOT USE FOR: writing integration/SSE tests (use agui-dotnet-integration-tests), server hosting/endpoint code, or non-Abstractions packages.'
---

# AG-UI .NET Wire/Protocol Types

Add or change a serialized protocol type in `sdks/dotnet/src/AGUI.Abstractions/`. These types are the JSON wire format. **The TypeScript SDK is the reference** — every type must round-trip against its JSON. Add `// Keep in sync with sdks/typescript/packages/core/src/{events,types}.ts` to each new type.

The 5 source packages are `AGUI.Abstractions`, `AGUI.Formatting`, `AGUI.Protobuf`, `AGUI.Client`, `AGUI.Server`. Wire types live in `AGUI.Abstractions` only. (`sdks/dotnet/AGENTS.md` is the canonical reference for the serialization rules and conventions.)

Run all commands from `sdks/dotnet/`.

## Hard rules (forgetting any breaks the build or wire compat)

Every change to a polymorphic type touches **four** coordinated spots. Miss one and either the build fails or the type silently won't deserialize:

1. The concrete class (`Events/`, `Messages/`).
2. The discriminator constant (`AGUIEventTypes` / `AGUIRoles` / `AGUIInputContentTypes`).
3. The source-gen context registration (`Serialization/AGUIJsonSerializerContext.cs`).
4. The hand-written converter `Read` **and** `Write` cases (`BaseEventJsonConverter` / `AGUIMessageJsonConverter` / `AGUIInputContentJsonConverter`).

Plus: `PublicAPI.Unshipped.txt` (analyzer fails the build) and a round-trip test.

## Recipe: new EVENT type

1. **Class** in `Events/{Name}Event.cs`, `sealed`, deriving `BaseEvent`. Override `Type => AGUIEventTypes.{Name}`.
2. **Constant** in `Events/AGUIEventTypes.cs`: `public const string {Name} = "SCREAMING_SNAKE_CASE";`.
3. **Register** `[JsonSerializable(typeof({Name}Event))]` in `AGUIJsonSerializerContext`.
4. **Converter** in `BaseEventJsonConverter`: add a `Read` switch arm (`AGUIEventTypes.{Name} => jsonElement.Deserialize(options.GetTypeInfo(typeof({Name}Event))) as {Name}Event`) **and** a `Write` `case {Name}Event x: JsonSerializer.Serialize(writer, x, options.GetTypeInfo(typeof({Name}Event))); break;`.
5. **PublicAPI** — add every new public member to `src/AGUI.Abstractions/PublicAPI.Unshipped.txt` (format below).
6. **Test** in `tests/AGUI.Abstractions.UnitTests/{Name}EventTest.cs` (JsonDocument assertions).

```csharp
[JsonPropertyName("type")]
public override string Type => AGUIEventTypes.RunStarted;

[JsonPropertyName("threadId")]                          // required: init to string.Empty
public string ThreadId { get; set; } = string.Empty;

[JsonPropertyName("parentRunId")]                       // optional: no JsonIgnore needed
public string? ParentRunId { get; set; }

[JsonPropertyName("value")]                             // dynamic payload: JsonElement, never object
public JsonElement? Value { get; set; }
```

## Variation: MESSAGE type

Same shape, but: folder `Messages/`, derive `AGUIMessage`, discriminator is `role` keyed on `AGUIRoles` constants (lowercase, e.g. `"assistant"`), and the converter is `AGUIMessageJsonConverter` (`Read` + `Write` switch arms). Sync against `types.ts`. Most roles serialize directly; `AGUIUserMessage` is hand-serialized because its `content` is `string | array` — follow the existing `WriteUserMessage`/`DeserializeUserMessage` pattern if a role needs union content.

## Variation: INPUT-CONTENT part

Folder `Messages/`, derive `AGUIInputContent`, discriminator is `type` keyed on `AGUIInputContentTypes` constants (lowercase, e.g. `"image"`), converter is `AGUIInputContentJsonConverter`. **Also** add the same arm to `AGUIMessageJsonConverter.DeserializeUserMessage`'s inner `contentType switch`, since user-message arrays inline-dispatch content parts.

## Serialization / AOT rules

- `[JsonSerializable(typeof(T))]` for every new type — non-negotiable for AOT (no runtime reflection serializer).
- `[JsonPropertyName("camelCase")]` on every serialized property (explicit even though the context sets `CamelCase`).
- **No** `[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]` on optional properties. The
  context sets `DefaultIgnoreCondition = WhenWritingNull` once, for every type it knows, and
  `AGUIJsonUtilities.DefaultTypeInfoResolver` carries the same rule into caller-owned
  `JsonSerializerOptions`. Repeating it per property is what let three `null`s onto the wire before
  anyone noticed the pattern was optional. `NullOmissionTest` fails if the context-wide setting stops
  doing the work, so a re-added attribute is not a harmless duplicate — it hides the regression.
- A non-nullable `JsonElement` that the contract lets a producer leave out does need
  `[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]` (see `AGUITool.Parameters`): it
  is never `null`, so the null rule cannot reach it, and an unset `JsonElement` throws on write.
- Required strings init to `string.Empty`; collections init to `[]`.
- Serialize via the generated context: `AGUIJsonSerializerContext.Default.{Type}` (or `options.GetTypeInfo(typeof(T))` inside converters).
- Dynamic/arbitrary payloads are `JsonElement` / `JsonElement?`.
- **Never** `JsonSerializer.Serialize<object>(...)`, never pass raw strings through unparsed, never reflection-based serialization.

## Polymorphic converter pattern

Hand-written `JsonConverter<TBase>`, keyed on a discriminator property. `BaseEventJsonConverter` is the exemplar: `Read` deserializes to `JsonElement`, reads the discriminator, `switch`es to the concrete `GetTypeInfo(...)`, and throws `JsonException` on unknown/null; `Write` `switch`es on the runtime type. Both directions must list every concrete type. A new abstract family needs the converter referenced via `[JsonConverter(typeof(...))]` on the base class.

## PublicAPI.Unshipped.txt

The analyzer fails the build if a public member is missing here. Add one line per member, e.g. for an event:

```
AGUI.Abstractions.RunStartedEvent
AGUI.Abstractions.RunStartedEvent.RunStartedEvent() -> void
AGUI.Abstractions.RunStartedEvent.ThreadId.get -> string!
AGUI.Abstractions.RunStartedEvent.ThreadId.set -> void
override AGUI.Abstractions.RunStartedEvent.Type.get -> string!
AGUI.Abstractions.AGUIJsonSerializerContext.RunStartedEvent.get -> System.Text.Json.Serialization.Metadata.JsonTypeInfo<AGUI.Abstractions.RunStartedEvent>
```

`!` = non-null reference, `?` = nullable. Don't forget the source-gen context's generated `JsonTypeInfo<T>` getter line.

## Round-trip test (mandatory)

Assert JSON **property names** by parsing with `JsonDocument` — asserting the deserialized object alone misses camelCase/discriminator bugs. Don't compare full JSON strings; no reflection.

```csharp
var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.CustomEvent);
using var doc = JsonDocument.Parse(json);
Assert.Equal("CUSTOM", doc.RootElement.GetProperty("type").GetString());
Assert.Equal("user_preference_updated", doc.RootElement.GetProperty("name").GetString());
```

Also test dispatch through the base: `JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.BaseEvent)` then `Assert.IsType<CustomEvent>(evt)`. For wire-format drift, add a fixture under `tests/AGUI.Abstractions.UnitTests/Compatibility/` produced by the TypeScript SDK and load it via `FixtureLoader` (`{Category}CompatibilityTest` naming).

## Code style / naming

- `sealed class` (no `record`); one type per file named for the type.
- No tuples in public APIs — define a named type.
- Event classes `{Name}Event`; event discriminators `SCREAMING_SNAKE_CASE` (member PascalCase); role/type/outcome discriminators are lowercase string constants in static classes — **never enums**.
- Braces always; `ArgumentNullException.ThrowIfNull(...)` for public validation; no `///` docs on `internal`/`private`.

## Validate

```bash
dotnet build
dotnet test tests/AGUI.Abstractions.UnitTests/
```
