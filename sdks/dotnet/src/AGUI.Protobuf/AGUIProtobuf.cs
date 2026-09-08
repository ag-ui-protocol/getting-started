using System;
using System.Buffers;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.IO;
using System.Runtime.CompilerServices;
using System.Threading;
using System.Threading.Tasks;
using AGUI.Abstractions;
using Google.Protobuf;
using Proto = AGUI.ProtocolBuffers;

namespace AGUI.Protobuf;

/// <summary>
/// Protobuf codec for AG-UI events, wire-compatible with the TypeScript
/// <c>@ag-ui/proto</c> and <c>@ag-ui/encoder</c> packages.
/// </summary>
internal static class AGUIProtobuf
{
    /// <summary>
    /// Encodes an event to its protobuf message bytes (no length prefix), mirroring
    /// the TypeScript <c>proto.encode</c>.
    /// </summary>
    /// <param name="evt">The event to encode.</param>
    /// <returns>The encoded protobuf message bytes.</returns>
    /// <exception cref="NotSupportedException">The event type is not representable in the protobuf wire format.</exception>
    public static byte[] Encode(BaseEvent evt)
    {
        RequireNotNull(evt, nameof(evt));
        return ProtoEventMapper.ToProto(evt).ToByteArray();
    }

    /// <summary>
    /// Encodes an event's protobuf message bytes (no length prefix) into the supplied buffer writer.
    /// </summary>
    /// <param name="evt">The event to encode.</param>
    /// <param name="writer">The destination buffer writer.</param>
    /// <exception cref="NotSupportedException">The event type is not representable in the protobuf wire format.</exception>
    public static void Encode(BaseEvent evt, IBufferWriter<byte> writer)
    {
        RequireNotNull(evt, nameof(evt));
        RequireNotNull(writer, nameof(writer));
        ProtoEventMapper.ToProto(evt).WriteTo(writer);
    }

    /// <summary>
    /// Decodes protobuf message bytes (no length prefix) into an event, mirroring the
    /// TypeScript <c>proto.decode</c>.
    /// </summary>
    /// <param name="message">The protobuf message bytes.</param>
    /// <returns>The decoded event.</returns>
    public static BaseEvent Decode(ReadOnlySpan<byte> message)
    {
        var proto = Proto.Event.Parser.ParseFrom(message);
        return ProtoEventMapper.FromProto(proto);
    }

    /// <summary>
    /// Writes a single framed event (4-byte big-endian length prefix followed by the
    /// protobuf message bytes) to the supplied buffer writer.
    /// </summary>
    /// <param name="evt">The event to write.</param>
    /// <param name="writer">The destination buffer writer.</param>
    /// <exception cref="NotSupportedException">The event type is not representable in the protobuf wire format.</exception>
    public static void WriteFramed(BaseEvent evt, IBufferWriter<byte> writer)
    {
        RequireNotNull(evt, nameof(evt));
        RequireNotNull(writer, nameof(writer));

        var proto = ProtoEventMapper.ToProto(evt);
        int length = proto.CalculateSize();

        var prefix = writer.GetSpan(4);
        BinaryPrimitives.WriteUInt32BigEndian(prefix, (uint)length);
        writer.Advance(4);

        proto.WriteTo(writer);
    }

    /// <summary>
    /// Reads a stream of framed events (each a 4-byte big-endian length prefix followed by
    /// protobuf message bytes), decoding each one into an event.
    /// </summary>
    /// <param name="stream">The source stream.</param>
    /// <param name="cancellationToken">A token to cancel the read.</param>
    /// <returns>An asynchronous sequence of decoded events.</returns>
    public static async IAsyncEnumerable<BaseEvent> ReadFramedAsync(
        Stream stream,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        RequireNotNull(stream, nameof(stream));

        var prefix = new byte[4];
        while (true)
        {
            if (!await ReadExactlyAsync(stream, prefix, 0, 4, cancellationToken).ConfigureAwait(false))
            {
                yield break;
            }

            uint length = BinaryPrimitives.ReadUInt32BigEndian(prefix);
            var payload = new byte[length];
            if (length > 0 &&
                !await ReadExactlyAsync(stream, payload, 0, (int)length, cancellationToken).ConfigureAwait(false))
            {
                throw new EndOfStreamException("Unexpected end of stream while reading a framed AG-UI event payload.");
            }

            yield return Decode(payload);
        }
    }

    private static async Task<bool> ReadExactlyAsync(
        Stream stream,
        byte[] buffer,
        int offset,
        int count,
        CancellationToken cancellationToken)
    {
        int read = 0;
        while (read < count)
        {
#if NET
            int bytes = await stream
                .ReadAsync(buffer.AsMemory(offset + read, count - read), cancellationToken)
                .ConfigureAwait(false);
#else
            int bytes = await stream
                .ReadAsync(buffer, offset + read, count - read, cancellationToken)
                .ConfigureAwait(false);
#endif
            if (bytes == 0)
            {
                if (read == 0)
                {
                    return false;
                }

                throw new EndOfStreamException("Unexpected end of stream while reading a framed AG-UI event.");
            }

            read += bytes;
        }

        return true;
    }

    private static void RequireNotNull(object? value, string paramName)
    {
        if (value is null)
        {
            throw new ArgumentNullException(paramName);
        }
    }
}
