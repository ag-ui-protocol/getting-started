using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using AGUI.Abstractions;
using AGUI.Formatting;
using Xunit;

namespace AGUI.Formatting.UnitTests;

public sealed class SseEventStreamFormatterTest
{
    [Fact]
    public void MediaType_IsServerSentEvents()
    {
        var formatter = new SseEventStreamFormatter();

        Assert.Equal("text/event-stream", formatter.MediaType);
    }

    [Theory]
    [InlineData(null, true)]
    [InlineData("", true)]
    [InlineData("text/event-stream", true)]
    [InlineData("TEXT/EVENT-STREAM", true)]
    [InlineData("application/json", false)]
    public void CanRead_MatchesServerSentEvents(string? contentType, bool expected)
    {
        var formatter = new SseEventStreamFormatter();

        Assert.Equal(expected, formatter.CanRead(contentType));
    }

    [Fact]
    public async Task WriteAsync_ProducesDataJsonShapeForEachEvent()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new TextMessageContentEvent { MessageId = "m1", Delta = "hi" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" },
        };

        var formatter = new SseEventStreamFormatter();
        using var stream = new MemoryStream();

        await formatter.WriteAsync(ToAsync(events), stream, CancellationToken.None);

        var body = Encoding.UTF8.GetString(stream.ToArray());

        var expected = new StringBuilder();
        foreach (var evt in events)
        {
            var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.BaseEvent);
            expected.Append("data: ").Append(json).Append("\n\n");
        }

        Assert.Equal(expected.ToString(), body);
    }

    [Fact]
    public async Task ReadAsync_RoundTripsWrittenEvents()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new TextMessageContentEvent { MessageId = "m1", Delta = "hi" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" },
        };

        var formatter = new SseEventStreamFormatter();
        using var stream = new MemoryStream();
        await formatter.WriteAsync(ToAsync(events), stream, CancellationToken.None);

        stream.Position = 0;

        var read = new List<BaseEvent>();
        await foreach (var evt in formatter.ReadAsync(stream, CancellationToken.None))
        {
            read.Add(evt);
        }

        Assert.Equal(events.Length, read.Count);
        Assert.IsType<RunStartedEvent>(read[0]);
        Assert.IsType<TextMessageContentEvent>(read[1]);
        Assert.IsType<RunFinishedEvent>(read[2]);
    }

    // The protocol is open at the top: an event type this build has no model for
    // is skipped and the stream carries on, rather than one unknown entry ending
    // an otherwise valid stream.
    [Fact]
    public async Task ReadAsync_SkipsAnUnknownEventTypeAndKeepsReading()
    {
        var body =
            "data: {\"type\":\"RUN_STARTED\",\"threadId\":\"t1\",\"runId\":\"r1\"}\n\n" +
            "data: {\"type\":\"SOMETHING_NEWER\",\"whatever\":1}\n\n" +
            "data: {\"type\":\"RUN_FINISHED\",\"threadId\":\"t1\",\"runId\":\"r1\"}\n\n";

        var formatter = new SseEventStreamFormatter();
        using var stream = new MemoryStream(Encoding.UTF8.GetBytes(body));

        var read = new List<BaseEvent>();
        await foreach (var evt in formatter.ReadAsync(stream, CancellationToken.None))
        {
            read.Add(evt);
        }

        Assert.Collection(
            read,
            evt => Assert.IsType<RunStartedEvent>(evt),
            evt => Assert.IsType<RunFinishedEvent>(evt));
    }

    // A known event that is malformed is a different thing entirely, and stays
    // fatal: skipping it would hide a producer bug behind the openness above.
    [Fact]
    public async Task ReadAsync_ThrowsForAMalformedKnownEvent()
    {
        var body = "data: {\"type\":\"RUN_STARTED\",\"threadId\":[]}\n\n";

        var formatter = new SseEventStreamFormatter();
        using var stream = new MemoryStream(Encoding.UTF8.GetBytes(body));

        await Assert.ThrowsAsync<JsonException>(async () =>
        {
            await foreach (var _ in formatter.ReadAsync(stream, CancellationToken.None).ConfigureAwait(false))
            {
            }
        });
    }

    private static async IAsyncEnumerable<BaseEvent> ToAsync(IEnumerable<BaseEvent> events)
    {
        foreach (var evt in events)
        {
            yield return evt;
        }

        await Task.CompletedTask.ConfigureAwait(false);
    }
}
