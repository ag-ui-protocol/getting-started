using System.Text.Json;
using Xunit;

namespace AGUI.Abstractions.UnitTests;

public sealed class StepFinishedEventTest
{
    [Fact]
    public void Serialization_RoundTrips()
    {
        var evt = new StepFinishedEvent
        {
            StepName = "Process"
        };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.StepFinishedEvent);
        using var doc = JsonDocument.Parse(json);

        Assert.Equal("STEP_FINISHED", doc.RootElement.GetProperty("type").GetString());
        Assert.Equal("Process", doc.RootElement.GetProperty("stepName").GetString());
        Assert.False(doc.RootElement.TryGetProperty("stepId", out _));
        Assert.False(doc.RootElement.TryGetProperty("status", out _));
        Assert.False(doc.RootElement.TryGetProperty("result", out _));
    }

    [Fact]
    public void Deserialize_RoundTrips()
    {
        var evt = new StepFinishedEvent { StepName = "Cleanup" };
        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.StepFinishedEvent);
        var deserialized = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.StepFinishedEvent);

        Assert.NotNull(deserialized);
        Assert.Equal("Cleanup", deserialized.StepName);
    }
}
