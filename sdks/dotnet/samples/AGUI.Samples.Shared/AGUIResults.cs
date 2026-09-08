using System.Collections.Generic;
using System.Linq;
using System.Threading;
using AGUI.Abstractions;
using AGUI.Formatting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Net.Http.Headers;

namespace AGUI.Samples.Shared;

/// <summary>
/// Factory methods for AG-UI <see cref="IResult"/> values that negotiate the response
/// transport format from the request <c>Accept</c> header.
/// </summary>
public static class AGUIResults
{
    private const string ProtobufMediaType = "application/vnd.ag-ui.event+proto";

    /// <summary>
    /// Creates a streaming <see cref="IResult"/> that negotiates the AG-UI event stream
    /// transport from the request <c>Accept</c> header.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The available formatters are the registered <see cref="IAGUIEventStreamFormatter"/> services
    /// plus the always-available built-in <see cref="SseEventStreamFormatter"/>.
    /// </para>
    /// <para>
    /// Negotiation mirrors <c>preferredMediaTypes(accept, [proto])</c> in the TypeScript
    /// <c>@ag-ui/encoder</c> package: the protobuf formatter is selected only when its media type is
    /// <em>explicitly</em> present in the <c>Accept</c> header (with a non-zero quality) and a
    /// matching formatter is registered. Otherwise Server-Sent Events are used when
    /// <c>text/event-stream</c>, a wildcard (<c>*/*</c> or <c>text/*</c>), or no <c>Accept</c>
    /// header is acceptable. When neither transport is acceptable the result responds with
    /// <c>406 Not Acceptable</c>.
    /// </para>
    /// </remarks>
    /// <param name="events">The events to stream to the client.</param>
    /// <param name="context">The current request context, used to read the <c>Accept</c> header and resolve formatters.</param>
    /// <param name="cancellationToken">A token to cancel the stream.</param>
    /// <returns>An <see cref="IResult"/> that streams the negotiated representation, or <c>406 Not Acceptable</c>.</returns>
    public static IResult Events(
        IAsyncEnumerable<BaseEvent> events,
        HttpContext context,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(events);
        ArgumentNullException.ThrowIfNull(context);

        var formatters = CollectFormatters(context);
        var chosen = Negotiate(context.Request, formatters);

        if (chosen is null)
        {
            return Results.StatusCode(StatusCodes.Status406NotAcceptable);
        }

        return new AGUIEventStreamResult(events, chosen, cancellationToken);
    }

    private static IReadOnlyList<IAGUIEventStreamFormatter> CollectFormatters(HttpContext context)
    {
        var registered = context.RequestServices.GetServices<IAGUIEventStreamFormatter>();

        var formatters = new List<IAGUIEventStreamFormatter>();
        var hasSse = false;
        foreach (var formatter in registered)
        {
            formatters.Add(formatter);
            if (string.Equals(formatter.MediaType, SseEventStreamFormatter.ServerSentEventsMediaType, StringComparison.OrdinalIgnoreCase))
            {
                hasSse = true;
            }
        }

        if (!hasSse)
        {
            formatters.Add(new SseEventStreamFormatter());
        }

        return formatters;
    }

    private static IAGUIEventStreamFormatter? Negotiate(
        HttpRequest request,
        IReadOnlyList<IAGUIEventStreamFormatter> formatters)
    {
        var accepted = ParseAccept(request);

        var protoFormatter = formatters.FirstOrDefault(
            f => string.Equals(f.MediaType, ProtobufMediaType, StringComparison.OrdinalIgnoreCase));
        if (protoFormatter is not null && IsExplicitlyAcceptable(ProtobufMediaType, accepted))
        {
            return protoFormatter;
        }

        var sseFormatter = formatters.FirstOrDefault(
            f => string.Equals(f.MediaType, SseEventStreamFormatter.ServerSentEventsMediaType, StringComparison.OrdinalIgnoreCase));
        if (sseFormatter is not null && IsSseAcceptable(accepted))
        {
            return sseFormatter;
        }

        return null;
    }

    private static IReadOnlyList<MediaTypeHeaderValue> ParseAccept(HttpRequest request)
    {
        var values = request.Headers.Accept;
        if (values.Count == 0)
        {
            return [];
        }

        if (MediaTypeHeaderValue.TryParseList(values, out var parsed) && parsed is not null)
        {
            return [.. parsed];
        }

        return [];
    }

    private static bool IsExplicitlyAcceptable(
        string mediaType,
        IReadOnlyList<MediaTypeHeaderValue> accepted)
    {
        foreach (var entry in accepted)
        {
            if (QualityAllows(entry) && entry.MediaType.Equals(mediaType, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }

        return false;
    }

    private static bool IsSseAcceptable(IReadOnlyList<MediaTypeHeaderValue> accepted)
    {
        if (accepted.Count == 0)
        {
            return true;
        }

        var sse = new MediaTypeHeaderValue(SseEventStreamFormatter.ServerSentEventsMediaType);
        foreach (var entry in accepted)
        {
            if (QualityAllows(entry) && sse.IsSubsetOf(entry))
            {
                return true;
            }
        }

        return false;
    }

    private static bool QualityAllows(MediaTypeHeaderValue entry)
    {
        return !entry.Quality.HasValue || entry.Quality.Value > 0;
    }
}
