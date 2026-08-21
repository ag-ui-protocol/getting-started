using System.Text.Json;
using AGUI.Abstractions;
using Xunit;

namespace AGUI.Abstractions.UnitTests;

/// <summary>
/// Metadata is declared once on <see cref="BaseEvent"/> and once on
/// <see cref="AGUIMessage"/>, so every event type and every message role carries
/// it. These tests cover the value shapes the protocol promises survive a round
/// trip, and the absent/empty/null distinctions.
/// </summary>
public sealed class MetadataTest
{
    // Every JSON shape the protocol promises survives a round trip.
    private const string ValueShapesJson = """
        {
          "nullValue": null,
          "string": "finish_reason",
          "number": 42,
          "float": 1.5,
          "boolean": true,
          "emptyArray": [],
          "array": [1, "two", null, { "nested": true }],
          "emptyObject": {},
          "nested": { "usage": { "input": 10, "output": 20 }, "tags": ["a", "b"] }
        }
        """;

    private static JsonElement ValueShapes() => JsonDocument.Parse(ValueShapesJson).RootElement.Clone();

    [Fact]
    public void Event_SerializesEveryValueShape()
    {
        var evt = new TextMessageStartEvent { MessageId = "m1", Metadata = ValueShapes() };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.TextMessageStartEvent);
        using var doc = JsonDocument.Parse(json);
        var metadata = doc.RootElement.GetProperty("metadata");

        Assert.Equal(JsonValueKind.Null, metadata.GetProperty("nullValue").ValueKind);
        Assert.Equal("finish_reason", metadata.GetProperty("string").GetString());
        Assert.Equal(42, metadata.GetProperty("number").GetInt32());
        Assert.Equal(1.5, metadata.GetProperty("float").GetDouble());
        Assert.True(metadata.GetProperty("boolean").GetBoolean());
        Assert.Equal(0, metadata.GetProperty("emptyArray").GetArrayLength());
        Assert.Equal(4, metadata.GetProperty("array").GetArrayLength());
        Assert.Equal(10, metadata.GetProperty("nested").GetProperty("usage").GetProperty("input").GetInt32());
    }

    [Fact]
    public void Event_RoundTripsMetadata()
    {
        var evt = new TextMessageStartEvent { MessageId = "m1", Metadata = ValueShapes() };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.TextMessageStartEvent);
        var restored = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.TextMessageStartEvent);

        Assert.NotNull(restored);
        Assert.NotNull(restored!.Metadata);
        Assert.Equal(
            JsonSerializer.Serialize(ValueShapes()),
            JsonSerializer.Serialize(restored.Metadata!.Value));
    }

    [Fact]
    public void Event_OmitsAbsentMetadataFromTheWire()
    {
        // An absent object must not become "metadata": null — AG-UI never puts a
        // null on the wire in place of the object.
        var evt = new TextMessageStartEvent { MessageId = "m1" };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.TextMessageStartEvent);
        using var doc = JsonDocument.Parse(json);

        Assert.False(doc.RootElement.TryGetProperty("metadata", out _));
    }

    [Fact]
    public void Event_ReadsExplicitNullAsAbsent()
    {
        // Producers that serialize unset optionals as null must still round-trip,
        // matching the TypeScript and Python schemas.
        const string json = """{"type":"TEXT_MESSAGE_START","messageId":"m1","metadata":null}""";

        var restored = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.TextMessageStartEvent);

        Assert.NotNull(restored);
        Assert.Null(restored!.Metadata);
    }

    [Fact]
    public void Event_DistinguishesEmptyObjectFromAbsent()
    {
        const string json = """{"type":"TEXT_MESSAGE_START","messageId":"m1","metadata":{}}""";

        var restored = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.TextMessageStartEvent);

        Assert.NotNull(restored);
        Assert.NotNull(restored!.Metadata);
        Assert.Equal(JsonValueKind.Object, restored.Metadata!.Value.ValueKind);
        Assert.Empty(restored.Metadata!.Value.EnumerateObject());
    }

    [Fact]
    public void NonMessageEvent_CarriesMetadata()
    {
        var evt = new RunFinishedEvent
        {
            ThreadId = "t1",
            RunId = "r1",
            Metadata = JsonDocument.Parse("""{"usage":{"total":100}}""").RootElement.Clone(),
        };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.RunFinishedEvent);
        var restored = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.RunFinishedEvent);

        Assert.NotNull(restored?.Metadata);
        Assert.Equal(100, restored!.Metadata!.Value.GetProperty("usage").GetProperty("total").GetInt32());
    }

    public static TheoryData<AGUIMessage> AllMessageRoles() =>
    [
        new AGUIDeveloperMessage { Id = "1", Content = "c" },
        new AGUISystemMessage { Id = "1", Content = "c" },
        new AGUIAssistantMessage { Id = "1", Content = "c" },
        new AGUIUserMessage { Id = "1", Content = "c" },
        new AGUIToolMessage { Id = "1", Content = "c", ToolCallId = "tc1" },
        new AGUIActivityMessage
        {
            Id = "1",
            ActivityType = "PLAN",
            Content = JsonDocument.Parse("{}").RootElement.Clone(),
        },
        new AGUIReasoningMessage { Id = "1", Content = "c" },
    ];

    [Theory]
    [MemberData(nameof(AllMessageRoles))]
    public void Message_RoundTripsMetadataForEveryRole(AGUIMessage message)
    {
        message.Metadata = ValueShapes();

        var json = JsonSerializer.Serialize(message, AGUIJsonSerializerContext.Default.AGUIMessage);
        var restored = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.AGUIMessage);

        Assert.NotNull(restored);
        Assert.NotNull(restored!.Metadata);
        Assert.Equal(
            JsonSerializer.Serialize(ValueShapes()),
            JsonSerializer.Serialize(restored.Metadata!.Value));
    }

    [Theory]
    [MemberData(nameof(AllMessageRoles))]
    public void Message_OmitsAbsentMetadataForEveryRole(AGUIMessage message)
    {
        var json = JsonSerializer.Serialize(message, AGUIJsonSerializerContext.Default.AGUIMessage);
        using var doc = JsonDocument.Parse(json);

        Assert.False(doc.RootElement.TryGetProperty("metadata", out _));
    }

    [Theory]
    [MemberData(nameof(AllMessageRoles))]
    public void Message_ReadsExplicitNullAsAbsentForEveryRole(AGUIMessage message)
    {
        var json = JsonSerializer.Serialize(message, AGUIJsonSerializerContext.Default.AGUIMessage);
        // Splice an explicit null in, the way a producer without exclude-none would.
        var withNull = json.TrimEnd('}') + ""","metadata":null}""";

        var restored = JsonSerializer.Deserialize(withNull, AGUIJsonSerializerContext.Default.AGUIMessage);

        Assert.NotNull(restored);
        Assert.Null(restored!.Metadata);
    }

    [Fact]
    public void Message_CarriesTheReservedKey()
    {
        var message = new AGUIAssistantMessage
        {
            Id = "1",
            Content = "hello",
            Metadata = JsonDocument
                .Parse("{\"" + AGUIMetadata.ReservedKey + "\":{\"usage\":{\"input\":1}}}")
                .RootElement.Clone(),
        };

        var json = JsonSerializer.Serialize(message, AGUIJsonSerializerContext.Default.AGUIMessage);
        var restored = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.AGUIMessage);

        Assert.NotNull(restored?.Metadata);
        Assert.Equal(
            1,
            restored!.Metadata!.Value
                .GetProperty(AGUIMetadata.ReservedKey)
                .GetProperty("usage")
                .GetProperty("input")
                .GetInt32());
    }
}
