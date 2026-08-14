using AGUI.Abstractions;
using AGUI.Client;
using Microsoft.Extensions.AI;

namespace AGUI.CrossLanguage.IntegrationTests;

[Collection(nameof(TsServerCollection))]
public sealed class TokenUsageTests
{
    private readonly TsServerFixture _fixture;

    public TokenUsageTests(TsServerFixture fixture) => _fixture = fixture;

    private async Task<List<ChatResponseUpdate>> RunAsync()
    {
        using HttpClient http = new() { Timeout = TimeSpan.FromSeconds(10) };
        AGUIChatClient client = new(new(http, $"{_fixture.BaseUrl}/token_usage"));
        using CancellationTokenSource cts = new(TimeSpan.FromSeconds(20));

        List<ChatResponseUpdate> updates = [];
        await foreach (ChatResponseUpdate update in client
            .GetStreamingResponseAsync(
                [new(ChatRole.User, "How many tokens?")],
                cancellationToken: cts.Token)
            .ConfigureAwait(false))
        {
            updates.Add(update);
        }

        return updates;
    }

    // The direction the .NET SDK cannot cover on its own: a TypeScript server
    // encodes RUN_FINISHED.usage via @ag-ui/encoder, and the C# client must
    // surface it through the IChatClient abstraction. Before the client-side
    // mapping existed this returned null while every .NET-only test still passed.
    [Fact]
    public async Task TypeScriptServerUsage_SurfacesOnChatResponseUsage()
    {
        List<ChatResponseUpdate> updates = await RunAsync();

        UsageDetails? usage = updates.ToChatResponse().Usage;

        Assert.NotNull(usage);
        // Aggregated across both entries the TS server reported.
        Assert.Equal(16, usage!.InputTokenCount);
        Assert.Equal(22, usage.OutputTokenCount);
        Assert.Equal(7, usage.ReasoningTokenCount);
    }

    [Fact]
    public async Task TypeScriptServerUsage_KeepsPerModelAttribution()
    {
        List<ChatResponseUpdate> updates = await RunAsync();

        List<ChatResponseUpdate> usageUpdates = updates
            .Where(u => u.Contents.OfType<UsageContent>().Any())
            .ToList();

        Assert.Equal(2, usageUpdates.Count);
        Assert.Equal("gpt-4o", usageUpdates[0].ModelId);
        Assert.Equal("claude-opus-4", usageUpdates[1].ModelId);
    }

    [Fact]
    public async Task TypeScriptServerUsage_DistinguishesReportedZeroFromUnreported()
    {
        List<ChatResponseUpdate> updates = await RunAsync();

        UsageDetails first = updates
            .SelectMany(u => u.Contents.OfType<UsageContent>())
            .First()
            .Details;

        // Reported as 0 by the TS server — must arrive as 0, not null.
        Assert.Equal(0, first.CachedInputTokenCount);

        UsageDetails second = updates
            .SelectMany(u => u.Contents.OfType<UsageContent>())
            .Last()
            .Details;

        // Never reported for the second entry — must stay null, not become 0.
        Assert.Null(second.OutputTokenCount);
        Assert.Null(second.ReasoningTokenCount);
    }

    // `provider` has no Microsoft.Extensions.AI equivalent, so it is intentionally
    // not mapped onto UsageDetails. It stays reachable on the raw event.
    [Fact]
    public async Task Provider_NotLostEvenThoughMeaiHasNoFieldForIt()
    {
        List<ChatResponseUpdate> updates = await RunAsync();

        RunFinishedEvent? finished = updates
            .Select(u => u.RawRepresentation)
            .OfType<RunFinishedEvent>()
            .FirstOrDefault();

        Assert.NotNull(finished);
        Assert.Equal("openai", finished!.Usage![0].Provider);
        Assert.Equal("anthropic", finished.Usage[1].Provider);
    }
}
