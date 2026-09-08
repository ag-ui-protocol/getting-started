using System.Text.Json;
using Xunit;

namespace AGUI.Abstractions.UnitTests;

public sealed class RunStartedEventTest
{
    [Fact]
    public void Serialization_RoundTrips()
    {
        var evt = new RunStartedEvent
        {
            ThreadId = "t1",
            RunId = "r1",
            Timestamp = 1234567890
        };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.RunStartedEvent);
        using var doc = JsonDocument.Parse(json);

        Assert.Equal("RUN_STARTED", doc.RootElement.GetProperty("type").GetString());
        Assert.Equal("t1", doc.RootElement.GetProperty("threadId").GetString());
        Assert.Equal("r1", doc.RootElement.GetProperty("runId").GetString());
        Assert.Equal(1234567890, doc.RootElement.GetProperty("timestamp").GetInt64());
    }
}
