using System.Net;
using System.Net.Http.Json;
using System.Text;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace AGUI.ClaudeManagedAgents.Tests;

public class ManagedAgentsEndpointTest : IAsyncLifetime
{
    private WebApplication _app = null!;
    private HttpClient _http = null!;
    private FakeManagedAgentsClient _fake = null!;

    public async Task InitializeAsync()
    {
        _fake = new FakeManagedAgentsClient([
            """{"type":"agent.message","id":"msg_1","content":[{"type":"text","text":"Hi!"}]}""",
            """{"type":"session.status_idle","id":"idle_1","stop_reason":{"type":"end_turn"}}""",
        ]);
        var agent = new ManagedAgentsAgent(new ManagedAgentsAgentOptions
        {
            ManagedAgentId = "agent_endpoint",
            EnvironmentId = "env_1",
            Client = _fake,
        });

        var builder = WebApplication.CreateBuilder();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        _app = builder.Build();
        _app.MapManagedAgentsAgent("/chat", agent);
        await _app.StartAsync();

        var address = _app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.First();
        _http = new HttpClient { BaseAddress = new Uri(address) };
    }

    public async Task DisposeAsync()
    {
        _http.Dispose();
        await _app.DisposeAsync();
    }

    [Fact]
    public async Task StreamsTheRunAsServerSentEvents()
    {
        var body = """{"threadId":"thread_1","runId":"run_1","messages":[{"id":"u1","role":"user","content":"Hello"}],"tools":[],"state":{}}""";
        using var response = await _http.PostAsync("/chat", new StringContent(body, Encoding.UTF8, "application/json"));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("text/event-stream", response.Content.Headers.ContentType?.MediaType);

        var stream = await response.Content.ReadAsStringAsync();
        var types = stream
            .Split('\n')
            .Where(line => line.StartsWith("data: ", StringComparison.Ordinal))
            .Select(line => line["data: ".Length..])
            .ToList();
        Assert.Contains(types, json => json.Contains("\"type\":\"RUN_STARTED\"", StringComparison.Ordinal));
        Assert.Contains(types, json => json.Contains("\"type\":\"TEXT_MESSAGE_CONTENT\"", StringComparison.Ordinal) && json.Contains("Hi!", StringComparison.Ordinal));
        Assert.EndsWith("\"type\":\"RUN_FINISHED\",\"threadId\":\"thread_1\",\"runId\":\"run_1\"}", types[^1], StringComparison.Ordinal);
        Assert.Single(_fake.CreatedSessions);
    }

    [Fact]
    public async Task KeysTheSessionStoreByTheManagedAgentAndThreadId()
    {
        var store = new InMemorySessionStore();
        var agent = new ManagedAgentsAgent(new ManagedAgentsAgentOptions
        {
            ManagedAgentId = "agent_endpoint",
            EnvironmentId = "env_1",
            Client = new FakeManagedAgentsClient(["""{"type":"session.status_idle","id":"idle_1","stop_reason":{"type":"end_turn"}}"""]),
            SessionStore = store,
        });
        _app.MapManagedAgentsAgent("/threads", agent);

        var request = new HttpRequestMessage(HttpMethod.Post, "/threads")
        {
            Content = new StringContent(
                """{"threadId":"thread_1","runId":"run_1","messages":[{"id":"u1","role":"user","content":"Hello"}],"tools":[],"state":{}}""",
                Encoding.UTF8,
                "application/json"),
        };
        using var response = await _http.SendAsync(request);
        _ = await response.Content.ReadAsStringAsync();

        // Scoped, not the bare (client-supplied) thread id.
        Assert.Null(await store.GetAsync("thread_1", default));
        Assert.NotNull(await store.GetAsync("14:agent_endpoint|0:|5:env_1|0:|thread_1", default));
    }

    [Fact]
    public async Task ReturnsBadRequestForAnInvalidJsonBody()
    {
        using var response = await _http.PostAsync("/chat", new StringContent("not json", Encoding.UTF8, "application/json"));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }
}
