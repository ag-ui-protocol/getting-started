using System.Text.Json;
using Xunit;

namespace AGUI.Abstractions.UnitTests.Compatibility;

public sealed class RunEventsCompatibilityTest
{
    private readonly JsonElement[] _fixtures = FixtureLoader.LoadFixture("run-events.json");

    [Fact]
    public void RunStartedEvent_DeserializesFromTypeScriptPayload()
    {
        var evt = FixtureLoader.DeserializeAsBaseEvent(_fixtures[0]);

        var typed = Assert.IsType<RunStartedEvent>(evt);
        Assert.Equal("thread-1234", typed.ThreadId);
        Assert.Equal("run-5678", typed.RunId);
        Assert.Equal(1234567890, typed.Timestamp);
    }

    [Fact]
    public void RunFinishedEvent_DeserializesFromTypeScriptPayload()
    {
        var evt = FixtureLoader.DeserializeAsBaseEvent(_fixtures[1]);

        var typed = Assert.IsType<RunFinishedEvent>(evt);
        Assert.Equal("thread-1234", typed.ThreadId);
        Assert.Equal("run-5678", typed.RunId);
        Assert.Equal(1234567890, typed.Timestamp);
    }

    [Fact]
    public void RunErrorEvent_WithMessage_DeserializesFromTypeScriptPayload()
    {
        var evt = FixtureLoader.DeserializeAsBaseEvent(_fixtures[2]);

        var typed = Assert.IsType<RunErrorEvent>(evt);
        Assert.Equal("Failed to execute tool call", typed.Message);
        Assert.Equal(1234567890, typed.Timestamp);
    }

    [Fact]
    public void RunErrorEvent_WithCode_DeserializesFromTypeScriptPayload()
    {
        var evt = FixtureLoader.DeserializeAsBaseEvent(_fixtures[3]);

        var typed = Assert.IsType<RunErrorEvent>(evt);
        Assert.Equal("API request failed", typed.Message);
        Assert.Equal("API_ERROR", typed.Code);
    }

    [Fact]
    public void StepStartedEvent_WithTimestamp_DeserializesFromTypeScriptPayload()
    {
        var evt = FixtureLoader.DeserializeAsBaseEvent(_fixtures[4]);

        var typed = Assert.IsType<StepStartedEvent>(evt);
        Assert.Equal("data_analysis", typed.StepName);
        Assert.Equal(1234567890, typed.Timestamp);
    }

    [Fact]
    public void StepStartedEvent_Minimal_DeserializesFromTypeScriptPayload()
    {
        var evt = FixtureLoader.DeserializeAsBaseEvent(_fixtures[5]);

        var typed = Assert.IsType<StepStartedEvent>(evt);
        Assert.Equal("process_payment", typed.StepName);
    }

    [Fact]
    public void StepFinishedEvent_WithTimestamp_DeserializesFromTypeScriptPayload()
    {
        var evt = FixtureLoader.DeserializeAsBaseEvent(_fixtures[6]);

        var typed = Assert.IsType<StepFinishedEvent>(evt);
        Assert.Equal("data_analysis", typed.StepName);
        Assert.Equal(1234567890, typed.Timestamp);
    }

    [Fact]
    public void StepFinishedEvent_Minimal_DeserializesFromTypeScriptPayload()
    {
        var evt = FixtureLoader.DeserializeAsBaseEvent(_fixtures[7]);

        var typed = Assert.IsType<StepFinishedEvent>(evt);
        Assert.Equal("process_payment", typed.StepName);
    }

    [Fact]
    public void RunFinishedEvent_WithUsage_DeserializesFromTypeScriptPayload()
    {
        var evt = FixtureLoader.DeserializeAsBaseEvent(_fixtures[8]);

        var typed = Assert.IsType<RunFinishedEvent>(evt);
        Assert.Equal(2, typed.Usage!.Count);

        Assert.Equal("openai", typed.Usage[0].Provider);
        Assert.Equal("gpt-4o", typed.Usage[0].Model);
        Assert.Equal(11, typed.Usage[0].InputTokens);
        Assert.Equal(22, typed.Usage[0].OutputTokens);
        Assert.Equal(33, typed.Usage[0].TotalTokens);
        Assert.Equal(44, typed.Usage[0].ReasoningTokens);
        Assert.Equal(55, typed.Usage[0].CachedInputTokens);

        Assert.Equal("anthropic", typed.Usage[1].Provider);
        Assert.Equal(1, typed.Usage[1].InputTokens);
        Assert.Null(typed.Usage[1].OutputTokens);
    }

    [Fact]
    public void RunErrorEvent_WithUsage_DeserializesFromTypeScriptPayload()
    {
        var evt = FixtureLoader.DeserializeAsBaseEvent(_fixtures[9]);

        var typed = Assert.IsType<RunErrorEvent>(evt);
        Assert.Equal("API request failed", typed.Message);
        var entry = Assert.Single(typed.Usage!);
        Assert.Equal("openai", entry.Provider);
        Assert.Equal(120, entry.InputTokens);
    }

    [Fact]
    public void AllRunEvents_RoundTrip_ProduceSameJson()
    {
        foreach (var fixture in _fixtures)
        {
            var evt = FixtureLoader.DeserializeAsBaseEvent(fixture);
            var reserialized = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.BaseEvent);
            var reDeserialized = JsonSerializer.Deserialize<BaseEvent>(reserialized, AGUIJsonSerializerContext.Default.BaseEvent)!;

            Assert.Equal(evt.Type, reDeserialized.Type);
        }
    }
}
