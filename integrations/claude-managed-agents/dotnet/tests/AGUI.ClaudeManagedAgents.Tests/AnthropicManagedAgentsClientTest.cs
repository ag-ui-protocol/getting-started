using System.Net;
using System.Text;
using System.Text.Json;
using Anthropic;
using Anthropic.Core;
using Xunit;

namespace AGUI.ClaudeManagedAgents.Tests;

/// <summary>
/// Wire-shape tests for the default client, over a fake HTTP handler (no network).
/// </summary>
public class AnthropicManagedAgentsClientTest
{
    private sealed class RecordedRequest
    {
        internal required HttpMethod Method { get; init; }

        internal required Uri Uri { get; init; }

        internal required string? BetaHeader { get; init; }

        internal required JsonElement? Body { get; init; }
    }

    private sealed class RecordingHandler : HttpMessageHandler
    {
        private readonly Func<HttpRequestMessage, HttpResponseMessage> _respond;

        internal RecordingHandler(Func<HttpRequestMessage, HttpResponseMessage> respond) => _respond = respond;

        internal List<RecordedRequest> Requests { get; } = [];

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var body = request.Content is null ? null : await request.Content.ReadAsStringAsync(cancellationToken);
            Requests.Add(new RecordedRequest
            {
                Method = request.Method,
                Uri = request.RequestUri!,
                BetaHeader = request.Headers.TryGetValues("anthropic-beta", out var values) ? string.Join(",", values) : null,
                Body = string.IsNullOrEmpty(body) ? null : FakeManagedAgentsClient.Json(body),
            });
            return _respond(request);
        }
    }

    private static AnthropicManagedAgentsClient NewClient(RecordingHandler handler)
    {
        var options = new ClientOptions
        {
            ApiKey = "test-key",
            BaseUrl = "http://managed-agents.test",
            HttpClient = new HttpClient(handler),
            MaxRetries = 0,
        };
        return new AnthropicManagedAgentsClient(new AnthropicClient(options));
    }

    private static HttpResponseMessage JsonResponse(string json)
    {
        return new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(json, Encoding.UTF8, "application/json"),
        };
    }

    private static void AssertJson(string expected, JsonElement? actual)
    {
        Assert.NotNull(actual);
        var expectedElement = FakeManagedAgentsClient.Json(expected);
        Assert.True(
            JsonElement.DeepEquals(expectedElement, actual!.Value),
            $"Expected {expectedElement.GetRawText()}\nActual   {actual.Value.GetRawText()}");
    }

    [Fact]
    public async Task CreatesASessionWithToolOverridesAndAPinnedVersion()
    {
        var handler = new RecordingHandler(_ => JsonResponse("""{"id":"sesn_test"}"""));
        var client = NewClient(handler);

        var sessionId = await client.CreateSessionAsync(
            new ManagedAgentSessionRequest
            {
                ManagedAgentId = "agent_1",
                AgentVersion = 3,
                EnvironmentId = "env_1",
                Title = "AG-UI thread thread_1",
                OverrideTools = [FakeManagedAgentsClient.Json("""{"type":"custom","name":"show_chart"}""")],
            },
            default);

        Assert.Equal("sesn_test", sessionId);
        var request = Assert.Single(handler.Requests);
        Assert.Equal((HttpMethod.Post, "/v1/sessions"), (request.Method, request.Uri.AbsolutePath));
        Assert.Contains("managed-agents-2026-04-01", request.BetaHeader);
        AssertJson(
            """
            {
              "agent": {"type": "agent_with_overrides", "id": "agent_1", "version": 3, "tools": [{"type": "custom", "name": "show_chart"}]},
              "environment_id": "env_1",
              "title": "AG-UI thread thread_1"
            }
            """,
            request.Body);
    }

    [Fact]
    public async Task CreatesASessionOnThePlainAgentWithoutOverrides()
    {
        var handler = new RecordingHandler(_ => JsonResponse("""{"id":"sesn_test"}"""));
        var client = NewClient(handler);

        await client.CreateSessionAsync(
            new ManagedAgentSessionRequest { ManagedAgentId = "agent_1", EnvironmentId = "env_1", Title = "T" },
            default);

        AssertJson(
            """{"agent":{"type":"agent","id":"agent_1"},"environment_id":"env_1","title":"T"}""",
            Assert.Single(handler.Requests).Body);
    }

    [Fact]
    public async Task UpdatesTheSessionsToolListInFull()
    {
        var handler = new RecordingHandler(_ => JsonResponse("""{"id":"sesn_test"}"""));
        var client = NewClient(handler);

        await client.UpdateSessionToolsAsync(
            "sesn_test",
            [
                FakeManagedAgentsClient.Json("""{"type":"agent_toolset_20260401"}"""),
                FakeManagedAgentsClient.Json("""{"type":"custom","name":"show_chart"}"""),
            ],
            default);

        var request = Assert.Single(handler.Requests);
        Assert.Equal((HttpMethod.Post, "/v1/sessions/sesn_test"), (request.Method, request.Uri.AbsolutePath));
        AssertJson(
            """{"agent":{"tools":[{"type":"agent_toolset_20260401"},{"type":"custom","name":"show_chart"}]}}""",
            request.Body);
    }

    [Fact]
    public async Task ReadsTheAgentsOwnToolsAtAPinnedVersion()
    {
        var handler = new RecordingHandler(_ => JsonResponse("""{"id":"agent_1","tools":[{"type":"agent_toolset_20260401"}]}"""));
        var client = NewClient(handler);

        var tools = await client.GetAgentToolsAsync("agent_1", 3, default);

        var request = Assert.Single(handler.Requests);
        Assert.Equal((HttpMethod.Get, "/v1/agents/agent_1"), (request.Method, request.Uri.AbsolutePath));
        Assert.Contains("version=3", request.Uri.Query);
        AssertJson("""{"type":"agent_toolset_20260401"}""", Assert.Single(tools));
    }

    [Fact]
    public async Task PostsEventsIntoTheSession()
    {
        var handler = new RecordingHandler(_ => JsonResponse("{}"));
        var client = NewClient(handler);

        await client.SendEventsAsync("sesn_test", [ManagedAgentsSessionEvents.UserMessage("hi")], default);

        var request = Assert.Single(handler.Requests);
        Assert.Equal((HttpMethod.Post, "/v1/sessions/sesn_test/events"), (request.Method, request.Uri.AbsolutePath));
        AssertJson(
            """{"events":[{"type":"user.message","content":[{"type":"text","text":"hi"}]}]}""",
            request.Body);
    }

    [Fact]
    public async Task OpensTheEventStreamRequestingPreviewsAndReadsItsEvents()
    {
        var handler = new RecordingHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(
                "event: session.status_idle\ndata: {\"type\":\"session.status_idle\",\"id\":\"idle_1\",\"stop_reason\":{\"type\":\"end_turn\"}}\n\n",
                Encoding.UTF8,
                "text/event-stream"),
        });
        var client = NewClient(handler);

        var stream = await client.OpenEventStreamAsync("sesn_test", streamDeltas: true, default);
        var received = new List<string>();
        await using ((IAsyncDisposable)stream)
        {
            await foreach (var streamEvent in stream)
            {
                received.Add(streamEvent.Json.GetProperty("type").GetString()!);
            }
        }

        var request = Assert.Single(handler.Requests);
        Assert.Equal((HttpMethod.Get, "/v1/sessions/sesn_test/events/stream"), (request.Method, request.Uri.AbsolutePath));
        var query = Uri.UnescapeDataString(request.Uri.Query);
        Assert.Contains("event_deltas", query);
        Assert.Contains("agent.message", query);
        Assert.Contains("agent.thinking", query);
        Assert.Equal(["session.status_idle"], received);
    }

    [Fact]
    public async Task OpensTheEventStreamWithoutPreviewsWhenDisabled()
    {
        var handler = new RecordingHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(string.Empty, Encoding.UTF8, "text/event-stream"),
        });
        var client = NewClient(handler);

        var stream = await client.OpenEventStreamAsync("sesn_test", streamDeltas: false, default);
        await ((IAsyncDisposable)stream).DisposeAsync();

        Assert.DoesNotContain("event_deltas", Uri.UnescapeDataString(Assert.Single(handler.Requests).Uri.Query));
    }
}
