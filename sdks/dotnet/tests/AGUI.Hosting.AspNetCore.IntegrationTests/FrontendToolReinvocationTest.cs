using System.Runtime.CompilerServices;
using AGUI.Abstractions;
using AGUI.Client;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Xunit;

namespace AGUI.Server.IntegrationTests;

public sealed class FrontendToolReinvocationTest : IntegrationTestBase
{
    public FrontendToolReinvocationTest(WebApplicationFactory<Program> factory) : base(factory) { }

    [Fact]
    public async Task ReinvokedClientTool_SurfacesAgain_WithFreshResult()
    {
        var model = new QueueModel();
        model.Enqueue(EmitToolCallResponse("call_l1", "get_user_location", new Dictionary<string, object?>()));
        model.Enqueue(EmitToolCallResponse("call_l2", "get_user_location", new Dictionary<string, object?>()));
        model.Enqueue(EmitTextResponse("Done."));

        var factory = Factory.WithWebHostBuilder(builder =>
        {
            builder.ConfigureTestServices(services =>
            {
                services.RemoveAll<IChatClient>();
                services.AddChatClient(sp => (IChatClient)model).UseFunctionInvocation();
            });
        });

        var httpClient = factory.CreateClient();
        var transport = new AGUIHttpTransport(httpClient, "/agui");
        var aguiClient = new AGUIChatClient(new() { Transport = transport });

        var results = new List<string>();
        var clientTool = AIFunctionFactory.Create(
            () => { var r = $"Amsterdam #{results.Count + 1}"; results.Add(r); return r; },
            "get_user_location", "Gets the user's GPS location (live)");

        var updates = await CollectUpdates(aguiClient, new List<ChatMessage> { new(ChatRole.User, "where am I?") },
            new ChatOptions { Tools = [clientTool] });

        // The client tool must be executed on the client BOTH times (fresh), not served stale server-side.
        Assert.Equal(new[] { "Amsterdam #1", "Amsterdam #2" }, results);
        // Three provider rounds: initial call, re-invocation, final text.
        Assert.Equal(3, model.Rounds);
        Assert.Contains("Done.", ExtractText(updates));
    }

    private sealed class QueueModel : IChatClient
    {
        private readonly Queue<Func<IAsyncEnumerable<ChatResponseUpdate>>> _q = new();
        public int Rounds { get; private set; }
        public void Enqueue(IAsyncEnumerable<ChatResponseUpdate> u) => _q.Enqueue(() => u);
        public async IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(
            IEnumerable<ChatMessage> messages, ChatOptions? options = null, [EnumeratorCancellation] CancellationToken ct = default)
        {
            Rounds++;
            var src = _q.Count > 0 ? _q.Dequeue()() : EmitTextResponse("fallback", ct);
            await foreach (var u in src.WithCancellation(ct).ConfigureAwait(false)) yield return u;
        }
        public Task<ChatResponse> GetResponseAsync(IEnumerable<ChatMessage> messages, ChatOptions? options = null, CancellationToken ct = default)
            => GetStreamingResponseAsync(messages, options, ct).ToChatResponseAsync(ct);
        public object? GetService(Type t, object? k = null) => null;
        public void Dispose() { }
    }
}
