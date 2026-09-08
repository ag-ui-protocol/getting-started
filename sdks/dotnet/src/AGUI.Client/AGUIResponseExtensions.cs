using System;
using System.Collections.Generic;
using System.IO;
using System.Net.Http;
using System.Runtime.CompilerServices;
using System.Threading;
using System.Threading.Tasks;
using AGUI.Abstractions;
using AGUI.Formatting;

namespace AGUI.Client;

/// <summary>
/// Extension methods for reading an AG-UI event stream from an <see cref="HttpResponseMessage"/>.
/// </summary>
public static class AGUIResponseExtensions
{
    /// <summary>
    /// Reads the AG-UI event stream from the response body, decoding it with the formatter chosen
    /// during content negotiation.
    /// </summary>
    /// <param name="response">The HTTP response to read.</param>
    /// <param name="cancellationToken">A token to cancel the read.</param>
    /// <returns>An asynchronous sequence of decoded events.</returns>
    /// <remarks>
    /// The formatter recorded by <see cref="AGUIEventStreamHandler"/> on the request options is used when
    /// present; otherwise the response falls back to Server-Sent Events, preserving the default behavior
    /// when no handler is configured.
    /// </remarks>
    public static async IAsyncEnumerable<BaseEvent> ReadAGUIEventStreamAsync(
        this HttpResponseMessage response,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        ArgumentNullThrowHelper.ThrowIfNull(response);

        IAGUIEventStreamFormatter? formatter = null;
        if (response.RequestMessage is not null &&
            AGUIEventStreamHandler.TryGetFormatter(response.RequestMessage, out var chosen))
        {
            formatter = chosen;
        }

        formatter ??= new SseEventStreamFormatter();

#if NET
        Stream body = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
#else
        Stream body = await response.Content.ReadAsStreamAsync().ConfigureAwait(false);
#endif

        await foreach (var evt in formatter.ReadAsync(body, cancellationToken).ConfigureAwait(false))
        {
            yield return evt;
        }
    }
}
