using System.Linq;
using AGUI.Abstractions;
using AGUI.Client;
using Microsoft.Extensions.AI;

namespace AGUI.CrossLanguage.IntegrationTests;

[Collection(nameof(TsServerCollection))]
public sealed class StateEventsTests
{
    private readonly TsServerFixture _fixture;

    public StateEventsTests(TsServerFixture fixture) => _fixture = fixture;

    [Fact]
    public async Task StateSnapshotAndDelta_SurfaceViaRawRepresentation()
    {
        // The fake agent emits a STATE_SNAPSHOT (full recipe) followed by
        // three STATE_DELTA JSON Patch ops (one per ingredient added).
        // AGUIChatClient passes both through as ChatResponseUpdate.RawRepresentation
        // so consumers can subscribe to state changes alongside the chat stream.
        using HttpClient http = new() { Timeout = TimeSpan.FromSeconds(10) };
        AGUIChatClient client = new(new(http, $"{_fixture.BaseUrl}/state_events"));
        using CancellationTokenSource cts = new(TimeSpan.FromSeconds(20));

        List<ChatResponseUpdate> updates = [];
        await foreach (ChatResponseUpdate update in client
            .GetStreamingResponseAsync(
                [new(ChatRole.User, "Build me a recipe")],
                cancellationToken: cts.Token))
        {
            updates.Add(update);
        }

        StateSnapshotEvent? snapshot = updates
            .Select(u => u.RawRepresentation)
            .OfType<StateSnapshotEvent>()
            .FirstOrDefault();
        Assert.NotNull(snapshot);
        // The snapshot is a JsonElement; assert by serializing it back out.
        Assert.Contains("Pasta al Limone", snapshot!.Snapshot.ToString(), StringComparison.Ordinal);

        StateDeltaEvent[] deltas = updates
            .Select(u => u.RawRepresentation)
            .OfType<StateDeltaEvent>()
            .ToArray();
        Assert.Equal(3, deltas.Length);
        // Each delta is a JSON Patch operations array.
        Assert.All(deltas, d =>
            Assert.Contains("/recipe/ingredients/", d.Delta.ToString(), StringComparison.Ordinal));

        // The follow-up assistant text still flows through.
        string text = string.Concat(updates.Select(u => u.Text));
        Assert.Contains("Recipe ready", text);
    }
}
