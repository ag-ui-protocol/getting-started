using System.Collections.Generic;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using AGUI.Abstractions;

namespace AGUI.Formatting;

/// <summary>
/// Reads and writes an AG-UI event stream for a specific media type.
/// </summary>
/// <remarks>
/// Implementations are stateless and transport-agnostic: they operate on a raw
/// <see cref="Stream"/> so they can be shared between the HTTP client, the server host, and any
/// other transport. A single formatter handles both directions: the read side decodes a response
/// body into events; the write side encodes events into a response body.
/// </remarks>
public interface IAGUIEventStreamFormatter
{
    /// <summary>
    /// Gets the media type advertised in the request <c>Accept</c> header (client side) and written
    /// as the response <c>Content-Type</c> (server side) for this formatter.
    /// </summary>
    /// <remarks>
    /// When several formatters are registered, list order conveys preference (first = highest priority).
    /// </remarks>
    string MediaType { get; }

    /// <summary>
    /// Determines whether this formatter can decode a response with the supplied content type.
    /// </summary>
    /// <param name="contentType">The response media type, or <see langword="null"/> when none was advertised.</param>
    /// <returns><see langword="true"/> if this formatter can read the response; otherwise <see langword="false"/>.</returns>
    bool CanRead(string? contentType);

    /// <summary>
    /// Reads and decodes the event stream from the supplied body.
    /// </summary>
    /// <param name="body">The response body stream.</param>
    /// <param name="cancellationToken">A token to cancel the read.</param>
    /// <returns>An asynchronous sequence of decoded events.</returns>
    IAsyncEnumerable<BaseEvent> ReadAsync(Stream body, CancellationToken cancellationToken);

    /// <summary>
    /// Encodes the supplied events and writes them to the output stream.
    /// </summary>
    /// <param name="events">The events to encode.</param>
    /// <param name="output">The destination stream.</param>
    /// <param name="cancellationToken">A token to cancel the write.</param>
    /// <returns>A task that completes when all events have been written.</returns>
    Task WriteAsync(IAsyncEnumerable<BaseEvent> events, Stream output, CancellationToken cancellationToken);
}
