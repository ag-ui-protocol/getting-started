using System;
using System.Buffers;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using AGUI.Abstractions;
using Xunit;

namespace AGUI.Protobuf.UnitTests;

public sealed class ProtobufEventStreamFormatterTest
{
    [Fact]
    public void MediaType_IsProtobufMediaType()
    {
        var formatter = new ProtobufEventStreamFormatter();

        Assert.Equal(ProtobufEventStreamFormatter.ProtobufMediaType, formatter.MediaType);
    }

    [Theory]
    [InlineData("application/vnd.ag-ui.event+proto", true)]
    [InlineData("text/event-stream", false)]
    [InlineData("", false)]
    [InlineData(null, false)]
    public void CanRead_MatchesProtobufMediaTypeOnly(string? contentType, bool expected)
    {
        var formatter = new ProtobufEventStreamFormatter();

        Assert.Equal(expected, formatter.CanRead(contentType));
    }

    [Fact]
    public async Task ReadAsync_RoundTripsFramedEvents()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new TextMessageStartEvent { MessageId = "m1", Role = "assistant" },
            new TextMessageContentEvent { MessageId = "m1", Delta = "hello" },
            new TextMessageEndEvent { MessageId = "m1" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" },
        };

        var writer = new ArrayBufferWriter<byte>();
        foreach (var evt in events)
        {
            AGUIProtobuf.WriteFramed(evt, writer);
        }

        using var stream = new MemoryStream(writer.WrittenSpan.ToArray());
        var formatter = new ProtobufEventStreamFormatter();

        var decoded = new List<BaseEvent>();
        await foreach (var evt in formatter.ReadAsync(stream, CancellationToken.None).ConfigureAwait(false))
        {
            decoded.Add(evt);
        }

        Assert.Equal(5, decoded.Count);
        Assert.IsType<RunStartedEvent>(decoded[0]);
        Assert.Equal("hello", Assert.IsType<TextMessageContentEvent>(decoded[2]).Delta);
        Assert.IsType<RunFinishedEvent>(decoded[4]);
    }

    [Fact]
    public async Task WriteAsync_ProducesFramedBytesThatRoundTrip()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new TextMessageStartEvent { MessageId = "m1", Role = "assistant" },
            new TextMessageContentEvent { MessageId = "m1", Delta = "hello" },
            new TextMessageEndEvent { MessageId = "m1" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" },
        };

        var formatter = new ProtobufEventStreamFormatter();
        using var stream = new MemoryStream();

        await formatter.WriteAsync(ToAsync(events), stream, CancellationToken.None);

        stream.Position = 0;
        var decoded = new List<BaseEvent>();
        await foreach (var evt in AGUIProtobuf.ReadFramedAsync(stream, CancellationToken.None))
        {
            decoded.Add(evt);
        }

        Assert.Equal(5, decoded.Count);
        Assert.IsType<RunStartedEvent>(decoded[0]);
        Assert.Equal("hello", Assert.IsType<TextMessageContentEvent>(decoded[2]).Delta);
        Assert.IsType<RunFinishedEvent>(decoded[4]);
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
