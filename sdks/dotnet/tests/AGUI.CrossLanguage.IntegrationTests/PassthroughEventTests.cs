using AGUI.Abstractions;
using AGUI.Client;
using Microsoft.Extensions.AI;

namespace AGUI.CrossLanguage.IntegrationTests;

[Collection(nameof(TsServerCollection))]
public sealed class PassthroughEventTests
{
    private readonly TsServerFixture _fixture;

    public PassthroughEventTests(TsServerFixture fixture) => _fixture = fixture;

    [Fact]
    public async Task CustomEvent_SurfacesViaRawRepresentation()
    {
        // CUSTOM events are application-specific signals; AGUIChatClient
        // doesn't have a typed surface for them but must still yield a
        // ChatResponseUpdate whose RawRepresentation is the CustomEvent.
        // This proves a producer can pass arbitrary signals across the
        // language boundary without crashing the client.
        using HttpClient http = new() { Timeout = TimeSpan.FromSeconds(10) };
        AGUIChatClient client = new(new(http, $"{_fixture.BaseUrl}/custom_event"));
        using CancellationTokenSource cts = new(TimeSpan.FromSeconds(20));

        List<ChatResponseUpdate> updates = [];
        await foreach (ChatResponseUpdate update in client
            .GetStreamingResponseAsync(
                [new(ChatRole.User, "Trigger a notification")],
                cancellationToken: cts.Token))
        {
            updates.Add(update);
        }

        CustomEvent? custom = updates
            .Select(u => u.RawRepresentation)
            .OfType<CustomEvent>()
            .FirstOrDefault();
        Assert.NotNull(custom);
        Assert.Equal("ui.notify", custom!.Name);
        Assert.NotNull(custom.Value);
        Assert.Contains("test-marker", custom.Value!.Value.ToString());

        // The text payload alongside the custom event still flows through.
        string text = string.Concat(updates.Select(u => u.Text));
        Assert.Contains("Hello", text);
    }

    [Fact]
    public async Task RawEvent_SurfacesViaRawRepresentation()
    {
        // RAW events carry provider-native payloads (e.g. OpenAI tokens
        // metadata) and follow the same pass-through contract as CUSTOM.
        using HttpClient http = new() { Timeout = TimeSpan.FromSeconds(10) };
        AGUIChatClient client = new(new(http, $"{_fixture.BaseUrl}/raw_event"));
        using CancellationTokenSource cts = new(TimeSpan.FromSeconds(20));

        List<ChatResponseUpdate> updates = [];
        await foreach (ChatResponseUpdate update in client
            .GetStreamingResponseAsync(
                [new(ChatRole.User, "Send a raw payload")],
                cancellationToken: cts.Token))
        {
            updates.Add(update);
        }

        RawEvent? raw = updates
            .Select(u => u.RawRepresentation)
            .OfType<RawEvent>()
            .FirstOrDefault();
        Assert.NotNull(raw);
        Assert.Equal("fake-agent", raw!.Source);
        Assert.Contains("fake-llm-7b", raw.Event.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task RunError_SurfacesErrorContent()
    {
        // RUN_ERROR crosses the language boundary as ErrorContent so callers
        // can inspect both the error message and the protocol error code.
        using HttpClient http = new() { Timeout = TimeSpan.FromSeconds(10) };
        AGUIChatClient client = new(new(http, $"{_fixture.BaseUrl}/run_error"));
        using CancellationTokenSource cts = new(TimeSpan.FromSeconds(20));

        List<ChatResponseUpdate> updates = [];
        await foreach (ChatResponseUpdate update in client
            .GetStreamingResponseAsync(
                [new(ChatRole.User, "fail")],
                cancellationToken: cts.Token)
            .ConfigureAwait(false))
        {
            updates.Add(update);
        }

        ChatResponseUpdate errorUpdate = Assert.Single(updates, u => u.Contents.Any(c => c is ErrorContent));
        ErrorContent error = Assert.IsType<ErrorContent>(Assert.Single(errorUpdate.Contents));
        Assert.Equal("fake agent: simulated upstream failure", error.Message);
        Assert.Equal("FAKE_AGENT_FAILURE", error.ErrorCode);
        Assert.IsType<RunErrorEvent>(errorUpdate.RawRepresentation);
    }
}
