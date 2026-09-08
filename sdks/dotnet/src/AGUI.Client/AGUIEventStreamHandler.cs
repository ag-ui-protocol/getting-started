using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Threading;
using System.Threading.Tasks;
using AGUI.Abstractions;
using AGUI.Formatting;

namespace AGUI.Client;

/// <summary>
/// A <see cref="DelegatingHandler"/> that negotiates the AG-UI event stream format.
/// </summary>
/// <remarks>
/// On each request it advertises the registered formatters in the <c>Accept</c> header
/// (list order conveys preference), then inspects the response <c>Content-Type</c> and records
/// the matching formatter on the request. The response body is left untouched so it can be
/// streamed lazily by <see cref="AGUIResponseExtensions.ReadAGUIEventStreamAsync"/>.
/// </remarks>
public sealed class AGUIEventStreamHandler : DelegatingHandler
{
    // HttpRequestMessage.Options is only available on .NET 5 and later, so the netstandard2.0/net472
    // builds fall back to the (otherwise obsolete) HttpRequestMessage.Properties dictionary. Both
    // store the negotiated formatter under the same key.
    private const string FormatterKey = "AGUI.EventStreamFormatter";

#if NET
    private static readonly HttpRequestOptionsKey<IAGUIEventStreamFormatter> FormatterOptionsKey = new(FormatterKey);
#endif

    private readonly IReadOnlyList<IAGUIEventStreamFormatter> _formatters;

    /// <summary>
    /// Initializes a new instance of the <see cref="AGUIEventStreamHandler"/> class.
    /// </summary>
    /// <param name="formatters">The ordered formatters to negotiate; the first has the highest preference.</param>
    public AGUIEventStreamHandler(IEnumerable<IAGUIEventStreamFormatter> formatters)
    {
        ArgumentNullThrowHelper.ThrowIfNull(formatters);

        _formatters = formatters.ToList();
    }

    /// <inheritdoc />
    protected override async Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request,
        CancellationToken cancellationToken)
    {
        ArgumentNullThrowHelper.ThrowIfNull(request);

        if (_formatters.Count > 0)
        {
            request.Headers.Accept.Clear();
            foreach (var formatter in _formatters)
            {
                request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue(formatter.MediaType));
            }
        }

        var response = await base.SendAsync(request, cancellationToken).ConfigureAwait(false);

        var mediaType = response.Content?.Headers.ContentType?.MediaType;
        foreach (var formatter in _formatters)
        {
            if (formatter.CanRead(mediaType))
            {
                SetFormatter(request, formatter);

                // Ensure the response points at the request that carries the chosen formatter so
                // ReadAGUIEventStreamAsync can retrieve it. Real handlers set this; some test doubles do not.
                response.RequestMessage ??= request;
                break;
            }
        }

        return response;
    }

    internal static void SetFormatter(HttpRequestMessage request, IAGUIEventStreamFormatter formatter)
    {
#if NET
        request.Options.Set(FormatterOptionsKey, formatter);
#else
        request.Properties[FormatterKey] = formatter;
#endif
    }

    internal static bool TryGetFormatter(HttpRequestMessage request, out IAGUIEventStreamFormatter? formatter)
    {
#if NET
        return request.Options.TryGetValue(FormatterOptionsKey, out formatter);
#else
        if (request.Properties.TryGetValue(FormatterKey, out var value) && value is IAGUIEventStreamFormatter resolved)
        {
            formatter = resolved;
            return true;
        }

        formatter = null;
        return false;
#endif
    }
}
