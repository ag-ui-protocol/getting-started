using System.Text.Json;
using AGUI.Abstractions;
using AGUI.Protobuf;
using Xunit;

namespace AGUI.Protobuf.UnitTests;

/// <summary>
/// Metadata must survive the binary transport with every value shape intact,
/// including nulls under a key, and must keep an absent object distinguishable
/// from an empty one.
/// </summary>
public sealed class MetadataRoundTripTest
{
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

    private static BaseEvent RoundTrip(BaseEvent evt) =>
        ProtoEventMapper.FromProto(ProtoEventMapper.ToProto(evt));

    [Fact]
    public void Event_PreservesEveryValueShape()
    {
        var restored = RoundTrip(new TextMessageStartEvent { MessageId = "m1", Metadata = ValueShapes() });

        Assert.NotNull(restored.Metadata);
        var metadata = restored.Metadata!.Value;

        Assert.Equal(JsonValueKind.Null, metadata.GetProperty("nullValue").ValueKind);
        Assert.Equal("finish_reason", metadata.GetProperty("string").GetString());
        Assert.Equal(42, metadata.GetProperty("number").GetInt32());
        Assert.Equal(1.5, metadata.GetProperty("float").GetDouble());
        Assert.True(metadata.GetProperty("boolean").GetBoolean());
        Assert.Equal(0, metadata.GetProperty("emptyArray").GetArrayLength());
        Assert.Equal(4, metadata.GetProperty("array").GetArrayLength());
        Assert.Equal(JsonValueKind.Null, metadata.GetProperty("array")[2].ValueKind);
        Assert.Equal(10, metadata.GetProperty("nested").GetProperty("usage").GetProperty("input").GetInt32());
        Assert.Equal("b", metadata.GetProperty("nested").GetProperty("tags")[1].GetString());
    }

    [Fact]
    public void Event_KeepsAbsentMetadataAbsent()
    {
        var restored = RoundTrip(new TextMessageStartEvent { MessageId = "m1" });

        Assert.Null(restored.Metadata);
    }

    [Fact]
    public void Event_DistinguishesEmptyObjectFromAbsent()
    {
        var restored = RoundTrip(new TextMessageStartEvent
        {
            MessageId = "m1",
            Metadata = JsonDocument.Parse("{}").RootElement.Clone(),
        });

        Assert.NotNull(restored.Metadata);
        Assert.Equal(JsonValueKind.Object, restored.Metadata!.Value.ValueKind);
        Assert.Empty(restored.Metadata!.Value.EnumerateObject());
    }

    [Fact]
    public void NonMessageEvent_CarriesMetadata()
    {
        var restored = RoundTrip(new RunFinishedEvent
        {
            ThreadId = "t1",
            RunId = "r1",
            Metadata = JsonDocument.Parse("""{"usage":{"total":100}}""").RootElement.Clone(),
        });

        Assert.NotNull(restored.Metadata);
        Assert.Equal(100, restored.Metadata!.Value.GetProperty("usage").GetProperty("total").GetInt32());
    }

    [Fact]
    public void MessagesSnapshot_CarriesPerMessageMetadataWithoutLeaking()
    {
        var snapshot = new MessagesSnapshotEvent
        {
            Messages =
            [
                new AGUIAssistantMessage { Id = "m1", Content = "a", Metadata = ValueShapes() },
                new AGUIAssistantMessage { Id = "m2", Content = "b" },
            ],
        };

        var restored = (MessagesSnapshotEvent)RoundTrip(snapshot);

        Assert.NotNull(restored.Messages[0].Metadata);
        Assert.Equal(42, restored.Messages[0].Metadata!.Value.GetProperty("number").GetInt32());
        // The second message had none and must not gain any.
        Assert.Null(restored.Messages[1].Metadata);
    }

    [Fact]
    public void Message_PreservesTheReservedKey()
    {
        var snapshot = new MessagesSnapshotEvent
        {
            Messages =
            [
                new AGUIAssistantMessage
                {
                    Id = "m1",
                    Content = "a",
                    Metadata = JsonDocument
                        .Parse("{\"" + AGUIMetadata.ReservedKey + "\":{\"usage\":{\"input\":1}}}")
                        .RootElement.Clone(),
                },
            ],
        };

        var restored = (MessagesSnapshotEvent)RoundTrip(snapshot);

        Assert.Equal(
            1,
            restored.Messages[0].Metadata!.Value
                .GetProperty(AGUIMetadata.ReservedKey)
                .GetProperty("usage")
                .GetProperty("input")
                .GetInt32());
    }

    [Fact]
    public void NullKindMetadata_IsTreatedAsAbsent()
    {
        // A JsonElement whose kind is Null stands in for an absent object, the
        // same null-as-absent rule the other SDKs apply.
        var restored = RoundTrip(new TextMessageStartEvent
        {
            MessageId = "m1",
            Metadata = JsonDocument.Parse("null").RootElement.Clone(),
        });

        Assert.Null(restored.Metadata);
    }

    [Theory]
    [InlineData("[1,2,3]")]
    [InlineData("\"a string\"")]
    [InlineData("42")]
    [InlineData("true")]
    public void NonObjectMetadata_FailsLoudlyInsteadOfBeingSilentlyDropped(string json)
    {
        // Metadata is an object; TypeScript and Python reject anything else at
        // the parse boundary. .NET types it as JsonElement and cannot, so the
        // encoder must not silently drop it — that would make the value survive
        // JSON and vanish over protobuf.
        var evt = new TextMessageStartEvent
        {
            MessageId = "m1",
            Metadata = JsonDocument.Parse(json).RootElement.Clone(),
        };

        Assert.Throws<NotSupportedException>(() => ProtoEventMapper.ToProto(evt));
    }

    [Fact]
    public void ToolCall_CarriesItsOwnMetadataIndependently()
    {
        // A tool call is not a message, so it carries its own metadata rather
        // than folding into the assistant message that owns it.
        var snapshot = new MessagesSnapshotEvent
        {
            Messages =
            [
                new AGUIAssistantMessage
                {
                    Id = "m1",
                    Content = "",
                    ToolCalls =
                    [
                        new AGUIToolCall
                        {
                            Id = "tc1",
                            Function = new AGUIToolCallFunction { Name = "a", Arguments = "{}" },
                            Metadata = ValueShapes(),
                        },
                        // Carries none, so a leak between tool calls would surface.
                        new AGUIToolCall
                        {
                            Id = "tc2",
                            Function = new AGUIToolCallFunction { Name = "b", Arguments = "{}" },
                        },
                    ],
                },
            ],
        };

        var restored = (MessagesSnapshotEvent)RoundTrip(snapshot);
        var toolCalls = ((AGUIAssistantMessage)restored.Messages[0]).ToolCalls!;

        Assert.Equal(42, toolCalls[0].Metadata!.Value.GetProperty("number").GetInt32());
        Assert.Null(toolCalls[1].Metadata);
        Assert.Null(restored.Messages[0].Metadata);
    }
}
