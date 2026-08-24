using System.Collections.Generic;
using System.Text.Json;
using AGUI.Abstractions;
using Xunit;

namespace AGUI.Protobuf.UnitTests;

public sealed class EventRoundTripTest
{
    private static T RoundTrip<T>(T evt)
        where T : BaseEvent
    {
        var bytes = AGUIProtobuf.Encode(evt);
        var decoded = AGUIProtobuf.Decode(bytes);
        return Assert.IsType<T>(decoded);
    }

    [Fact]
    public void RunStarted_RoundTrips()
    {
        var result = RoundTrip(new RunStartedEvent
        {
            ThreadId = "thread-1",
            RunId = "run-1",
            Timestamp = 1234567890,
            RawEvent = JsonTestHelpers.Parse("{\"source\":\"x\"}"),
        });

        Assert.Equal("thread-1", result.ThreadId);
        Assert.Equal("run-1", result.RunId);
        Assert.Equal(1234567890, result.Timestamp);
        JsonTestHelpers.AssertEqual(JsonTestHelpers.Parse("{\"source\":\"x\"}"), result.RawEvent!.Value);
    }

    [Fact]
    public void RunFinished_Success_RoundTrips()
    {
        var result = RoundTrip(new RunFinishedEvent
        {
            ThreadId = "thread-1",
            RunId = "run-1",
            Result = JsonTestHelpers.Parse("{\"answer\":42}"),
            Outcome = new RunFinishedSuccessOutcome(),
        });

        Assert.Equal("thread-1", result.ThreadId);
        Assert.Equal("run-1", result.RunId);
        JsonTestHelpers.AssertEqual(JsonTestHelpers.Parse("{\"answer\":42}"), result.Result!.Value);
        Assert.IsType<RunFinishedSuccessOutcome>(result.Outcome);
    }

    [Fact]
    public void RunFinished_Interrupt_RoundTrips()
    {
        var result = RoundTrip(new RunFinishedEvent
        {
            ThreadId = "thread-1",
            RunId = "run-1",
            Outcome = new RunFinishedInterruptOutcome
            {
                Interrupts =
                {
                    new AGUIInterrupt
                    {
                        Id = "int-1",
                        Reason = InterruptReasons.ToolCall,
                        Message = "needs approval",
                        ToolCallId = "tc-1",
                        ResponseSchema = JsonTestHelpers.Parse("{\"type\":\"object\"}"),
                        ExpiresAt = "2030-01-01T00:00:00Z",
                        Metadata = JsonTestHelpers.Parse("{\"k\":\"v\"}"),
                    },
                },
            },
        });

        var outcome = Assert.IsType<RunFinishedInterruptOutcome>(result.Outcome);
        var interrupt = Assert.Single(outcome.Interrupts);
        Assert.Equal("int-1", interrupt.Id);
        Assert.Equal(InterruptReasons.ToolCall, interrupt.Reason);
        Assert.Equal("needs approval", interrupt.Message);
        Assert.Equal("tc-1", interrupt.ToolCallId);
        Assert.Equal("2030-01-01T00:00:00Z", interrupt.ExpiresAt);
        JsonTestHelpers.AssertEqual(JsonTestHelpers.Parse("{\"type\":\"object\"}"), interrupt.ResponseSchema!.Value);
        JsonTestHelpers.AssertEqual(JsonTestHelpers.Parse("{\"k\":\"v\"}"), interrupt.Metadata!.Value);
    }

    [Fact]
    public void RunFinished_NoOutcome_RoundTripsToNull()
    {
        var result = RoundTrip(new RunFinishedEvent { ThreadId = "t", RunId = "r" });

        Assert.Null(result.Outcome);
    }

    [Fact]
    public void RunError_RoundTrips()
    {
        var result = RoundTrip(new RunErrorEvent { Message = "boom", Code = "E42" });

        Assert.Equal("boom", result.Message);
        Assert.Equal("E42", result.Code);
    }

    [Fact]
    public void RunError_NoCode_RoundTrips()
    {
        var result = RoundTrip(new RunErrorEvent { Message = "boom" });

        Assert.Equal("boom", result.Message);
        Assert.Null(result.Code);
    }

    [Fact]
    public void RunFinished_WithUsage_RoundTrips()
    {
        var result = RoundTrip(new RunFinishedEvent
        {
            ThreadId = "thread-1",
            RunId = "run-1",
            Outcome = new RunFinishedSuccessOutcome(),
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
                },
                new TokenUsage { Provider = "anthropic", Model = "claude-opus-4", InputTokens = 1 }
            ],
        });

        Assert.Equal(2, result.Usage!.Count);

        var first = result.Usage[0];
        Assert.Equal("openai", first.Provider);
        Assert.Equal("gpt-4o", first.Model);
        Assert.Equal(11, first.InputTokens);
        Assert.Equal(22, first.OutputTokens);
        Assert.Equal(33, first.TotalTokens);
        Assert.Equal(44, first.ReasoningTokens);
        Assert.Equal(55, first.CachedInputTokens);

        var second = result.Usage[1];
        Assert.Equal("anthropic", second.Provider);
        Assert.Equal(1, second.InputTokens);
        // Counts the producer never reported must stay null, not collapse to 0.
        Assert.Null(second.OutputTokens);
        Assert.Null(second.TotalTokens);
    }

    [Fact]
    public void RunError_WithUsage_RoundTrips()
    {
        var result = RoundTrip(new RunErrorEvent
        {
            Message = "boom",
            Code = "E42",
            Usage = [new TokenUsage { Provider = "openai", InputTokens = 120 }],
        });

        Assert.Equal("boom", result.Message);
        var entry = Assert.Single(result.Usage!);
        Assert.Equal("openai", entry.Provider);
        Assert.Equal(120, entry.InputTokens);
        Assert.Null(entry.Model);
    }

    [Fact]
    public void RunFinished_UsageZeroCounts_SurviveAsZeroNotNull()
    {
        // Providers do report explicit zeros (e.g. cachedInputTokens: 0 when nothing
        // was cached). The proto fields are `optional`, so a set-to-zero count must
        // round-trip as 0 rather than collapsing to "not reported".
        var result = RoundTrip(new RunFinishedEvent
        {
            ThreadId = "thread-1",
            RunId = "run-1",
            Usage = [new TokenUsage { InputTokens = 0, CachedInputTokens = 0, ReasoningTokens = 0 }],
        });

        var entry = Assert.Single(result.Usage!);
        Assert.Equal(0, entry.InputTokens);
        Assert.Equal(0, entry.CachedInputTokens);
        Assert.Equal(0, entry.ReasoningTokens);
        // Never set at all — must stay null, proving zero and absent are distinguishable.
        Assert.Null(entry.OutputTokens);
        Assert.Null(entry.TotalTokens);
    }

    [Fact]
    public void RunFinished_EmptyUsage_EncodesIdenticallyToAbsentUsage()
    {
        var absent = new RunFinishedEvent { ThreadId = "thread-1", RunId = "run-1", Usage = null };
        var empty = new RunFinishedEvent { ThreadId = "thread-1", RunId = "run-1", Usage = [] };

        Assert.Equal(AGUIProtobuf.Encode(absent), AGUIProtobuf.Encode(empty));
    }

    [Fact]
    public void RunFinished_NoUsage_DecodesToNullNotEmptyList()
    {
        var result = RoundTrip(new RunFinishedEvent { ThreadId = "thread-1", RunId = "run-1" });

        Assert.Null(result.Usage);
    }

    [Fact]
    public void RunError_NoUsage_DecodesToNullNotEmptyList()
    {
        var result = RoundTrip(new RunErrorEvent { Message = "boom" });

        Assert.Null(result.Usage);
    }

    [Fact]
    public void StepStarted_RoundTrips()
    {
        var result = RoundTrip(new StepStartedEvent { StepName = "step-1" });

        Assert.Equal("step-1", result.StepName);
    }

    [Fact]
    public void StepFinished_RoundTrips()
    {
        var result = RoundTrip(new StepFinishedEvent { StepName = "step-1" });

        Assert.Equal("step-1", result.StepName);
    }

    [Fact]
    public void TextMessageStart_RoundTrips()
    {
        var result = RoundTrip(new TextMessageStartEvent
        {
            MessageId = "msg-1",
            Role = "assistant",
            Name = "bot",
        });

        Assert.Equal("msg-1", result.MessageId);
        Assert.Equal("assistant", result.Role);
        Assert.Equal("bot", result.Name);
    }

    [Fact]
    public void TextMessageContent_RoundTrips()
    {
        var result = RoundTrip(new TextMessageContentEvent { MessageId = "msg-1", Delta = "hello" });

        Assert.Equal("msg-1", result.MessageId);
        Assert.Equal("hello", result.Delta);
    }

    [Fact]
    public void TextMessageEnd_RoundTrips()
    {
        var result = RoundTrip(new TextMessageEndEvent { MessageId = "msg-1" });

        Assert.Equal("msg-1", result.MessageId);
    }

    [Fact]
    public void ToolCallStart_RoundTrips()
    {
        var result = RoundTrip(new ToolCallStartEvent
        {
            ToolCallId = "tc-1",
            ToolCallName = "search",
            ParentMessageId = "msg-1",
        });

        Assert.Equal("tc-1", result.ToolCallId);
        Assert.Equal("search", result.ToolCallName);
        Assert.Equal("msg-1", result.ParentMessageId);
    }

    [Fact]
    public void ToolCallArgs_RoundTrips()
    {
        var result = RoundTrip(new ToolCallArgsEvent { ToolCallId = "tc-1", Delta = "{\"q\":" });

        Assert.Equal("tc-1", result.ToolCallId);
        Assert.Equal("{\"q\":", result.Delta);
    }

    [Fact]
    public void ToolCallEnd_RoundTrips()
    {
        var result = RoundTrip(new ToolCallEndEvent { ToolCallId = "tc-1" });

        Assert.Equal("tc-1", result.ToolCallId);
    }

    [Fact]
    public void StateSnapshot_RoundTrips()
    {
        var snapshot = JsonTestHelpers.Parse("{\"counter\":5,\"items\":[\"a\",\"b\"]}");
        var result = RoundTrip(new StateSnapshotEvent { Snapshot = snapshot });

        JsonTestHelpers.AssertEqual(snapshot, result.Snapshot);
    }

    [Fact]
    public void StateDelta_RoundTrips()
    {
        var delta = JsonTestHelpers.Parse(
            "[{\"op\":\"add\",\"path\":\"/a\",\"value\":1},{\"op\":\"remove\",\"path\":\"/b\"},{\"op\":\"move\",\"from\":\"/c\",\"path\":\"/d\"}]");
        var result = RoundTrip(new StateDeltaEvent { Delta = delta });

        JsonTestHelpers.AssertEqual(delta, result.Delta);
    }

    [Fact]
    public void MessagesSnapshot_RoundTrips()
    {
        var snapshot = new MessagesSnapshotEvent
        {
            Messages =
            {
                new AGUISystemMessage { Id = "s1", Content = "be helpful", Name = "sys" },
                new AGUIUserMessage { Id = "u1", Content = "hi there", Name = "alice" },
                new AGUIAssistantMessage
                {
                    Id = "a1",
                    Content = "calling tool",
                    ToolCalls = new List<AGUIToolCall>
                    {
                        new AGUIToolCall
                        {
                            Id = "tc-1",
                            Type = "function",
                            Function = new AGUIToolCallFunction { Name = "search", Arguments = "{\"q\":\"x\"}" },
                        },
                    },
                },
                new AGUIToolMessage { Id = "t1", Content = "result", ToolCallId = "tc-1" },
                new AGUIDeveloperMessage { Id = "d1", Content = "debug" },
            },
        };

        var result = RoundTrip(snapshot);

        Assert.Equal(5, result.Messages.Count);

        var system = Assert.IsType<AGUISystemMessage>(result.Messages[0]);
        Assert.Equal("be helpful", system.Content);
        Assert.Equal("sys", system.Name);

        var user = Assert.IsType<AGUIUserMessage>(result.Messages[1]);
        Assert.Equal("alice", user.Name);
        Assert.Equal("hi there", Assert.IsType<string>(user.Content.Value));

        var assistant = Assert.IsType<AGUIAssistantMessage>(result.Messages[2]);
        Assert.Equal("calling tool", assistant.Content);
        var toolCall = Assert.Single(assistant.ToolCalls!);
        Assert.Equal("search", toolCall.Function.Name);
        Assert.Equal("{\"q\":\"x\"}", toolCall.Function.Arguments);

        var tool = Assert.IsType<AGUIToolMessage>(result.Messages[3]);
        Assert.Equal("result", tool.Content);
        Assert.Equal("tc-1", tool.ToolCallId);

        var developer = Assert.IsType<AGUIDeveloperMessage>(result.Messages[4]);
        Assert.Equal("debug", developer.Content);
    }

    [Fact]
    public void MessagesSnapshot_UserMultimodalContent_RoundTrips()
    {
        var snapshot = new MessagesSnapshotEvent
        {
            Messages =
            {
                new AGUIUserMessage
                {
                    Id = "u1",
                    Content = new List<AGUIInputContent>
                    {
                        new AGUITextInputContent { Text = "look at this" },
                        new AGUIImageInputContent
                        {
                            Source = new AGUIInputContentUrlSource { Value = "https://example.com/a.png", MimeType = "image/png" },
                            Metadata = JsonTestHelpers.Parse("{\"alt\":\"pic\"}"),
                        },
                        new AGUIAudioInputContent
                        {
                            Source = new AGUIInputContentDataSource { Value = "base64data", MimeType = "audio/mpeg" },
                        },
                    },
                },
            },
        };

        var result = RoundTrip(snapshot);

        var user = Assert.IsType<AGUIUserMessage>(Assert.Single(result.Messages));
        var parts = Assert.IsType<List<AGUIInputContent>>(user.Content.Value);
        Assert.Equal(3, parts.Count);

        Assert.Equal("look at this", Assert.IsType<AGUITextInputContent>(parts[0]).Text);

        var image = Assert.IsType<AGUIImageInputContent>(parts[1]);
        var imageSource = Assert.IsType<AGUIInputContentUrlSource>(image.Source);
        Assert.Equal("https://example.com/a.png", imageSource.Value);
        Assert.Equal("image/png", imageSource.MimeType);
        JsonTestHelpers.AssertEqual(JsonTestHelpers.Parse("{\"alt\":\"pic\"}"), image.Metadata!.Value);

        var audio = Assert.IsType<AGUIAudioInputContent>(parts[2]);
        var audioSource = Assert.IsType<AGUIInputContentDataSource>(audio.Source);
        Assert.Equal("base64data", audioSource.Value);
        Assert.Equal("audio/mpeg", audioSource.MimeType);
    }

    [Fact]
    public void Raw_RoundTrips()
    {
        var payload = JsonTestHelpers.Parse("{\"foo\":\"bar\"}");
        var result = RoundTrip(new RawEvent { Event = payload, Source = "external" });

        JsonTestHelpers.AssertEqual(payload, result.Event);
        Assert.Equal("external", result.Source);
    }

    [Fact]
    public void Custom_RoundTrips()
    {
        var value = JsonTestHelpers.Parse("[1,2,3]");
        var result = RoundTrip(new CustomEvent { Name = "ping", Value = value });

        Assert.Equal("ping", result.Name);
        JsonTestHelpers.AssertEqual(value, result.Value!.Value);
    }

    [Fact]
    public void Custom_NoValue_RoundTripsAsExplicitNull()
    {
        // The schema makes value required, so the wire always carries it: a
        // C#-null model value crosses as a JSON null and comes back as a
        // null-kind element, which the JSON serialiser collapses to absent.
        var result = RoundTrip(new CustomEvent { Name = "ping" });

        Assert.Equal("ping", result.Name);
        Assert.NotNull(result.Value);
        Assert.Equal(JsonValueKind.Null, result.Value.Value.ValueKind);
    }
}
