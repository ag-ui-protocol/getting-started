using System;
using System.Buffers;
using System.Collections.Generic;
using System.IO;
using System.Net.ServerSentEvents;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using AGUI.Abstractions;

namespace AGUI.Formatting;

/// <summary>
/// Reads and writes an AG-UI event stream encoded as Server-Sent Events (<c>text/event-stream</c>).
/// This is the default, always-available formatter; its wire output is a sequence of
/// <c>data: {json}\n\n</c> records where each event is serialized via
/// <see cref="AGUIJsonSerializerContext"/>.
/// </summary>
public sealed class SseEventStreamFormatter : IAGUIEventStreamFormatter
{
    /// <summary>
    /// The media type advertised, decoded, and written by this formatter.
    /// </summary>
    public const string ServerSentEventsMediaType = "text/event-stream";

    /// <inheritdoc />
    public string MediaType => ServerSentEventsMediaType;

    /// <inheritdoc />
    public bool CanRead(string? contentType)
    {
        return string.IsNullOrEmpty(contentType) ||
            string.Equals(contentType, ServerSentEventsMediaType, StringComparison.OrdinalIgnoreCase);
    }

    /// <inheritdoc />
    public async IAsyncEnumerable<BaseEvent> ReadAsync(
        Stream body,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        ArgumentNullThrowHelper.ThrowIfNull(body);

        var items = SseParser.Create(body, ItemParser).EnumerateAsync(cancellationToken);
        await foreach (var item in items.ConfigureAwait(false))
        {
            yield return item.Data;
        }
    }

    /// <inheritdoc />
    public Task WriteAsync(
        IAsyncEnumerable<BaseEvent> events,
        Stream output,
        CancellationToken cancellationToken)
    {
        ArgumentNullThrowHelper.ThrowIfNull(events);
        ArgumentNullThrowHelper.ThrowIfNull(output);

        return SseFormatter.WriteAsync(
            WrapAsSseItems(events, cancellationToken),
            output,
            SerializeEvent,
            cancellationToken);
    }

    private static BaseEvent ItemParser(string type, ReadOnlySpan<byte> data)
    {
        return JsonSerializer.Deserialize(data, AGUIJsonSerializerContext.Default.BaseEvent) ??
            throw new InvalidOperationException("Failed to deserialize SSE item.");
    }

    private static async IAsyncEnumerable<SseItem<BaseEvent>> WrapAsSseItems(
        IAsyncEnumerable<BaseEvent> events,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        await foreach (var evt in events.WithCancellation(cancellationToken).ConfigureAwait(false))
        {
            yield return new SseItem<BaseEvent>(evt);
        }
    }

    private static void SerializeEvent(SseItem<BaseEvent> item, IBufferWriter<byte> writer)
    {
        using var jsonWriter = new Utf8JsonWriter(writer);
        JsonSerializer.Serialize(jsonWriter, item.Data, AGUIJsonSerializerContext.Default.BaseEvent);
    }
}
