using System.Text.Json;
using Xunit;

namespace AGUI.Abstractions.UnitTests.Compatibility;

public sealed class ForwardCompatibilityTest
{
    private readonly JsonElement[] _fixtures = FixtureLoader.LoadFixture("forward-compatibility.json");

    [Fact]
    public void RunStarted_WithExtraFields_DeserializesWithoutError()
    {
        var evt = FixtureLoader.DeserializeAsBaseEvent(_fixtures[0]);

        var typed = Assert.IsType<RunStartedEvent>(evt);
        Assert.Equal("t1", typed.ThreadId);
        Assert.Equal("r1", typed.RunId);
    }

    [Fact]
    public void TextMessageStart_WithExtraNestedFields_DeserializesWithoutError()
    {
        var evt = FixtureLoader.DeserializeAsBaseEvent(_fixtures[1]);

        var typed = Assert.IsType<TextMessageStartEvent>(evt);
        Assert.Equal("msg-1", typed.MessageId);
        Assert.Equal("assistant", typed.Role);
    }

    [Fact]
    public void TextMessageContent_WithExtraArrayField_DeserializesWithoutError()
    {
        var evt = FixtureLoader.DeserializeAsBaseEvent(_fixtures[2]);

        var typed = Assert.IsType<TextMessageContentEvent>(evt);
        Assert.Equal("msg-1", typed.MessageId);
        Assert.Equal("hello", typed.Delta);
    }

    [Fact]
    public void ToolCallStart_WithExtraField_DeserializesWithoutError()
    {
        var evt = FixtureLoader.DeserializeAsBaseEvent(_fixtures[3]);

        var typed = Assert.IsType<ToolCallStartEvent>(evt);
        Assert.Equal("tc-1", typed.ToolCallId);
        Assert.Equal("test", typed.ToolCallName);
    }

    [Fact]
    public void StateSnapshot_WithExtraField_DeserializesWithoutError()
    {
        var evt = FixtureLoader.DeserializeAsBaseEvent(_fixtures[4]);

        var typed = Assert.IsType<StateSnapshotEvent>(evt);
        Assert.Equal("value", typed.Snapshot.GetProperty("key").GetString());
    }

    [Fact]
    public void StateDelta_WithExtraField_DeserializesWithoutError()
    {
        var evt = FixtureLoader.DeserializeAsBaseEvent(_fixtures[5]);

        var typed = Assert.IsType<StateDeltaEvent>(evt);
        Assert.Equal(1, typed.Delta.GetArrayLength());
    }

    [Fact]
    public void CustomEvent_WithExtraField_DeserializesWithoutError()
    {
        var evt = FixtureLoader.DeserializeAsBaseEvent(_fixtures[6]);

        var typed = Assert.IsType<CustomEvent>(evt);
        Assert.Equal("test", typed.Name);
    }

    [Fact]
    public void RawEvent_WithExtraField_DeserializesWithoutError()
    {
        var evt = FixtureLoader.DeserializeAsBaseEvent(_fixtures[7]);

        var typed = Assert.IsType<RawEvent>(evt);
        Assert.Equal("test", typed.Source);
    }

    [Fact]
    public void ActivitySnapshot_WithExtraField_DeserializesWithoutError()
    {
        var evt = FixtureLoader.DeserializeAsBaseEvent(_fixtures[8]);

        var typed = Assert.IsType<ActivitySnapshotEvent>(evt);
        Assert.Equal("msg-1", typed.MessageId);
        Assert.Equal("PLAN", typed.ActivityType);
        Assert.True(typed.Replace);
    }

    [Fact]
    public void RunFinished_WithExtraField_DeserializesWithoutError()
    {
        var evt = FixtureLoader.DeserializeAsBaseEvent(_fixtures[9]);

        var typed = Assert.IsType<RunFinishedEvent>(evt);
        Assert.Equal("t1", typed.ThreadId);
        Assert.Equal("r1", typed.RunId);
    }

    [Fact]
    public void RunError_WithExtraNestedField_DeserializesWithoutError()
    {
        var evt = FixtureLoader.DeserializeAsBaseEvent(_fixtures[10]);

        var typed = Assert.IsType<RunErrorEvent>(evt);
        Assert.Equal("fail", typed.Message);
        Assert.Equal("ERR", typed.Code);
    }

    [Fact]
    public void AllForwardCompatibilityEvents_CanDeserialize()
    {
        // Verify that every event in the fixture can be deserialized without throwing
        for (var i = 0; i < _fixtures.Length; i++)
        {
            var evt = FixtureLoader.DeserializeAsBaseEvent(_fixtures[i]);
            Assert.NotNull(evt);
            Assert.False(string.IsNullOrEmpty(evt.Type), $"Event at index {i} has null/empty type");
        }
    }
}
