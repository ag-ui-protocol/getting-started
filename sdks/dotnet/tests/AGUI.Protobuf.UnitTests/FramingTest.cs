using System.Buffers;
using System.Collections.Generic;
using System.IO;
using System.Threading.Tasks;
using AGUI.Abstractions;
using Xunit;

namespace AGUI.Protobuf.UnitTests;

public sealed class FramingTest
{
    [Fact]
    public void EncodeToBufferWriter_MatchesEncodeToArray()
    {
        var evt = new TextMessageContentEvent { MessageId = "m1", Delta = "hi" };

        var expected = AGUIProtobuf.Encode(evt);

        var writer = new ArrayBufferWriter<byte>();
        AGUIProtobuf.Encode(evt, writer);

        Assert.Equal(expected, writer.WrittenSpan.ToArray());
    }

    [Fact]
    public void WriteFramed_PrependsBigEndianLengthPrefix()
    {
        var evt = new TextMessageContentEvent { MessageId = "m1", Delta = "hi" };
        var message = AGUIProtobuf.Encode(evt);

        var writer = new ArrayBufferWriter<byte>();
        AGUIProtobuf.WriteFramed(evt, writer);
        var framed = writer.WrittenSpan.ToArray();

        Assert.Equal(message.Length + 4, framed.Length);
        uint length = ((uint)framed[0] << 24) | ((uint)framed[1] << 16) | ((uint)framed[2] << 8) | framed[3];
        Assert.Equal((uint)message.Length, length);
        Assert.Equal(message, framed[4..]);
    }

    [Fact]
    public async Task ReadFramedAsync_ReadsAllWrittenEvents()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t", RunId = "r" },
            new TextMessageStartEvent { MessageId = "m1", Role = "assistant" },
            new TextMessageContentEvent { MessageId = "m1", Delta = "hello" },
            new TextMessageEndEvent { MessageId = "m1" },
            new RunFinishedEvent { ThreadId = "t", RunId = "r" },
        };

        var writer = new ArrayBufferWriter<byte>();
        foreach (var evt in events)
        {
            AGUIProtobuf.WriteFramed(evt, writer);
        }

        using var stream = new MemoryStream(writer.WrittenSpan.ToArray());

        var decoded = new List<BaseEvent>();
        await foreach (var evt in AGUIProtobuf.ReadFramedAsync(stream).ConfigureAwait(false))
        {
            decoded.Add(evt);
        }

        Assert.Equal(5, decoded.Count);
        Assert.IsType<RunStartedEvent>(decoded[0]);
        Assert.Equal("hello", Assert.IsType<TextMessageContentEvent>(decoded[2]).Delta);
        Assert.IsType<RunFinishedEvent>(decoded[4]);
    }

    [Fact]
    public async Task ReadFramedAsync_EmptyStream_YieldsNothing()
    {
        using var stream = new MemoryStream();

        var count = 0;
        await foreach (var _ in AGUIProtobuf.ReadFramedAsync(stream).ConfigureAwait(false))
        {
            count++;
        }

        Assert.Equal(0, count);
    }

    [Fact]
    public async Task ReadFramedAsync_TruncatedPayload_Throws()
    {
        var evt = new TextMessageContentEvent { MessageId = "m1", Delta = "hello world" };
        var writer = new ArrayBufferWriter<byte>();
        AGUIProtobuf.WriteFramed(evt, writer);
        var framed = writer.WrittenSpan.ToArray();

        using var stream = new MemoryStream(framed[..(framed.Length - 2)]);

        await Assert.ThrowsAsync<EndOfStreamException>(async () =>
        {
            await foreach (var _ in AGUIProtobuf.ReadFramedAsync(stream).ConfigureAwait(false))
            {
            }
        }).ConfigureAwait(true);
    }
}
