using System.Text.Json;
using Xunit;

namespace AGUI.Abstractions.UnitTests;

public sealed class StepStartedEventTest
{
    [Fact]
    public void Serialization_RoundTrips()
    {
        var evt = new StepStartedEvent
        {
            StepName = "Process"
        };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.StepStartedEvent);
        using var doc = JsonDocument.Parse(json);

        Assert.Equal("STEP_STARTED", doc.RootElement.GetProperty("type").GetString());
        Assert.Equal("Process", doc.RootElement.GetProperty("stepName").GetString());
        Assert.False(doc.RootElement.TryGetProperty("stepId", out _));
        Assert.False(doc.RootElement.TryGetProperty("parentStepId", out _));
        Assert.False(doc.RootElement.TryGetProperty("metadata", out _));
    }

    [Fact]
    public void Deserialize_RoundTrips()
    {
        var evt = new StepStartedEvent { StepName = "Initialize" };
        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.StepStartedEvent);
        var deserialized = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.StepStartedEvent);

        Assert.NotNull(deserialized);
        Assert.Equal("Initialize", deserialized.StepName);
    }
}
