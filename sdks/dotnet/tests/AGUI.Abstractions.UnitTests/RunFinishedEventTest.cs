using System.Text.Json;
using Xunit;

namespace AGUI.Abstractions.UnitTests;

public sealed class RunFinishedEventTest
{
    [Fact]
    public void Serialization_WithOutcomeAndResult()
    {
        var resultElement = JsonSerializer.SerializeToElement(new { answer = 42 });
        var evt = new RunFinishedEvent
        {
            ThreadId = "t1",
            RunId = "r1",
            Outcome = new RunFinishedSuccessOutcome(),
            Result = resultElement
        };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.RunFinishedEvent);
        using var doc = JsonDocument.Parse(json);

        Assert.Equal("RUN_FINISHED", doc.RootElement.GetProperty("type").GetString());
        Assert.Equal("t1", doc.RootElement.GetProperty("threadId").GetString());
        Assert.Equal("r1", doc.RootElement.GetProperty("runId").GetString());
        Assert.Equal("success", doc.RootElement.GetProperty("outcome").GetProperty("type").GetString());
        Assert.Equal(42, doc.RootElement.GetProperty("result").GetProperty("answer").GetInt32());
    }

    [Fact]
    public void Serialization_WithInterrupt()
    {
        var evt = new RunFinishedEvent
        {
            ThreadId = "t1",
            Outcome = new RunFinishedInterruptOutcome
            {
                Interrupts =
                [
                    new AGUIInterrupt
                    {
                        Id = "int-1",
                        Reason = InterruptReasons.InputRequired,
                        Message = "need_input"
                    }
                ]
            }
        };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.RunFinishedEvent);
        using var doc = JsonDocument.Parse(json);

        Assert.Equal("RUN_FINISHED", doc.RootElement.GetProperty("type").GetString());
        Assert.Equal("interrupt", doc.RootElement.GetProperty("outcome").GetProperty("type").GetString());

        var interrupts = doc.RootElement.GetProperty("outcome").GetProperty("interrupts");
        Assert.Equal(1, interrupts.GetArrayLength());
        Assert.Equal("int-1", interrupts[0].GetProperty("id").GetString());
        Assert.Equal("need_input", interrupts[0].GetProperty("message").GetString());
    }

    [Fact]
    public void Serialization_OmitsNullProperties()
    {
        var evt = new RunFinishedEvent();

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.RunFinishedEvent);
        using var doc = JsonDocument.Parse(json);

        Assert.Equal("RUN_FINISHED", doc.RootElement.GetProperty("type").GetString());
        Assert.Equal("", doc.RootElement.GetProperty("threadId").GetString());
        Assert.Equal("", doc.RootElement.GetProperty("runId").GetString());
        Assert.False(doc.RootElement.TryGetProperty("outcome", out _));
        Assert.False(doc.RootElement.TryGetProperty("result", out _));
        Assert.False(doc.RootElement.TryGetProperty("usage", out _));
    }

    [Fact]
    public void Serialization_WithUsage()
    {
        var evt = new RunFinishedEvent
        {
            ThreadId = "t1",
            RunId = "r1",
            Usage =
            [
                new TokenUsage
                {
                    Provider = "openai",
                    Model = "gpt-4o",
                    InputTokens = 11,
                    OutputTokens = 22,
                    TotalTokens = 33,
                    ReasoningTokens = 44,
                    CachedInputTokens = 55
                }
            ]
        };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.RunFinishedEvent);
        using var doc = JsonDocument.Parse(json);

        var usage = doc.RootElement.GetProperty("usage");
        Assert.Equal(1, usage.GetArrayLength());
        Assert.Equal("openai", usage[0].GetProperty("provider").GetString());
        Assert.Equal("gpt-4o", usage[0].GetProperty("model").GetString());
        Assert.Equal(11, usage[0].GetProperty("inputTokens").GetInt64());
        Assert.Equal(22, usage[0].GetProperty("outputTokens").GetInt64());
        Assert.Equal(33, usage[0].GetProperty("totalTokens").GetInt64());
        Assert.Equal(44, usage[0].GetProperty("reasoningTokens").GetInt64());
        Assert.Equal(55, usage[0].GetProperty("cachedInputTokens").GetInt64());
    }

    [Fact]
    public void Serialization_UsageOmitsUnreportedCounts()
    {
        var evt = new RunFinishedEvent
        {
            ThreadId = "t1",
            RunId = "r1",
            Usage = [new TokenUsage { InputTokens = 7 }]
        };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.RunFinishedEvent);
        using var doc = JsonDocument.Parse(json);

        var entry = doc.RootElement.GetProperty("usage")[0];
        Assert.Equal(7, entry.GetProperty("inputTokens").GetInt64());
        Assert.False(entry.TryGetProperty("provider", out _));
        Assert.False(entry.TryGetProperty("model", out _));
        Assert.False(entry.TryGetProperty("outputTokens", out _));
        Assert.False(entry.TryGetProperty("totalTokens", out _));
        Assert.False(entry.TryGetProperty("reasoningTokens", out _));
        Assert.False(entry.TryGetProperty("cachedInputTokens", out _));
    }

    [Fact]
    public void Deserialization_WithUsage()
    {
        const string json = """
            {
              "type": "RUN_FINISHED",
              "threadId": "t1",
              "runId": "r1",
              "usage": [{ "provider": "anthropic", "model": "claude-opus-4", "inputTokens": 5, "outputTokens": 6 }]
            }
            """;

        var evt = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.RunFinishedEvent);

        Assert.NotNull(evt);
        var entry = Assert.Single(evt.Usage!);
        Assert.Equal("anthropic", entry.Provider);
        Assert.Equal("claude-opus-4", entry.Model);
        Assert.Equal(5, entry.InputTokens);
        Assert.Equal(6, entry.OutputTokens);
        Assert.Null(entry.TotalTokens);
    }
}
