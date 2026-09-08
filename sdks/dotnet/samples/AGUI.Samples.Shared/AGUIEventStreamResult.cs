using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using AGUI.Abstractions;
using AGUI.Formatting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;

namespace AGUI.Samples.Shared;

internal sealed class AGUIEventStreamResult : IResult
{
    private readonly IAsyncEnumerable<BaseEvent> _events;
    private readonly IAGUIEventStreamFormatter _formatter;
    private readonly CancellationToken _cancellationToken;

    internal AGUIEventStreamResult(
        IAsyncEnumerable<BaseEvent> events,
        IAGUIEventStreamFormatter formatter,
        CancellationToken cancellationToken)
    {
        _events = events;
        _formatter = formatter;
        _cancellationToken = cancellationToken;
    }

    public async Task ExecuteAsync(HttpContext httpContext)
    {
        ArgumentNullException.ThrowIfNull(httpContext);

        var response = httpContext.Response;
        response.StatusCode = StatusCodes.Status200OK;
        response.ContentType = _formatter.MediaType;
        response.Headers.CacheControl = "no-cache,no-store";
        response.Headers.Pragma = "no-cache";

        httpContext.Features.Get<IHttpResponseBodyFeature>()?.DisableBuffering();

        using var linked = CancellationTokenSource.CreateLinkedTokenSource(
            httpContext.RequestAborted,
            _cancellationToken);

        var body = response.Body;
        await _formatter.WriteAsync(_events, body, linked.Token).ConfigureAwait(false);
        await body.FlushAsync(linked.Token).ConfigureAwait(false);
    }
}
