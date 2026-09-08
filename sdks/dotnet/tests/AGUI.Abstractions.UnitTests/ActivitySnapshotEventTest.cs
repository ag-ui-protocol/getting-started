using System.Text.Json;
using AGUI.Abstractions;
using Xunit;

namespace AGUI.Abstractions.UnitTests;

public sealed class ActivitySnapshotEventTest
{
    [Fact]
    public void Serialize_IncludesTypeAndProperties()
    {
        var evt = new ActivitySnapshotEvent
        {
            MessageId = "msg_activity",
            ActivityType = "PLAN",
            Content = JsonSerializer.SerializeToElement(new { tasks = new[] { "search", "process" } }),
            Replace = true
        };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.ActivitySnapshotEvent);
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        Assert.Equal("ACTIVITY_SNAPSHOT", root.GetProperty("type").GetString());
        Assert.Equal("msg_activity", root.GetProperty("messageId").GetString());
        Assert.Equal("PLAN", root.GetProperty("activityType").GetString());
        Assert.Equal(2, root.GetProperty("content").GetProperty("tasks").GetArrayLength());
        Assert.True(root.GetProperty("replace").GetBoolean());
    }

    [Fact]
    public void Serialize_OmitsReplaceWhenNull()
    {
        var evt = new ActivitySnapshotEvent
        {
            MessageId = "msg1",
            ActivityType = "SEARCH",
            Content = JsonSerializer.SerializeToElement(new { query = "test" })
        };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.ActivitySnapshotEvent);
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        Assert.False(root.TryGetProperty("replace", out _));
    }

    [Fact]
    public void Deserialize_RoundTrips()
    {
        var evt = new ActivitySnapshotEvent
        {
            MessageId = "msg_activity",
            ActivityType = "PLAN",
            Content = JsonSerializer.SerializeToElement(new { tasks = new[] { "search" } }),
            Replace = true
        };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.ActivitySnapshotEvent);
        var deserialized = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.ActivitySnapshotEvent);

        Assert.NotNull(deserialized);
        Assert.Equal("msg_activity", deserialized.MessageId);
        Assert.Equal("PLAN", deserialized.ActivityType);
        Assert.True(deserialized.Replace);
        Assert.Equal(1, deserialized.Content.GetProperty("tasks").GetArrayLength());
    }

    [Fact]
    public void Deserialize_ViaBaseEvent_ReturnsCorrectType()
    {
        var json = """{"type":"ACTIVITY_SNAPSHOT","messageId":"msg1","activityType":"PLAN","content":{"tasks":[]}}""";
        var evt = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.BaseEvent);

        var snapshot = Assert.IsType<ActivitySnapshotEvent>(evt);
        Assert.Equal("msg1", snapshot.MessageId);
        Assert.Equal("PLAN", snapshot.ActivityType);
    }
}
