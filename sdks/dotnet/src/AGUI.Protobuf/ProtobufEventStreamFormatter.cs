using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using AGUI.Abstractions;
using AGUI.Formatting;

namespace AGUI.Protobuf;

/// <summary>
/// Reads and writes an AG-UI event stream encoded as length-prefixed protobuf
/// (<see cref="ProtobufMediaType"/>). Each event is framed as a 4-byte big-endian length
/// prefix followed by its protobuf message bytes, matching the TypeScript <c>@ag-ui/encoder</c>
/// binary framing.
/// </summary>
public sealed class ProtobufEventStreamFormatter : IAGUIEventStreamFormatter
{
    /// <summary>
    /// The media type used to negotiate the AG-UI protobuf event stream.
    /// </summary>
    public const string ProtobufMediaType = "application/vnd.ag-ui.event+proto";

    /// <inheritdoc />
    public string MediaType => ProtobufMediaType;

    /// <inheritdoc />
    public bool CanRead(string? contentType)
    {
        return string.Equals(contentType, ProtobufMediaType, StringComparison.OrdinalIgnoreCase);
    }

    /// <inheritdoc />
    public IAsyncEnumerable<BaseEvent> ReadAsync(Stream body, CancellationToken cancellationToken)
    {
        return AGUIProtobuf.ReadFramedAsync(body, cancellationToken);
    }

    /// <inheritdoc />
    public async Task WriteAsync(
        IAsyncEnumerable<BaseEvent> events,
        Stream output,
        CancellationToken cancellationToken)
    {
#if NET7_0_OR_GREATER
        ArgumentNullException.ThrowIfNull(events);
        ArgumentNullException.ThrowIfNull(output);
#else
        if (events is null)
        {
            throw new ArgumentNullException(nameof(events));
        }

        if (output is null)
        {
            throw new ArgumentNullException(nameof(output));
        }
#endif

        using var buffer = new PooledBufferWriter();
        await foreach (var evt in events.WithCancellation(cancellationToken).ConfigureAwait(false))
        {
            buffer.Reset();
            AGUIProtobuf.WriteFramed(evt, buffer);

#if NET
            await output.WriteAsync(buffer.WrittenMemory, cancellationToken).ConfigureAwait(false);
#else
            await output.WriteAsync(buffer.Buffer, 0, buffer.WrittenCount, cancellationToken).ConfigureAwait(false);
#endif
            await output.FlushAsync(cancellationToken).ConfigureAwait(false);
        }
    }
}
