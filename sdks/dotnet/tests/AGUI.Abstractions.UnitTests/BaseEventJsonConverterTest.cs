using System.Text.Json;
using Xunit;

namespace AGUI.Abstractions.UnitTests;

public sealed class BaseEventJsonConverterTest
{
    [Fact]
    public void PolymorphicDeserialization_RunStartedEvent()
    {
        var original = new RunStartedEvent
        {
            ThreadId = "t1",
            RunId = "r1"
        };

        var json = JsonSerializer.Serialize<BaseEvent>(original, AGUIJsonSerializerContext.Default.BaseEvent);
        using var doc = JsonDocument.Parse(json);
        Assert.Equal("RUN_STARTED", doc.RootElement.GetProperty("type").GetString());

        var deserialized = JsonSerializer.Deserialize<BaseEvent>(json, AGUIJsonSerializerContext.Default.BaseEvent);
        Assert.NotNull(deserialized);
        var typed = Assert.IsType<RunStartedEvent>(deserialized);
        Assert.Equal("t1", typed.ThreadId);
        Assert.Equal("r1", typed.RunId);
    }

    [Fact]
    public void PolymorphicDeserialization_RunFinishedEvent()
    {
        var original = new RunFinishedEvent
        {
            ThreadId = "t1",
            Outcome = new RunFinishedSuccessOutcome()
        };

        var json = JsonSerializer.Serialize<BaseEvent>(original, AGUIJsonSerializerContext.Default.BaseEvent);
        var deserialized = JsonSerializer.Deserialize<BaseEvent>(json, AGUIJsonSerializerContext.Default.BaseEvent);

        Assert.NotNull(deserialized);
        var typed = Assert.IsType<RunFinishedEvent>(deserialized);
        Assert.Equal("t1", typed.ThreadId);
        Assert.IsType<RunFinishedSuccessOutcome>(typed.Outcome);
    }

    [Fact]
    public void PolymorphicDeserialization_RunErrorEvent()
    {
        var original = new RunErrorEvent
        {
            Message = "fail",
            Code = "E1"
        };

        var json = JsonSerializer.Serialize<BaseEvent>(original, AGUIJsonSerializerContext.Default.BaseEvent);
        var deserialized = JsonSerializer.Deserialize<BaseEvent>(json, AGUIJsonSerializerContext.Default.BaseEvent);

        Assert.NotNull(deserialized);
        var typed = Assert.IsType<RunErrorEvent>(deserialized);
        Assert.Equal("fail", typed.Message);
        Assert.Equal("E1", typed.Code);
    }

    [Fact]
    public void Deserialization_ThrowsForUnknownType()
    {
        var json = """{"type":"UNKNOWN_TYPE"}""";
        Assert.Throws<JsonException>(() =>
            JsonSerializer.Deserialize<BaseEvent>(json, AGUIJsonSerializerContext.Default.BaseEvent));
    }

    [Fact]
    public void Deserialization_ThrowsForMissingType()
    {
        var json = """{"threadId":"t1"}""";
        Assert.Throws<JsonException>(() =>
            JsonSerializer.Deserialize<BaseEvent>(json, AGUIJsonSerializerContext.Default.BaseEvent));
    }
}
