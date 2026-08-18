using System.Text.Json;
using Xunit;

namespace AGUI.Abstractions.UnitTests;

public sealed class RunErrorEventTest
{
    [Fact]
    public void Serialization_RoundTrips()
    {
        var evt = new RunErrorEvent
        {
            Message = "Something went wrong",
            Code = "ERR_001"
        };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.RunErrorEvent);
        using var doc = JsonDocument.Parse(json);

        Assert.Equal("RUN_ERROR", doc.RootElement.GetProperty("type").GetString());
        Assert.Equal("Something went wrong", doc.RootElement.GetProperty("message").GetString());
        Assert.Equal("ERR_001", doc.RootElement.GetProperty("code").GetString());
    }

    [Fact]
    public void Serialization_OmitsNullCode()
    {
        var evt = new RunErrorEvent
        {
            Message = "error"
        };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.RunErrorEvent);
        using var doc = JsonDocument.Parse(json);

        Assert.Equal("RUN_ERROR", doc.RootElement.GetProperty("type").GetString());
        Assert.Equal("error", doc.RootElement.GetProperty("message").GetString());
        Assert.False(doc.RootElement.TryGetProperty("code", out _));
        Assert.False(doc.RootElement.TryGetProperty("usage", out _));
    }

    [Fact]
    public void Serialization_WithPartialUsage()
    {
        var evt = new RunErrorEvent
        {
            Message = "model call failed mid-run",
            Usage = [new TokenUsage { Provider = "openai", Model = "gpt-4o", InputTokens = 120 }]
        };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.RunErrorEvent);
        using var doc = JsonDocument.Parse(json);

        var usage = doc.RootElement.GetProperty("usage");
        Assert.Equal(1, usage.GetArrayLength());
        Assert.Equal("openai", usage[0].GetProperty("provider").GetString());
        Assert.Equal("gpt-4o", usage[0].GetProperty("model").GetString());
        Assert.Equal(120, usage[0].GetProperty("inputTokens").GetInt64());
    }

    [Fact]
    public void Deserialization_WithUsage()
    {
        const string json = """
            { "type": "RUN_ERROR", "message": "boom", "usage": [{ "totalTokens": 9 }] }
            """;

        var evt = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.RunErrorEvent);

        Assert.NotNull(evt);
        var entry = Assert.Single(evt.Usage!);
        Assert.Equal(9, entry.TotalTokens);
        Assert.Null(entry.Provider);
    }
}
