using System.Collections.Generic;
using System.Net.Http;
using System.Net.Http.Json;
using System.Runtime.CompilerServices;
using System.Threading;
using System.Threading.Tasks;
using AGUI.Abstractions;

namespace AGUI.Client;

internal sealed class AGUIHttpTransport : IAGUITransport
{
    private readonly HttpClient _client;
    private readonly string _endpoint;

    internal AGUIHttpTransport(HttpClient client, string endpoint)
    {
        _client = client;
        _endpoint = endpoint;
    }

    public async IAsyncEnumerable<BaseEvent> SendAsync(
        RunAgentInput input,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        using HttpRequestMessage request = new(HttpMethod.Post, _endpoint)
        {
            Content = JsonContent.Create(input, AGUIJsonSerializerContext.Default.RunAgentInput),
        };

        using HttpResponseMessage response = await _client.SendAsync(
            request,
            HttpCompletionOption.ResponseHeadersRead,
            cancellationToken).ConfigureAwait(false);

        response.EnsureSuccessStatusCode();

        await foreach (var evt in response.ReadAGUIEventStreamAsync(cancellationToken).ConfigureAwait(false))
        {
            yield return evt;
        }
    }
}
