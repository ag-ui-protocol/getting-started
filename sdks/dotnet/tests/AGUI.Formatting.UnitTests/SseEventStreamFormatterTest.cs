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

    private static async IAsyncEnumerable<BaseEvent> ToAsync(IEnumerable<BaseEvent> events)
    {
        foreach (var evt in events)
        {
            yield return evt;
        }

        await Task.CompletedTask.ConfigureAwait(false);
    }
}
