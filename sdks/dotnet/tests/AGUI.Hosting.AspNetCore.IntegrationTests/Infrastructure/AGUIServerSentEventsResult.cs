using System.Buffers;
using System.Net.ServerSentEvents;
using System.Runtime.CompilerServices;
using System.Text.Json;
using AGUI.Abstractions;
using Microsoft.AspNetCore.Http;

namespace AGUI.Server.IntegrationTests;

internal sealed class AGUIServerSentEventsResult : IResult, IDisposable
{
    private readonly IAsyncEnumerable<BaseEvent> _events;
    private Utf8JsonWriter? _jsonWriter;

    internal AGUIServerSentEventsResult(IAsyncEnumerable<BaseEvent> events)
    {
        _events = events;
    }

    public async Task ExecuteAsync(HttpContext httpContext)
    {
        httpContext.Response.ContentType = "text/event-stream";
        httpContext.Response.Headers.CacheControl = "no-cache,no-store";
        httpContext.Response.Headers.Pragma = "no-cache";

        var body = httpContext.Response.Body;
        var cancellationToken = httpContext.RequestAborted;

        await SseFormatter.WriteAsync(
            WrapEventsAsSseItemsAsync(_events, cancellationToken),
            body,
            SerializeEvent,
            cancellationToken).ConfigureAwait(false);

        await body.FlushAsync(cancellationToken).ConfigureAwait(false);
    }

    private static async IAsyncEnumerable<SseItem<BaseEvent>> WrapEventsAsSseItemsAsync(
        IAsyncEnumerable<BaseEvent> events,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        await foreach (BaseEvent evt in events.WithCancellation(cancellationToken).ConfigureAwait(false))
        {
            yield return new SseItem<BaseEvent>(evt);
        }
    }

    private void SerializeEvent(SseItem<BaseEvent> item, IBufferWriter<byte> writer)
    {
        if (_jsonWriter == null)
        {
            _jsonWriter = new Utf8JsonWriter(writer);
        }
        else
        {
            _jsonWriter.Reset(writer);
        }

        JsonSerializer.Serialize(_jsonWriter, item.Data, AGUIJsonSerializerContext.Default.BaseEvent);
    }

    public void Dispose()
    {
        _jsonWriter?.Dispose();
    }
}
