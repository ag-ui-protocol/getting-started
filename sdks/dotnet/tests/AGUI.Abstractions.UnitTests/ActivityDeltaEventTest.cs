using System.Text.Json;
using AGUI.Abstractions;
using Xunit;

namespace AGUI.Abstractions.UnitTests;

public sealed class ActivityDeltaEventTest
{
    [Fact]
    public void Serialize_IncludesTypeAndProperties()
    {
        var evt = new ActivityDeltaEvent
        {
            MessageId = "msg_activity",
            ActivityType = "PLAN",
            Patch = JsonSerializer.SerializeToElement(new[]
            {
                new { op = "replace", path = "/tasks/0", value = "✓ search" }
            })
        };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.ActivityDeltaEvent);
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        Assert.Equal("ACTIVITY_DELTA", root.GetProperty("type").GetString());
        Assert.Equal("msg_activity", root.GetProperty("messageId").GetString());
        Assert.Equal("PLAN", root.GetProperty("activityType").GetString());
        var patch = root.GetProperty("patch");
        Assert.Equal(1, patch.GetArrayLength());
        Assert.Equal("replace", patch[0].GetProperty("op").GetString());
    }

    [Fact]
    public void Deserialize_RoundTrips()
    {
        var evt = new ActivityDeltaEvent
        {
            MessageId = "msg_activity",
            ActivityType = "PLAN",
            Patch = JsonSerializer.SerializeToElement(new object[]
            {
                new { op = "replace", path = "/tasks/0", value = "done" },
                new { op = "add", path = "/tasks/-", value = "new task" }
            })
        };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.ActivityDeltaEvent);
        var deserialized = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.ActivityDeltaEvent);

        Assert.NotNull(deserialized);
        Assert.Equal("msg_activity", deserialized.MessageId);
        Assert.Equal("PLAN", deserialized.ActivityType);
        Assert.Equal(2, deserialized.Patch.GetArrayLength());
        Assert.Equal("replace", deserialized.Patch[0].GetProperty("op").GetString());
        Assert.Equal("add", deserialized.Patch[1].GetProperty("op").GetString());
    }

    [Fact]
    public void Deserialize_ViaBaseEvent_ReturnsCorrectType()
    {
        var json = """{"type":"ACTIVITY_DELTA","messageId":"msg1","activityType":"PLAN","patch":[{"op":"replace","path":"/tasks/0","value":"done"}]}""";
        var evt = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.BaseEvent);

        var delta = Assert.IsType<ActivityDeltaEvent>(evt);
        Assert.Equal("msg1", delta.MessageId);
        Assert.Equal("PLAN", delta.ActivityType);
        Assert.Equal(1, delta.Patch.GetArrayLength());
    }
}
